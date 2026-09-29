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
  ToolApprovalStatus,
  ToolChoice,
} from 'ai'
import type { ModelSettings } from '../agent/types.ts'
import type { HarnessWarning } from '../errors.ts'
import type { Awaitable, ProviderOptions } from '../internal/ai-types.ts'
import type { DataChunk, DataPartDef } from '../messages/data-parts.ts'
import type { MessageKindDef } from '../messages/kinds.ts'
import type { HarnessUIMessage, StopReason, TurnKind, TurnResult } from '../messages/types.ts'
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
  /** True for a `send()` that waited in the queue. */
  queued: boolean
  /** Undefined for respond/regenerate/wake and for `send()` without input. */
  input: HarnessUIMessage | undefined
  /** Validated `callOptions` value of this call. */
  options: unknown
  /** Model chosen for the turn (after `turn.prepare`). */
  model: LanguageModel
  /** Settings chosen for the turn (after `turn.prepare`). */
  settings: ModelSettings
  abortSignal: AbortSignal
  /** Add usage from nested work (subagents, tool-internal model calls) to this turn. */
  addUsage(usage: LanguageModelUsage, source?: string): void
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
  toolCalls: Array<{ toolName: string; toolCallId: string; input: unknown }>
  toolResults: Array<{
    toolName: string
    toolCallId: string
    status: 'output' | 'error' | 'denied'
  }>
  /** Appended to the wire by this step. */
  responseMessages: ModelMessage[]
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
    e: { stop: StopReason; stepIndex: number; continues: number; lastText: string },
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
    e: { toolName: string; toolCallId: string; input: unknown; toolMetadata?: unknown },
  ): Awaitable<ToolApprovalStatus | void>
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

  /** Contribute context to / replace the summarizer prompt. */
  'compaction.prompt'?(
    ctx: HarnessContext<DP>,
    out: { context: string[]; prompt?: string },
  ): Awaitable<void>
  'compaction.after'?(ctx: HarnessContext<DP>, e: { marker: HarnessUIMessage }): Awaitable<void>

  /**
   * Chainable. Adjust a loaded skill doc and add notes to the `load_skill` result (e.g. an
   * executable path, spec 07 §7). `source` is the `SkillSource.id`; `location` is the result of
   * `SkillSource.locate(name)` (omitted when the source has none or returns `null`).
   */
  'skill.load'?(
    ctx: HarnessContext<DP>,
    e: { skill: SkillDoc; source: string; location?: { service: string; root: string } },
  ): Awaitable<{ skill?: SkillDoc; notes?: string[] } | void>
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
  tools?: ToolsInput
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
