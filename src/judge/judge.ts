/**
 * The shared LLM judge engine (ADR-0060): one model call with a structured verdict, one restricted
 * transcript renderer, truncation that fails closed, a verdict cache, a circuit breaker, retries and
 * timeouts. `guard()` (`eharness/guard`, role `tighten`) and `modelClassifier()`
 * (`eharness/permissions`, role `decide`) are thin wrappers over it.
 *
 * @see docs/specs/15-guard-plugin.md
 * @see docs/specs/18-permissions-plugin.md#12-auto-mode-draft
 */
import {
  generateText,
  type LanguageModel,
  type LanguageModelUsage,
  NoObjectGeneratedError,
  Output,
} from 'ai'
import { z } from 'zod/v4'
import { HarnessError } from '../errors.ts'
import { describeModel } from '../internal/model.ts'
import type { GuardTranscriptEntry } from '../registry/transcript.ts'
import {
  callTruncated,
  type JudgeRenderCall,
  judgeKey,
  renderCall,
  renderPrompt,
  renderTranscript,
} from './render.ts'

/**
 * What the judge may do with an `allow`: `tighten` never approves (an allow means "no objection",
 * the rest of the approval chain decides); `decide` approves (an allow replaces asking a person).
 */
export type JudgeRole = 'tighten' | 'decide'

/** The model's opinion of a call. */
export type JudgeVerdict = 'allow' | 'ask' | 'deny'

/**
 * What the caller does: `approve` (role `decide` only), `no-objection` (role `tighten`: nothing to
 * add, the rest of the chain decides), `ask` (a person decides) or `deny`.
 */
export type JudgeOutcome = 'approve' | 'no-objection' | 'ask' | 'deny'

/** `[key, verdict, reason, at]`: one cached verdict (JSON-friendly, so a store can persist it). */
export type JudgeCacheEntry = [string, JudgeVerdict, string, number]

/** Where the engine keeps the verdict cache and the denial counter (per session or in memory). */
export interface JudgeStore {
  verdicts(): JudgeCacheEntry[]
  setVerdicts(entries: JudgeCacheEntry[]): void
  denials(): number
  setDenials(count: number): void
}

/** A call under review. */
export type JudgeCall = JudgeRenderCall

/** The view limits of a judge: two judges can share one model call only when these are equal. */
export interface JudgeLimits {
  maxMessages: number
  maxChars: number
  maxCallChars: number
}

/**
 * A `tighten` judge that can ride along on a `decide` call (see `judgeCoordinator`): what the
 * decide judge needs to ask both questions in one model call.
 */
export interface JudgeParticipant {
  /** The tighten judge's model: a combined call happens only when it is the decide judge's model. */
  readonly model: LanguageModel
  /** The tighten judge's rules. */
  readonly instructions: string
  /** The application policy the tighten judge enforces. */
  readonly policy: string
  /** The tighten judge's view limits (must equal the decide judge's, else two calls). */
  readonly limits: JudgeLimits
  /** False when the tighten side would not review this call at all (its fast path). */
  applies(call: { toolName: string; risk?: string }): boolean
  /** True when the tighten side already has its answer (cache hit, recorded answer): no need to ask. */
  settled(call: { toolCallId: string; toolName: string; input: unknown }): Promise<boolean>
}

/** The tighten half of a combined call: an answer, or why the combined call failed. */
export type JudgeTightenAnswer =
  | { verdict: JudgeVerdict; reason: string; usage?: LanguageModelUsage }
  | { error: string; usage?: LanguageModelUsage }

/** Per-call context. */
export interface JudgeContext {
  /** The restricted transcript (user messages and earlier tool calls), oldest first. */
  transcript?: readonly GuardTranscriptEntry[]
  abortSignal?: AbortSignal
  /** Cache and breaker storage. Default: memory of this engine instance. */
  store?: JudgeStore
  /** Wraps the judge model, e.g. `ctx.observeModel` of a hook context. */
  observeModel?: (model: LanguageModel) => LanguageModel
  /** Receives the usage of every judge call (also of a failed one, when known). */
  onUsage?: (usage: LanguageModelUsage) => void
  /**
   * Role `decide` only: ask the tighten judge's question in the same model call. Ignored (an
   * ordinary one-question call) unless {@link Judge.combinable} says the two can share a call.
   * The answer comes back as {@link JudgeResult.tighten}; the decide answer is unchanged.
   */
  alongside?: JudgeParticipant
  /**
   * Role `tighten` only: the verdict a combined call already produced. The engine skips the model
   * and treats it as the model's answer (cache, breaker and outcome work as usual).
   */
  precomputed?: { verdict: JudgeVerdict; reason: string }
}

/** Options of {@link createJudge}. */
export interface JudgeOptions {
  /** The judge: a cheap, fast model. */
  model: LanguageModel
  role: JudgeRole
  /** The rules, sent as `instructions` (never mixed with the transcript). */
  instructions: string
  /** Application policy, framed as `<policy>` in the prompt (trusted text). */
  policy?: string
  /** What is trusted in this deployment, framed as `<environment>` in the prompt (trusted text). */
  environment?: string
  /** Transcript view: last `maxMessages` entries (default 20), `maxChars` in total (default 12 000). */
  transcript?: { maxMessages?: number; maxChars?: number }
  /**
   * Longest call input (canonical JSON) reviewed in full; a longer one is never judged and asks a
   * person. Independent of `transcript.maxChars`, which bounds the transcript view only. Default
   * {@link DEFAULT_JUDGE_MAX_CALL_CHARS}. `guard()` and `modelClassifier()` expose it under the same
   * name with the same default.
   */
  maxCallChars?: number
  /** Longest `summary` reviewed in full. Default 2000. */
  maxSummaryChars?: number
  /** Judge timeout in ms. Default 15 000. */
  timeoutMs?: number
  /** AI SDK retries of the judge call. Default 1. */
  maxRetries?: number
  /** Output token cap of the judge call (a verdict is one short sentence). Default 1024. */
  maxOutputTokens?: number
  /** Sampling temperature. Default 0. */
  temperature?: number
  /**
   * Consecutive denials after which further would-be denials become `ask`. Default 3 for
   * `tighten`, `Infinity` (off) for `decide` (its caller keeps its own pause logic).
   */
  maxConsecutiveDenials?: number
  /**
   * Verdict cache keyed by tool, canonical input hash and rule set: `maxEntries` (default 200),
   * `ttlMs` (default 1 hour; `Infinity` = no expiry). `false` disables it. Default: on for
   * `tighten`, off for `decide` (a cached allow would ignore a later boundary the user stated).
   */
  cache?: false | { maxEntries?: number; ttlMs?: number }
  /** Prefix of configuration errors (default `'judge'`). */
  name?: string
}

/** The engine's answer for one call. */
export interface JudgeResult {
  outcome: JudgeOutcome
  /** The model's opinion (or `ask` when the call was not judged). */
  verdict: JudgeVerdict
  /** The model's reason, trimmed; `''` when it gave none or the call was not judged. */
  reason: string
  /** Cache key of the call (tool + input hash + rule set). */
  key: string
  /** The verdict came from the cache. */
  cached: boolean
  /** The call was longer than the judge reviews in full: not judged, nothing cached (fail closed). */
  truncated: boolean
  /** The circuit breaker turned a would-be denial into `ask`. */
  breaker: boolean
  /** Consecutive denials before this call. */
  denials: number
  /** The review window, for texts (`maxCallChars`). */
  maxCallChars: number
  /** Set when the call was judged together with {@link JudgeContext.alongside}: the tighten answer. */
  tighten?: { verdict: JudgeVerdict; reason: string }
}

/** The shared judge engine. */
export interface Judge {
  readonly role: JudgeRole
  /** The effective view limits. */
  readonly limits: JudgeLimits
  /** True when this decide judge can answer the participant's question in one call (same model, same limits). */
  combinable(participant: JudgeParticipant): boolean
  /** The cached verdict of a call (no model call), when there is a fresh one. */
  cachedVerdict(call: JudgeCall, store?: JudgeStore): Promise<JudgeVerdict | undefined>
  /** Cache key of a call (tool + canonical input hash + rule set). */
  key(call: JudgeCall): Promise<string>
  /** Judge one call. Throws {@link JudgeUnavailableError} when the model gave no usable verdict. */
  judge(call: JudgeCall, ctx?: JudgeContext): Promise<JudgeResult>
  /** Start the circuit breaker over (a person answered). */
  resetBreaker(store?: JudgeStore): void
}

/**
 * Thrown by {@link Judge.judge} when the model gave no verdict: `kind: 'unavailable'` (provider
 * error, timeout, abort) or `'unreadable'` (the answer did not match the verdict schema). Callers
 * fail closed.
 */
export class JudgeUnavailableError extends Error {
  override readonly name = 'JudgeUnavailableError'
  /** The judge failed to run (spec 10 §1.2): a provider-side failure, never a verdict. */
  readonly code = 'EH_PROVIDER' as const
  readonly kind: 'unavailable' | 'unreadable'
  constructor(message: string, kind: 'unavailable' | 'unreadable', options?: { cause?: unknown }) {
    super(message, options)
    this.kind = kind
  }
}

/**
 * Default `maxCallChars` of every judge, `guard()` and `modelClassifier()` included: the longest
 * call input (canonical JSON) a judge reviews in full. 8 000 characters is about 2 000 tokens:
 * enough for ordinary edits, writes and shell commands, small enough that a call cannot crowd out
 * the transcript (default 12 000 characters) or make one verdict expensive and slow. A longer
 * input cannot be reviewed honestly, so it is never judged and asks a person.
 */
export const DEFAULT_JUDGE_MAX_CALL_CHARS = 8_000

const DEFAULT_CACHE_TTL_MS = 3_600_000

const tightenSchema = z.object({
  decision: z.enum(['allow', 'ask', 'deny']),
  reason: z.string(),
})
const decideSchema = z.object({
  decision: z.enum(['allow', 'block']).describe('allow the action, or block it'),
  reason: z.string().describe('one short sentence; for a block, what rule it matches'),
})

const combinedSchema = z.object({
  auto: z.enum(['allow', 'block']).describe('review 1: allow the action, or block it'),
  autoReason: z
    .string()
    .describe('review 1: one short sentence; for a block, what rule it matches'),
  guard: z.enum(['allow', 'ask', 'deny']).describe('review 2: the application policy verdict'),
  guardReason: z.string().describe('review 2: one short sentence the agent can read'),
})

/** Rules of one call that answers two independent reviews (permissions auto mode + guard). */
function combinedInstructions(auto: string, guard: JudgeParticipant): string {
  return `You answer TWO independent reviews of ONE tool call in a single reply. Fill both; never let the answer of one review influence the other.

## Review 1: "auto" (the <environment> block, if any, belongs to this review)
${auto}

Answer this review in the fields "auto" (allow or block) and "autoReason". Where it says to reply allow or block, that is these fields.

## Review 2: "guard" (the <policy> block belongs to this review)
${guard.instructions}

Answer this review in the fields "guard" (allow, ask or deny) and "guardReason". Where it says to answer with a "decision", that is these fields.`
}

/** Models are the same when they are the same instance, or the same gateway string. */
function sameModel(a: LanguageModel, b: LanguageModel): boolean {
  return a === b
}

function isUsage(value: unknown): value is LanguageModelUsage {
  return (
    typeof value === 'object' &&
    value !== null &&
    ('inputTokens' in value || 'outputTokens' in value)
  )
}

function errorText(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'TimeoutError') return 'timed out'
    return error.message.length > 200 ? `${error.message.slice(0, 200)}…` : error.message
  }
  return String(error)
}

/** Memory store of one engine instance (the default). */
function memoryStore(): JudgeStore {
  let verdicts: JudgeCacheEntry[] = []
  let denials = 0
  return {
    verdicts: () => verdicts,
    setVerdicts: (entries) => {
      verdicts = entries
    },
    denials: () => denials,
    setDenials: (count) => {
      denials = count
    },
  }
}

/**
 * Build the shared judge engine.
 *
 * @example
 * ```ts
 * const judge = createJudge({ model, role: 'tighten', instructions: 'You review one tool call…' })
 * const { outcome, reason } = await judge.judge({ toolName: 'send_email', input }, { transcript })
 * ```
 *
 * @experimental Draft: may change in a minor release (docs/engineering/api-stability.md).
 * @see docs/decisions/0060-shared-llm-judge-engine.md
 */
export function createJudge(options: JudgeOptions): Judge {
  const name = options.name ?? 'judge'
  const invalid = (message: string): HarnessError =>
    new HarnessError('EH_CONFIG_INVALID', `${name}: ${message}`)
  const positive = (label: string, value: number | undefined, fallback: number): number => {
    if (value === undefined) return fallback
    if (typeof value !== 'number' || Number.isNaN(value) || value <= 0) {
      throw invalid(`${label} must be a positive number.`)
    }
    return value
  }
  if (typeof options !== 'object' || options === null || options.model === undefined) {
    throw invalid('`model` is required.')
  }
  if (options.role !== 'tighten' && options.role !== 'decide') {
    throw invalid("`role` must be 'tighten' or 'decide'.")
  }
  const role = options.role
  const limits = {
    maxMessages: positive('transcript.maxMessages', options.transcript?.maxMessages, 20),
    maxChars: positive('transcript.maxChars', options.transcript?.maxChars, 12_000),
  }
  const maxCallChars = positive('maxCallChars', options.maxCallChars, DEFAULT_JUDGE_MAX_CALL_CHARS)
  const maxSummaryChars = positive('maxSummaryChars', options.maxSummaryChars, 2000)
  const timeoutMs = positive('timeoutMs', options.timeoutMs, 15_000)
  const maxRetries = options.maxRetries ?? 1
  if (!Number.isInteger(maxRetries) || maxRetries < 0) {
    throw invalid('maxRetries must be a non-negative integer.')
  }
  const maxOutputTokens = positive('maxOutputTokens', options.maxOutputTokens, 1024)
  const temperature = options.temperature ?? 0
  const maxDenials = positive(
    'maxConsecutiveDenials',
    options.maxConsecutiveDenials,
    role === 'tighten' ? 3 : Number.POSITIVE_INFINITY,
  )
  const cacheOption =
    options.cache === undefined ? (role === 'tighten' ? {} : false) : options.cache
  const cache =
    cacheOption === false
      ? undefined
      : {
          maxEntries: positive('cache.maxEntries', cacheOption.maxEntries, 200),
          ttlMs: positive('cache.ttlMs', cacheOption.ttlMs, DEFAULT_CACHE_TTL_MS),
        }
  const model = options.model
  const instructions = options.instructions
  /** Scope of cached verdicts: a changed rule set or judge model never reuses an older verdict. */
  const scope = [
    role,
    instructions,
    options.policy ?? '',
    options.environment ?? '',
    describeModel(model),
  ].join('\u0000')
  const fallbackStore = memoryStore()

  const limitsView: JudgeLimits = { ...limits, maxCallChars }
  const combinable = (participant: JudgeParticipant): boolean =>
    role === 'decide' &&
    sameModel(participant.model, model) &&
    participant.limits.maxMessages === limitsView.maxMessages &&
    participant.limits.maxChars === limitsView.maxChars &&
    participant.limits.maxCallChars === limitsView.maxCallChars

  async function ask(
    call: JudgeCall,
    ctx: JudgeContext,
    partner?: JudgeParticipant,
  ): Promise<{
    verdict: JudgeVerdict
    reason: string
    tighten?: { verdict: JudgeVerdict; reason: string }
  }> {
    // the roles differ in the words the model answers with ('block' for decide), mapped below
    const schema = (
      partner !== undefined ? combinedSchema : role === 'tighten' ? tightenSchema : decideSchema
    ) as typeof tightenSchema
    const prompt = renderPrompt({
      ...(partner !== undefined
        ? { policy: partner.policy }
        : options.policy === undefined
          ? {}
          : { policy: options.policy }),
      ...(options.environment === undefined ? {} : { environment: options.environment }),
      transcript: renderTranscript(ctx.transcript ?? [], limits),
      call: renderCall(call, maxCallChars),
    })
    const signals = [AbortSignal.timeout(timeoutMs)]
    if (ctx.abortSignal !== undefined) signals.push(ctx.abortSignal)
    const charge = (usage: unknown) => {
      if (isUsage(usage)) ctx.onUsage?.(usage)
    }
    let output: unknown
    try {
      const result = await generateText({
        model: ctx.observeModel === undefined ? model : ctx.observeModel(model),
        instructions:
          partner === undefined ? instructions : combinedInstructions(instructions, partner),
        prompt,
        output: Output.object({ schema }),
        abortSignal: AbortSignal.any(signals),
        maxRetries,
        maxOutputTokens,
        temperature,
      })
      charge(result.totalUsage)
      output = result.output
    } catch (error) {
      charge((error as { usage?: unknown } | null)?.usage)
      // an unreadable verdict is the judge's answer; anything else means it did not run
      if (NoObjectGeneratedError.isInstance(error)) {
        throw new JudgeUnavailableError('unreadable verdict', 'unreadable', { cause: error })
      }
      throw new JudgeUnavailableError(errorText(error), 'unavailable', { cause: error })
    }
    const parsed = schema.safeParse(output)
    if (!parsed.success) throw new JudgeUnavailableError('unreadable verdict', 'unreadable')
    if (partner !== undefined) {
      const both = parsed.data as unknown as z.infer<typeof combinedSchema>
      return {
        verdict: both.auto === 'block' ? 'deny' : 'allow',
        reason: both.autoReason.trim(),
        tighten: { verdict: both.guard, reason: both.guardReason.trim() },
      }
    }
    const decision = parsed.data.decision
    return {
      verdict: (decision as string) === 'block' ? 'deny' : decision,
      reason: parsed.data.reason.trim(),
    }
  }

  const key = (call: JudgeCall): Promise<string> => judgeKey(call.toolName, call.input, scope)

  return {
    role,
    limits: limitsView,
    combinable,
    async cachedVerdict(call, store = fallbackStore) {
      if (cache === undefined) return undefined
      const callKey = await key(call)
      return store
        .verdicts()
        .find((entry) => entry[0] === callKey && Date.now() - entry[3] <= cache.ttlMs)?.[1]
    },
    key,
    resetBreaker(store = fallbackStore) {
      if (store.denials() > 0) store.setDenials(0)
    },
    async judge(call, ctx = {}): Promise<JudgeResult> {
      const store = ctx.store ?? fallbackStore
      const callKey = await key(call)
      const base = {
        key: callKey,
        cached: false,
        truncated: false,
        breaker: false,
        denials: store.denials(),
        maxCallChars,
      }
      // a call the judge cannot see in full is never judged (the cut-off tail could hold the
      // harmful part): a person decides, nothing is cached, the breaker is untouched
      if (callTruncated(call, maxCallChars, maxSummaryChars)) {
        return { ...base, outcome: 'ask', verdict: 'ask', reason: '', truncated: true }
      }
      let verdict: JudgeVerdict
      let reason: string
      let cached = false
      let tighten: { verdict: JudgeVerdict; reason: string } | undefined
      const partner =
        ctx.alongside !== undefined && combinable(ctx.alongside) ? ctx.alongside : undefined
      // a combined answer has a second half a cached decide verdict would not carry
      const useCache = cache !== undefined && partner === undefined
      const hit =
        !useCache || cache === undefined
          ? undefined
          : store
              .verdicts()
              .find((entry) => entry[0] === callKey && Date.now() - entry[3] <= cache.ttlMs)
      if (hit !== undefined) {
        verdict = hit[1]
        reason = hit[2]
        cached = true
      } else {
        if (role === 'tighten' && ctx.precomputed !== undefined) {
          ;({ verdict, reason } = ctx.precomputed)
        } else {
          ;({ verdict, reason, tighten } = await ask(call, ctx, partner))
        }
        if (useCache && cache !== undefined) {
          const list = store.verdicts().filter((entry) => entry[0] !== callKey)
          list.push([callKey, verdict, reason, Date.now()])
          while (list.length > cache.maxEntries) list.shift()
          store.setVerdicts(list)
        }
      }
      if (verdict === 'allow') {
        store.setDenials(0)
        return {
          ...base,
          ...(tighten === undefined ? {} : { tighten }),
          cached,
          verdict,
          reason,
          outcome: role === 'decide' ? 'approve' : 'no-objection',
        }
      }
      const extra = tighten === undefined ? {} : { tighten }
      if (verdict === 'ask') return { ...base, ...extra, cached, verdict, reason, outcome: 'ask' }
      if (base.denials >= maxDenials) {
        return { ...base, ...extra, cached, verdict, reason, outcome: 'ask', breaker: true }
      }
      store.setDenials(base.denials + 1)
      return { ...base, ...extra, cached, verdict, reason, outcome: 'deny' }
    },
  }
}
