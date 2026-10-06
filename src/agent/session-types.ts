/**
 * Session, run and storage contract types (spec 05, 04 §6–7, 11). Implemented in P2/P7; declared
 * here so the agent API is fully typed.
 *
 * @see docs/specs/05-session-and-storage.md
 */
import type {
  FileUIPart,
  FlexibleSchema,
  InferSchema,
  InferUIMessageChunk,
  JSONValue,
  LanguageModel,
  pipeUIMessageStreamToResponse,
  TextUIPart,
  UIMessage,
} from 'ai'
import type {
  CompactionPayload,
  ContextStats,
  EventPayload,
  FlushPayload,
  HarnessUIMessage,
  NoticePayload,
  PendingExternal,
  PendingState,
  RewindPayload,
  StopReason,
  TurnKind,
  TurnResult,
} from '../messages/types.ts'
import type { OutputSpec } from '../output/types.ts'
import type {
  ClientToolDeclaration,
  ClientToolsOptions,
  PageContextEntry,
  PageContextOptions,
} from '../registry/request-tools.ts'
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
  'eh.flush': FlushPayload
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
   * - `{ fromId }` → all messages with id >= fromId (inclusive, compared: fromId need not be
   *   stored), no limit
   * - `{ beforeId, limit }` → the `limit` newest messages with id < beforeId
   * - `{ beforeId }` → all messages with id < beforeId
   * - `{ limit }` → the `limit` newest messages
   * - `{}` → all messages
   */
  load(q: { sessionId: string; fromId?: string; beforeId?: string; limit?: number }): Promise<M[]>
  /** Upsert by id (idempotent): replaces the whole message, never merges. */
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
 * A request, written by another instance, to abort the turn `turnId` (cross-process abort). The
 * only `state.core` field a foreign instance may write while a turn runs.
 *
 * @see docs/specs/05-session-and-storage.md#91-cross-process-abort
 */
export interface AbortRequest {
  /** The turn to abort; an owner ignores (and clears) a request for any other turn. */
  turnId: string
  /** Epoch ms of the request. */
  at: number
  /** Abort reason (the terminal `abort` chunk's `reason`). */
  reason?: string
  /** Instance id of the requester. */
  by?: string
}

/**
 * Where `session.requestAbort()` sent the abort: a turn of this process (`'local'`), a turn running
 * in another instance (`'remote'`), nowhere because no turn runs (`'idle'`), or nowhere because the
 * storage cannot carry the request (`'unsupported'`: no `StateAdapter.setIf`, or `recovery: false`).
 *
 * @see docs/specs/05-session-and-storage.md#91-cross-process-abort
 */
export interface AbortRequestResult {
  target: 'local' | 'remote' | 'idle' | 'unsupported'
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
    /** A cross-process abort request for the active turn (spec 05 §9.1). */
    abortRequest?: AbortRequest
    /**
     * Ids of the last 100 `wake` inbox items applied to this session (dedupe, spec 05 §12; send
     * items and steers are deduped by the `inboxId` of their stored messages).
     */
    inboxDelivered?: string[]
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
 * User input in the serialized (JSON) form an inbox stores: normalized `text` / `file` parts, the
 * client's message id and, with `acceptClientMetadata`, app metadata keys.
 *
 * @see docs/specs/05-session-and-storage.md#12-inbox
 */
export interface SerializedInput {
  parts: Array<TextUIPart | FileUIPart>
  clientId?: string
  appMetadata?: Record<string, JSONValue>
}

/**
 * Debounce of `collect` inputs: they are merged into one user message after `quietMs` without a
 * new item, `maxWaitMs` after the first one, or once `maxItems` are waiting.
 *
 * @see docs/specs/05-session-and-storage.md#12-inbox
 */
export interface CollectOptions {
  /** Default 1 500. */
  quietMs?: number
  /** Default 10 000. */
  maxWaitMs?: number
  /** Default 20. */
  maxItems?: number
}

/**
 * What an {@link InboxAdapter} stores: an input for the session (`send`), a wake-up for a kind
 * message another instance already saved (`wake`), or an abort request (`abort`). `at` is the
 * enqueue time (epoch ms). `availableAt` (epoch ms, optional) makes the item claimable only from
 * then on: until then it is invisible and does not hold back the items after it (a durable timer,
 * not a queue entry; spec 05 §12 rule 14).
 *
 * @see docs/specs/05-session-and-storage.md#12-inbox
 */
export type InboxItemInput =
  | {
      kind: 'send'
      mode: 'queue' | 'steer' | 'collect'
      input: SerializedInput
      collect?: CollectOptions
      at: number
      availableAt?: number
    }
  | { kind: 'wake'; messageId: string; at: number; availableAt?: number }
  | { kind: 'abort'; turnId?: string; reason?: string; at: number; availableAt?: number }
  | { kind: 'wait-timeout'; waitId: string; at: number; availableAt?: number }

/**
 * A stored inbox item: the input plus its id (time-sortable, assigned by the adapter), the
 * number of counted claims (`attempts`, spec 05 §12 rule 11) and the error of the last failed
 * attempt (`lastError`, set by `release(…, { lastError })`).
 *
 * @see docs/specs/05-session-and-storage.md#12-inbox
 */
export type InboxItem = InboxItemInput & { id: string; attempts: number; lastError?: string }

/**
 * A dead-lettered inbox item (spec 05 §12 rule 12): kept by the adapter, never claimed, listed by
 * `listDead()` and made ready again by `redrive()`. `reason` is `'max-attempts'` or
 * `'non-retryable'`; `deadAt` is epoch ms.
 *
 * @see docs/specs/05-session-and-storage.md#12-inbox
 */
export type DeadInboxItem = InboxItem & { sessionId: string; deadAt: number; reason: string }

/**
 * Options of `InboxAdapter.release()` (spec 05 §12 rule 11). An adapter that ignores them keeps
 * the 0.4 behaviour (ready at once, every claim counted).
 *
 * @see docs/specs/05-session-and-storage.md#12-inbox
 */
export interface InboxReleaseOptions {
  /**
   * The items become claimable only after `now + delayMs` (retry backoff). A delayed item keeps
   * its place: `send` / `wake` items behind it are not claimed meanwhile (`abort` items are).
   */
  delayMs?: number
  /**
   * A deferral, not a failed attempt (the core held the items without trying them): undo the
   * `attempts` increment of the claim being released.
   */
  uncount?: boolean
  /** The error of the failed attempt, returned as `lastError` by later claims. */
  lastError?: string
}

/**
 * Counts of `InboxAdapter.stats()`: `ready` (due, not claimed, not dead), `claimed` (a live
 * claim), `delayed` (released with `delayMs` or `availableAt` in the future), `dead`.
 *
 * @see docs/specs/05-session-and-storage.md#12-inbox
 */
export interface InboxStats {
  ready: number
  claimed: number
  delayed: number
  dead: number
}

/**
 * Optional durable inbox of a multi-instance deployment: inputs, wake-ups and abort requests for a
 * session, drained by whichever instance holds the session (spec 05 §12). eharness ships only
 * `memoryInbox()` (`eharness/storage/memory`) and `inboxAdapterConformance` (`eharness/testing`).
 *
 * @see docs/specs/05-session-and-storage.md#12-inbox
 */
export interface InboxAdapter {
  /** Store an item; durable before the promise resolves. Returns its id (time-sortable). */
  enqueue(sessionId: string, item: InboxItemInput): Promise<string>
  /**
   * Atomically claim the ready items of a session for `owner`, oldest (lowest id) first, at most
   * `limit`. Claimed items are invisible to other claims until `ack` / `release` or until the
   * claim expires (`claimTtlMs`). Every claim increments `attempts`.
   *
   * Head of line: never return an item behind an older item of the session that another owner
   * still holds. Renewal: items `owner` already holds get their claim extended to
   * `now + claimTtlMs` (not returned again, `attempts` unchanged).
   */
  claim(
    sessionId: string,
    owner: string,
    opts?: { limit?: number; claimTtlMs?: number },
  ): Promise<InboxItem[]>
  /** Remove items (their effect is durable). Unknown ids are ignored. */
  ack(ids: string[]): Promise<void>
  /**
   * Make claimed items ready again. Unknown ids are ignored. `opts` (optional to honour, spec 05
   * §12 rule 11): `delayMs` backoff, `uncount` for deferrals, `lastError`.
   */
  release(ids: string[], opts?: InboxReleaseOptions): Promise<void>
  /** Optional: wake the instances subscribed to the session (LISTEN/NOTIFY, pub/sub). */
  notify?(sessionId: string): Promise<void>
  /** Optional: called on `notify` of the session; returns the unsubscribe function. */
  subscribe?(sessionId: string, onNotify: () => void): () => void
  /** Optional: ids of sessions with claimable items (the oldest is not claimed; a sweeper). */
  pending?(opts?: { limit?: number }): Promise<string[]>
  /**
   * Optional: move items to dead (kept, never claimed, listed by `listDead`). Without it the
   * core acks dead items after reporting them (spec 05 §12 rule 12). Unknown ids are ignored.
   */
  deadLetter?(ids: string[], info: { reason: string; lastError?: string }): Promise<void>
  /**
   * Optional: dead items become ready again with `attempts` 0, in their original id order.
   * Unknown ids and ids that are not dead are ignored.
   */
  redrive?(ids: string[]): Promise<void>
  /** Optional: dead items, oldest (lowest id) first (an admin UI). */
  listDead?(opts?: { sessionId?: string; limit?: number }): Promise<DeadInboxItem[]>
  /** Optional: item counts for metrics; without `sessionId` over the whole inbox. */
  stats?(opts?: { sessionId?: string }): Promise<InboxStats>
}

/**
 * Options of `session.enqueue()`.
 *
 * @see docs/specs/05-session-and-storage.md#12-inbox
 */
export interface EnqueueOptions {
  /**
   * `'queue'` (default): a turn of its own after the running one. `'steer'`: delivered into the
   * running turn at its next step boundary (a queued turn when none runs). `'collect'`: merged
   * with other `collect` inputs into one user message (debounced, {@link CollectOptions}).
   */
  mode?: 'queue' | 'steer' | 'collect'
  collect?: CollectOptions
}

/**
 * Result of `session.enqueue()`: the item id (`metadata.eharness.inboxId` / `collected` of the
 * user message it becomes) and where it will be applied — in this process (`'local'`) or by the
 * instance whose turn is running (`'remote'`, best effort: the holder is decided when it drains).
 *
 * @see docs/specs/05-session-and-storage.md#12-inbox
 */
export interface EnqueueResult {
  inboxId: string
  target: 'local' | 'remote'
}

/**
 * Options of `agent.session(id, options)`.
 *
 * @see docs/specs/05-session-and-storage.md#1-session-options
 */
export interface SessionOptions {
  storage?: { messages?: MessageAdapter; state?: StateAdapter; inbox?: InboxAdapter }
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
  /**
   * While a turn runs: reject (default, `EH_SESSION_BUSY`), queue or steer (`send()` only), or
   * `'wait'` (`send()` and `respond()`): wait for the running turn and the queue ahead, then run.
   * A waiting `send()` is held while approvals created by a turn it waited for are pending (it
   * never denies them); `abortSignal` drops it while it waits (`stop: 'aborted'`). `'collect'`
   * (`send()` only): merged with other collected inputs into one queued turn (`collect`).
   */
  ifBusy?: 'reject' | 'queue' | 'steer' | 'wait' | 'collect'
  /** Debounce of `ifBusy: 'collect'` (defaults: `config.inbox.collect`, then 1 500 / 10 000 / 20). */
  collect?: CollectOptions
  model?: LanguageModel
  settings?: Partial<ModelSettings>
  /** Validated with `config.callOptions`. */
  options?: unknown
  /** Overrides `loop.maxSteps` for this turn. */
  maxSteps?: number
  abortSignal?: AbortSignal
  runtime?: Record<string, unknown>
  toolsContext?: Record<string, unknown>
  /**
   * Ask this turn for a typed final answer (0.4.0): validated against `output.schema`, retried on
   * invalid answers, returned as `TurnResult.output`. Server-side only (`handleChatRequest` never
   * reads it from a request body); not carried over a `'tool-pending'` stop — pass it again to
   * `respond()`. With `ifBusy: 'steer'` or `'collect'` the run fails with `EH_INVALID_INPUT`
   * (`details.reason: 'output-with-steer-or-collect'`). Spec 05 §3.3.
   */
  output?: OutputSpec
  /**
   * Client tools declared for this turn only (0.5.0, spec 11 §7.1): AI SDK tools without
   * `execute` built from the declarations, answered by the client (`respond()`). Untrusted:
   * validated all-or-nothing (names, schema size, collisions with server tools; run error
   * `EH_INVALID_INPUT`, `details.reason: 'client-tools'`), no implied permission (approval rules
   * apply), appended after the static tools. Re-declare them on `respond()`; not carried over a
   * `'tool-pending'` stop. `handleChatRequest` reads them from the body only when enabled.
   */
  clientTools?: ClientToolDeclaration[]
  /** Limits and filters of {@link SendOptions.clientTools} (`allow`, `maxTools`, `timeoutMs`, …). */
  clientToolsOptions?: ClientToolsOptions
  /**
   * Page context for this turn only (0.5.0, spec 11 §7.1 rule 6): delivered in the turn reminder,
   * framed as data (tags neutralised, capped), never stored and never in `instructions`.
   */
  pageContext?: PageContextEntry[]
  /** Limits of {@link SendOptions.pageContext} (`maxChars`, default 4 000). */
  pageContextOptions?: PageContextOptions
}

/** {@link SendOptions} with a typed {@link OutputSpec} (the `send()` overload that types `output`). */
export type SendOptionsWithOutput<S extends FlexibleSchema> = SendOptions & {
  output: OutputSpec<S>
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
 * Who answered an approval (spec 11 §3.2). `id` is the application's user id; the object is
 * passed to `approval.decided` hooks as given (JSON values only).
 */
export interface ApprovalActor {
  id: string
  name?: string
  [key: string]: JSONValue | undefined
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
    /** Who answered (for audit, `approval.decided`); never sent to the model. */
    actor?: ApprovalActor
  }>
  toolOutputs?: Array<
    { toolCallId: string; output: unknown } | { toolCallId: string; errorText: string }
  >
  /**
   * Results of external waits (`externalTool()`, 0.5.0), answered all at once with the rest. An
   * external wait whose result `resolveWait()` already recorded is used as recorded and must not
   * be answered again here. A client output for an external call is `EH_INVALID_INPUT`
   * (`'wrong-kind'`): only the server resolves waits.
   */
  externals?: Array<{ waitId: string; output: unknown } | { waitId: string; errorText: string }>
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
  | { type: 'wait-resolved'; waitId: string; by: 'result' | 'timeout' | 'cancel' }
  | {
      type: 'input-dropped'
      reason: 'tool-pending' | 'aborted' | 'blocked'
      text: string
      clientId?: string
    }
  | { type: 'message'; message: M }
  | { type: 'data'; chunk: DataChunkOf<M> }
  | { type: 'status'; running: boolean }
  | {
      type: 'inbox-enqueued'
      inboxId: string
      kind: InboxItem['kind']
      mode?: 'queue' | 'steer' | 'collect'
    }
  | { type: 'inbox-drained'; inboxIds: string[]; turnId?: string }
  | {
      type: 'inbox-dead'
      inboxId: string
      kind: InboxItem['kind']
      reason: string
      attempts: number
    }

/**
 * A running (or finished) turn.
 *
 * @see docs/specs/04-streaming.md#7-harnessrun-and-responses
 */
export interface HarnessRun<M extends UIMessage = HarnessUIMessage, O = never> {
  readonly turnId: string
  readonly kind: TurnKind
  /** Assistant message id; resolves when `start` is written. */
  readonly messageId: Promise<string>
  /** The UI message stream. Single consumer. */
  readonly stream: ReadableStream<InferUIMessageChunk<M>>
  /**
   * Resolves after the turn is fully persisted. Never rejects. `output` is typed `O` for a turn
   * started with `SendOptions.output` (spec 05 §3.3).
   */
  readonly result: Promise<TurnResult<M, O>>
  abort(reason?: string): void
  /** `createUIMessageStreamResponse({ stream })`. */
  toResponse(init?: ResponseInit): Response
  /** `pipeUIMessageStreamToResponse` for Node's `ServerResponse`. */
  pipeTo(response: Parameters<typeof pipeUIMessageStreamToResponse>[0]['response']): Promise<void>
}

/**
 * Outcome of `session.resolveWait()`: `continued` (the continuation turn runs), `recorded`
 * (stored; `remaining` items still wait), `already-resolved` (a result was recorded before:
 * idempotent no-op) or `not-pending` (unknown wait, or the pending state was consumed).
 *
 * @see docs/specs/11-interaction.md#42-external-waits
 */
export type ResolveWaitResult<M extends UIMessage = HarnessUIMessage> =
  | { status: 'continued'; run: HarnessRun<M> }
  | { status: 'recorded'; remaining: number }
  | { status: 'already-resolved' }
  | { status: 'not-pending' }

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
  /**
   * Start a turn. `input` omitted = continue from history. With `options.output`, `result.output`
   * is the validated final answer, typed from the schema (spec 05 §3.3).
   */
  send<S extends FlexibleSchema>(
    input: SendInput | undefined,
    options: SendOptionsWithOutput<S>,
  ): HarnessRun<M, InferSchema<S>>
  send(input?: SendInput, options?: SendOptions): HarnessRun<M>
  /**
   * Answer pending approvals / client tool calls and continue that message. The output spec of the
   * turn that stopped `'tool-pending'` is not carried over: pass `output` again.
   */
  respond<S extends FlexibleSchema>(
    response: PendingResponse,
    options: SendOptionsWithOutput<S>,
  ): HarnessRun<M, InferSchema<S>>
  respond(response: PendingResponse, options?: SendOptions): HarnessRun<M>
  /** Answer again. */
  regenerate<S extends FlexibleSchema>(
    options: { messageId?: string } & SendOptionsWithOutput<S>,
  ): HarnessRun<M, InferSchema<S>>
  regenerate(options?: { messageId?: string } & SendOptions): HarnessRun<M>
  /** Replace a user message and answer it. */
  edit<S extends FlexibleSchema>(
    messageId: string,
    input: SendInput,
    options: SendOptionsWithOutput<S>,
  ): HarnessRun<M, InferSchema<S>>
  edit(messageId: string, input: SendInput, options?: SendOptions): HarnessRun<M>
  /** Replay + follow the running turn. */
  attach(): HarnessRun<M> | undefined
  /**
   * Abort the running turn. Queued turns are dropped. When no turn of this session runs in this
   * process, it requests the abort of a turn running in another instance (fire-and-forget form of
   * {@link HarnessSession.requestAbort}; failures are logged).
   */
  abort(reason?: string): void
  /**
   * Awaitable abort that tells where the abort went: a local turn, a turn running in another
   * instance (stopped at its next step boundary or heartbeat, `stop: 'aborted'`), `'idle'` or
   * `'unsupported'` (`W_ABORT_UNSUPPORTED`). Queued turns are dropped like `abort()`. Rejects with
   * `EH_STORAGE` when the state cannot be read, `EH_SESSION_CLOSED` after `close()`.
   *
   * @see docs/specs/05-session-and-storage.md#91-cross-process-abort
   */
  requestAbort(reason?: string): Promise<AbortRequestResult>
  /**
   * Hand an input to whichever instance holds the session: with `storage.inbox` it is stored
   * durably first and applied by the instance running (or next running) the session; without
   * one it is applied in this process. `mode`: `'queue'` (default), `'steer'` or `'collect'`.
   * Rejects with `EH_INVALID_INPUT` (input), `EH_STORAGE` (inbox) or `EH_SESSION_CLOSED`.
   *
   * @see docs/specs/05-session-and-storage.md#12-inbox
   */
  enqueue(input: SendInput, options?: EnqueueOptions): Promise<EnqueueResult>
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
  /**
   * Record the result of an external wait (`externalTool()`, spec 11 §4.2) from any instance:
   * validated against the tool's `outputSchema`, passed through `tool.after` and the output
   * limits, written with a compare-and-set. The first result wins. When it leaves nothing
   * pending, the **same** assistant message continues like a `respond()` continuation.
   * `actor` is reserved for audit. Rejects with `EH_INVALID_INPUT` (`'invalid-result'`),
   * `EH_STORAGE`, `EH_SESSION_BUSY` (a turn runs here) or `EH_SESSION_CLOSED`.
   */
  resolveWait(
    waitId: string,
    result: { output: unknown } | { errorText: string },
    options?: SendOptions & { actor?: ApprovalActor },
  ): Promise<ResolveWaitResult<M>>
  /**
   * Expire every external wait whose `timeoutAt` is due (default `now` = `Date.now()`): each takes
   * its `onTimeout` result through the same compare-and-set as `resolveWait()`; a pending state
   * whose waits are all resolved continues. For cron sweepers without an inbox.
   */
  expireWaits(now?: number): Promise<{ expired: string[]; run?: HarnessRun<M> }>
  /** The external waits of the stored pending state (a read helper for UIs and sweepers). */
  pendingWaits(): Promise<PendingExternal[]>
  /** Read history for UIs (newest `limit` before `beforeId`, chronological). */
  messages(q?: { beforeId?: string; limit?: number; includeHidden?: boolean }): Promise<M[]>
  /** Current context stats and pending state. */
  stats(): Promise<ContextStats & { pending: PendingState | null; activeTurn: ActiveTurn | null }>
  events(): ReadableStream<SessionEvent<M>>
  /**
   * Resolves when no turn runs and nothing is queued (also after `close()`). A queue held by
   * pending approvals keeps it waiting until `respond()` (or `abort()` drops the queue).
   */
  idle(): Promise<void>
  close(): Promise<void>
}
