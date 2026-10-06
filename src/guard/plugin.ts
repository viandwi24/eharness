/**
 * The `approvalGuard()` plugin (spec 15): an LLM judge on the approval chain that can only
 * tighten — it denies (with a reason the model reads) or escalates to a person, never approves.
 *
 * Built only with the public core API (ADR-0008). The judge reads the core's restricted
 * transcript (`tool.approve` event `transcript()`: user messages and tool calls only), so a prompt
 * injection in a tool output cannot reach it. Verdicts are cached in plugin state per session.
 *
 * @see docs/specs/15-guard-plugin.md
 * @see docs/decisions/0030-llm-approval-guard-plugin.md
 */
import {
  generateText,
  type JSONValue,
  type LanguageModel,
  type LanguageModelUsage,
  Output,
  type ToolApprovalStatus,
} from 'ai'
import { z } from 'zod/v4'
import {
  definePlugin,
  type HarnessContext,
  HarnessError,
  type HarnessHooks,
  type HarnessPlugin,
  type SessionContribution,
  type ToolRisk,
} from '../index.ts'
import { renderCall, renderPrompt, renderTranscript, verdictKey } from './prompt.ts'
import {
  fill,
  GUARD_ASK,
  GUARD_BREAKER,
  GUARD_DEFAULT_POLICY,
  GUARD_DENIED,
  GUARD_INSTRUCTIONS,
  GUARD_UNAVAILABLE,
} from './texts.ts'

/** A judge verdict. */
export type GuardVerdict = 'allow' | 'ask' | 'deny'

/** Options of {@link approvalGuard}. */
export interface ApprovalGuardOptions {
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
  /** Transcript view limits: last `maxMessages` entries (default 20), `maxChars` in total (default 12 000). */
  transcript?: { maxMessages?: number; maxChars?: number }
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
   * Verdict cache (per session, in plugin state): `maxEntries` (default 200), `ttlMs` (default: no
   * expiry). A cached `allow` ignores later conversation context (it is keyed by tool, input,
   * policy and judge model only); set a `ttlMs` when context can change what is acceptable.
   */
  cache?: { maxEntries?: number; ttlMs?: number }
}

/** `[key, verdict, reason, at]` — one cached judge verdict. */
type CachedVerdict = [string, GuardVerdict, string, number]
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

const verdictSchema = z.object({
  decision: z.enum(['allow', 'ask', 'deny']),
  reason: z.string(),
})

type ApproveEvent = Parameters<NonNullable<HarnessHooks['tool.approve']>>[1]

function invalid(message: string): HarnessError {
  return new HarnessError('EH_CONFIG_INVALID', `approvalGuard: ${message}`)
}

function positive(name: string, value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || Number.isNaN(value) || value <= 0) {
    throw invalid(`${name} must be a positive number.`)
  }
  return value
}

function isUsage(value: unknown): value is LanguageModelUsage {
  return (
    typeof value === 'object' &&
    value !== null &&
    ('inputTokens' in value || 'outputTokens' in value)
  )
}

function modelId(model: LanguageModel): string {
  if (typeof model === 'string') return model
  const m = model as { provider?: unknown; modelId?: unknown }
  return `${String(m.provider ?? '')}/${String(m.modelId ?? '')}`
}

function errorText(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'TimeoutError') return 'timed out'
    return error.message.length > 200 ? `${error.message.slice(0, 200)}…` : error.message
  }
  return String(error)
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
 *   plugins: [approvalGuard({ model: 'openai/gpt-5-mini', policy: 'Only email @acme.com.' })],
 * })
 * ```
 * @see docs/specs/15-guard-plugin.md
 */
export function approvalGuard(options: ApprovalGuardOptions): HarnessPlugin<'guard'> {
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
  const limits = {
    maxMessages: positive('transcript.maxMessages', options.transcript?.maxMessages, 20),
    maxChars: positive('transcript.maxChars', options.transcript?.maxChars, 12_000),
  }
  const timeoutMs = positive('timeoutMs', options.timeoutMs, 15_000)
  const maxRetries = options.maxRetries ?? 1
  if (!Number.isInteger(maxRetries) || maxRetries < 0) {
    throw invalid('maxRetries must be a non-negative integer.')
  }
  const maxDenials = positive('maxConsecutiveDenials', options.maxConsecutiveDenials, 3)
  const maxEntries = positive('cache.maxEntries', options.cache?.maxEntries, 200)
  const ttlMs =
    options.cache?.ttlMs === undefined ? undefined : positive('cache.ttlMs', options.cache.ttlMs, 0)
  const judgeModel = options.model
  /** Scope of cached verdicts: a changed policy or judge model never reuses an older verdict. */
  const scope = `${policy}\u0000${modelId(judgeModel)}`

  /** Ask the judge. Throws when it is unavailable (error, timeout, unparseable output). */
  async function judge(
    ctx: HarnessContext,
    e: ApproveEvent,
    risk: string,
  ): Promise<{ decision: GuardVerdict; reason: string }> {
    const prompt = renderPrompt({
      policy,
      transcript: renderTranscript(e.transcript(), limits),
      call: renderCall({ toolName: e.toolName, input: e.input, risk }, limits.maxChars),
    })
    const signals = [AbortSignal.timeout(timeoutMs)]
    const turnSignal = ctx.turn?.abortSignal
    if (turnSignal !== undefined) signals.push(turnSignal)
    const charge = (usage: unknown) => {
      if (isUsage(usage)) ctx.turn?.addUsage(usage, { source: 'guard', model: judgeModel })
    }
    try {
      const result = await generateText({
        model: judgeModel,
        instructions: GUARD_INSTRUCTIONS,
        prompt,
        output: Output.object({ schema: verdictSchema }),
        abortSignal: AbortSignal.any(signals),
        maxRetries,
      })
      charge(result.totalUsage)
      const parsed = verdictSchema.safeParse(result.output)
      if (!parsed.success) throw new Error('unparseable verdict')
      return { decision: parsed.data.decision, reason: parsed.data.reason.trim() }
    } catch (error) {
      charge((error as { usage?: unknown } | null)?.usage)
      throw error
    }
  }

  return definePlugin({
    name: 'guard',
    session(ctx): SessionContribution {
      let warnedTurn: string | undefined

      const readVerdicts = (): CachedVerdict[] =>
        (ctx.state.get<JSONValue>(VERDICTS) as CachedVerdict[] | undefined) ?? []
      const readCalls = (): CallRecord[] =>
        (ctx.state.get<JSONValue>(CALLS) as CallRecord[] | undefined) ?? []
      const denials = (): number => ctx.state.get<number>(DENIALS) ?? 0

      const cached = (key: string): CachedVerdict | undefined => {
        const now = Date.now()
        const list = readVerdicts()
        const index = list.findIndex((entry) => entry[0] === key)
        if (index < 0) return undefined
        const entry = list[index] as CachedVerdict
        if (ttlMs !== undefined && now - entry[3] > ttlMs) return undefined
        return entry
      }
      const remember = (key: string, decision: GuardVerdict, reason: string) => {
        const list = readVerdicts().filter((entry) => entry[0] !== key)
        list.push([key, decision, reason, Date.now()])
        while (list.length > maxEntries) list.shift()
        ctx.state.set(VERDICTS, list as unknown as JSONValue)
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
        while (list.length > maxEntries) list.shift()
        ctx.state.set(CALLS, list as unknown as JSONValue)
      }
      const answer = (status: CallRecord[1], reason: string): ToolApprovalStatus =>
        status === 'not-applicable' ? 'not-applicable' : { type: status, reason }

      return {
        hooks: {
          'tool.approve': async (hookCtx, e) => {
            // 1. fast path: no model call, nothing recorded
            if (onlyTools !== undefined && !onlyTools.has(e.toolName)) return 'not-applicable'
            if (skipTools.has(e.toolName)) return 'not-applicable'
            const risk = e.risk ?? 'unknown'
            if (skipRisks.has(risk)) return 'not-applicable'

            // 2. the same call again (AI SDK re-validates approved calls): the same answer. A
            //    reused call id with another tool or input is a different call: judged again.
            const key = await verdictKey(e.toolName, e.input, scope)
            const previous = readCalls().find(
              (entry) => entry[0] === e.toolCallId && entry[3] === e.toolName && entry[4] === key,
            )
            if (previous !== undefined) return answer(previous[1], previous[2])

            // 3. verdict: cache, else the judge (unavailable → a person decides)
            let verdict: { decision: GuardVerdict; reason: string }
            const hit = cached(key)
            if (hit !== undefined) {
              verdict = { decision: hit[1], reason: hit[2] }
            } else {
              try {
                verdict = await judge(hookCtx, e, risk)
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
              remember(key, verdict.decision, verdict.reason)
            }

            // 4. status, with the circuit breaker on consecutive denials
            const reason = verdict.reason === '' ? 'no reason given.' : verdict.reason
            let status: CallRecord[1]
            let text: string
            if (verdict.decision === 'allow') {
              ctx.state.set(DENIALS, undefined)
              status = 'not-applicable'
              text = ''
            } else if (verdict.decision === 'ask') {
              status = 'user-approval'
              text = fill(GUARD_ASK, { reason })
            } else if (denials() >= maxDenials) {
              status = 'user-approval'
              text = fill(GUARD_BREAKER, { count: denials(), reason })
            } else {
              ctx.state.set(DENIALS, denials() + 1)
              status = 'denied'
              text = fill(GUARD_DENIED, { reason })
            }
            record(e.toolCallId, status, text, e.toolName, key)
            return answer(status, text)
          },
          'approval.decided': (_ctx, decision) => {
            // a person answered: the breaker starts over
            if (decision.by === 'user' && denials() > 0) ctx.state.set(DENIALS, undefined)
          },
        },
      }
    },
  })
}
