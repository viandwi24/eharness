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
import type { ApprovalDecision, HarnessContext } from '../plugin/types.ts'
import type { HookRunner } from '../session/hooks.ts'
import { isLimitedOutput, limitToolOutput, type OutputLimitDeps } from './output-limits.ts'
import { riskOf } from './risk.ts'

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
  if (isUnwrapped(name, tool)) {
    // client tools: their outputs (respond(), spec 09 §6) are limited like server outputs
    const convert = limitAware(tool)
    const isClient = typeof tool.execute !== 'function' && tool.type !== 'provider'
    return isClient && deps.limits !== undefined && convert !== undefined
      ? ({ ...tool, toModelOutput: convert } as Tool)
      : tool
  }
  const execute = tool.execute as (
    input: unknown,
    options: ToolExecutionOptions<unknown>,
  ) => unknown
  const toToolError = (error: unknown, toolCallId: string) =>
    error instanceof HarnessToolError
      ? error
      : new HarnessToolError(error, { toolName: name, toolCallId })

  const limits = deps.limits
  const finish = (input: unknown, output: unknown, toolCallId: string) =>
    finishToolOutput(name, toolCallId, input, output, deps)

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
  const convert = limitAware(tool)
  if (limits === undefined || convert === undefined) return { ...tool, execute: wrapped } as Tool
  return { ...tool, execute: wrapped, toModelOutput: convert } as Tool
}

/**
 * The tool's own `toModelOutput`, skipped for a limited structured output (it no longer has the
 * shape the tool's converter expects), or `undefined` when the tool has none.
 */
function limitAware(tool: Tool): Tool['toModelOutput'] | undefined {
  const toModelOutput = tool.toModelOutput as
    | ((options: { toolCallId: string; input: unknown; output: unknown }) => unknown)
    | undefined
  if (toModelOutput === undefined) return undefined
  return ((options: { toolCallId: string; input: unknown; output: unknown }) =>
    isLimitedOutput(options.output)
      ? { type: 'json', value: options.output }
      : toModelOutput(options)) as Tool['toModelOutput']
}

/**
 * The final output of a tool call: the `tool.after` chain, then the output limit (spec 09 §4).
 * Used for server outputs (execute wrapper) and client tool outputs (`respond()`, spec 09 §6).
 */
export async function finishToolOutput(
  name: string,
  toolCallId: string,
  input: unknown,
  output: unknown,
  deps: ToolWrapDeps,
): Promise<unknown> {
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
  const limits = deps.limits
  return limits === undefined
    ? current
    : limitToolOutput(name, toolCallId, current, { ...limits, warn: deps.warn })
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
  const type: unknown = typeof status === 'string' ? status : (status as { type?: unknown }).type
  // an unknown status (a typo, a value from another version) fails closed like a throw
  if (typeof type !== 'string' || !Object.hasOwn(RANK, type)) {
    return { type: 'denied', reason: `invalid approval status '${String(type)}'` }
  }
  const out: Normalized = { type: type as Normalized['type'] }
  if (typeof status === 'object' && typeof status.reason === 'string') out.reason = status.reason
  return out
}

/** Session approval grants, read at every approval decision (spec 11 §3.1). */
export interface ApprovalGrants {
  /** The grants in effect right now (`undefined` = none). */
  current(): Readonly<Record<string, 'always' | 'never'>> | undefined
}

/**
 * The per-step approval function (spec 11 §3): `approval.policy`, then every `tool.approve` hook,
 * then session grants, combined most-restrictive-wins. A throwing policy or hook, or an unknown
 * status value, counts as `denied` (fail closed). A grant `never` denies; `always` turns `user-approval` into `approved`
 * but never overrides `denied` (then `W_GRANT_IGNORED`, once per tool). `undefined` only when there
 * is neither a policy, a hook nor a grant source; turns always pass a grant source, so every turn
 * gets a function (it returns `not-applicable` when nothing applies).
 */
export function buildApproval(
  config: ApprovalConfig | undefined,
  deps: ToolWrapDeps,
  grants?: ApprovalGrants,
): GenericToolApprovalFunction<ToolSet, never, unknown> | undefined {
  const policy = config?.policy
  const byRisk = config?.risk
  const hooks = deps.hooks.list('tool.approve')
  if (policy === undefined && byRisk === undefined && hooks.length === 0 && grants === undefined) {
    return undefined
  }
  const ignoredWarned = new Set<string>()
  /** Calls already reported to `approval.decided` (AI SDK re-runs the function for approved calls). */
  const reported = new Set<string>()
  const failed = (error: unknown): Normalized => ({
    type: 'denied',
    reason: error instanceof Error ? error.message : String(error),
  })
  return async (options) => {
    const { toolCall } = options
    const toolMetadata = (toolCall as { toolMetadata?: unknown }).toolMetadata
    const risk = riskOf(toolMetadata)
    const statuses: Array<{ status: Normalized; by: ApprovalDecision['by'] }> = []
    if (typeof policy === 'function') {
      try {
        statuses.push({ status: normalizeStatus(await policy(options as never)), by: 'policy' })
      } catch (error) {
        statuses.push({ status: failed(error), by: 'policy' })
      }
    } else if (policy !== undefined) {
      const entry = (policy as Record<string, unknown>)[toolCall.toolName]
      if (typeof entry === 'function') {
        try {
          const status = await (entry as (input: unknown, o: unknown) => unknown)(toolCall.input, {
            toolCallId: toolCall.toolCallId,
            messages: options.messages,
            toolContext: (options.toolsContext as Record<string, unknown> | undefined)?.[
              toolCall.toolName
            ],
            runtimeContext: options.runtimeContext,
          })
          statuses.push({ status: normalizeStatus(status as ToolApprovalStatus), by: 'policy' })
        } catch (error) {
          statuses.push({ status: failed(error), by: 'policy' })
        }
      } else {
        statuses.push({ status: normalizeStatus(entry as ToolApprovalStatus), by: 'policy' })
      }
    }
    if (byRisk !== undefined) {
      statuses.push({ status: normalizeStatus(byRisk[risk ?? 'unknown']), by: 'risk' })
    }
    for (const hook of hooks) {
      try {
        const status = await hook.fn(deps.contextOf(hook.owner), {
          toolName: toolCall.toolName,
          toolCallId: toolCall.toolCallId,
          input: toolCall.input,
          ...(toolMetadata === undefined ? {} : { toolMetadata }),
          ...(risk === undefined ? {} : { risk }),
        })
        statuses.push({ status: normalizeStatus(status ?? undefined), by: `plugin:${hook.owner}` })
      } catch (error) {
        statuses.push({ status: failed(error), by: `plugin:${hook.owner}` })
      }
    }
    let winner: Normalized = { type: 'not-applicable' }
    let by: ApprovalDecision['by'] = 'policy'
    for (const entry of statuses) {
      if (RANK[entry.status.type] > RANK[winner.type]) {
        winner = entry.status
        by = entry.by
      }
    }
    const grant = grants?.current()?.[toolCall.toolName]
    if (grant === 'never') {
      if (winner.type !== 'denied') {
        winner = { type: 'denied' }
        by = 'grant'
      }
    } else if (grant === 'always') {
      if (winner.type === 'user-approval') {
        winner = { type: 'approved' }
        by = 'grant'
      } else if (winner.type === 'denied' && !ignoredWarned.has(toolCall.toolName)) {
        ignoredWarned.add(toolCall.toolName)
        deps.warn(
          {
            code: 'W_GRANT_IGNORED',
            message: `The session grant 'always' for tool '${toolCall.toolName}' cannot apply: the approval policy or a tool.approve hook denies it.`,
            details: { tool: toolCall.toolName },
          },
          `grant:${toolCall.toolName}`,
        )
      }
    }
    if (
      (winner.type === 'approved' || winner.type === 'denied') &&
      !reported.has(toolCall.toolCallId)
    ) {
      reported.add(toolCall.toolCallId)
      await reportDecision(deps, {
        toolName: toolCall.toolName,
        toolCallId: toolCall.toolCallId,
        input: toolCall.input,
        ...(risk === undefined ? {} : { risk }),
        approved: winner.type === 'approved',
        by,
        ...(winner.reason === undefined ? {} : { reason: winner.reason }),
      })
    }
    return winner.reason === undefined
      ? winner.type
      : ({ type: winner.type, reason: winner.reason } as ToolApprovalStatus)
  }
}

/** Run the `approval.decided` hooks (failures are `W_HOOK_FAILED`). */
export async function reportDecision(
  deps: Pick<ToolWrapDeps, 'hooks' | 'contextOf' | 'warn'>,
  decision: ApprovalDecision,
): Promise<void> {
  for (const hook of deps.hooks.list('approval.decided')) {
    try {
      await hook.fn(deps.contextOf(hook.owner), structuredClone(decision))
    } catch (error) {
      hookFailed(deps, 'approval.decided', hook.owner, error)
    }
  }
}
