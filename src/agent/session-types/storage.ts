/**
 * Storage ports (message, state, lock) and session snapshot/peek/fork types.
 *
 * @see docs/specs/05-session-and-storage.md
 */
import type { JSONValue, UIMessage } from 'ai'
import type { HarnessUIMessage, PendingExternal, PendingState } from '../../messages/types.ts'
import type { HarnessSession } from './session.ts'
import type { AbortRequest, ActiveTurn, SessionBusy, SessionUsage } from './turn.ts'

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

/** Options of {@link HarnessSession.compact} (this call only). */
export interface CompactOptions {
  /** Completed turns kept verbatim; overrides `compaction.keepLast`. `0` summarizes everything. */
  keepLast?: number
  /** Extra focus text for the summarizer. */
  instructions?: string
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
  /**
   * Resolve with a release function. Reject with `new HarnessError('EH_SESSION_BUSY', …)` when the
   * session is locked elsewhere (contention); any other rejection is a failing lock service and
   * becomes `EH_LOCK_UNAVAILABLE`. Must not block indefinitely.
   */
  acquire(sessionId: string, opts: { signal: AbortSignal }): Promise<() => Promise<void>>
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
    usage?: SessionUsage
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
    /** Set when this session is a child session (`SessionOptions.parent`, spec 05 §13). */
    parent?: ParentInfo
    /**
     * Child sessions opened with this session as `parent` (spec 05 §13): append-only, capped at
     * 500 (oldest dropped), written by the children themselves (foreign-writable like
     * `abortRequest`), never by the owner of this session.
     */
    children?: ChildSessionInfo[]
    /** Set when this session was created by `session.fork()` (spec 05 §14). */
    forkedFrom?: { sessionId: string; beforeMessageId?: string; at: number }
  }
  plugins: Record<string, Record<string, JSONValue>>
}

/**
 * The parent of a child session (`SessionOptions.parent`), as stored in the child's state and
 * returned by `session.parentInfo()`.
 *
 * @see docs/specs/05-session-and-storage.md#13-parent-and-child-sessions
 */
export interface ParentInfo {
  sessionId: string
  turnId: string
  toolCallId?: string
  depth: number
  /**
   * Identity of the child (not of the parent), set by whoever opens the child (the `subagent()`
   * plugin): `agent` is the catalog key of the agent definition that runs it, `name` the name its
   * launcher gave it, `description` the short task description. Copied into the parent's
   * {@link ChildSessionInfo}. Absent in sessions stored before 0.x (spec 05 §13).
   */
  agent?: string
  name?: string
  description?: string
}

/**
 * A child session of a parent, as stored in the parent's state and returned by
 * `session.children()` (`createdAt` is epoch ms of the registration).
 *
 * @see docs/specs/05-session-and-storage.md#13-parent-and-child-sessions
 */
export interface ChildSessionInfo {
  sessionId: string
  turnId: string
  toolCallId?: string
  createdAt: number
  /** Catalog key of the agent definition that runs the child (see {@link ParentInfo.agent}). */
  agent?: string
  /** Name the launcher gave the child. */
  name?: string
  /** Short description of the child's task. */
  description?: string
}

/**
 * A side-effect-free read handle (`agent.peek(id)`, spec 05 §2.2): reads the stored state and
 * messages only. It runs no `session.start` hook, no crash recovery, no reconcile and no inbox
 * drain, takes no lock and never writes. Cheap: create one per read.
 */
export interface SessionPeek<M extends UIMessage = HarnessUIMessage> {
  readonly id: string
  /** Same as `session.messages()`, read from the storage. */
  messages(q?: { beforeId?: string; limit?: number; includeHidden?: boolean }): Promise<M[]>
  /** Stored pending state, active turn and usage (`null` / zero when the session does not exist). */
  stats(): Promise<{
    pending: PendingState | null
    activeTurn: ActiveTurn | null
    usage: SessionUsage
  }>
  /** Like `session.busy()`; `local` when a live handle of this agent runs a turn. */
  busy(): Promise<SessionBusy | null>
  /** External waits of the stored pending state. */
  pendingWaits(): Promise<PendingExternal[]>
  /** Stored pending state (`null` when none). */
  pending(): Promise<PendingState | null>
  /** Children registered in the stored state, with their identity when recorded. */
  children(): Promise<ChildSessionInfo[]>
  /** The stored parent of the session. */
  parentInfo(): Promise<ParentInfo | undefined>
}

/**
 * Options of `session.fork()`.
 *
 * @see docs/specs/05-session-and-storage.md#14-fork
 */
export interface ForkOptions {
  /** Copy the messages with an id strictly before this one (default: all messages). */
  beforeMessageId?: string
  /** Id of the new session (default: a generated UUIDv7). Must not exist yet. */
  id?: string
  /** `SessionOptions.runtime` of the new session. */
  runtime?: Record<string, unknown>
  /** `'all'` (default): copy usage, grants, plugin state and the compaction/rewind pointers; `'none'`: copy no state. */
  copyState?: 'all' | 'none'
}
