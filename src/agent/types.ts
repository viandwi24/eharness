/**
 * Agent configuration and the `HarnessAgent` value.
 *
 * @see docs/specs/01-agent-and-plugins.md#1-defineharnessagent
 */
import type {
  FlexibleSchema,
  InferUITools,
  LanguageModel,
  LanguageModelCallOptions,
  RequestOptions,
  TelemetryOptions,
  TimeoutConfiguration,
  Tool,
  ToolApprovalConfiguration,
  ToolApprovalStatus,
  ToolCallRepairFunction,
  ToolResultPart,
  ToolSet,
  UIMessage,
  UITools,
} from 'ai'
import type { HarnessWarning } from '../errors.ts'
import type { ProviderOptions } from '../internal/ai-types.ts'
import type {
  HarnessDataTypes,
  HarnessMetadata,
  HarnessUIMessage,
  ToolRisk,
} from '../messages/types.ts'
import type { ModelCatalog } from '../models/types.ts'
import type {
  DataPartMap,
  HarnessContext,
  HarnessLogger,
  HarnessPlugin,
  InferDataTypes,
  KindMap,
  NamespacedDataTypes,
} from '../plugin/types.ts'
import type {
  InstructionInput,
  Skill,
  SkillSource,
  ToolInput,
  ToolSource,
  ToolsInput,
} from '../registry/types.ts'
import type {
  CollectOptions,
  DeadInboxItem,
  HarnessKindTypes,
  HarnessSession,
  InboxAdapter,
  MessageAdapter,
  SessionOptions,
  StateAdapter,
} from './session-types.ts'

/**
 * Backoff between failed attempts of an inbox item (`inbox.retry.backoff`): `fixed` waits
 * `delayMs`, `exponential` (default) `delayMs × 2^(attempts − 1)`, both capped at `maxDelayMs`;
 * `jitter` (default true) draws the wait uniformly from `[0, delay]` (full jitter).
 *
 * @see docs/specs/05-session-and-storage.md#12-inbox
 */
export interface InboxBackoffOptions {
  /** Default `'exponential'`. */
  type?: 'fixed' | 'exponential'
  /** Default 1 000. */
  delayMs?: number
  /** Default 60 000. */
  maxDelayMs?: number
  /** Default true. */
  jitter?: boolean
}

/**
 * Poison-item limits of the durable inbox (`inbox.retry`, spec 05 §12 rules 11–13). Without it
 * an item is redelivered without limit (0.4).
 *
 * @see docs/specs/05-session-and-storage.md#12-inbox
 */
export interface InboxRetryOptions {
  /** Counted claims after which an item is dead-lettered. Default: unlimited. */
  maxAttempts?: number
  backoff?: InboxBackoffOptions
  /** Failures that go dead at once (reason `'non-retryable'`). Default: `code === 'EH_INVALID_INPUT'`. */
  nonRetryable?: (error: { code?: string; message: string }) => boolean
}

/**
 * Loop limits and persistence.
 *
 * @see docs/specs/01-agent-and-plugins.md#1-defineharnessagent
 */
export interface LoopConfig {
  /** Default 500 — per turn (stop `'max-steps'`; extensible by `turn.beforeEnd`). */
  maxSteps?: number
  /**
   * Default true — when the step budget runs out, run one more step without tools that asks the
   * model to summarize what it did and what is left (the stop stays `'max-steps'`).
   */
  wrapUp?: boolean
  /** Default none — output-token cap incl. nested usage (stop `'cost-cap'`). */
  maxTurnOutputTokens?: number
  /** Default none — wall clock per turn (stop `'timeout'`). */
  turnTimeoutMs?: number
  /** Default none — absolute cap on forced continuations per turn via `turn.beforeEnd`. */
  maxContinues?: number
  /**
   * Default 3 — continuations in a row after which the turn made no progress (no new successful
   * tool result) before further continuations are refused (`W_CONTINUE_LIMIT`).
   */
  maxIdleContinues?: number
  /** Stuck detection (spec 05 §3.2). `false` disables it. */
  progress?: ProgressConfig | false
  /** Default true — upsert the assistant message after every step. */
  persistEachStep?: boolean
}

/**
 * Spending limits in USD, computed from `models` pricing (estimates, spec 12 §4). Exceeding one
 * stops the turn with `'cost-cap'` after the step that crossed it.
 *
 * @see docs/specs/12-models-and-cost.md#4-budgets
 */
export interface BudgetConfig {
  /** USD per turn, incl. `ctx.turn.addUsage()` contributions. */
  maxTurnUsd?: number
  /** USD per session: all turns so far (`state.core.usage.costUsd`) plus the running turn. */
  maxSessionUsd?: number
  /** Default 0.8 — `W_BUDGET` once per turn and budget when spending reaches this share. */
  warnAt?: number
  /**
   * Cross-session limits (per user, tenant, month — whatever the app defines) enforced through a
   * {@link BudgetLedger}: every model call reserves an estimate first and commits the actual cost
   * after the step; a refused reservation stops the turn with `'cost-cap'` before the call.
   *
   * @see docs/specs/12-models-and-cost.md#41-budget-ledger-normative
   */
  ledger?: BudgetLedgerConfig
}

/**
 * `budget.ledger` (spec 12 §4.1). Scopes, periods, prices and limits are app policy: the core
 * treats scope strings as opaque and never interprets them.
 *
 * @see docs/specs/12-models-and-cost.md#41-budget-ledger-normative
 */
export interface BudgetLedgerConfig {
  adapter: BudgetLedger
  /**
   * The app-defined scopes of a turn, e.g. `[`user:${id}`, `tenant:${t}`]`; resolved once per
   * turn (before its first model call). An empty list leaves the turn unlimited by the ledger.
   */
  scopes: (ctx: HarnessContext) => string[] | Promise<string[]>
  /**
   * USD reserved before a model call. Default {@link estimateStepCostUsd}: context tokens × input
   * price + `maxOutputTokens` (default 4 096) × output price; 0 for an unpriced model.
   */
  estimate?: (e: BudgetEstimateEvent) => number
  /** Expiry of a reservation whose process died. Default `loop.turnTimeoutMs`, else 600 000. */
  reservationTtlMs?: number
  /**
   * A ledger call before a model call failed (or `scopes` threw). Default `'stop'` (fail closed):
   * the turn stops with `'error'` (`EH_STORAGE`, `details.operation: 'budget-ledger'`).
   * `'continue'`: `W_BUDGET_LEDGER_FAILED`, and the step runs unreserved.
   */
  onError?: 'stop' | 'continue'
}

/** Input of `budget.ledger.estimate`. */
export interface BudgetEstimateEvent {
  ctx: HarnessContext
  /** The step's model (after `step.prepare`). */
  model: LanguageModel
  /** Estimated input tokens of the request (instructions, tools, messages; calibrated). */
  contextTokens: number
  /** `settings.maxOutputTokens` of the step, else 4 096. */
  maxOutputTokens: number
}

/** Result of {@link BudgetLedger.reserve}. */
export type BudgetReservation =
  | { ok: true; reservationId: string }
  | {
      ok: false
      /** The first scope (in request order) that cannot take the amount. */
      scope: string
      limitUsd: number
      /** Spent plus reserved on that scope. */
      spentUsd: number
    }

/** One scope of {@link BudgetLedger.check}. */
export interface BudgetScopeStatus {
  scope: string
  /** Absent: the scope has no limit. */
  limitUsd?: number
  spentUsd: number
  /** Open (unexpired) reservations. */
  reservedUsd: number
}

/**
 * Cross-session spending ledger (spec 12 §4.1): the app's store of spent and reserved USD per
 * scope. Implementations must make `reserve` atomic over all scopes (all or nothing) and safe
 * under concurrent callers in many processes. eharness ships `memoryBudgetLedger()`
 * (`eharness/storage/memory`) and `budgetLedgerConformance` (`eharness/testing`).
 *
 * @see docs/specs/12-models-and-cost.md#41-budget-ledger-normative
 */
export interface BudgetLedger {
  /**
   * Atomically reserve `amountUsd` on every scope, or nothing. A scope with a limit takes it when
   * it is not used up (spent + reserved < limit) and spent + reserved + amount ≤ limit; a scope
   * without a limit always does. `key` (`${sessionId}:${turnId}:${stepIndex}` from the core) makes
   * a retried call return the open reservation of that key instead of reserving twice. The
   * reservation expires after `ttlMs` (its amount stops counting).
   */
  reserve(req: {
    scopes: string[]
    amountUsd: number
    ttlMs: number
    key: string
  }): Promise<BudgetReservation>
  /**
   * Replace a reservation by the actual cost (higher or lower). Idempotent per reservation; an
   * expired reservation still charges `actualUsd`; unknown or released ids are ignored.
   */
  commit(reservationId: string, actualUsd: number): Promise<void>
  /** Drop a reservation without cost (the model call did not happen). Idempotent. */
  release(reservationId: string): Promise<void>
  /** Record cost without a reservation (nested usage, summarizer). Idempotent per `key`. */
  record(req: { scopes: string[]; amountUsd: number; key: string }): Promise<void>
  /**
   * Read-only status of `scopes` (for a UI or a pre-turn check): `ok` is false when a scope with
   * a limit is used up (spent + reserved ≥ limit).
   */
  check(scopes: string[]): Promise<{ ok: boolean; scopes: BudgetScopeStatus[] }>
}

/**
 * Progress guard: a turn that repeats the same call with the same result, or whose tool calls keep
 * failing, gets one reminder and then stops with `'stuck'`.
 *
 * @see docs/specs/05-session-and-storage.md#32-progress-guard-normative
 */
export interface ProgressConfig {
  /** Default 3 — the same call with the same result this many times within `window` steps. */
  repeats?: number
  /** Default 20 — steps (that called tools) examined for repeats. */
  window?: number
  /** Default 5 — steps in a row whose tool calls all failed. */
  errorStreak?: number
  /** Default 1 — reminders before the turn stops with `'stuck'`. 0 stops at once. */
  nudges?: number
  /** Tools that may legitimately repeat (polling, waiting); ignored by the guard. */
  ignoreTools?: string[]
}

/**
 * Model settings passed to every `streamText` call.
 *
 * @see docs/specs/01-agent-and-plugins.md#1-defineharnessagent
 */
export type ModelSettings = Pick<
  LanguageModelCallOptions,
  | 'maxOutputTokens'
  | 'temperature'
  | 'topP'
  | 'topK'
  | 'presencePenalty'
  | 'frequencyPenalty'
  | 'stopSequences'
  | 'seed'
  | 'reasoning'
> &
  Pick<RequestOptions, 'maxRetries'> & {
    headers?: Record<string, string>
    providerOptions?: ProviderOptions
    /** Per step. A number means `stepMs`. `totalMs` is rejected — use `loop.turnTimeoutMs`. */
    timeout?: number | Omit<Exclude<TimeoutConfiguration<ToolSet>, number>, 'totalMs'>
    /** Retries of a step after streaming started (AI SDK `streamRetries`). */
    streamRetries?: number
  }

/**
 * Human-in-the-loop tool approval.
 *
 * @see docs/specs/11-interaction.md#3-tool-approval
 */
export interface ApprovalConfig {
  /** Static policy; same shape as AI SDK `ToolApprovalConfiguration`. */
  policy?: ToolApprovalConfiguration<ToolSet, unknown>
  /**
   * Status per tool risk (spec 11 §3.2); `unknown` applies to tools without a risk. Combined with
   * the policy and hooks, most restrictive wins.
   *
   * @example { destructive: 'user-approval', unknown: 'user-approval' }
   */
  risk?: Partial<Record<ToolRisk | 'unknown', ToolApprovalStatus>>
  /** Passed as `experimental_toolApprovalSecret`: HMAC-signs requests. */
  secret?: string
  /** What `send()`/`regenerate()`/`edit()` do while approvals are pending. Default `'deny'`. */
  onNewInput?: 'deny' | 'reject'
}

/**
 * Prompt caching configuration.
 *
 * @see docs/specs/02-context-registry.md#61-cache-configuration
 */
export interface CacheConfig {
  mode?: 'auto' | 'breakpoints'
  ttl?: '5m' | '1h'
}

/**
 * File parts of user input (spec 05 §3 step 7). A URL outside `protocols` or a `data:` URL over
 * `maxBytes` is `EH_INVALID_INPUT`.
 *
 * @see docs/specs/05-session-and-storage.md#3-turn-lifecycle-normative-order
 */
export interface InputFilesConfig {
  /** Allowed URL protocols (lowercase, with the colon). Default `['data:', 'https:']`. */
  protocols?: string[]
  /** Maximum decoded size of a `data:` URL in bytes. Default 20 MB (20 971 520). */
  maxBytes?: number
}

/** Maps a thrown tool error to its text (`config.toolErrorText`). */
export type ToolErrorTextFn = (
  error: unknown,
  call: { toolName: string; toolCallId: string },
) => string

/**
 * Tool result size limits.
 *
 * @see docs/specs/09-tools-and-mcp.md
 */
export interface ToolOutputConfig {
  /** Default 50_000 per result. */
  maxChars?: number
  perTool?: Record<string, number | false>
  /** Default `'truncate'`. */
  strategy?: 'truncate' | 'evict'
}

/**
 * Compaction configuration.
 *
 * @see docs/specs/06-compaction.md#1-configuration
 */
export interface CompactionConfig {
  /** Summarize when projected context exceeds this ratio of `contextWindow`. Default 0.75. */
  summarizeAt?: number
  /** Most recent completed turns kept verbatim. Default 4. */
  keepLast?: number
  /** Summarizer model. Default: agent model. */
  model?: LanguageModel
  /** Summarizer context window. */
  contextWindow?: number
  /** Replace the default summarizer instructions. */
  prompt?: string
  /** Max tokens for the summary. Default 4_000. */
  maxSummaryTokens?: number
  /** Token counter. Default `ceil(chars / 4)`, calibrated by provider usage. */
  countTokens?: (text: string) => number
  /** Escape hatch: final say over the assembled view, before the guard. */
  select?: (view: HarnessUIMessage[], ctx: HarnessContext) => HarnessUIMessage[]
  /**
   * View-only pruning of old, large tool outputs before summarizing (spec 06 §5.0). Default off
   * (`undefined` or `false`); `{}` turns it on with the defaults. Stored messages never change.
   */
  prune?: PruneConfig | false
  /**
   * Thrash detection (spec 06 §4): when a second automatic (mid-turn or overflow) compaction
   * within `withinSteps` model steps of the previous one ran (or was skipped as no-gain) and the
   * context is still above `summarizeAt` afterwards, the turn stops with `'context-thrash'`.
   * Pre-turn compactions do not start the window. Default `{ withinSteps: 2 }`; `false`
   * keeps going (0.3 behaviour).
   */
  thrash?: { withinSteps?: number } | false
}

/**
 * Options of `compaction.prune` (spec 06 §5.0): old tool outputs are replaced by a short
 * placeholder in the request only. Errors and `execution-denied` results are never pruned; the
 * current turn is never pruned.
 *
 * @see docs/specs/06-compaction.md#50-prune
 */
export interface PruneConfig {
  /** Completed turns (newest first) whose tool outputs are never pruned. Default 2. */
  keepTurns?: number
  /** Only outputs whose projected size exceeds this many characters are pruned. Default 2_000. */
  minChars?: number
  /** Final tool names whose outputs are never pruned. */
  exclude?: string[]
  /**
   * Placeholder text (must be pure: same part → same text). Default `TOOL_OUTPUT_PRUNED`
   * (`[output of <tool> pruned: <n> chars]`). The text is used as a `{ type: 'text' }` output.
   */
  replaceWith?: (part: ToolResultPart) => string
}

/**
 * Configuration of `defineHarnessAgent`.
 *
 * @see docs/specs/01-agent-and-plugins.md#1-defineharnessagent
 */
export interface HarnessAgentConfig<DP extends DataPartMap = DataPartMap> {
  /** Stable id used in logs/telemetry. Default `'agent'`. */
  id?: string
  /** Default model: gateway string or provider instance. */
  model: LanguageModel
  /** Context window in tokens (or a function of the model). Default 128_000. */
  contextWindow?: number | ((model: LanguageModel) => number | undefined)
  /**
   * Limits and prices of the models in use (spec 12): a record keyed by model id or a function.
   * Supplies the context window when `contextWindow` does not, and prices for cost and budgets.
   */
  models?: ModelCatalog
  /** USD spending limits (spec 12 §4). Needs `models` with pricing. */
  budget?: BudgetConfig

  instructions?: InstructionInput | InstructionInput[]
  /** Tool functions get the app context: `ctx.stream.data` is typed with `dataParts`. */
  tools?: ToolsInput<DP>
  skills?: Array<Skill | SkillSource>
  mcp?: ToolSource[]
  /** App data parts (no namespace): part type `data-<key>`. */
  dataParts?: DP
  /** App message kinds (no namespace). */
  messageKinds?: KindMap
  plugins?: readonly HarnessPlugin<string, DataPartMap, KindMap>[]

  /** Default: memory adapters; no inbox (spec 05 §12). */
  storage?: { messages?: MessageAdapter; state?: StateAdapter; inbox?: InboxAdapter }
  /**
   * Durable inbox behaviour (spec 05 §12): `pollMs` (default 2 000; `0` = no polling) is how often
   * a live session claims inbox items when no notification arrived, `claimTtlMs` (default
   * `recovery.staleMs`) how long a claim hides an item, `collect` the default debounce of
   * `collect` inputs (also used without an inbox). `retry` limits poison items (default: none,
   * unlimited redelivery as in 0.4) and `onDeadLetter` reports items that went dead (spec 05 §12
   * rules 11–15; a throwing callback is `W_HOOK_FAILED`).
   */
  inbox?: {
    pollMs?: number
    claimTtlMs?: number
    collect?: CollectOptions
    retry?: InboxRetryOptions
    onDeadLetter?: (item: DeadInboxItem) => void | Promise<void>
  }
  compaction?: CompactionConfig | false
  guard?: { maxContextRatio?: number; reserveTokens?: number }
  /** Extra overflow detection for providers the built-in patterns miss. */
  isContextOverflow?: (error: unknown) => boolean
  loop?: LoopConfig
  /** Passed to every `streamText` call. */
  settings?: ModelSettings
  approval?: ApprovalConfig
  /** Prompt caching. Default `'auto'` mode. */
  cache?: CacheConfig | false
  toolOutput?: ToolOutputConfig
  /**
   * The text a tool's thrown error becomes — in the UI stream, in storage and on the model wire
   * (identical everywhere). Default `String(error)`, which may carry secrets (connection strings,
   * tokens) to clients and the model; map them to something safe here. Expected failures should be
   * returned as `ERROR:` strings instead of thrown (spec 10 §1.1).
   */
  toolErrorText?: ToolErrorTextFn
  /** File parts of user input: allowed URL protocols and the data URL size cap (spec 05 §3). */
  inputFiles?: InputFilesConfig
  /** Typed per-call options accepted by `send()`/`respond()`/… (`options`). */
  callOptions?: FlexibleSchema
  /** Passed to `streamText` `repairToolCall`. */
  repairToolCall?: ToolCallRepairFunction<ToolSet>
  /**
   * Crash recovery of turns interrupted by a dead process, and cross-process abort (spec 05 §9).
   * Default `{ staleMs: 120_000, abortPollMs: 2_000 }`. `abortPollMs`: how often a running turn
   * reads the state for an abort request of another instance (`0` = never; needs
   * `StateAdapter.setIf`).
   */
  recovery?: { staleMs?: number; abortPollMs?: number } | false
  telemetry?: TelemetryOptions
  /** Throw `EH_CONFIG_INVALID` instead of warning on API misuse. Default false. */
  strict?: boolean
  logger?: HarnessLogger
  /** Called for every warning. Default: `console.warn`, deduplicated per code + key. */
  onWarning?: (w: HarnessWarning) => void
  /** Id generator for messages/turns. Must produce time-sortable ids. Default: `uuidv7`. */
  generateId?: () => string
  /** Max skills listed in the prompt index before switching to search mode. Default 50. */
  skillsIndexLimit?: number
  /** Evict idle cached sessions after this many ms. Default 30 min. 0 = never. */
  sessionIdleMs?: number
}

type UnionToIntersection<U> = (U extends unknown ? (arg: U) => void : never) extends (
  arg: infer I,
) => void
  ? I
  : never

type Simplify<T> = { [K in keyof T]: T[K] } & {}

type PluginsOf<C> = C extends { plugins: readonly (infer P)[] } ? P : never

type PluginDataTypes<P> = UnionToIntersection<
  P extends HarnessPlugin<infer Name, infer DP, infer MK>
    ? NamespacedDataTypes<Name, DP> & NamespacedDataTypes<Name, MK>
    : never
>

type PluginKindTypes<P> = UnionToIntersection<
  P extends HarnessPlugin<infer Name, DataPartMap, infer MK> ? NamespacedDataTypes<Name, MK> : never
>

type OrEmpty<T> = [T] extends [never] ? Record<never, never> : T

type AppPartTypes<C> = C extends { dataParts: infer DP } ? InferDataTypes<DP> : Record<never, never>
type AppKindTypes<C> = C extends { messageKinds: infer MK }
  ? InferDataTypes<MK>
  : Record<never, never>

/**
 * All data part payload types of an agent config: core + app parts/kinds + namespaced plugin
 * parts/kinds (keys without the `data-` prefix).
 */
export type AgentDataTypes<C> = Simplify<
  HarnessDataTypes & AppPartTypes<C> & AppKindTypes<C> & OrEmpty<PluginDataTypes<PluginsOf<C>>>
>

/** All message kind payload types of an agent config: core + app + namespaced plugin kinds. */
export type AgentKindTypes<C> = Simplify<
  HarnessKindTypes & AppKindTypes<C> & OrEmpty<PluginKindTypes<PluginsOf<C>>>
>

type ResolvedTool<T> = T extends (...args: never[]) => infer R ? R : T

type ToolRecordOf<T> = T extends ToolSource
  ? never
  : T extends Record<string, ToolInput>
    ? { [K in keyof T]: ResolvedTool<T[K]> }
    : never

/** Static app tools of an agent config (records in `config.tools`), resolved to `Tool`s. */
export type AgentStaticTools<C> = C extends { tools: infer T }
  ? T extends readonly (infer E)[]
    ? OrEmpty<UnionToIntersection<ToolRecordOf<E>>>
    : OrEmpty<ToolRecordOf<T>>
  : Record<never, never>

type UIToolsOf<Tools> = keyof Tools extends never
  ? UITools
  : Tools extends Record<string, Tool>
    ? InferUITools<Tools>
    : UITools

/**
 * The exact message type of an agent config: core + plugin + app data parts/kinds, and the
 * static app tools' `InferUITools` (any tool when there are none).
 *
 * @see docs/specs/01-agent-and-plugins.md#12-harnessagent
 */
export type AgentMessageOf<C> = UIMessage<
  HarnessMetadata,
  AgentDataTypes<C>,
  UIToolsOf<AgentStaticTools<C>>
>

/**
 * The value returned by `defineHarnessAgent`: configuration + plugins, no live state.
 *
 * @see docs/specs/01-agent-and-plugins.md#12-harnessagent
 */
export interface HarnessAgent<C = HarnessAgentConfig> {
  readonly id: string
  readonly config: Readonly<C>
  /** Get (hot) or create a live session. Does no I/O until first use. */
  session(
    sessionId: string,
    options?: SessionOptions,
  ): HarnessSession<AgentMessageOf<C>, AgentKindTypes<C>>
  /** Close and evict a cached session (runs plugin dispose). */
  closeSession(sessionId: string): Promise<void>
  /** Close all sessions. Call on shutdown. */
  close(): Promise<void>
  /** Type-only brand used by `InferHarnessUIMessage`. Undefined at runtime. */
  readonly '~types': { message: AgentMessageOf<C>; kinds: AgentKindTypes<C> }
}
