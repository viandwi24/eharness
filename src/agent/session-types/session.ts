/**
 * Run, session event and `HarnessSession` types.
 *
 * @see docs/specs/05-session-and-storage.md
 */
import type {
  FlexibleSchema,
  InferSchema,
  InferUIMessageChunk,
  pipeUIMessageStreamToResponse,
  UIMessage,
} from 'ai'
import type {
  ContextStats,
  HarnessUIMessage,
  PendingExternal,
  PendingState,
  StopReason,
  TurnKind,
  TurnResult,
} from '../../messages/types.ts'
import type { SessionToolInfo } from '../../registry/inventory.ts'
import type { EnqueueOptions, EnqueueResult, InboxItem } from './inbox.ts'
import type { HarnessKindTypes, KindData, KindName } from './kinds.ts'
import type { ChildSessionInfo, CompactOptions, ForkOptions, ParentInfo } from './storage.ts'
import type {
  AbortRequestResult,
  ActiveTurn,
  ApprovalActor,
  InjectOptions,
  PendingResponse,
  RecoverResult,
  SendInput,
  SendOptions,
  SendOptionsWithOutput,
  SessionBusy,
  SessionUsage,
} from './turn.ts'

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

/** Outcome of a steer (`HarnessRun.delivery`). */
export type SteerDelivery = 'step' | 'turn' | 'dropped'

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
  /**
   * Only on the run of `send(input, { ifBusy: 'steer' })` (0.7.0, spec 05 §2): where the input
   * went. `'step'`: delivered at a step boundary of the running turn (this run follows that turn).
   * `'turn'`: no turn took it and it runs as a queued turn of its own (when the running turn
   * refused it at once, this run is that queued turn's; when the turn ended without taking it,
   * the run is still the first turn's — follow the new one with `attach()` / `events()`).
   * `'dropped'`: not delivered — the turn stopped `'tool-pending'`, was aborted, or an
   * `input.submit` hook blocked it (`input-dropped` event). Never rejects.
   */
  readonly delivery?: Promise<SteerDelivery>
  /**
   * Resolves `undefined` once the turn is accepted (it passed its commit point, or ended without
   * an error: blocked, aborted) and the error of a turn that failed **before** its commit point
   * (busy, invalid input, no pending answer; nothing was persisted). Runs of `attach()` /
   * `attachRemote()` resolve `undefined` at once. Never rejects.
   */
  readonly accepted: Promise<NonNullable<TurnResult['error']> | undefined>
  abort(reason?: string): void
  /**
   * The safe HTTP answer: waits for {@link HarnessRun.accepted} first, so a turn that failed
   * before its commit point answers an HTTP status with a JSON body `{ error: { code, message } }`
   * (`EH_SESSION_BUSY` / `EH_SESSION_CLOSED` 409, `EH_INVALID_INPUT` / `EH_PENDING_RESPONSE` /
   * `EH_INVALID_MESSAGE` 400, `EH_STORAGE` 503, others 500); every other turn streams as
   * {@link HarnessRun.toStreamResponse} does, and failures after the stream started stay in the
   * stream (spec 04 §7).
   */
  toResponse(init?: ResponseInit): Promise<Response>
  /**
   * `createUIMessageStreamResponse({ stream })` at once: always status 200, even when the turn
   * fails before its commit point (the error is an in-stream `error` chunk). Prefer
   * {@link HarnessRun.toResponse} for an HTTP handler.
   */
  toStreamResponse(init?: ResponseInit): Response
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
    options: { messageId: string; input: SendInput } & SendOptionsWithOutput<S>,
  ): HarnessRun<M, InferSchema<S>>
  edit(options: { messageId: string; input: SendInput } & SendOptions): HarnessRun<M>
  /** Replay + follow the running turn of this process. */
  attach(): HarnessRun<M> | undefined
  /**
   * Replay + follow the active turn of this session from the stream log (`storage.streams`), also
   * when another instance runs it (spec 04 §6.2, ADR-0039). Replays from cursor `from` (default 0,
   * chunk index), then follows until the log closes; `signal` stops the reader (never the turn).
   * Resolves `undefined` when nothing is active, no log is configured or it expired: fall back to
   * the stored messages. A turn of this process is served from the turn buffer.
   *
   * @experimental Draft (stream log, spec 04 §6): may change in a minor release (docs/engineering/api-stability.md).
   */
  attachRemote(options?: {
    from?: number
    signal?: AbortSignal
  }): Promise<HarnessRun<M> | undefined>
  /**
   * Called synchronously whenever ANY turn of this session starts in this process: `send`,
   * `respond`, `regenerate`, `edit`, a queued turn (`ifBusy: 'queue' | 'wait' | 'collect'`, the
   * fallback of a steer), a wake (`inject(…, { wake: true })`, `ctx.session.inject`, background
   * deliveries) and a turn the inbox drain starts. It is called before the turn's stream is read.
   *
   * Every listener gets its OWN run object, a reader of the turn buffer like `attach()` (replay
   * from the first chunk + follow): consuming `run.stream` of a listener never takes anything
   * from the caller of `send()` or from other listeners, and a listener that never reads it costs
   * only the (already kept) turn buffer. `abort()` of that run aborts the turn. A listener that
   * throws is logged and skipped. Returns the unsubscribe function; `close()` drops all.
   *
   * In-process only (deployment profiles b/c in one process, ADR-0034): a turn started by another
   * instance is not announced; use `events()` + `attach()` there.
   *
   * @see docs/specs/05-session-and-storage.md#2-session-api
   */
  onRun(listener: (run: HarnessRun<M>) => void): () => void
  /**
   * Abort the running turn and drop the queued ones. Tells where the abort went: a local turn, a
   * turn running in another instance (stopped at its next step boundary or heartbeat,
   * `stop: 'aborted'`), `'idle'` or `'unsupported'` (`W_ABORT_UNSUPPORTED`). Rejects with
   * `EH_STORAGE` when the state cannot be read, `EH_SESSION_CLOSED` after `close()`. For the
   * handle of one local run use {@link HarnessRun.abort}.
   *
   * @see docs/specs/05-session-and-storage.md#91-cross-process-abort
   */
  abort(reason?: string): Promise<AbortRequestResult>
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
  /**
   * Manual compaction (spec 06 §4). `options.keepLast` / `options.instructions` apply to this
   * call only. Rejects `EH_INVALID_INPUT` for an invalid option.
   */
  compact(options?: CompactOptions): Promise<M | null>
  /**
   * Repair an interrupted turn now (spec 05 §9.2), without waiting for the next operation: a
   * stored `activeTurn` that is stale (see `recovery`) is closed the way the commit point of the
   * next turn would close it: dangling tool calls answered `Interrupted:` (ADR-0014), the message
   * marked `stop: 'interrupted'`, an `eh.notice`, `activeTurn` cleared. Idempotent. Throws
   * `EH_SESSION_BUSY` only when a turn of this process runs.
   */
  recover(): Promise<RecoverResult>
  /** Forget session approval grants. */
  clearGrants(): Promise<void>
  /**
   * Create a new session from the messages of this one (before `beforeMessageId`, default all) and
   * the state that stays valid for them; the lineage is stored in the new state's
   * `core.forkedFrom`. Message ids are kept. Rejects with `EH_SESSION_BUSY` while a turn of this
   * session runs (here or in another instance), `EH_INVALID_INPUT` when the copy would include a
   * pending message, the new id exists, or `id` is this session's, `EH_STORAGE`, or
   * `EH_SESSION_CLOSED`. Returns the opened handle of the new session (cached in the agent).
   *
   * @see docs/specs/05-session-and-storage.md#14-fork
   */
  fork(options?: ForkOptions): Promise<HarnessSession<M, Kinds>>
  /**
   * Child sessions that registered with this session as their `parent`, oldest first, read from
   * the stored state (works in any instance, after restarts).
   *
   * @see docs/specs/05-session-and-storage.md#13-parent-and-child-sessions
   */
  children(): Promise<ChildSessionInfo[]>
  /** The stored `parent` of this session, `undefined` for a root session. */
  parentInfo(): Promise<ParentInfo | undefined>
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
  stats(): Promise<
    ContextStats & {
      pending: PendingState | null
      activeTurn: ActiveTurn | null
      /** Cumulative usage of all finished turns of this session (spec 05 §7, spec 12). */
      usage: SessionUsage
    }
  >
  /**
   * Whether a turn is running right now, in this process (`scope: 'local'`) or in another
   * instance (`scope: 'remote'`: a stored `activeTurn` of another owner whose heartbeat is
   * younger than `recovery.staleMs`). `null` when idle. Reads the stored state; never recovers.
   * A lock held by another instance without a stored `activeTurn` is not visible here (the turn
   * operations report it as `EH_SESSION_BUSY`).
   */
  busy(): Promise<SessionBusy | null>
  /**
   * The tools the model sees in the next request, in request order (spec 02 §3.4): static, skill,
   * source and `tool_search` tools with their source, deferral and estimated tokens. Resolved the
   * way a turn would resolve them, without running one: `refresh: 'session'` sources are listed
   * once per session and cached, `refresh: 'turn'` sources on every call. Request-scoped client
   * tools and the per-turn output tool are not included. Opens the session if needed.
   */
  tools(): Promise<SessionToolInfo[]>
  events(): ReadableStream<SessionEvent<M>>
  /**
   * Resolves when no turn runs and nothing is queued (also after `close()`). A queue held by
   * pending approvals keeps it waiting until `respond()` (or `abort()` drops the queue).
   */
  idle(): Promise<void>
  close(): Promise<void>
}
