/**
 * Session, run and storage contract types (spec 05, 04 §6–7, 11). Implemented in P2/P7; declared
 * here so the agent API is fully typed.
 *
 * @see docs/specs/05-session-and-storage.md
 */
import type {
  FileUIPart,
  InferUIMessageChunk,
  JSONValue,
  LanguageModel,
  pipeUIMessageStreamToResponse,
  UIMessage,
} from 'ai'
import type {
  CompactionPayload,
  ContextStats,
  EventPayload,
  HarnessUIMessage,
  NoticePayload,
  PendingState,
  RewindPayload,
  StopReason,
  TurnKind,
  TurnResult,
} from '../messages/types.ts'
import type { ModelSettings } from './types.ts'

/**
 * Payload types of the core message kinds.
 *
 * @see docs/specs/03-messages.md#53-core-kinds
 */
export type HarnessKindTypes = {
  'eh.compaction': CompactionPayload
  'eh.notice': NoticePayload
  'eh.event': EventPayload
  'eh.rewind': RewindPayload
}

/** Kind names of a kind payload map (e.g. `AgentKindTypes<C>`). */
export type KindName<Kinds> = keyof Kinds & string

/** Payload type of kind `K` in a kind payload map. */
export type KindData<Kinds, K extends keyof Kinds> = Kinds[K]

/**
 * Message storage contract (2 methods + optional `lastId`).
 *
 * @see docs/specs/05-session-and-storage.md#4-messageadapter-the-storage-contract
 */
export interface MessageAdapter<M extends UIMessage = UIMessage> {
  /**
   * Chronological (ascending id) messages of a session.
   * - `{ fromId }` → all messages with id >= fromId (inclusive), no limit
   * - `{ beforeId, limit }` → the `limit` newest messages with id < beforeId
   * - `{ limit }` → the `limit` newest messages
   * - `{}` → all messages
   */
  load(q: { sessionId: string; fromId?: string; beforeId?: string; limit?: number }): Promise<M[]>
  /** Upsert by id (idempotent). */
  save(sessionId: string, messages: M[]): Promise<void>
  /** Optional: id of the newest message, for multi-instance cache validation. */
  lastId?(sessionId: string): Promise<string | null>
}

/**
 * The turn currently running somewhere (crash recovery).
 *
 * @see docs/specs/05-session-and-storage.md#9-crash-recovery
 */
export interface ActiveTurn {
  turnId: string
  kind: TurnKind
  messageId: string
  userMessageId?: string
  owner: string
  startedAt: number
  heartbeatAt: number
}

/**
 * Persisted session state.
 *
 * @see docs/specs/05-session-and-storage.md#7-state
 */
export interface SessionStateSnapshot {
  v: 1
  /** Incremented by the core on every write. */
  rev: number
  core: {
    compaction?: { markerId: string; resumeFromId: string | null }
    /** `costUsd`: estimated USD of all turns (spec 12), when anything was priced. */
    usage?: { inputTokens: number; outputTokens: number; turns: number; costUsd?: number }
    activeTurn?: ActiveTurn
    pending?: PendingState
    grants?: Record<string, 'always' | 'never'>
    rewinds?: Array<{ afterId: string | null; rewindId: string }>
  }
  plugins: Record<string, Record<string, JSONValue>>
}

/**
 * Session state storage contract.
 *
 * @see docs/specs/05-session-and-storage.md#7-state
 */
export interface StateAdapter {
  get(sessionId: string): Promise<SessionStateSnapshot | null>
  set(sessionId: string, state: SessionStateSnapshot): Promise<void>
  /** Optional compare-and-set on `rev` (`null` = no snapshot yet). Returns false on conflict. */
  setIf?(
    sessionId: string,
    state: SessionStateSnapshot,
    expectedRev: number | null,
  ): Promise<boolean>
}

/**
 * Cross-process mutual exclusion for turns.
 *
 * @see docs/specs/05-session-and-storage.md#8-concurrency-and-locking
 */
export interface SessionLock {
  /** Resolve with a release function, or reject if locked elsewhere. Must not block indefinitely. */
  acquire(sessionId: string, opts: { signal: AbortSignal }): Promise<() => Promise<void>>
}

/**
 * Options of `agent.session(id, options)`.
 *
 * @see docs/specs/05-session-and-storage.md#1-session-options
 */
export interface SessionOptions {
  storage?: { messages?: MessageAdapter; state?: StateAdapter }
  runtime?: Record<string, unknown>
  /** AI SDK `toolsContext`: map keyed by final tool name. */
  toolsContext?: Record<string, unknown>
  lock?: SessionLock
  /** Policy for invalid stored messages. Default `'drop'`. */
  onInvalidMessage?: 'drop' | 'keep' | 'throw'
  /** Keep app-level metadata keys sent by the client on user messages. Default false. */
  acceptClientMetadata?: boolean
  /** Marks a child session (subagent). Depth > 8 is rejected. */
  parent?: { sessionId: string; turnId: string; toolCallId?: string; depth: number }
}

/**
 * Input of `send()` / `edit()`.
 *
 * @see docs/specs/05-session-and-storage.md#2-session-api
 */
export type SendInput = string | { text?: string; files?: FileUIPart[] } | UIMessage

/**
 * Per-call options of turn operations.
 *
 * @see docs/specs/05-session-and-storage.md#2-session-api
 */
export interface SendOptions {
  /** Only for `send()`: reject (default), queue or steer while a turn runs. */
  ifBusy?: 'reject' | 'queue' | 'steer'
  model?: LanguageModel
  settings?: Partial<ModelSettings>
  /** Validated with `config.callOptions`. */
  options?: unknown
  /** Overrides `loop.maxSteps` for this turn. */
  maxSteps?: number
  abortSignal?: AbortSignal
  runtime?: Record<string, unknown>
  toolsContext?: Record<string, unknown>
}

/**
 * Options of `session.inject()`.
 *
 * @see docs/specs/11-interaction.md
 */
export interface InjectOptions {
  deliver?: 'next-turn' | 'next-step'
  wake?: boolean
}

/**
 * Answers to pending approvals / client tool calls.
 *
 * @see docs/specs/11-interaction.md#4-respond
 */
export interface PendingResponse {
  approvals?: Array<{
    id: string
    approved: boolean
    reason?: string
    remember?: 'once' | 'session'
  }>
  toolOutputs?: Array<
    { toolCallId: string; output: unknown } | { toolCallId: string; errorText: string }
  >
}

/** A data chunk of a message type. */
export type DataChunkOf<M extends UIMessage> = Extract<
  InferUIMessageChunk<M>,
  { type: `data-${string}` }
>

/**
 * Events of the long-lived session channel (`session.events()`).
 *
 * @see docs/specs/04-streaming.md#6-turn-buffer-attach-and-session-events
 */
export type SessionEvent<M extends UIMessage = HarnessUIMessage> =
  | { type: 'turn-start'; turnId: string; messageId: string; kind: TurnKind; queued: boolean }
  | { type: 'turn-end'; turnId: string; messageId: string; stop: StopReason }
  | { type: 'pending'; pending: PendingState | null }
  | {
      type: 'input-dropped'
      reason: 'tool-pending' | 'aborted' | 'blocked'
      text: string
      clientId?: string
    }
  | { type: 'message'; message: M }
  | { type: 'data'; chunk: DataChunkOf<M> }
  | { type: 'status'; running: boolean }

/**
 * A running (or finished) turn.
 *
 * @see docs/specs/04-streaming.md#7-harnessrun-and-responses
 */
export interface HarnessRun<M extends UIMessage = HarnessUIMessage> {
  readonly turnId: string
  readonly kind: TurnKind
  /** Assistant message id; resolves when `start` is written. */
  readonly messageId: Promise<string>
  /** The UI message stream. Single consumer. */
  readonly stream: ReadableStream<InferUIMessageChunk<M>>
  /** Resolves after the turn is fully persisted. Never rejects. */
  readonly result: Promise<TurnResult<M>>
  abort(reason?: string): void
  /** `createUIMessageStreamResponse({ stream })`. */
  toResponse(init?: ResponseInit): Response
  /** `pipeUIMessageStreamToResponse` for Node's `ServerResponse`. */
  pipeTo(response: Parameters<typeof pipeUIMessageStreamToResponse>[0]['response']): Promise<void>
}

/**
 * A live session.
 *
 * `Kinds` is the kind payload map of the agent (core + app + plugin kinds), used by `inject`.
 *
 * @see docs/specs/05-session-and-storage.md#2-session-api
 */
export interface HarnessSession<
  M extends UIMessage = HarnessUIMessage,
  Kinds extends Record<string, unknown> = HarnessKindTypes,
> {
  readonly id: string
  readonly running: boolean
  /** Open the session now and surface configuration errors. Idempotent. */
  ready(): Promise<void>
  /** Start a turn. `input` omitted = continue from history. */
  send(input?: SendInput, options?: SendOptions): HarnessRun<M>
  /** Answer pending approvals / client tool calls and continue that message. */
  respond(response: PendingResponse, options?: SendOptions): HarnessRun<M>
  /** Answer again. */
  regenerate(options?: { messageId?: string } & SendOptions): HarnessRun<M>
  /** Replace a user message and answer it. */
  edit(messageId: string, input: SendInput, options?: SendOptions): HarnessRun<M>
  /** Replay + follow the running turn. */
  attach(): HarnessRun<M> | undefined
  /** Abort the running turn. Queued turns are dropped. */
  abort(reason?: string): void
  /** Save a kind message; optionally deliver it into the running turn or wake the agent. */
  inject<K extends KindName<Kinds>>(
    kind: K,
    data: KindData<Kinds, K>,
    options?: InjectOptions,
  ): Promise<{ message: M; run?: HarnessRun<M> }>
  /** Manual compaction. */
  compact(): Promise<M | null>
  /** Forget session approval grants. */
  clearGrants(): Promise<void>
  /** Read history for UIs (newest `limit` before `beforeId`, chronological). */
  messages(q?: { beforeId?: string; limit?: number; includeHidden?: boolean }): Promise<M[]>
  /** Current context stats and pending state. */
  stats(): Promise<ContextStats & { pending: PendingState | null; activeTurn: ActiveTurn | null }>
  events(): ReadableStream<SessionEvent<M>>
  close(): Promise<void>
}
