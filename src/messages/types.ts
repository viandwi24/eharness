/**
 * The message model: `HarnessUIMessage`, metadata, core data part payloads, stop reasons.
 *
 * @see docs/specs/03-messages.md
 */
import type { FileUIPart, InferUITools, ToolSet, UIMessage } from 'ai'

/**
 * What started a turn.
 *
 * @see docs/specs/01-agent-and-plugins.md#4-harnesscontext-sessionturnstep-context
 */
export type TurnKind = 'send' | 'respond' | 'regenerate' | 'edit' | 'wake'

/**
 * Why a turn ended. Stored in `metadata.eharness.stop` and returned in {@link TurnResult}.
 *
 * @see docs/specs/10-errors-and-stop-reasons.md#4-stop-reasons
 */
export type StopReason =
  /** The model answered without tool calls (finishReason `stop` or `other`). */
  | 'complete'
  /** Waiting for `respond()`: approval request or client-side tool. */
  | 'tool-pending'
  /** Provider finishReason `length`. */
  | 'length'
  /** Provider finishReason `content-filter`. */
  | 'content-filter'
  /** Provider/stream/storage/overflow error (see `metadata.eharness.error`). */
  | 'error'
  /** `run.abort()` / `session.abort()` / abort signal. */
  | 'aborted'
  /** `loop.turnTimeoutMs` or an AI SDK step timeout. */
  | 'timeout'
  /** An `input.submit` hook blocked the input. */
  | 'blocked'
  /** The progress guard found the turn repeating itself or failing, and a nudge did not help (spec 05 §3.2). */
  | 'stuck'
  /** The context was above `summarizeAt` again within `compaction.thrash.withinSteps` steps after a compaction (spec 06 §4). */
  | 'context-thrash'
  /** The process died mid-turn; set by crash recovery. */
  | 'interrupted'
  /** Step budget reached. */
  | 'max-steps'
  /** `loop.maxTurnOutputTokens` exceeded, or a USD `budget` used up (spec 12 §4). */
  | 'cost-cap'
  /**
   * `SendOptions.output` (0.4.0): no final answer matched the schema within `maxRetries` retries
   * (or a retry was refused by the continuation bounds), spec 05 §3.3.
   */
  | 'output-invalid'
  /** A `step.end` hook stopped the turn: `plugin:<plugin>:<reason>`. */
  | `plugin:${string}`

/**
 * Risk class of a tool (spec 11 §3.2): `tool({ metadata: { risk } })`. MCP tools whose server marks
 * them `destructiveHint` are `'destructive'`.
 */
export type ToolRisk = 'read' | 'write' | 'destructive'

/**
 * Approvals and client tool calls waiting for `respond()`.
 *
 * @see docs/specs/11-interaction.md#2-pending-state
 */
export interface PendingState {
  /** The assistant message waiting for answers. */
  messageId: string
  /**
   * Tool calls waiting for a user approval decision. `input` (the refined tool input) and `risk`
   * (spec 11 §3.2) let an inbox show the request without loading messages; absent in state
   * written before 0.3.
   */
  approvals: Array<{
    approvalId: string
    toolCallId: string
    toolName: string
    input?: unknown
    risk?: ToolRisk
  }>
  /** Calls of tools without `execute` waiting for a client-provided output. */
  clientTools: Array<{ toolCallId: string; toolName: string }>
}

/**
 * Token usage stored on assistant messages (flattened from AI SDK `LanguageModelUsage`).
 *
 * @see docs/specs/03-messages.md#3-metadata
 */
export interface HarnessUsageMeta {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  /** `outputTokenDetails.reasoningTokens`. */
  reasoningTokens?: number
  /** `inputTokenDetails.cacheReadTokens`. */
  cachedInputTokens?: number
  cacheWriteTokens?: number
  /** Total reported through `ctx.turn.addUsage()` (nested work, subagents). */
  nested?: number
  /** Estimated USD (spec 12 §3); absent when no priced usage was recorded. */
  costUsd?: number
}

/**
 * The reserved `metadata.eharness` object. Unknown keys must be preserved on load/save.
 *
 * @see docs/specs/03-messages.md#3-metadata
 */
export interface HarnessMessageMeta {
  /** Schema version of this object. */
  v: 1
  /** Epoch ms. */
  createdAt: number
  /** Present only on kind messages. Absent = ordinary chat message. */
  kind?: string
  /** Turn that produced or received this message. */
  turnId?: string
  /** Cached token estimate of this message's model projection (spec 06 §2). */
  tokens?: number
  /** User messages: the id the client used, if any (ids are always server-generated). */
  clientId?: string
  /** Id of the previous message on the active path. */
  parentId?: string | null
  /** User messages: number of trailing text parts added by `input.submit` `context`. */
  augmented?: number
  /** Kind messages delivered into a running turn: the assistant message that carries them. */
  deliveredIn?: string
  /** User messages: the id of the inbox item it was made from (`session.enqueue()`). */
  inboxId?: string
  /** User messages merged from `collect` inputs: one entry per input, in arrival order. */
  collected?: Array<{ inboxId?: string; clientId?: string }>
  /** Assistant messages: model id used by the turn. */
  model?: string
  /** Assistant messages: token usage (cumulative over all turns that wrote the message). */
  usage?: HarnessUsageMeta
  /** Assistant messages: why the turn ended. */
  stop?: StopReason
  /** Assistant messages: set on `tool-pending`; `null` once resolved. */
  pending?: PendingState | null
  /** Assistant messages: number of steps. */
  steps?: number
  /** Assistant messages: wall-clock duration. */
  durationMs?: number
  /** Assistant messages: error of a turn that ended with `stop: 'error'`. */
  error?: { code?: string; message: string }
  /**
   * Assistant messages of a turn with `SendOptions.output` (0.4.0, spec 05 §3.3): whether a valid
   * final answer was recorded, and how many answers were checked.
   */
  output?: { ok: boolean; attempts: number }
}

/**
 * Message metadata of every eharness message. Apps may add their own keys next to `eharness`.
 *
 * @see docs/specs/03-messages.md#3-metadata
 */
export interface HarnessMetadata {
  eharness?: HarnessMessageMeta
}

/**
 * Context size statistics (absolute token counts).
 *
 * @see docs/specs/06-compaction.md#2-token-accounting
 */
export interface ContextStats {
  window: number
  /** Calibrated estimate of the next request. */
  tokens: number
  instructions: number
  tools: number
  messages: number
  /** Absolute tokens. */
  summarizeAt: number
  /** Absolute tokens. */
  hardLimit: number
  lastCompaction?: { markerId: string; before: number; after: number; at: number }
  /**
   * Tool outputs replaced by the prune stage in this request (spec 06 §5.0): `chars` = characters
   * saved (original − placeholder). Present only when `compaction.prune` is on.
   */
  pruned?: { outputs: number; chars: number }
}

/**
 * Payload of an `eh.compaction` marker.
 *
 * @see docs/specs/06-compaction.md#3-marker-payload
 */
export interface CompactionPayload {
  summary: string
  /** First message (id order) kept verbatim after this marker; `null` = nothing kept. */
  resumeFromId: string | null
  /** Inside `messageId`, drop steps before `fromStep` when projecting. */
  partial?: { messageId: string; fromStep: number }
  tokens: { before: number; after: number }
  trigger: 'auto' | 'manual' | 'turn'
  model?: string
}

/** Data of the transient `data-eh.status` part (live spinner). */
export interface StatusPartData {
  state: 'thinking' | 'tool' | 'compacting' | 'idle'
  step?: number
  tool?: string
}

/** Data of the transient `data-eh.usage` part (cumulative for the turn). */
export interface UsagePartData {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  steps: number
  /** Estimated USD of the turn so far; absent when no priced usage was recorded (spec 12). */
  costUsd?: number
}

/** Data of the transient `data-eh.warning` part. */
export interface WarningPartData {
  code: string
  message: string
}

/**
 * Data of the persistent `data-eh.input` part: input delivered inside a running assistant message
 * (steer, next-step event, hook context). Projected by splitting the message (ADR-0011).
 */
export interface InputPartData {
  source: 'user' | 'event' | `plugin:${string}`
  text: string
  files?: FileUIPart[]
  clientId?: string
  /** A steer from the durable inbox: its item id (dedupe on redelivery). */
  inboxId?: string
}

/**
 * Data of the persistent `data-eh.output` part (0.4.0): the validated final answer of a turn with
 * `SendOptions.output` (spec 05 §3.3). Never projected to the model.
 */
export interface OutputPartData {
  /** The validated (schema-transformed) final answer; equals `TurnResult.output`. */
  value: unknown
  /** How the answer was produced. */
  mode: 'tool' | 'native'
  /** Answers checked, including the valid one (1 = valid at the first try). */
  attempts: number
}

/** Payload of the `eh.notice` kind (errors, timeouts, blocked input, recovered turns). */
export interface NoticePayload {
  level: 'info' | 'warning' | 'error'
  code?: string
  message: string
}

/** Payload of the `eh.event` kind (app-injected events). */
export interface EventPayload {
  name: string
  text: string
  data?: unknown
}

/** Payload of the `eh.rewind` kind: hides messages with `afterId < id < rewind.id`. */
export interface RewindPayload {
  afterId: string | null
  reason: 'regenerate' | 'edit' | 'revert'
}

/**
 * Payload of the `eh.flush` kind (0.4.0): the model-invisible audit record of a pre-compaction
 * flush (spec 06 §5.2a). Carries no tool inputs or outputs.
 */
export interface FlushPayload {
  /** The compaction trigger the flush ran for (`'overflow'` = overflow recovery). */
  trigger: 'auto' | 'manual' | 'turn' | 'overflow'
  /** The merged flush prompt. */
  prompt: string
  /** Model id of the flush call. */
  model?: string
  /** Model calls the flush made. */
  steps: number
  /** Tool calls of the flush, in call order. */
  toolCalls: Array<{ toolName: string; status: 'output' | 'error' | 'denied' }>
  usage: { inputTokens: number; outputTokens: number; totalTokens: number }
  /** Estimated USD (spec 12); absent when the model is not priced. */
  costUsd?: number
  /** Set when the flush failed (compaction continued). */
  error?: string
}

/**
 * Data types of the core data parts and kinds (without the `data-` prefix).
 *
 * @see docs/specs/03-messages.md#43-core-data-parts
 */
export type HarnessDataTypes = {
  'eh.status': StatusPartData
  'eh.usage': UsagePartData
  'eh.context': ContextStats
  'eh.warning': WarningPartData
  'eh.input': InputPartData
  'eh.output': OutputPartData
  'eh.compaction': CompactionPayload
  'eh.notice': NoticePayload
  'eh.event': EventPayload
  'eh.rewind': RewindPayload
  'eh.flush': FlushPayload
}

/**
 * The stored and streamed message type: AI SDK `UIMessage` with eharness metadata and data parts.
 *
 * Use {@link InferHarnessUIMessage} to get the exact type of a concrete agent.
 *
 * @see docs/specs/03-messages.md#2-the-message-type
 */
export type HarnessUIMessage<
  AppMeta extends Record<string, unknown> = Record<never, never>,
  Data extends Record<string, unknown> = HarnessDataTypes,
  Tools extends ToolSet = ToolSet,
> = UIMessage<HarnessMetadata & AppMeta, Data, InferUITools<Tools>>

/**
 * Infer the exact message type of an agent (all plugin/app data parts, kinds and static tools).
 *
 * @example
 * ```ts
 * const chat = useChat<InferHarnessUIMessage<typeof agent>>()
 * ```
 * @see docs/specs/03-messages.md#2-the-message-type
 */
export type InferHarnessUIMessage<A> = A extends { '~types': { message: infer M } } ? M : never

/**
 * Context passed to data part and kind projections.
 *
 * @see docs/specs/03-messages.md#6-projection-to-the-model
 */
export interface ProjectionContext {
  /** The message that contains the part / the kind message. */
  message: HarnessUIMessage
  sessionId: string
}

/**
 * Result of a turn (`run.result`). Never rejects.
 *
 * @see docs/specs/10-errors-and-stop-reasons.md#4-stop-reasons
 */
export interface TurnResult<M = HarnessUIMessage, O = unknown> {
  turnId: string
  kind: TurnKind
  /** Assistant message written by the turn. Undefined for early failures and blocks without persist. */
  messageId?: string
  stop: StopReason
  /** Set when stop is `tool-pending`. */
  pending?: PendingState
  /** Messages created by this turn (user, assistant, and any kind messages such as markers). */
  messages: M[]
  /** This turn only; includes `addUsage()` contributions. */
  usage: {
    inputTokens: number
    outputTokens: number
    totalTokens: number
    cachedInputTokens?: number
    cacheWriteTokens?: number
    /** Estimated USD (spec 12); absent when nothing was priced. */
    costUsd?: number
  }
  steps: number
  durationMs: number
  /** Set when stop is `error`; `details` of an `EH_*` error (e.g. `{ reason: 'stale' }`, spec 11). */
  error?: { code?: string; message: string; details?: Record<string, unknown> }
  /**
   * The validated final answer of a turn started with `SendOptions.output` (0.4.0, spec 05 §3.3);
   * typed from the schema. Set only when `stop` is `'complete'` and the answer was valid.
   */
  output?: O
}
