/**
 * The `guard()` plugin (spec 15): an LLM judge on the approval chain that can only
 * tighten — it denies (with a reason the model reads) or escalates to a person, never approves.
 *
 * A thin wrapper over the shared judge engine (`createJudge`, role `tighten`, ADR-0060), built only
 * with the public core API (ADR-0008). The judge reads the core's restricted
 * transcript (`tool.approve` event `transcript()`: user messages and tool calls only), so a prompt
 * injection in a tool output cannot reach it. Verdicts are cached in plugin state per session.
 *
 * @see docs/specs/15-guard-plugin.md
 * @see docs/decisions/0030-llm-approval-guard-plugin.md
 */
import type { JSONValue, LanguageModel, ToolApprovalStatus } from 'ai'
import {
  createJudge,
  definePlugin,
  errorText,
  HarnessError,
  type HarnessPlugin,
  type JudgeCacheEntry,
  type JudgeStore,
  JudgeUnavailableError,
  judgeCoordinator,
  type SessionContribution,
  type ToolRisk,
} from '../index.ts'
import {
  fill,
  GUARD_ASK,
  GUARD_BREAKER,
  GUARD_DEFAULT_POLICY,
  GUARD_DENIED,
  GUARD_INPUT_TOO_LONG,
  GUARD_INSTRUCTIONS,
  GUARD_UNAVAILABLE,
} from './texts.ts'

/** A judge verdict. */
export type GuardVerdict = 'allow' | 'ask' | 'deny'

/** Options of {@link guard}. */
export interface GuardOptions {
  /** The judge: a cheap, fast model. Its usage is charged to the turn (`addUsage`). */
  model: LanguageModel
  /** The application's policy text for the judge. Default {@link GUARD_DEFAULT_POLICY}. */
  policy?: string
  /** Risks that skip the judge (fast path). Default `['read']`. `'unknown'` = tools without a risk. */
  skipRisks?: Array<ToolRisk | 'unknown'>
  /** Tool names (after prefixing) never reviewed. */
  skipTools?: string[]
  /** When set, only these tool names (after prefixing) are reviewed. */
  onlyTools?: string[]
  /**
   * Transcript view limits: last `maxMessages` entries (default 20), `maxChars` in total (default
   * 12 000). Bounds the transcript only; the call input has its own limit, `maxCallChars`.
   */
  transcript?: { maxMessages?: number; maxChars?: number }
  /**
   * Longest call input (canonical JSON) that is judged; a longer one is never judged and asks a
   * person. Default `DEFAULT_JUDGE_MAX_CALL_CHARS` (8 000), the same as `modelClassifier()`.
   */
  maxCallChars?: number
  /** Judge timeout in ms; a timeout escalates to a person. Default 15 000. */
  timeoutMs?: number
  /** AI SDK retries of the judge call. Default 1. */
  maxRetries?: number
  /**
   * Consecutive judge denials (per session) after which further would-be denials escalate to a
   * person instead. Default 3. `Infinity` disables the breaker.
   */
  maxConsecutiveDenials?: number
  /**
   * Verdict cache (per session, in plugin state): `maxEntries` (default 200), `ttlMs` (default
   * 1 hour; `Infinity` = no expiry). A cached `allow` ignores later conversation context (it is
   * keyed by tool, input, policy and judge model only); lower `ttlMs` when context can change
   * what is acceptable.
   */
  cache?: { maxEntries?: number; ttlMs?: number }
  /**
   * Let permissions auto mode answer this guard's question in its own judge call. When the
   * `permissions` plugin runs in `auto` mode in the same session, with a classifier on the same
   * model instance (or gateway string) and the same view limits (`transcript`, `maxCallChars`),
   * ONE model call judges the action against both the auto rules and this policy, and the guard
   * records its half without calling its model (spec 15 §7). Outcomes are the same as with two
   * calls. Needs `permissions` listed before `guard` (the engine decides first); otherwise, with a
   * different model or limits, or with auto mode paused, the guard judges alone. `false`: always
   * judge alone. Default `true`.
   */
  combineWithAutoMode?: boolean
}

/**
 * `[toolCallId, status, reason, toolName, key]` — the status this plugin returned for a call. The
 * record is reused only when the tool name and the verdict key (tool + input hash) match, so a
 * reused call id with a different call is judged again.
 */
type CallRecord = [string, 'not-applicable' | 'user-approval' | 'denied', string, string, string]

/** State keys (`plugins.guard[...]`). */
const VERDICTS = 'verdicts'
const CALLS = 'calls'
const DENIALS = 'denials'

function invalid(message: string): HarnessError {
  return new HarnessError('EH_CONFIG_INVALID', `guard: ${message}`)
}

/**
 * The approval guard plugin (name `'guard'`, spec 15): reviews tool calls with a second model on
 * the approval chain. Returns `'not-applicable'` (allowed, skipped), `denied` or
 * `user-approval` — never `approved`, so with most-restrictive-wins it can only tighten. Use it
 * with a permissive base policy, e.g. `approval: { risk: { write: 'approved' } }`.
 *
 * @example
 * ```ts
 * defineHarnessAgent({
 *   model,
 *   approval: { risk: { read: 'approved', write: 'approved', external: 'approved' } },
 *   plugins: [guard({ model: 'openai/gpt-5-mini', policy: 'Only email @acme.com.' })],
 * })
 * ```
 * @see docs/specs/15-guard-plugin.md
 */
export function guard(options: GuardOptions): HarnessPlugin<'guard'> {
  if (typeof options !== 'object' || options === null || options.model === undefined) {
    throw invalid('`model` is required.')
  }
  const policy = options.policy ?? GUARD_DEFAULT_POLICY
  if (typeof policy !== 'string' || policy.trim() === '') {
    throw invalid('`policy` must be a non-empty string.')
  }
  const skipRisks = new Set<string>(options.skipRisks ?? ['read'])
  const skipTools = new Set(options.skipTools ?? [])
  const onlyTools = options.onlyTools === undefined ? undefined : new Set(options.onlyTools)
  const maxCallRecords = options.cache?.maxEntries ?? 200
  const judge = createJudge({
    name: 'guard',
    role: 'tighten',
    model: options.model,
    instructions: GUARD_INSTRUCTIONS,
    policy,
    ...(options.transcript === undefined ? {} : { transcript: options.transcript }),
    ...(options.maxCallChars === undefined ? {} : { maxCallChars: options.maxCallChars }),
    timeoutMs: options.timeoutMs ?? 15_000,
    ...(options.maxRetries === undefined ? {} : { maxRetries: options.maxRetries }),
    ...(options.maxConsecutiveDenials === undefined
      ? {}
      : { maxConsecutiveDenials: options.maxConsecutiveDenials }),
    cache: options.cache ?? {},
  })

  return definePlugin({
    name: 'guard',
    session(ctx): SessionContribution {
      let warnedTurn: string | undefined

      const readCalls = (): CallRecord[] =>
        (ctx.state.get<JSONValue>(CALLS) as CallRecord[] | undefined) ?? []
      /** Verdict cache and denial counter of the judge engine, kept in session plugin state. */
      const store: JudgeStore = {
        verdicts: () => (ctx.state.get<JSONValue>(VERDICTS) as JudgeCacheEntry[] | undefined) ?? [],
        setVerdicts: (entries) => ctx.state.set(VERDICTS, entries as unknown as JSONValue),
        denials: () => ctx.state.get<number>(DENIALS) ?? 0,
        setDenials: (count) => ctx.state.set(DENIALS, count === 0 ? undefined : count),
      }
      const record = (
        toolCallId: string,
        status: CallRecord[1],
        reason: string,
        toolName: string,
        key: string,
      ) => {
        const list = readCalls().filter((entry) => entry[0] !== toolCallId)
        list.push([toolCallId, status, reason, toolName, key])
        while (list.length > maxCallRecords) list.shift()
        ctx.state.set(CALLS, list as unknown as JSONValue)
      }
      const answer = (status: CallRecord[1], reason: string): ToolApprovalStatus =>
        status === 'not-applicable' ? 'not-applicable' : { type: status, reason }
      const fastPath = (toolName: string, risk: string): boolean =>
        (onlyTools !== undefined && !onlyTools.has(toolName)) ||
        skipTools.has(toolName) ||
        skipRisks.has(risk)

      // permissions auto mode may judge this guard's policy in its own call (spec 15 §7)
      if (options.combineWithAutoMode !== false) {
        judgeCoordinator(ctx.signal).register({
          model: options.model,
          instructions: GUARD_INSTRUCTIONS,
          policy,
          limits: judge.limits,
          applies: (call) => !fastPath(call.toolName, call.risk ?? 'unknown'),
          settled: async (call) => {
            const key = await judge.key(call)
            if (
              readCalls().some(
                (entry) =>
                  entry[0] === call.toolCallId && entry[3] === call.toolName && entry[4] === key,
              )
            ) {
              return true
            }
            return (await judge.cachedVerdict(call, store)) !== undefined
          },
        })
      }

      return {
        hooks: {
          'tool.approve': async (hookCtx, e) => {
            // 1. fast path: no model call, nothing recorded
            const risk = e.risk ?? 'unknown'
            if (fastPath(e.toolName, risk)) return 'not-applicable'

            // 2. the same call again (AI SDK re-validates approved calls): the same answer. A
            //    reused call id with another tool or input is a different call: judged again.
            const call = { toolName: e.toolName, input: e.input, risk }
            const key = await judge.key(call)
            const previous = readCalls().find(
              (entry) => entry[0] === e.toolCallId && entry[3] === e.toolName && entry[4] === key,
            )
            if (previous !== undefined) return answer(previous[1], previous[2])

            // 3. the shared engine: cache, else the model (unavailable → a person decides)
            //    A combined call of permissions auto mode (same session, same call) already holds
            //    this guard's half: no second model call (its usage is charged here).
            const combined =
              options.combineWithAutoMode === false
                ? undefined
                : await judgeCoordinator(hookCtx.signal).take({
                    toolCallId: e.toolCallId,
                    toolName: e.toolName,
                    input: e.input,
                  })
            if (combined?.usage !== undefined) {
              hookCtx.turn?.addUsage(combined.usage, { source: 'guard', model: options.model })
            }
            let result: Awaited<ReturnType<typeof judge.judge>>
            try {
              if (combined !== undefined && 'error' in combined) {
                throw new JudgeUnavailableError(combined.error, 'unavailable')
              }
              result = await judge.judge(call, {
                ...(combined === undefined
                  ? {}
                  : { precomputed: { verdict: combined.verdict, reason: combined.reason } }),
                transcript: e.transcript(),
                store,
                observeModel: (m) => hookCtx.observeModel(m),
                onUsage: (usage) =>
                  hookCtx.turn?.addUsage(usage, { source: 'guard', model: options.model }),
                ...(hookCtx.turn?.abortSignal === undefined
                  ? {}
                  : { abortSignal: hookCtx.turn.abortSignal }),
              })
            } catch (error) {
              const text = errorText(error)
              const turnId = hookCtx.turn?.id
              if (turnId === undefined || warnedTurn !== turnId) {
                warnedTurn = turnId
                hookCtx.warn({
                  code: 'W_GUARD_UNAVAILABLE',
                  message: `The approval guard could not review '${e.toolName}' (${text}); the call needs a person.`,
                  details: { tool: e.toolName, toolCallId: e.toolCallId, error: text },
                })
              }
              const reason = fill(GUARD_UNAVAILABLE, { error: text })
              record(e.toolCallId, 'user-approval', reason, e.toolName, key)
              return answer('user-approval', reason)
            }

            // 4. status from the outcome (the engine applied the circuit breaker)
            const why = result.reason === '' ? 'no reason given.' : result.reason
            let status: CallRecord[1]
            let text: string
            if (result.truncated) {
              status = 'user-approval'
              text = fill(GUARD_ASK, {
                reason: fill(GUARD_INPUT_TOO_LONG, { max: result.maxCallChars }),
              })
            } else if (result.outcome === 'no-objection' || result.outcome === 'approve') {
              status = 'not-applicable'
              text = ''
            } else if (result.outcome === 'ask') {
              status = 'user-approval'
              text = result.breaker
                ? fill(GUARD_BREAKER, { count: result.denials, reason: why })
                : fill(GUARD_ASK, { reason: why })
            } else {
              status = 'denied'
              text = fill(GUARD_DENIED, { reason: why })
            }
            record(e.toolCallId, status, text, e.toolName, key)
            return answer(status, text)
          },
          'approval.decided': (_ctx, decision) => {
            // a person answered: the breaker starts over
            if (decision.by === 'user') judge.resetBreaker(store)
          },
        },
      }
    },
  })
}
