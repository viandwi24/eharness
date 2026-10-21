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
import {
  type GenericToolApprovalFunction,
  InvalidToolInputError,
  type Tool,
  type ToolApprovalStatus,
  type ToolCallRepairFunction,
  type ToolExecutionOptions,
  type ToolInputRefinement,
  type ToolSet,
} from 'ai'
import type { ApprovalConfig, ToolErrorTextFn } from '../agent/types.ts'
import { HarnessToolError, type HarnessWarning } from '../errors.ts'
import { hookFailed, runHook } from '../internal/hook-run.ts'
import type { Observer } from '../internal/observe.ts'
import { errorText } from '../internal/util.ts'
import { rehydrateOutputMedia } from '../messages/tool-media.ts'
import type { ApprovalDecision, HarnessContext } from '../plugin/types.ts'
import type { HookRunner } from '../session/hooks.ts'
import { inputJsonSchema, repairInputText, repairToolInput } from './input-repair.ts'
import { isLimitedOutput, limitToolOutput, type OutputLimitDeps } from './output-limits.ts'
import { toolTraits } from './risk.ts'
import { withToolExecute, withToolFields } from './tool-copy.ts'
import { offloadToolMedia, toolMediaReader } from './tool-media.ts'
import { buildTranscript, type GuardTranscriptEntry } from './transcript.ts'

/** The text of a thrown tool error when `toolErrorText` throws or returns a non-string. */
const TOOL_ERROR_FALLBACK = 'Error: the tool failed.'

/** Dependencies of the wrappers. */
export interface ToolWrapDeps {
  hooks: HookRunner
  contextOf(owner: string): HarnessContext
  warn(warning: HarnessWarning, key?: string): void
  /** Write `data-eh.status { state: 'tool', tool }` (no-op outside a turn). */
  status(toolName: string): void
  /** Tool output limits (spec 09 §4); omitted = no limits (unit tests). */
  limits?: Omit<OutputLimitDeps, 'warn'>
  /** `config.toolErrorText`: the text a thrown error becomes (spec 10 §1.1). */
  toolErrorText?: ToolErrorTextFn
  /** `config.hooks.timeoutMs` (default 30 000): a hook that does not settle counts as throwing. */
  hookTimeoutMs?: number
  /** Turn signal: aborting the turn cuts a running hook short. */
  signal?: AbortSignal
  /** `config.observe`: every tool execution is a `tool.execute` span (spec 10 §8). */
  observe?: Observer | undefined
  sessionId?: string | undefined
  turnId?: string | undefined
  /** Per-step call limits (spec 09 §4.1): a refusal text, or undefined to run the call. */
  callGuard?: ToolCallGuard
}

/** Default `toolCalls.maxPerStep`. */
export const DEFAULT_MAX_TOOL_CALLS_PER_STEP = 24

/** Admits the calls of a step (spec 09 §4.1). */
export interface ToolCallGuard {
  admit(toolName: string, input: unknown): string | undefined
  /** Record what an admitted call returned (its output, or its error text). */
  record?(toolName: string, input: unknown, result: { output: unknown } | { error: string }): void
}

/** Default `toolCalls.maxIdenticalResults`. */
export const DEFAULT_MAX_IDENTICAL_RESULTS = 3

const HASH_CAP = 65_536

/** FNV-1a over a text, two seeds, with the length: a cheap fingerprint, nothing large is kept. */
function hashText(text: string): string {
  let a = 0x811c9dc5
  let b = 0x9747b28c
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    a = Math.imul(a ^ c, 0x01000193)
    b = Math.imul(b ^ c, 0x85ebca6b)
  }
  return `${text.length}.${(a >>> 0).toString(36)}.${(b >>> 0).toString(36)}`
}

/** Serialize with sorted keys, base64 `data` strings and media bodies skipped, capped in size. */
function stableText(value: unknown): string {
  let budget = HASH_CAP
  const seen = new WeakSet<object>()
  const walk = (v: unknown, key?: string): unknown => {
    if (typeof v === 'string') {
      if (key === 'data' || key === 'base64' || key === 'bytes') return `[${v.length}]`
      if (v.length > budget) {
        const head = v.slice(0, Math.max(budget, 0))
        budget = 0
        return `${head}[${v.length}]`
      }
      budget -= v.length
      return v
    }
    if (typeof v !== 'object' || v === null) return v
    if (v instanceof Uint8Array) return `[bytes ${v.length}]`
    if (budget <= 0 || seen.has(v)) return '[cut]'
    seen.add(v)
    if (Array.isArray(v)) return v.map((x) => walk(x))
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(v).sort()) {
      if (budget <= 0) break
      out[k] = walk((v as Record<string, unknown>)[k], k)
    }
    return out
  }
  try {
    return JSON.stringify(walk(value)) ?? ''
  } catch {
    return String(value).slice(0, HASH_CAP)
  }
}

/**
 * The per-step guard of a turn: at most `max` calls run in one step, and an exact repeat of a call
 * of the same step (same tool, same input) does not run again.
 */
export function toolCallGuard(
  stepOf: () => number | undefined,
  max: number,
  maxIdentical: number = DEFAULT_MAX_IDENTICAL_RESULTS,
): ToolCallGuard {
  let step: number | undefined
  let count = 0
  const seen = new Set<string>()
  // per turn: the last result of a (tool, input) and how many times in a row it came back
  const results = new Map<string, { hash: string; count: number }>()
  const keyOf = (toolName: string, input: unknown): string =>
    `${toolName}\u0000${hashText(stableText(input))}`
  return {
    record(toolName, input, result) {
      if (maxIdentical <= 0) return
      const key = keyOf(toolName, input)
      const hash = hashText(
        'error' in result ? `E${result.error.slice(0, HASH_CAP)}` : `O${stableText(result.output)}`,
      )
      const prev = results.get(key)
      results.set(
        key,
        prev !== undefined && prev.hash === hash
          ? { hash, count: prev.count + 1 }
          : { hash, count: 1 },
      )
    },
    admit(toolName, input) {
      const now = stepOf() ?? 0
      if (now !== step) {
        step = now
        count = 0
        seen.clear()
      }
      let key: string
      try {
        key = `${toolName}\u0000${JSON.stringify(input) ?? ''}`
      } catch {
        key = `${toolName}\u0000${String(input)}`
      }
      if (seen.has(key)) {
        return `Skipped: the same ${toolName} call with the same input was already made in this step; use that result instead of repeating it.`
      }
      if (maxIdentical > 0) {
        const prev = results.get(keyOf(toolName, input))
        if (prev !== undefined && prev.count >= maxIdentical) {
          return `Skipped: ${toolName} with this input already returned the same result ${maxIdentical} times in this turn; it will not change now. Use that result or try something else.`
        }
      }
      seen.add(key)
      count++
      if (count > max) {
        return `Skipped: more than ${max} tool calls in one step. Make fewer calls at a time and wait for their results before the next ones.`
      }
      return undefined
    },
  }
}

/** Run one hook bounded by the hook timeout and the turn signal (see {@link runHook}). */
export function callHook<T>(
  deps: Pick<ToolWrapDeps, 'hookTimeoutMs' | 'signal'>,
  hook: string,
  owner: string,
  call: () => T | Promise<T>,
): Promise<T> {
  return runHook(call, { hook, owner, timeoutMs: deps.hookTimeoutMs, signal: deps.signal })
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
    const convert = limitAware(tool, deps)
    const isClient = typeof tool.execute !== 'function' && tool.type !== 'provider'
    return isClient && deps.limits !== undefined && convert !== undefined
      ? withToolFields(tool, { toModelOutput: convert })
      : tool
  }
  const execute = tool.execute as (
    input: unknown,
    options: ToolExecutionOptions<unknown>,
  ) => unknown
  const toToolError = (error: unknown, toolCallId: string) => {
    if (error instanceof HarnessToolError) return error
    const map = deps.toolErrorText
    if (map === undefined) return new HarnessToolError(error, { toolName: name, toolCallId })
    let text: string
    try {
      const mapped: unknown = map(error, { toolName: name, toolCallId })
      text = typeof mapped === 'string' ? mapped : TOOL_ERROR_FALLBACK
    } catch {
      // a failing mapper must not leak the original text either
      text = TOOL_ERROR_FALLBACK
    }
    return new HarnessToolError(error, { toolName: name, toolCallId, text })
  }

  const limits = deps.limits
  const finish = (input: unknown, output: unknown, toolCallId: string) =>
    finishToolOutput(name, toolCallId, input, output, deps)

  const wrapped = (input: unknown, options: ToolExecutionOptions<unknown>): unknown => {
    const refused = deps.callGuard?.admit(name, input)
    if (refused !== undefined) {
      return Promise.reject(
        new HarnessToolError(new Error(refused), {
          toolName: name,
          toolCallId: options.toolCallId,
          text: refused,
        }),
      )
    }
    deps.status(name)
    if (deps.observe === undefined) return run(input, options)
    const observe = deps.observe
    const started = performance.now()
    const scope = { sessionId: deps.sessionId, turnId: deps.turnId, tool: name }
    const done = (ok: boolean): void =>
      observe({
        type: 'span',
        name: 'tool.execute',
        durationMs: performance.now() - started,
        ok,
        ...scope,
      })
    let out: unknown
    try {
      out = run(input, options)
    } catch (error) {
      done(false)
      throw error
    }
    if (isAsyncIterable(out)) {
      const source = out
      return (async function* () {
        try {
          yield* source
        } catch (error) {
          done(false)
          throw error
        }
        done(true)
      })()
    }
    return Promise.resolve(out).then(
      (value) => {
        done(true)
        return value
      },
      (error: unknown) => {
        done(false)
        throw error
      },
    )
  }
  const run = (input: unknown, options: ToolExecutionOptions<unknown>): unknown => {
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
            yield cloneableOutput(name, value)
          }
        } catch (error) {
          throw toToolError(error, options.toolCallId)
        }
        if (has) {
          const final = await finish(input, last, options.toolCallId)
          deps.callGuard?.record?.(name, input, { output: final })
          if (final !== last) yield final
        }
      })()
    }
    return Promise.resolve(result).then(
      async (output) => {
        const final = await finish(input, output, options.toolCallId)
        deps.callGuard?.record?.(name, input, { output: final })
        return final
      },
      (error: unknown) => {
        const wrappedError = toToolError(error, options.toolCallId)
        deps.callGuard?.record?.(name, input, { error: String(wrappedError) })
        throw wrappedError
      },
    )
  }
  const convert = limitAware(tool, deps)
  if (limits === undefined || convert === undefined) return withToolExecute(tool, wrapped)
  return withToolFields(withToolExecute(tool, wrapped), { toModelOutput: convert })
}

/**
 * The tool's own `toModelOutput`, skipped for a limited structured output (it no longer has the
 * shape the tool's converter expects), or `undefined` when the tool has none.
 */
function limitAware(tool: Tool, deps: ToolWrapDeps): Tool['toModelOutput'] | undefined {
  const toModelOutput = tool.toModelOutput as
    | ((options: { toolCallId: string; input: unknown; output: unknown }) => unknown)
    | undefined
  if (toModelOutput === undefined) return undefined
  const sink = deps.limits?.toolMedia
  const read = sink === undefined ? undefined : toolMediaReader(sink)
  return ((options: { toolCallId: string; input: unknown; output: unknown }) => {
    if (isLimitedOutput(options.output)) return { type: 'json', value: options.output }
    // offloaded media (spec 09 §4): the converter gets the bytes back as `data`
    if (read === undefined) return toModelOutput(options)
    return rehydrateOutputMedia(options.output, read).then((output) =>
      toModelOutput({ ...options, output }),
    )
  }) as Tool['toModelOutput']
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
      const result = await callHook(deps, 'tool.after', hook.owner, () =>
        hook.fn(deps.contextOf(hook.owner), {
          toolName: name,
          toolCallId,
          input,
          output: current,
        }),
      )
      if (result !== undefined && result !== null && 'output' in result) current = result.output
    } catch (error) {
      hookFailed(deps, 'tool.after', hook.owner, error)
    }
  }
  const limits = deps.limits
  const limited =
    limits === undefined
      ? current
      : await limitToolOutput(name, toolCallId, current, { ...limits, warn: deps.warn })
  const stored =
    limits?.toolMedia === undefined
      ? limited
      : await offloadToolMedia(name, toolCallId, limited, {
          sessionId: limits.sessionId,
          toolMedia: limits.toolMedia,
          warn: deps.warn,
        })
  return cloneableOutput(name, stored)
}

/**
 * A tool output the stream can copy: `structuredClone` rejects functions and some class
 * instances, which would kill the turn after the tool already ran. Falls back to a JSON-safe copy,
 * then to an error string the model can read (spec 09, rule 6).
 */
function cloneableOutput(name: string, output: unknown): unknown {
  try {
    structuredClone(output)
    return output
  } catch {
    // not copyable as is
  }
  try {
    const json = JSON.stringify(output)
    return json === undefined ? undefined : JSON.parse(json)
  } catch (error) {
    return `Error: the output of tool '${name}' could not be serialized (${errorText(error)}). The tool did run.`
  }
}

/** Warn once per agent, tool and property about a repaired input. */
const repairedWarned = new WeakMap<object, Set<string>>()

/** One `W_TOOL_INPUT_REPAIRED` per agent, tool and property. */
function warnRepaired(deps: ToolWrapDeps, toolName: string, properties: readonly string[]): void {
  const seen = repairedWarned.get(deps.warn) ?? new Set<string>()
  repairedWarned.set(deps.warn, seen)
  for (const property of properties) {
    const key = `${toolName}\u0000${property}`
    if (seen.has(key)) continue
    seen.add(key)
    deps.warn(
      {
        code: 'W_TOOL_INPUT_REPAIRED',
        message: `The model sent '${property}' of tool '${toolName}' in the wrong type; it was converted before the call.`,
        details: { tool: toolName, property },
      },
      key,
    )
  }
}

/**
 * AI SDK `repairToolCall` for the input repair of spec 09 §4.2: a call whose input failed
 * validation is retried once with the conservative type repair; `null` leaves the readable error
 * to the model.
 */
export function buildCallRepair(deps: ToolWrapDeps): ToolCallRepairFunction<ToolSet> {
  return async ({ toolCall, tools, error }) => {
    if (!InvalidToolInputError.isInstance(error)) return null
    const tool = tools[toolCall.toolName] as Tool | undefined
    if (tool === undefined || tool.type === 'provider') return null
    const schema = await inputJsonSchema(tool)
    if (schema === undefined) return null
    const fixed = repairInputText(toolCall.input, schema)
    if (fixed === undefined) return null
    warnRepaired(deps, toolCall.toolName, fixed.repaired)
    return { ...toolCall, input: fixed.text }
  }
}

/**
 * Tool input refinement map (AI SDK `experimental_refineToolInput`, named only in `internal/ai-compat.ts`):
 * the input repair of spec 09 §4.2 (JSON-encoded objects and arrays), then the `tool.before` chain.
 */
export function buildRefinement(
  toolNames: readonly string[],
  deps: ToolWrapDeps,
  tools: ToolSet,
): ToolInputRefinement<ToolSet> | undefined {
  const map: Record<string, (input: unknown) => Promise<unknown>> = {}
  const hasBefore = deps.hooks.has('tool.before')
  for (const toolName of toolNames) {
    const tool = tools[toolName] as Tool | undefined
    map[toolName] = async (input) => {
      let current = input
      if (tool !== undefined && tool.type !== 'provider') {
        const schema = await inputJsonSchema(tool)
        if (schema !== undefined) {
          const fixed = repairToolInput(current, schema)
          current = fixed.input
          warnRepaired(deps, toolName, fixed.repaired)
        }
      }
      if (!hasBefore) return current
      for (const hook of deps.hooks.list('tool.before')) {
        try {
          const result = await callHook(deps, 'tool.before', hook.owner, () =>
            hook.fn(deps.contextOf(hook.owner), { toolName, input: current }),
          )
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

/** Separator between a tool name and its scope in a grant key (`bash\u0000git status`). */
export const GRANT_SCOPE_SEPARATOR = '\u0000'

/**
 * The key a session grant of this call is stored under and looked up by (spec 11 §3.1): the tool
 * name, or `<tool>\u0000<scope>` when a `tool.grantScope` hook scopes the tool; `null` when a hook
 * says the call cannot be remembered (or throws: fail closed). First non-void hook result wins.
 */
export async function grantKeyOf(
  deps: Pick<ToolWrapDeps, 'hooks' | 'contextOf' | 'warn' | 'hookTimeoutMs' | 'signal'>,
  toolName: string,
  input: unknown,
): Promise<string | null> {
  for (const hook of deps.hooks.list('tool.grantScope')) {
    try {
      const scope = await callHook(deps, 'tool.grantScope', hook.owner, () =>
        hook.fn(deps.contextOf(hook.owner), {
          toolName,
          input: structuredClone(input),
        }),
      )
      if (scope === null) return null
      if (typeof scope === 'string') {
        return scope === '' ? null : `${toolName}${GRANT_SCOPE_SEPARATOR}${scope}`
      }
    } catch (error) {
      hookFailed(deps, 'tool.grantScope', hook.owner, error)
      return null
    }
  }
  return toolName
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
    reason: errorText(error),
  })
  return async (options) => {
    const { toolCall } = options
    // AI SDK's re-validation of approved calls (a respond() continuation) passes the stored call,
    // which has no `toolMetadata`: read it from the tool itself, so traits never fall to `unknown`
    const toolMetadata =
      (toolCall as { toolMetadata?: unknown }).toolMetadata ??
      (options.tools?.[toolCall.toolName] as { metadata?: unknown } | undefined)?.metadata
    const { risk, idempotent, hints } = toolTraits(toolMetadata)
    // restricted transcript (spec 11 §3.4): built lazily once per call, a fresh copy per read
    let transcriptMemo: GuardTranscriptEntry[] | undefined
    const transcript = (): GuardTranscriptEntry[] => {
      transcriptMemo ??= buildTranscript(options.messages, toolCall.toolCallId)
      return structuredClone(transcriptMemo)
    }
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
        const status = await callHook(deps, 'tool.approve', hook.owner, () =>
          hook.fn(deps.contextOf(hook.owner), {
            toolName: toolCall.toolName,
            toolCallId: toolCall.toolCallId,
            input: toolCall.input,
            ...(toolMetadata === undefined ? {} : { toolMetadata }),
            ...(risk === undefined ? {} : { risk }),
            ...(idempotent === undefined ? {} : { idempotent }),
            ...(hints === undefined ? {} : { hints: structuredClone(hints) }),
            transcript,
          }),
        )
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
    // no `tool.grantScope` hook: no await, so the approval path keeps its microtask timing (chunk
    // order is public API)
    const grantKey =
      grants === undefined
        ? null
        : deps.hooks.list('tool.grantScope').length === 0
          ? toolCall.toolName
          : await grantKeyOf(deps, toolCall.toolName, toolCall.input)
    const grant = grantKey === null ? undefined : grants?.current()?.[grantKey]
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
        ...(idempotent === undefined ? {} : { idempotent }),
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
  deps: Pick<ToolWrapDeps, 'hooks' | 'contextOf' | 'warn' | 'hookTimeoutMs' | 'signal'>,
  decision: ApprovalDecision,
): Promise<void> {
  for (const hook of deps.hooks.list('approval.decided')) {
    try {
      await callHook(deps, 'approval.decided', hook.owner, () =>
        hook.fn(deps.contextOf(hook.owner), structuredClone(decision)),
      )
    } catch (error) {
      hookFailed(deps, 'approval.decided', hook.owner, error)
    }
  }
}
