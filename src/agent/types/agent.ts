/**
 * Agent configuration and the `HarnessAgent` value.
 *
 * @see docs/specs/01-agent-and-plugins.md#1-defineharnessagent
 */
import type {
  FlexibleSchema,
  InferUITools,
  LanguageModel,
  TelemetryOptions,
  Tool,
  ToolCallRepairFunction,
  ToolSet,
  UIMessage,
  UITools,
} from 'ai'
import type { HarnessWarning } from '../../errors.ts'
import type { HarnessDataTypes, HarnessMetadata } from '../../messages/types.ts'
import type { ModelCatalog } from '../../models/types.ts'
import type {
  DataPartMap,
  HarnessLogger,
  HarnessPlugin,
  InferDataTypes,
  KindMap,
  NamespacedDataTypes,
} from '../../plugin/types.ts'
import type {
  InstructionInput,
  Skill,
  SkillSource,
  ToolInput,
  ToolSource,
  ToolsInput,
} from '../../registry/types.ts'
import type {
  CollectOptions,
  DeadInboxItem,
  HarnessKindTypes,
  HarnessSession,
  InboxAdapter,
  MessageAdapter,
  SessionOptions,
  SessionPeek,
  StateAdapter,
  StreamLogAdapter,
} from '../session-types.ts'
import type { BudgetConfig } from './budget.ts'
import type { ObserveEvent } from './observe.ts'
import type {
  ApprovalConfig,
  CacheConfig,
  CompactionConfig,
  HooksConfig,
  InboxRetryOptions,
  InputFilesConfig,
  LoopConfig,
  ModelSettings,
  ToolCallsConfig,
  ToolErrorTextFn,
  ToolOutputConfig,
  ToolSourcesConfig,
} from './options.ts'

type ToolRecordOf<T> = T extends ToolSource
  ? never
  : T extends Record<string, ToolInput>
    ? { [K in keyof T]: ResolvedTool<T[K]> }
    : never

type UnionToIntersection<U> = (U extends unknown ? (arg: U) => void : never) extends (
  arg: infer I,
) => void
  ? I
  : never

type ResolvedTool<T> = T extends (...args: never[]) => infer R ? R : T

type PluginDataTypes<P> = UnionToIntersection<
  P extends HarnessPlugin<infer Name, infer DP, infer MK>
    ? NamespacedDataTypes<Name, DP> & NamespacedDataTypes<Name, MK>
    : never
>

type AppPartTypes<C> = C extends { dataParts: infer DP } ? InferDataTypes<DP> : Record<never, never>
type AppKindTypes<C> = C extends { messageKinds: infer MK }
  ? InferDataTypes<MK>
  : Record<never, never>

type UIToolsOf<Tools> = keyof Tools extends never
  ? UITools
  : Tools extends Record<string, Tool>
    ? InferUITools<Tools>
    : UITools

type OrEmpty<T> = [T] extends [never] ? Record<never, never> : T

type PluginKindTypes<P> = UnionToIntersection<
  P extends HarnessPlugin<infer Name, DataPartMap, infer MK> ? NamespacedDataTypes<Name, MK> : never
>

type Simplify<T> = { [K in keyof T]: T[K] } & {}

type PluginsOf<C> = C extends { plugins: readonly (infer P)[] } ? P : never

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
  /**
   * Final tool names listed first in this order; every other tool follows in the default order
   * (static → skill → source → `tool_search` → request tools, spec 02 §6). Unknown names are
   * ignored and reported once per session (`W_TOOL_ORDER`). Keep it stable across turns: a
   * changed order busts the prompt cache.
   */
  toolOrder?: string[]
  /**
   * Names of tools to hide until found with `tool_search` (sets `deferLoading: true` on them,
   * spec 02 §3.3). Applies to app, plugin and source tools; names that match no tool are ignored.
   * The core lists the deferred tools by name in the turn reminder so the model knows they exist.
   */
  deferTools?: string[]
  skills?: Array<Skill | SkillSource>
  mcp?: ToolSource[]
  /** App data parts (no namespace): part type `data-<key>`. */
  dataParts?: DP
  /** App message kinds (no namespace). */
  messageKinds?: KindMap
  plugins?: readonly HarnessPlugin<string, DataPartMap, KindMap>[]

  /** Default: memory adapters; no inbox (spec 05 §12). */
  storage?: {
    messages?: MessageAdapter
    state?: StateAdapter
    inbox?: InboxAdapter
    /** Stream log for cross-process resume (spec 04 §6.2); default none. */
    streams?: StreamLogAdapter
  }
  /**
   * Stream log behaviour (spec 04 §6.2, needs `storage.streams`): `flushMs` (default 100) and
   * `batchSize` (default 64 chunks) bound how long chunks wait for an append, `retentionMs`
   * (default 600 000) is passed to `expire` after the turn closed, `pollMs` (default 500) is how
   * often `attachRemote` reads when the adapter has no `subscribe`.
   */
  streams?: { flushMs?: number; batchSize?: number; retentionMs?: number; pollMs?: number }
  /**
   * Durable inbox behaviour (spec 05 §12): `pollMs` (default 2 000; `0` = no polling) is how often
   * a live session claims inbox items when no notification arrived, `claimTtlMs` (default
   * `recovery.staleMs`) how long a claim hides an item, `collect` the default debounce of
   * `collect` inputs (also used without an inbox). `retry` limits poison items (default: none,
   * unlimited redelivery) and `onDeadLetter` reports items that went dead (spec 05 §12
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
  /** Plugin hook limits (spec 01 §5). */
  hooks?: HooksConfig
  /** Tool source listing limits (spec 02 §3). */
  toolSources?: ToolSourcesConfig
  /** Passed to every `streamText` call. */
  settings?: ModelSettings
  approval?: ApprovalConfig
  /** Prompt caching. Default `'auto'` mode. */
  cache?: CacheConfig | false
  toolOutput?: ToolOutputConfig
  /** Limits on the tool calls of one model step (spec 09 §4.1). */
  toolCalls?: ToolCallsConfig
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
   * Default `{ staleMs: 120_000, abortPollMs: 2_000 }`. Keep `staleMs` ≥ 1 000 in production: the
   * lock heartbeat writes every `staleMs / 4`, and a live turn older than `staleMs` may be taken over. `abortPollMs`: how often a running turn
   * reads the state for an abort request of another instance (`0` = never; needs
   * `StateAdapter.setIf`). `instanceId`: a **stable** id of this instance (default: random per
   * process). With a stable id a restarted process owns the turns its previous run left active:
   * they are recovered at once (next operation, or `session.recover()` at boot) instead of after
   * `staleMs`. Must be unique among the live instances of one storage (spec 05 §9.2).
   */
  recovery?: { staleMs?: number; abortPollMs?: number; instanceId?: string } | false
  telemetry?: TelemetryOptions
  /**
   * Operational signals for metrics and tracing (spec 10 §8): phase durations (`span` events: lock
   * wait, `turn.prepare` hooks, compaction, state and message writes, model call per step, tool
   * execution) and counters (hook failures and timeouts, dropped event readers, state write
   * conflicts, tool-source backoff skips, every warning). Called synchronously and must be cheap;
   * a throwing handler is ignored. Zero cost when unset. `telemetry` (above) stays the AI SDK
   * pass-through for model-call spans.
   */
  observe?: (event: ObserveEvent) => void
  /**
   * The default warning handler (no `onWarning`) prints a code + key once per window and counts
   * the suppressed repeats in the next report. `dedupeWindowMs` default 60 000 (`0` = print
   * every occurrence, at most 86 400 000).
   */
  warnings?: { dedupeWindowMs?: number }
  /** Throw `EH_CONFIG_INVALID` instead of warning on API misuse. Default false. */
  strict?: boolean
  /**
   * Session invariants (spec 05 §15). `invariants: true`: a message the core is about to save that
   * fails AI SDK `UIMessage` validation is a programmer error (`EH_INVALID_MESSAGE`, nothing is
   * saved), and a turn end that leaves the session state inconsistent is reported as
   * `W_INVARIANT_VIOLATION`. `false`: the production policy (warn `W_INVALID_MESSAGE`, save anyway;
   * a message that holds pending state is never dropped). Default `false`; it is never inferred
   * from `NODE_ENV`: tests and development opt in explicitly.
   */
  debug?: { invariants?: boolean }
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

/** Static app tools of an agent config (records in `config.tools`), resolved to `Tool`s. */
export type AgentStaticTools<C> = C extends { tools: infer T }
  ? T extends readonly (infer E)[]
    ? OrEmpty<UnionToIntersection<ToolRecordOf<E>>>
    : OrEmpty<ToolRecordOf<T>>
  : Record<never, never>

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
  /**
   * Side-effect-free read handle of a session (spec 05 §2.2): messages, stats, busy, pending
   * state, children and parent, read from storage without opening the session (no hooks, no
   * recovery, no lock, no writes). Turn operations do not exist on it.
   */
  peek(sessionId: string, options?: Pick<SessionOptions, 'storage'>): SessionPeek<AgentMessageOf<C>>
  /** Close and evict a cached session (runs plugin dispose). */
  closeSession(sessionId: string): Promise<void>
  /** Close all sessions. Call on shutdown. */
  close(): Promise<void>
  /** Type-only brand used by `InferHarnessUIMessage`. Undefined at runtime. */
  readonly '~types': { message: AgentMessageOf<C>; kinds: AgentKindTypes<C> }
}
