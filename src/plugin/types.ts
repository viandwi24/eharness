// biome-ignore-all lint/suspicious/noConfusingVoidType: hooks may return nothing (spec 01 §5)
/**
 * Plugin model: definitions, contributions, hooks, services and the context object.
 *
 * @see docs/specs/01-agent-and-plugins.md
 */
import type {
  FinishReason,
  FlexibleSchema,
  InferSchema,
  JSONValue,
  LanguageModel,
  LanguageModelUsage,
  ModelMessage,
  StepResult,
  ToolApprovalStatus,
  ToolChoice,
  ToolSet,
} from 'ai'
import type { ApprovalActor } from '../agent/session-types.ts'
import type { ModelSettings } from '../agent/types.ts'
import type { HarnessWarning } from '../errors.ts'
import type { Awaitable, ProviderOptions } from '../internal/ai-types.ts'
import type { DataChunk, DataPartDef } from '../messages/data-parts.ts'
import type { MessageKindDef } from '../messages/kinds.ts'
import type {
  HarnessUIMessage,
  StopReason,
  ToolRisk,
  TurnKind,
  TurnResult,
} from '../messages/types.ts'
import type { ToolHints } from '../registry/risk.ts'
import type { GuardTranscriptEntry } from '../registry/transcript.ts'
import type {
  InstructionInput,
  Skill,
  SkillDoc,
  SkillSource,
  ToolsInput,
} from '../registry/types.ts'

/** Map of data part definitions keyed by local name. */
export type DataPartMap = Record<string, DataPartDef>

/** Map of message kind definitions keyed by local name. */
export type KindMap = Record<string, MessageKindDef>

/**
 * Typed services shared between plugins. Empty by default; plugins add entries by declaration
 * merging.
 *
 * @example
 * ```ts
 * declare module 'eharness' {
 *   interface HarnessServices { fs: FileSystem }
 * }
 * ```
 * @see docs/specs/01-agent-and-plugins.md#6-services
 */
// biome-ignore lint/suspicious/noEmptyInterface: augmented by plugins through declaration merging
export interface HarnessServices {}

/**
 * Logger used for `ctx.log`. Default: debug/info no-op, warn/error to `console`.
 *
 * @see docs/specs/01-agent-and-plugins.md#4-harnesscontext-sessionturnstep-context
 */
export interface HarnessLogger {
  debug(msg: string, data?: Record<string, unknown>): void
  info(msg: string, data?: Record<string, unknown>): void
  warn(msg: string, data?: Record<string, unknown>): void
  error(msg: string, data?: Record<string, unknown>): void
}

/**
 * Namespaced, JSON-serializable persistent state of one plugin (`plugins[<name>][key]`).
 *
 * @see docs/specs/05-session-and-storage.md#7-state
 */
export interface PluginState {
  get<T extends JSONValue = JSONValue>(key: string): T | undefined
  /** `undefined` deletes the key. */
  set(key: string, value: JSONValue | undefined): void
}

/**
 * Namespaced stream writer of one plugin, typed with the plugin's own data parts.
 *
 * @see docs/specs/04-streaming.md#3-plugin-stream-writer
 */
export interface PluginStreamWriter<DP extends DataPartMap = Record<never, never>> {
  /** True while a turn stream is open. */
  readonly active: boolean
  /** Write a data part declared by THIS plugin (`name` is the local key, type-checked). */
  data<K extends keyof DP & string>(
    name: K,
    data: InferSchema<DP[K]['schema']>,
    opts?: { id?: string; transient?: boolean },
  ): void
  /** Escape hatch: write any registered data chunk. */
  write(chunk: DataChunk): void
}

/**
 * Information about the running turn (`ctx.turn`).
 *
 * @see docs/specs/01-agent-and-plugins.md#4-harnesscontext-sessionturnstep-context
 */
export interface TurnInfo {
  id: string
  /** What started the turn. */
  kind: TurnKind
  /** True for a turn that waited in the session queue (`ifBusy: 'queue' | 'wait'`, a steer that fell back to a turn, a queued wake). */
  queued: boolean
  /**
   * The turn's user message. Undefined for respond/regenerate/wake and for `send()` without
   * input, and also while the turn's registry resolves — `refresh: 'turn'` instructions and
   * dynamic tool/skill sources run before the input is normalized and submitted (spec 02 §2);
   * set from `input.submit` on (`turn.start`, tools, steps).
   */
  input: HarnessUIMessage | undefined
  /** Validated `callOptions` value of this call. */
  options: unknown
  /** Model chosen for the turn (after `turn.prepare`). */
  model: LanguageModel
  /** Settings chosen for the turn (after `turn.prepare`). */
  settings: ModelSettings
  abortSignal: AbortSignal
  /**
   * Add usage from nested work (subagents, tool-internal model calls) to this turn. Pass `model`
   * (priced from the agent's `models`) or `costUsd` so it counts toward cost and budgets (spec 12).
   */
  addUsage(usage: AddUsageInput, source?: string | AddUsageOptions): void
}

/**
 * Plain token counts accepted by {@link TurnInfo.addUsage}: the shape of `TurnResult['usage']`
 * (a subagent's result) with optional reasoning tokens. `costUsd` counts like
 * `AddUsageOptions.costUsd` (which wins when both are set).
 */
export interface PlainUsage {
  inputTokens: number
  outputTokens: number
  totalTokens?: number
  cachedInputTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
  /** Known cost in USD of this usage. */
  costUsd?: number
}

/** What {@link TurnInfo.addUsage} accepts: AI SDK usage or plain token counts. */
export type AddUsageInput = LanguageModelUsage | PlainUsage

/** Options of {@link TurnInfo.addUsage}. */
export interface AddUsageOptions {
  /** Label for logs (e.g. `'subagent:research'`). */
  source?: string
  /** Model that produced the usage; priced from the agent's `models`. */
  model?: LanguageModel
  /** Known cost in USD (e.g. reported by a gateway); wins over `model`. */
  costUsd?: number
}

/**
 * The context object of one (session, plugin). Turn- and step-dependent fields are live getters.
 *
 * @see docs/specs/01-agent-and-plugins.md#4-harnesscontext-sessionturnstep-context
 */
export interface HarnessContext<DP extends DataPartMap = Record<never, never>> {
  readonly agent: { id: string }
  readonly session: {
    id: string
    /** Set for child sessions (subagents). */
    parent?: { sessionId: string; turnId: string; toolCallId?: string; depth: number }
  }
  /** The plugin this ctx belongs to (`'app'` for the root plugin). */
  readonly plugin: { name: string }
  readonly turn: TurnInfo | undefined
  readonly step: { index: number; model: LanguageModel } | undefined
  /** Typed services map. Accessing a service that no plugin provides throws `EH_SERVICE_MISSING`. */
  readonly services: HarnessServices
  /** Namespaced stream writer, typed with this plugin's own data parts. */
  readonly stream: PluginStreamWriter<DP>
  /** Namespaced, JSON-serializable persistent state. */
  readonly state: PluginState
  /** Developer runtime context (`SessionOptions.runtime` / send options). */
  readonly runtime: Readonly<Record<string, unknown>>
  readonly log: HarnessLogger
  /**
   * Aborts on session close, and when the session open fails (release per-session resources on
   * abort; a retried open sees a fresh signal). Turn-level abort is `turn.abortSignal`.
   */
  readonly signal: AbortSignal
  /**
   * Emit a non-fatal warning on the session's warning channel: `config.onWarning` (or the
   * deduplicated console default), `strict` escalation, and a transient `data-eh.warning` part
   * during a turn. `details.plugin` is set to this plugin unless given.
   *
   * @example
   * ```ts
   * ctx.warn({ code: 'W_INVALID_SKILL', message: `Skipped /skills/x/SKILL.md: ${error}` })
   * ```
   */
  warn(warning: HarnessWarning): void
}

/**
 * Context of the agent phase (`plugin.setup`): sync, pure, no I/O.
 *
 * @see docs/specs/01-agent-and-plugins.md#3-agent-setup-context
 */
export interface AgentSetupContext {
  agentId: string
  plugin: { name: string }
  /** Registries built so far (read-only). `dataPart` takes a part type (`'data-invoice'`). */
  has: { dataPart(type: string): boolean; service(name: string): boolean }
}

/**
 * Event of the `step.prepare` hook.
 *
 * @see docs/specs/01-agent-and-plugins.md#5-hooks
 */
export interface StepPrepareEvent {
  stepIndex: number
  messages: ModelMessage[]
  toolNames: string[]
  model: LanguageModel
  /**
   * Step 0 of a `respond()` continuation only (0.7.0): the final tool names this `respond()`
   * answered — `approved` (the call runs or parks) and `denied`. Lets a hook react to what is
   * about to run (e.g. leaving plan mode) without inspecting the wire. Each name appears once.
   */
  continuing?: { approved: string[]; denied: string[] }
}

/**
 * Patch returned by `step.prepare` hooks.
 *
 * @see docs/specs/01-agent-and-plugins.md#5-hooks
 */
export interface StepPreparePatch {
  /** Last hook wins. */
  model?: LanguageModel
  /** Shallow-merged. */
  settings?: Partial<ModelSettings>
  /** Intersected across hooks (changing tools busts the prompt cache). */
  activeTools?: string[]
  toolChoice?: ToolChoice<Record<string, unknown>>
  /** Volatile text for this step only: sent as a trailing reminder message. */
  reminder?: string
  /** Deep-merged. */
  providerOptions?: ProviderOptions
  /** Wire-only rewrite for this step. Never stored. */
  messages?: ModelMessage[]
}

/**
 * Event of the `step.end` hook.
 *
 * @see docs/specs/01-agent-and-plugins.md#5-hooks
 */
export interface StepEndEvent {
  stepIndex: number
  finishReason: FinishReason
  /** This step. */
  usage: LanguageModelUsage
  /** Turn so far (incl. `addUsage`). */
  totalUsage: LanguageModelUsage
  /** Estimated USD of the turn so far; absent when nothing was priced (spec 12). */
  costUsd?: number
  toolCalls: Array<{ toolName: string; toolCallId: string; input: unknown }>
  toolResults: Array<{
    toolName: string
    toolCallId: string
    status: 'output' | 'error' | 'denied'
  }>
  /** Appended to the wire by this step. */
  responseMessages: ModelMessage[]
  /**
   * The AI SDK `StepResult` of this step (`result.finalStep`). `toolCalls` and `toolResults`
   * above are derived from it. Absent only if AI SDK did not provide it although the step's
   * `responseMessages` resolved; the other fields are then derived from `responseMessages`.
   */
  step?: StepResult<ToolSet>
}

/**
 * Hooks a plugin can register. Every hook receives the context of the plugin that registered it.
 * "Chainable" hooks receive the previous hook's result (plugin order, root first; setup hooks
 * before session hooks).
 *
 * @see docs/specs/01-agent-and-plugins.md#5-hooks
 */
export interface HarnessHooks<DP extends DataPartMap = Record<never, never>> {
  'session.start'?(ctx: HarnessContext<DP>): Awaitable<void>
  'session.close'?(ctx: HarnessContext<DP>): Awaitable<void>

  /** Chainable. Runs on every user input (send, edit, steer) before it is saved. */
  'input.submit'?(
    ctx: HarnessContext<DP>,
    e: { message: HarnessUIMessage; via: 'send' | 'edit' | 'steer' | 'queue' },
  ): Awaitable<
    | void
    | { message: HarnessUIMessage }
    | { block: { reason: string; persist?: boolean } }
    | { context: string[] }
  >

  /** Chainable. Choose model/settings/active tools for the turn. */
  'turn.prepare'?(
    ctx: HarnessContext<DP>,
    e: { model: LanguageModel; settings: ModelSettings; options: unknown },
  ): Awaitable<{
    model?: LanguageModel
    settings?: Partial<ModelSettings>
    activeTools?: string[]
  } | void>
  'turn.start'?(
    ctx: HarnessContext<DP>,
    e: { kind: TurnKind; input: HarnessUIMessage | undefined },
  ): Awaitable<void>
  /** The loop is about to stop with `complete`, `max-steps` or `length`. First non-void result wins. */
  'turn.beforeEnd'?(
    ctx: HarnessContext<DP>,
    e: {
      stop: StopReason
      stepIndex: number
      continues: number
      /** Continuations in a row after which the turn made no progress (spec 05 §3.2). */
      idleContinues: number
      lastText: string
    },
  ): Awaitable<void | { continue: { reason: string } } | { extendSteps: number }>
  'turn.end'?(ctx: HarnessContext<DP>, e: TurnResult): Awaitable<void>

  /** Chainable. Patch the next model call. */
  'step.prepare'?(ctx: HarnessContext<DP>, e: StepPrepareEvent): Awaitable<StepPreparePatch | void>
  /** After each step. `stop` ends the turn; `context` is delivered before the next step. */
  'step.end'?(
    ctx: HarnessContext<DP>,
    e: StepEndEvent,
  ): Awaitable<{ stop?: string; context?: string } | void>

  /** Most restrictive wins. Throw = denied. Must be deterministic and side-effect free. */
  'tool.approve'?(
    ctx: HarnessContext<DP>,
    e: {
      toolName: string
      toolCallId: string
      input: unknown
      toolMetadata?: unknown
      /** Risk of the tool (spec 11 §3.2, `toolTraits`), when known. */
      risk?: ToolRisk
      /** `metadata.idempotent` of the tool (app-declared only), when known. */
      idempotent?: boolean
      /** Raw MCP hints the server sent (untrusted), when any. */
      hints?: ToolHints
      /**
       * The restricted transcript (spec 11 §3.4, 0.5.0): user messages and the agent's earlier
       * tool calls only — never tool outputs, assistant text, reasoning, instructions, reminders or
       * data parts. Built lazily from the step's model wire; every call returns a fresh copy.
       */
      transcript: () => ReadonlyArray<GuardTranscriptEntry>
    },
  ): Awaitable<ToolApprovalStatus | void>
  /**
   * Observe every approval decision (spec 11 §3.3): automatic ones (policy, risk, hook, grant) when
   * the call is approved or denied without asking, and answers given through `respond()`. For
   * audit logs and cross-session inboxes; errors are `W_HOOK_FAILED`.
   */
  'approval.decided'?(ctx: HarnessContext<DP>, e: ApprovalDecision): Awaitable<void>
  /** Chainable. Rewrite tool input before approval and execution. Must be deterministic (spec 11 §3). */
  'tool.before'?(
    ctx: HarnessContext<DP>,
    e: { toolName: string; input: unknown },
  ): Awaitable<{ input: unknown } | void>
  /** Chainable. Rewrite the final output (before size limits). */
  'tool.after'?(
    ctx: HarnessContext<DP>,
    e: { toolName: string; toolCallId: string; input: unknown; output: unknown },
  ): Awaitable<{ output: unknown } | void>

  /** Chainable. Last chance to transform a message before `MessageAdapter.save`. Must keep id/role. */
  'message.beforeSave'?(
    ctx: HarnessContext<DP>,
    message: HarnessUIMessage,
  ): Awaitable<HarnessUIMessage | void>

  /**
   * Chainable (0.4.0). Runs once per compaction after the split and skip rule decided that
   * summarizing will happen, before the summarizer (spec 06 §5.2a). Return a `flush` to give the
   * agent one bounded, internal turn to save facts (e.g. into memory files) before history is
   * summarized. Patches of several plugins merge (prompts joined, tools unioned).
   */
  'compaction.before'?(
    ctx: HarnessContext<DP>,
    e: CompactionBeforeEvent,
  ): Awaitable<CompactionBeforePatch | void>
  /** Contribute context to / replace the summarizer prompt. */
  'compaction.prompt'?(
    ctx: HarnessContext<DP>,
    out: {
      context: string[]
      prompt?: string
      /** The messages being summarized (copies, id order; read-only input). */
      readonly messages: readonly HarnessUIMessage[]
    },
  ): Awaitable<void>
  'compaction.after'?(ctx: HarnessContext<DP>, e: { marker: HarnessUIMessage }): Awaitable<void>

  /**
   * Chainable. Adjust a loaded skill doc and add notes to the `load_skill` result (e.g. an
   * executable path, spec 07 §7). `source` is the `SkillSource.id`; `location` is the result of
   * `SkillSource.locate(name)` (omitted when the source has none or returns `null`).
   */
  'skill.load'?(
    ctx: HarnessContext<DP>,
    e: {
      skill: SkillDoc
      source: string
      location?: { service: string; root: string }
      /** `skill.version` of the document this hook receives, if any (spec 07 §3). */
      version?: string
    },
  ): Awaitable<{ skill?: SkillDoc; notes?: string[] } | void>
}

/**
 * Event of the `compaction.before` hook (spec 06 §5.2a).
 *
 * @see docs/specs/01-agent-and-plugins.md#5-hooks
 */
export interface CompactionBeforeEvent {
  /** The part that will be summarized (`drop`, spec 06 §5.1): copies of view messages, not the kept tail. */
  messages: HarnessUIMessage[]
  /** Calibrated estimate of the current context in tokens. */
  tokens: number
  /** `'turn'` = pre-turn, `'auto'` = mid-turn, `'manual'` = `compact()`, `'overflow'` = overflow recovery. */
  trigger: 'auto' | 'manual' | 'turn' | 'overflow'
}

/**
 * Result of the `compaction.before` hook (spec 06 §5.2a).
 *
 * @see docs/specs/01-agent-and-plugins.md#5-hooks
 */
export interface CompactionBeforePatch {
  /** Run a flush turn before summarizing. */
  flush?: {
    /** Instruction for the flush, sent as a user message after the current conversation. */
    prompt: string
    /** Final tool names the flush may call. Default: none (text-only). Client tools are never offered. */
    tools?: string[]
    /** Model calls of the flush. Default 3. */
    maxSteps?: number
    /** Default: `compaction.model`, else the turn's model. */
    model?: LanguageModel
  }
}

/**
 * One approval decision (spec 11 §3.3).
 */
export interface ApprovalDecision {
  toolName: string
  toolCallId: string
  input: unknown
  risk?: ToolRisk
  /** `metadata.idempotent` of the tool (app-declared only), when known (0.5.0). */
  idempotent?: boolean
  approved: boolean
  /**
   * Who decided: `'policy'` (`approval.policy`), `'risk'` (`approval.risk`), `'plugin:<name>'`
   * (`tool.approve` hook), `'grant'` (session grant), `'user'` (`respond()`), `'new-input'`
   * (denied because new input arrived, `onNewInput: 'deny'`).
   */
  by: 'policy' | 'risk' | 'grant' | 'user' | 'new-input' | `plugin:${string}`
  reason?: string
  /** `respond()` answers only: the actor the application passed. */
  actor?: ApprovalActor
  /** Set for `respond()` answers (and new-input denials). */
  approvalId?: string
  /** `respond()` answers: `remember` as given. */
  remember?: 'once' | 'session'
}

/** Name of a hook. */
export type HookName = keyof HarnessHooks

/**
 * What a plugin contributes in its setup or session phase.
 *
 * @see docs/specs/01-agent-and-plugins.md#2-defineplugin
 */
export interface PluginContribution<DP extends DataPartMap = Record<never, never>> {
  instructions?: InstructionInput | InstructionInput[]
  /** Tool functions receive this plugin's context: `ctx.stream.data` is typed with `DP`. */
  tools?: ToolsInput<DP>
  skills?: Array<Skill | SkillSource>
  hooks?: HarnessHooks<DP>
}

/**
 * What a plugin contributes in its session phase.
 *
 * @see docs/specs/01-agent-and-plugins.md#2-defineplugin
 */
export interface SessionContribution<DP extends DataPartMap = Record<never, never>>
  extends PluginContribution<DP> {
  /** Must contain exactly the names declared in `provides`. */
  services?: Partial<HarnessServices>
  /** Called on session close / eviction. */
  dispose?(): Promise<void> | void
}

/**
 * Definition of a plugin.
 *
 * @see docs/specs/01-agent-and-plugins.md#2-defineplugin
 */
export interface PluginDef<
  Name extends string,
  DP extends DataPartMap = Record<never, never>,
  MK extends KindMap = Record<never, never>,
> {
  /** `^[a-z][a-z0-9-]{0,31}$`; `'eh'` and `'app'` are reserved. Used as namespace. */
  name: Name
  version?: string
  /** Service names this plugin provides. */
  provides?: readonly string[]
  /** Service names this plugin needs. */
  requires?: readonly string[]
  /** Namespaced as `${name}.${key}` → part type `data-${name}.${key}`. */
  dataParts?: DP
  /** Namespaced as `${name}.${key}`. */
  messageKinds?: MK
  /** Agent phase: sync, pure, no I/O. Runs once in `defineHarnessAgent`. */
  setup?(ctx: AgentSetupContext): PluginContribution<DP> | void
  /** Session phase: async, I/O allowed. Runs once per live session, before its first turn. */
  session?(
    ctx: HarnessContext<DP>,
  ): Promise<SessionContribution<DP> | void> | SessionContribution<DP> | void
}

/**
 * Opaque value returned by `definePlugin` (carries its literal name and part maps for inference).
 *
 * @see docs/specs/01-agent-and-plugins.md#12-harnessagent
 */
export interface HarnessPlugin<
  Name extends string = string,
  DP extends DataPartMap = Record<never, never>,
  MK extends KindMap = Record<never, never>,
> {
  readonly name: Name
  readonly '~def': PluginDef<Name, DP, MK>
}

/** Payload types of a data part map (local names). */
export type InferDataTypes<DP> = {
  [K in keyof DP & string]: DP[K] extends { schema: infer S extends FlexibleSchema }
    ? InferSchema<S>
    : never
}

/** Payload types of a part/kind map, namespaced as `${Name}.${key}`. */
export type NamespacedDataTypes<Name extends string, DP> = {
  [K in keyof DP & string as `${Name}.${K}`]: DP[K] extends {
    schema: infer S extends FlexibleSchema
  }
    ? InferSchema<S>
    : never
}
