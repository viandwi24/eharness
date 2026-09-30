# Spec 01 — Agent and plugins

Status: **Accepted (reviewed for 0.1.0)**. Module: `src/agent`, `src/plugin`.

## 1. `defineHarnessAgent`

```ts
import type {
  LanguageModel, ToolSet, LanguageModelCallOptions, RequestOptions, TelemetryOptions, TimeoutConfiguration,
  ToolApprovalConfiguration, ToolCallRepairFunction, FlexibleSchema, streamText,
} from 'ai'

/** `ai` does not export ProviderOptions; derive it (defined once in src/internal/ai-types.ts). */
type ProviderOptions = NonNullable<Parameters<typeof streamText>[0]['providerOptions']>

export function defineHarnessAgent<const C extends HarnessAgentConfig<DP>, const DP extends DataPartMap = {}>(
  config: C & { dataParts?: DP },
): HarnessAgent<C>

export interface HarnessAgentConfig<DP extends DataPartMap = DataPartMap> {
  /** Stable id used in logs/telemetry. Default: 'agent'. */
  id?: string
  /** Default model: gateway string ('anthropic/claude-sonnet-4.6') or provider instance. */
  model: LanguageModel
  /**
   * Context window in tokens for compaction and guard. A function resolves the window of the model
   * actually used (models can change per turn/step, §5). Default 128_000 (+ W_DEFAULT_CONTEXT_WINDOW).
   */
  contextWindow?: number | ((model: LanguageModel) => number | undefined)
  /** Limits and prices of the models in use (spec 12): record keyed by model id, or a function. */
  models?: ModelCatalog
  /** USD spending limits (spec 12 §4). */
  budget?: BudgetConfig

  instructions?: InstructionInput | InstructionInput[]          // spec 02 §2
  tools?: ToolsInput<DP>                                         // tool functions: ctx typed with DP
  skills?: Array<Skill | SkillSource>                            // spec 07
  mcp?: ToolSource[]                                             // spec 09 (e.g. mcpServer(...))
  dataParts?: DP                                                 // spec 03 §4 (app namespace)
  messageKinds?: Record<string, MessageKindDef>                  // spec 03 §5 (app namespace)
  plugins?: HarnessPlugin[]

  storage?: { messages?: MessageAdapter; state?: StateAdapter }  // spec 05; default: memory
  compaction?: CompactionConfig | false                          // spec 06
  guard?: { maxContextRatio?: number; reserveTokens?: number }   // spec 06 §6
  /** Extra overflow detection for providers the built-in patterns miss (spec 06 §7). */
  isContextOverflow?: (error: unknown) => boolean
  loop?: LoopConfig
  settings?: ModelSettings                                       // passed to every streamText call
  /** Human-in-the-loop tool approval (spec 11 §3). */
  approval?: ApprovalConfig
  /** Prompt caching (spec 02 §6). Default 'auto'. */
  cache?: CacheConfig | false
  /** Tool result size limits (spec 09 §4). */
  toolOutput?: ToolOutputConfig
  /** Typed per-call options accepted by send()/respond()/… (`options`), exposed as ctx.turn.options. */
  callOptions?: FlexibleSchema
  /** Passed to streamText `repairToolCall` (fix malformed tool calls). */
  repairToolCall?: ToolCallRepairFunction<ToolSet>
  /** Crash recovery of turns interrupted by a dead process (spec 05 §9). */
  recovery?: { staleMs?: number } | false                        // default { staleMs: 120_000 }
  telemetry?: TelemetryOptions                                   // passed through to AI SDK
  /** Throw EH_CONFIG_INVALID instead of warning on API misuse (W_TRANSIENT_OVERRIDE, W_UNKNOWN_DATA_PART, W_WRITE_OUTSIDE_TURN). Default false. */
  strict?: boolean
  /** Logger used for ctx.log (§4). */
  logger?: HarnessLogger
  /** Called for every warning (spec 10 §2). Default handler: console.warn, deduplicated per code+key. */
  onWarning?: (w: HarnessWarning) => void
  /** Id generator for messages/turns. Must produce time-sortable ids. Default: uuidv7. */
  generateId?: () => string
  /** Max skills listed in the prompt index before switching to search mode (spec 07 §4). Default 50. */
  skillsIndexLimit?: number
  /** Evict idle cached sessions after this many ms (spec 05 §1). Default 30 min. 0 = never. */
  sessionIdleMs?: number
}

export interface LoopConfig {
  maxSteps?: number              // default 500 — per turn (stop: 'max-steps'; extensible by turn.beforeEnd)
  wrapUp?: boolean               // default true — one tool-less summary step when maxSteps runs out (spec 05 §3.1)
  maxTurnOutputTokens?: number   // default none — output-token cap incl. nested usage (stop: 'cost-cap')
  turnTimeoutMs?: number         // default none — wall clock per turn (stop: 'timeout')
  maxContinues?: number          // default none — absolute cap on turn.beforeEnd continuations (§5)
  maxIdleContinues?: number      // default 3 — continuations in a row without progress (spec 05 §3.2)
  progress?: ProgressConfig | false  // stuck detection (spec 05 §3.2)
  persistEachStep?: boolean      // default true — upsert assistant message after every step
}

export interface ProgressConfig {
  repeats?: number               // default 3 — same (tool, input, output) within the window
  window?: number                // default 20 — steps that called tools
  errorStreak?: number           // default 5 — steps in a row whose tool calls all failed
  nudges?: number                // default 1 — PROGRESS_NUDGE reminders before stop 'stuck'
  ignoreTools?: string[]         // tools that may legitimately repeat (polling)
}

// CallSettings is deprecated in AI SDK v7; use LanguageModelCallOptions + RequestOptions.
export type ModelSettings = Pick<LanguageModelCallOptions,
  'maxOutputTokens' | 'temperature' | 'topP' | 'topK' | 'presencePenalty' | 'frequencyPenalty' |
  'stopSequences' | 'seed' | 'reasoning'> & Pick<RequestOptions, 'maxRetries'> & {
  headers?: Record<string, string>
  providerOptions?: ProviderOptions
  /** Per step. A number means stepMs. `totalMs` is rejected (one streamText per step) — use loop.turnTimeoutMs. */
  timeout?: number | Omit<Exclude<TimeoutConfiguration<ToolSet>, number>, 'totalMs'>
  /** Retries of a step after streaming started (AI SDK streamRetries; `reset-step` is forwarded). */
  streamRetries?: number
}

export interface ApprovalConfig {                                // spec 11 §3
  policy?: ToolApprovalConfiguration<ToolSet, unknown>
  risk?: Partial<Record<ToolRisk | 'unknown', ToolApprovalStatus>> // spec 11 §3.2
  secret?: string
  onNewInput?: 'deny' | 'reject'
}
export interface CacheConfig { mode?: 'auto' | 'breakpoints'; ttl?: '5m' | '1h' }            // spec 02 §6
export interface ToolOutputConfig {                              // spec 09 §4
  maxChars?: number                                              // default 50_000 per result
  perTool?: Record<string, number | false>
  strategy?: 'truncate' | 'evict'                                // default 'truncate'
}
```

`ToolInput<DP> = Tool | ((ctx: HarnessContext<DP>) => Tool)` and
`ToolsInput<DP> = Record<string, ToolInput<DP>> | ToolSource | Array<Record<string, ToolInput<DP>> | ToolSource>`.
A function is resolved once per session, so static tools can capture the session context (e.g.
`ctx.stream`, `ctx.state`) without closures in application code. `DP` are the data parts of the
owner: the app's `dataParts` for top-level tools (inferred by `defineHarnessAgent`), the plugin's
`dataParts` for tools a plugin contributes, so `ctx.stream.data(name, data)` is type-checked in
both.

### 1.1 Root plugin

Top-level `instructions`, `tools`, `skills`, `mcp`, `dataParts`, `messageKinds` are sugar for an
implicit **root plugin** named `app` that is always first. Internally there is exactly one code
path: plugin composition. Items contributed by the root plugin use the **app namespace** (no
prefix) for data parts and message kinds.

### 1.2 `HarnessAgent`

```ts
export interface HarnessAgent<C = HarnessAgentConfig> {
  readonly id: string
  readonly config: Readonly<C>
  /** Get (hot) or create a live session. Does no I/O until first use. */
  session(sessionId: string, options?: SessionOptions): HarnessSession<AgentMessageOf<C>, AgentKindTypes<C>>
  /** Close and evict a cached session (runs plugin dispose). */
  closeSession(sessionId: string): Promise<void>
  /** Close all sessions. Call on shutdown. */
  close(): Promise<void>
  /**
   * Type-only brand used by InferHarnessUIMessage (undefined at runtime). `AgentMessageOf<C>` is
   * computed from the config type: core data parts + every plugin's namespaced parts/kinds + app
   * parts/kinds, and the static app tools' InferUITools (`config.tools` records; any tool when there
   * are none). `AgentKindTypes<C>` maps every kind name (core, app, `<plugin>.<key>`) to its payload.
   */
  readonly '~types': { message: AgentMessageOf<C>; kinds: AgentKindTypes<C> }
}

/** Opaque value returned by definePlugin (carries its literal name and part maps for inference). */
export interface HarnessPlugin<Name extends string = string, DP extends DataPartMap = {}, MK extends KindMap = {}> {
  readonly name: Name
  readonly '~def': PluginDef<Name, DP, MK>
}
export type DataPartMap = Record<string, DataPartDef>
export type KindMap = Record<string, MessageKindDef>
```

`SessionOptions` is defined in spec 05.

## 2. `definePlugin`

```ts
export function definePlugin<
  const Name extends string,
  const DP extends DataPartMap = {},
  const MK extends KindMap = {},
>(def: PluginDef<Name, DP, MK>): HarnessPlugin<Name, DP, MK>

export interface PluginDef<Name extends string, DP extends DataPartMap = {}, MK extends KindMap = {}> {
  /** ^[a-z][a-z0-9-]{0,31}$ ; 'eh' and 'app' are reserved. Used as namespace. */
  name: Name
  version?: string
  /** Service names this plugin provides / needs (§6). Static so conflicts are detected at boot. */
  provides?: readonly string[]
  requires?: readonly string[]
  /** Namespaced as `${name}.${key}` → part type `data-${name}.${key}`. */
  dataParts?: DP
  /** Namespaced as `${name}.${key}`. */
  messageKinds?: MK

  /** Agent phase: sync, pure, no I/O. Runs once in defineHarnessAgent. */
  setup?(ctx: AgentSetupContext): PluginContribution<DP> | void
  /** Session phase: async, I/O allowed. Runs once per live session, before its first turn. */
  session?(ctx: HarnessContext<DP>): Promise<SessionContribution<DP> | void> | SessionContribution<DP> | void
}

export interface PluginContribution<DP extends DataPartMap = {}> {
  instructions?: InstructionInput | InstructionInput[]
  tools?: ToolsInput<DP>          // tool functions receive HarnessContext<DP>
  skills?: Array<Skill | SkillSource>
  hooks?: HarnessHooks<DP>
}

export interface SessionContribution<DP extends DataPartMap = {}> extends PluginContribution<DP> {
  /** Must contain exactly the names declared in `provides`. */
  services?: Partial<HarnessServices>
  /** Called on session close / eviction. Close clients, flush buffers. */
  dispose?(): Promise<void> | void
}
```

Rules:

- `setup` must be pure: no network, no filesystem, no timers. Its tools/skills/instructions are
  **static** and participate in boot validation (duplicate detection).
- `session` may do I/O (connect MCP, open a sandbox, read config). Its contributions are
  **session-scoped** and validated when the session opens (a duplicate static name throws
  `EH_DUPLICATE_*`; see spec 02 §5 for dynamic sources).
- A plugin may use both phases. Hooks from both phases are merged (setup hooks first): hooks run
  in plugin order, and within one plugin its setup-phase hooks run before its session-phase hooks.
- Plugins are ordered `[root, ...config.plugins]`. That order defines instruction order, hook order
  and "first wins" for dynamic conflicts.

## 3. Agent setup context

```ts
export interface AgentSetupContext {
  agentId: string
  plugin: { name: string }
  /** Registries built so far (read-only), e.g. to check whether a data part exists. */
  has: { dataPart(type: string): boolean; service(name: string): boolean }
}
```

## 4. `HarnessContext` (session/turn/step context)

One context object per (session, plugin). Fields that depend on the running turn are **live
getters**; reading them outside a turn returns `undefined` / inactive values.

```ts
export interface HarnessContext<DP extends DataPartMap = {}> {
  readonly agent: { id: string }
  readonly session: {
    id: string
    /** Set for child sessions (subagents), spec 05 §1. */
    parent?: { sessionId: string; turnId: string; toolCallId?: string; depth: number }
  }
  readonly plugin: { name: string }            // the plugin this ctx belongs to ('app' for root)

  readonly turn: TurnInfo | undefined
  readonly step: { index: number; model: LanguageModel } | undefined

  /** Typed services map (§6). Accessing a service that no plugin provides throws EH_SERVICE_MISSING. */
  readonly services: HarnessServices
  /** Namespaced stream writer (spec 04 §3), typed with this plugin's own data parts. */
  readonly stream: PluginStreamWriter<DP>
  /** Namespaced, JSON-serializable persistent state (spec 05 §7). */
  readonly state: PluginState
  /** Developer runtime context from SessionOptions.runtime / send options (tenantId, userId, …). */
  readonly runtime: Readonly<Record<string, unknown>>
  readonly log: HarnessLogger
  /** Aborts on session close and when the session open fails (a retried open gets a fresh
   *  signal, spec 05 §2). Turn-level abort is `turn.abortSignal`. */
  readonly signal: AbortSignal
  /** Non-fatal warning on the session channel (onWarning / default dedup, strict escalation,
   *  data-eh.warning during a turn); details.plugin = this plugin unless given (spec 10 §2). */
  warn(warning: HarnessWarning): void
}

export interface TurnInfo {
  id: string
  /** What started the turn. */
  kind: 'send' | 'respond' | 'regenerate' | 'edit' | 'wake'
  /** True for a send() that waited in the queue (ifBusy: 'queue', or a steer that fell back to a turn). */
  queued: boolean
  /** Undefined for respond/regenerate/wake and for send() without input. */
  input: HarnessUIMessage | undefined
  /** Validated `callOptions` value of this call. */
  options: unknown
  /** Model and settings chosen for the turn (after turn.prepare). */
  model: LanguageModel
  settings: ModelSettings
  abortSignal: AbortSignal
  /** Add usage from nested work (subagents, tool-internal model calls) to this turn's totals, cost and caps (spec 12 §3). */
  addUsage(usage: LanguageModelUsage, source?: string | { source?: string; model?: LanguageModel; costUsd?: number }): void
}

export interface HarnessLogger {
  debug(msg: string, data?: Record<string, unknown>): void
  info(msg: string, data?: Record<string, unknown>): void
  warn(msg: string, data?: Record<string, unknown>): void
  error(msg: string, data?: Record<string, unknown>): void
}
// config.logger?: HarnessLogger — default: debug/info no-op, warn/error → console.
```

Inside tools created by `ToolInput` functions or plugin `session()`, use this `ctx`. Plain AI SDK
tools (objects) keep working and receive AI SDK's own `toolsContext` if they declare
`contextSchema`. `toolsContext` is a **map keyed by final tool name** (after any MCP prefix), each
value validated by that tool's `contextSchema`:
`send(input, { toolsContext: { get_price: { apiKey } } })` (or `SessionOptions.toolsContext`).
An invalid tool context fails the whole step in AI SDK (not just the tool), so the core validates
`toolsContext` against every `contextSchema` at turn start and ends the turn early with
`EH_INVALID_INPUT` instead.

## 5. Hooks

All hooks receive `HarnessContext<DP>` of the plugin that registered them. "Chainable" hooks
receive the previous hook's result (plugin order, root first; setup hooks before session hooks).

```ts
export interface HarnessHooks<DP extends DataPartMap = {}> {
  'session.start'?(ctx: HarnessContext<DP>): Awaitable<void>
  'session.close'?(ctx: HarnessContext<DP>): Awaitable<void>

  /** Chainable. Runs on every user input (send, edit, steer) before it is saved. */
  'input.submit'?(ctx: HarnessContext<DP>, e: { message: HarnessUIMessage; via: 'send' | 'edit' | 'steer' | 'queue' })
    : Awaitable<void
      | { message: HarnessUIMessage }                        // rewrite (re-normalized by the core)
      | { block: { reason: string; persist?: boolean } }     // end with stop 'blocked'
      | { context: string[] }>                               // extra text parts on the stored user message

  /** Chainable. Choose model/settings/active tools for the turn (`activeTools` of several hooks are intersected). */
  'turn.prepare'?(ctx: HarnessContext<DP>, e: { model: LanguageModel; settings: ModelSettings; options: unknown })
    : Awaitable<{ model?: LanguageModel; settings?: Partial<ModelSettings>; activeTools?: string[] } | void>
  'turn.start'?(ctx: HarnessContext<DP>, e: { kind: TurnInfo['kind']; input: HarnessUIMessage | undefined }): Awaitable<void>
  /**
   * The loop is about to stop with `stop` ∈ 'complete' | 'max-steps' | 'length' (spec 05 §3.1).
   * First non-void result wins (plugin order). Bounded by progress (loop.maxIdleContinues) and
   * loop.maxContinues (W_CONTINUE_LIMIT), spec 05 §3.1–3.2. `idleContinues` > 0 means the previous
   * continuation(s) produced no new tool results — a hook should give up or change its reason.
   */
  'turn.beforeEnd'?(ctx: HarnessContext<DP>, e: { stop: StopReason; stepIndex: number; continues: number; idleContinues: number; lastText: string })
    : Awaitable<void
      | { continue: { reason: string } }     // delivered as data-eh.input { source: 'plugin:<name>' }, one more step
      | { extendSteps: number }>             // only for 'max-steps': raise this turn's budget
  'turn.end'?(ctx: HarnessContext<DP>, e: TurnResult): Awaitable<void>

  /** Chainable. Patch the next model call. */
  'step.prepare'?(ctx: HarnessContext<DP>, e: StepPrepareEvent): Awaitable<StepPreparePatch | void>
  /** After each step. `stop` ends the turn (StopReason `plugin:<name>:<reason>`); `context` is delivered before the next step. */
  'step.end'?(ctx: HarnessContext<DP>, e: StepEndEvent): Awaitable<{ stop?: string; context?: string } | void>

  /** Most restrictive wins (spec 11 §3). Throw = denied. Must be deterministic and side-effect free: AI SDK calls it again for approved calls when a continuation starts. */
  'tool.approve'?(ctx: HarnessContext<DP>, e: { toolName: string; toolCallId: string; input: unknown; toolMetadata?: unknown; risk?: ToolRisk })
    : Awaitable<ToolApprovalStatus | void>
  /** Every automatic approval decision and every respond() answer (spec 11 §3.3). Observational; errors are W_HOOK_FAILED. */
  'approval.decided'?(ctx: HarnessContext<DP>, e: ApprovalDecision): Awaitable<void>
  /** Chainable. Rewrite tool input before approval and execution (implemented via experimental_refineToolInput). Must be deterministic (spec 11 §3). */
  'tool.before'?(ctx: HarnessContext<DP>, e: { toolName: string; input: unknown })
    : Awaitable<{ input: unknown } | void>
  /** Chainable. Rewrite the final output (before size limits, spec 09 §4). */
  'tool.after'?(ctx: HarnessContext<DP>, e: { toolName: string; toolCallId: string; input: unknown; output: unknown })
    : Awaitable<{ output: unknown } | void>

  /** Chainable. Last chance to transform a message before MessageAdapter.save. Must keep id/role. */
  'message.beforeSave'?(ctx: HarnessContext<DP>, message: HarnessUIMessage): Awaitable<HarnessUIMessage | void>

  /** Contribute context to / replace the summarizer prompt (spec 06 §5). */
  'compaction.prompt'?(ctx: HarnessContext<DP>, out: { context: string[]; prompt?: string }): Awaitable<void>
  'compaction.after'?(ctx: HarnessContext<DP>, e: { marker: HarnessUIMessage }): Awaitable<void>

  /** Chainable. Adjust a loaded skill doc (e.g. add an executable path, spec 07 §7). `location` = `SkillSource.locate(name)`, omitted when absent/null. */
  'skill.load'?(ctx: HarnessContext<DP>, e: { skill: SkillDoc; source: string; location?: { service: string; root: string } }): Awaitable<{ skill?: SkillDoc; notes?: string[] } | void>
}

export interface StepPrepareEvent { stepIndex: number; messages: ModelMessage[]; toolNames: string[]; model: LanguageModel }
export interface StepPreparePatch {
  model?: LanguageModel               // last hook wins
  settings?: Partial<ModelSettings>   // shallow-merged
  activeTools?: string[]              // intersected across hooks (changing tools busts the prompt cache, spec 02 §6)
  toolChoice?: ToolChoice
  /** Volatile text for this step only: sent as a trailing reminder message, never in the system prompt (spec 02 §5). */
  reminder?: string
  providerOptions?: ProviderOptions   // deep-merged
  /** Wire-only rewrite for this step (redaction, cache markers). Never stored. Tool call/result parity is re-checked. */
  messages?: ModelMessage[]
}
export interface StepEndEvent {
  stepIndex: number
  finishReason: FinishReason
  usage: LanguageModelUsage          // this step
  totalUsage: LanguageModelUsage     // turn so far (incl. addUsage)
  costUsd?: number                   // turn so far, estimated (spec 12); absent when nothing was priced
  toolCalls: Array<{ toolName: string; toolCallId: string; input: unknown }>
  toolResults: Array<{ toolName: string; toolCallId: string; status: 'output' | 'error' | 'denied' }>
  responseMessages: ModelMessage[]   // appended to the wire by this step
  step?: StepResult<ToolSet>         // AI SDK result of this step (`result.finalStep`)
}
```

`step` is AI SDK's own `StepResult` (typed `toolCalls`, `toolResults`, `content`, `text`, …).
`toolCalls` and `toolResults` are derived from it: `toolCalls` = `step.toolCalls`; `toolResults`
maps `tool-result` → `output`, `tool-error` → `error`, a denied `tool-approval-response` →
`denied`, in call order (not completion order). The status reflects what the tool did, not its
model output: a tool whose `toModelOutput` returns `error-text` is `output` (since 0.2; before, it
was read from the wire and was `error`). Results of a `respond()` continuation (spec 11)
are executed by AI SDK before the model call and are not part of `step`; they come first in
`toolResults` and are read from `responseMessages` (`execution-denied` → `denied`,
`error-text`/`error-json` → `error`). `turn.beforeEnd`'s `lastText` is `step.text` of the last
step. `step.end` does not fire for an aborted step or when the provider call failed before
streaming (`responseMessages` rejects then). Should `result.finalStep` fail although
`responseMessages` resolved, `step` is absent and every field (and `lastText`) is derived from
`responseMessages` instead.

Failure policy: a hook that throws raises `W_HOOK_FAILED` and is skipped — except
`tool.approve` (throw = `denied`, fail closed) and `input.submit` (throw = `block` with the error
message, fail closed).

Implementation notes:

- `tool.before` runs inside AI SDK's `experimental_refineToolInput` (one generated function per
  tool), so the stream, stored parts, approval and telemetry all see the refined input.
- `tool.after` and size limits run in an `execute` wrapper (`{ ...tool, execute: wrapped }`).
  AsyncIterable (preliminary) results are passed through unchanged; `tool.after` runs on the last
  yielded value, and when it changes the value the result is yielded once more as the final output
  (so the raw last value also appears as a preliminary output).
  Tools without `execute` (client tools), provider-executed tools and `toolSearch()` are not
  wrapped (AI SDK replaces `toolSearch()`'s `execute` anyway).
- Errors thrown by a tool become tool-error results (`String(error)` is what the model sees); the
  wrapper re-throws them as `HarnessToolError` so `onError` can send the same text to the UI
  (spec 04 §2).

## 6. Services

Services let plugins share typed objects (e.g. the filesystem) without importing each other.

```ts
// declared by a plugin module via declaration merging:
declare module 'eharness' {
  interface HarnessServices { fs: FileSystem }
}
```

- `provides: ['fs']` + returning `services: { fs }` from `session()`.
- Exactly one plugin may provide a given service name → otherwise boot error `EH_SERVICE_CONFLICT`.
- `requires: ['fs']` with no provider → boot error `EH_SERVICE_MISSING`.
- Providing a declared service is checked at session open; missing → `EH_SERVICE_MISSING`.
- `ctx.services.fs` is available to all plugins' `session()` and hooks **after** the providing
  plugin's `session()` ran. Session phases run in plugin order, then a second pass is not made:
  a plugin that `requires` a service must come **after** its provider in `plugins`, otherwise boot
  error `EH_PLUGIN_ORDER`.

## 7. Boot validation (summary)

| Check | Error |
|---|---|
| Plugin name invalid / reserved / duplicate | `EH_CONFIG_INVALID` |
| Two static tools with the same name | `EH_DUPLICATE_TOOL` |
| Two static skills with the same name | `EH_DUPLICATE_SKILL` |
| Data part or message kind type collision | `EH_DUPLICATE_DATA_PART` |
| Two providers for one service | `EH_SERVICE_CONFLICT` |
| Required service has no provider | `EH_SERVICE_MISSING` |
| Requirer ordered before provider | `EH_PLUGIN_ORDER` |
| `callOptions` is not a schema, `settings.timeout.totalMs` set | `EH_CONFIG_INVALID` |
| App data part / kind name contains `.` or starts with `eh` (plugin keys follow the same rule) | `EH_CONFIG_INVALID` |
| Data part / kind without `schema`, kind without `role` `'user' \| 'assistant'` | `EH_CONFIG_INVALID` |
| Static tool name not matching `^[a-zA-Z0-9_-]{1,64}$`, tool that is neither a `Tool` nor a function | `EH_CONFIG_INVALID` |
| Unknown hook name, hook that is not a function, invalid instruction/skill shape | `EH_CONFIG_INVALID` |
| `setup()` returns a promise or throws (the error is kept in `cause`) | `EH_CONFIG_INVALID` |
| `model` missing, `contextWindow` not a positive number or function, `mcp` entry not a `ToolSource` | `EH_CONFIG_INVALID` |

All thrown as `HarnessError` with `code` and a message naming every involved owner (plugin names,
source ids). Owners are named `the app (agent config)` for the root plugin and `plugin '<name>'`
otherwise; `details` carries the same names (`owners`, `plugin`, `service`, …).

Static skills are told apart from skill sources structurally: an object with `id` and `list` /
`load` functions is a `SkillSource`, an object with string `name` and `content` is a `Skill`.
Both are then validated like `defineSkill` / `defineSkillSource` (spec 07 §1–§3): an invalid name,
description, file path or source shape → `EH_CONFIG_INVALID` naming the owner.
Tool sources carry a `'~toolSource'` brand set by `defineToolSource` (spec 02 §3.2).

## 8. Example

```ts
import { defineHarnessAgent, defineSkill } from 'eharness'
import { filesystem } from 'eharness/filesystem'
import { memoryFs } from 'eharness/filesystem/memory'
import { tool } from 'ai'
import { z } from 'zod/v4'

export const agent = defineHarnessAgent({
  model: 'anthropic/claude-sonnet-4.6',
  contextWindow: 200_000,
  instructions: 'You write and review Pine Script v6 strategies.',
  tools: {
    get_price: tool({
      description: 'Latest price for a symbol',
      inputSchema: z.object({ symbol: z.string() }),
      execute: async ({ symbol }) => fetchPrice(symbol),
    }),
  },
  skills: [defineSkill({ name: 'pine-v6', description: 'Pine v6 syntax and pitfalls', content: '…' })],
  plugins: [filesystem({ fs: memoryFs(), skills: { root: '/skills' } })],
  compaction: { summarizeAt: 0.75, keepLast: 4 },
})
```
