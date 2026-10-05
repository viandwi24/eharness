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
  HarnessKindTypes,
  HarnessSession,
  MessageAdapter,
  SessionOptions,
  StateAdapter,
} from './session-types.ts'

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
   * Thrash detection (spec 06 §4): when the context is above `summarizeAt` again within
   * `withinSteps` model steps after an automatic compaction, the turn stops with
   * `'context-thrash'` instead of compacting again. Default `{ withinSteps: 2 }`; `false`
   * compacts again (0.3 behaviour).
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

  /** Default: memory adapters. */
  storage?: { messages?: MessageAdapter; state?: StateAdapter }
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
