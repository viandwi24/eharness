/**
 * Tool wrapping (internal): `tool.before` through `experimental_refineToolInput`, the `execute`
 * wrapper (`tool.after`, preliminary pass-through, `HarnessToolError`, status part) and the
 * per-step approval function (policy + `tool.approve` hooks, most restrictive wins).
 *
 * eharness never sets the deprecated tool-level `needsApproval`.
 *
 * @see docs/specs/01-agent-and-plugins.md#5-hooks
 * @see docs/specs/11-interaction.md#3-tool-approval
 */
import type {
  GenericToolApprovalFunction,
  Tool,
  ToolApprovalStatus,
  ToolExecutionOptions,
  ToolInputRefinement,
  ToolSet,
} from 'ai'
import type { ApprovalConfig } from '../agent/types.ts'
import { HarnessToolError, type HarnessWarning } from '../errors.ts'
import type { HarnessContext } from '../plugin/types.ts'
import type { HookRunner } from '../session/hooks.ts'
import { isLimitedOutput, limitToolOutput, type OutputLimitDeps } from './output-limits.ts'

/** Dependencies of the wrappers. */
export interface ToolWrapDeps {
  hooks: HookRunner
  contextOf(owner: string): HarnessContext
  warn(warning: HarnessWarning, key?: string): void
  /** Write `data-eh.status { state: 'tool', tool }` (no-op outside a turn). */
  status(toolName: string): void
  /** Tool output limits (spec 09 §4); omitted = no limits (unit tests). */
  limits?: Omit<OutputLimitDeps, 'warn'>
}

/** Report a failing hook (`W_HOOK_FAILED`). */
export function hookFailed(
  deps: Pick<ToolWrapDeps, 'warn'>,
  hook: string,
  owner: string,
  error: unknown,
): void {
  deps.warn(
    {
      code: 'W_HOOK_FAILED',
      message: `Hook '${hook}' of ${owner === 'app' ? 'the app' : `plugin '${owner}'`} threw and was skipped: ${error instanceof Error ? error.message : String(error)}`,
      details: { hook, owner },
    },
    `${owner}:${hook}`,
  )
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === 'function'
  )
}

/** True for tools the core never wraps: client tools, provider-executed tools, `toolSearch()`. */
export function isUnwrapped(name: string, tool: Tool): boolean {
  if (typeof tool.execute !== 'function') return true
  if (tool.type === 'provider' && (tool as { isProviderExecuted?: boolean }).isProviderExecuted) {
    return true
  }
  return name === 'tool_search'
}

/**
 * Wrap a tool's `execute`: status part, `tool.after` chain on the final output, output limits on
 * the final output (spec 09 §4), preliminary (AsyncIterable) results passed through, thrown errors
 * re-thrown as `HarnessToolError` (so `String(error)` is identical on the wire, in the UI and in
 * storage).
 */
export function wrapTool(name: string, tool: Tool, deps: ToolWrapDeps): Tool {
  if (isUnwrapped(name, tool)) return tool
  const execute = tool.execute as (
    input: unknown,
    options: ToolExecutionOptions<unknown>,
  ) => unknown
  const toToolError = (error: unknown, toolCallId: string) =>
    error instanceof HarnessToolError
      ? error
      : new HarnessToolError(error, { toolName: name, toolCallId })

  const after = async (input: unknown, output: unknown, toolCallId: string) => {
    let current = output
    for (const hook of deps.hooks.list('tool.after')) {
      try {
        const result = await hook.fn(deps.contextOf(hook.owner), {
          toolName: name,
          toolCallId,
          input,
          output: current,
        })
        if (result !== undefined && result !== null && 'output' in result) current = result.output
      } catch (error) {
        hookFailed(deps, 'tool.after', hook.owner, error)
      }
    }
    return current
  }

  const limits = deps.limits
  /** `tool.after` chain, then the output limit: the final value only. */
  const finish = async (input: unknown, output: unknown, toolCallId: string) => {
    const afterOutput = deps.hooks.has('tool.after')
      ? await after(input, output, toolCallId)
      : output
    return limits === undefined
      ? afterOutput
      : limitToolOutput(name, toolCallId, afterOutput, { ...limits, warn: deps.warn })
  }

  const wrapped = (input: unknown, options: ToolExecutionOptions<unknown>): unknown => {
    deps.status(name)
    let result: unknown
    try {
      result = execute(input, options)
    } catch (error) {
      return Promise.reject(toToolError(error, options.toolCallId))
    }
    if (isAsyncIterable(result)) {
      const source = result
      return (async function* () {
        let last: unknown
        let has = false
        try {
          for await (const value of source) {
            last = value
            has = true
            yield value
          }
        } catch (error) {
          throw toToolError(error, options.toolCallId)
        }
        if (has) {
          const final = await finish(input, last, options.toolCallId)
          if (final !== last) yield final
        }
      })()
    }
    return Promise.resolve(result).then(
      (output) => finish(input, output, options.toolCallId),
      (error: unknown) => {
        throw toToolError(error, options.toolCallId)
      },
    )
  }
  const toModelOutput = tool.toModelOutput as
    | ((options: { toolCallId: string; input: unknown; output: unknown }) => unknown)
    | undefined
  if (limits === undefined || toModelOutput === undefined) {
    return { ...tool, execute: wrapped } as Tool
  }
  // a limited structured output no longer has the shape the tool's own converter expects
  return {
    ...tool,
    execute: wrapped,
    toModelOutput: (options: { toolCallId: string; input: unknown; output: unknown }) =>
      isLimitedOutput(options.output)
        ? { type: 'json', value: options.output }
        : toModelOutput(options),
  } as Tool
}

/** `experimental_refineToolInput` map running the `tool.before` chain, or `undefined`. */
export function buildRefinement(
  toolNames: readonly string[],
  deps: ToolWrapDeps,
): ToolInputRefinement<ToolSet> | undefined {
  if (!deps.hooks.has('tool.before')) return undefined
  const map: Record<string, (input: unknown) => Promise<unknown>> = {}
  for (const toolName of toolNames) {
    map[toolName] = async (input) => {
      let current = input
      for (const hook of deps.hooks.list('tool.before')) {
        try {
          const result = await hook.fn(deps.contextOf(hook.owner), { toolName, input: current })
          if (result !== undefined && result !== null && 'input' in result) current = result.input
        } catch (error) {
          hookFailed(deps, 'tool.before', hook.owner, error)
        }
      }
      return current
    }
  }
  return map as ToolInputRefinement<ToolSet>
}

type Normalized = {
  type: 'not-applicable' | 'approved' | 'denied' | 'user-approval'
  reason?: string
}

const RANK: Record<Normalized['type'], number> = {
  'not-applicable': 0,
  approved: 1,
  'user-approval': 2,
  denied: 3,
}

function normalizeStatus(status: ToolApprovalStatus | undefined): Normalized {
  if (status === undefined || status === null) return { type: 'not-applicable' }
  if (typeof status === 'string') return { type: status }
  const out: Normalized = { type: status.type }
  if (typeof status.reason === 'string') out.reason = status.reason
  return out
}

/**
 * The per-step approval function (spec 11 §3): `approval.policy`, then every `tool.approve` hook
 * (a throwing hook counts as `denied`), combined most-restrictive-wins. `undefined` when there is
 * neither a policy nor a hook. Session grants are added by P7.
 */
export function buildApproval(
  config: ApprovalConfig | undefined,
  deps: ToolWrapDeps,
): GenericToolApprovalFunction<ToolSet, never, unknown> | undefined {
  const policy = config?.policy
  const hooks = deps.hooks.list('tool.approve')
  if (policy === undefined && hooks.length === 0) return undefined
  return async (options) => {
    const { toolCall } = options
    const statuses: Normalized[] = []
    if (typeof policy === 'function') {
      statuses.push(normalizeStatus(await policy(options as never)))
    } else if (policy !== undefined) {
      const entry = (policy as Record<string, unknown>)[toolCall.toolName]
      if (typeof entry === 'function') {
        const status = await (entry as (input: unknown, o: unknown) => unknown)(toolCall.input, {
          toolCallId: toolCall.toolCallId,
          messages: options.messages,
          toolContext: (options.toolsContext as Record<string, unknown> | undefined)?.[
            toolCall.toolName
          ],
          runtimeContext: options.runtimeContext,
        })
        statuses.push(normalizeStatus(status as ToolApprovalStatus))
      } else {
        statuses.push(normalizeStatus(entry as ToolApprovalStatus))
      }
    }
    for (const hook of hooks) {
      try {
        const status = await hook.fn(deps.contextOf(hook.owner), {
          toolName: toolCall.toolName,
          toolCallId: toolCall.toolCallId,
          input: toolCall.input,
          ...((toolCall as { toolMetadata?: unknown }).toolMetadata === undefined
            ? {}
            : { toolMetadata: (toolCall as { toolMetadata?: unknown }).toolMetadata }),
        })
        statuses.push(normalizeStatus(status ?? undefined))
      } catch (error) {
        statuses.push({
          type: 'denied',
          reason: error instanceof Error ? error.message : String(error),
        })
      }
    }
    let winner: Normalized = { type: 'not-applicable' }
    for (const status of statuses) if (RANK[status.type] > RANK[winner.type]) winner = status
    return winner.reason === undefined
      ? winner.type
      : ({ type: winner.type, reason: winner.reason } as ToolApprovalStatus)
  }
}
