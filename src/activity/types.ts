/**
 * Types of the activity feed: records, the `ActivityStore` port and the payloads of the events the
 * `activity()` plugin emits.
 *
 * @see docs/specs/25-activity.md
 */
import type { HarnessErrorCode, HarnessNoticeCode } from '../index.ts'

/** What a producer appends. `type` is free-form: the library's own events and app events share one feed. */
export interface ActivityInput {
  /** Event type, kebab-case. `boot` and `resync` are reserved for the SSE stream. */
  type: string
  /** Session the event belongs to, when it has one. */
  sessionId?: string | null
  /** Agent the event belongs to, when it has one (an app's own id or the agent id). */
  agentId?: string | null
  /** JSON-serializable data. */
  payload?: Record<string, unknown>
  /** Epoch ms. Default: the store's clock. */
  at?: number
}

/** A stored event. `seq` increases strictly with every append and is never reused. */
export interface ActivityRecord {
  seq: number
  type: string
  sessionId: string | null
  agentId: string | null
  payload: Record<string, unknown>
  /** Epoch ms. */
  createdAt: number
}

/** Query of {@link ActivityStore.read}. */
export interface ActivityReadQuery {
  /** Return records with a higher `seq`. */
  after: number
  /** Maximum number of records (oldest first). */
  limit: number
  /** Only these event types. */
  types?: readonly string[]
  /** Only this session. */
  sessionId?: string
}

/** Options of {@link ActivityStore.prune}. At least one of `olderThan` / `keepLast` is needed to delete anything. */
export interface ActivityPruneOptions {
  /** Delete records created before this time (epoch ms). */
  olderThan?: number
  /** Keep at most this many of the newest records. */
  keepLast?: number
  /**
   * Records that survive pruning: the newest record of `type` for every distinct `by` value
   * (e.g. the last `message-added` of every agent: a sidebar preview).
   */
  keepLatestOf?: ReadonlyArray<{ type: string; by: 'agentId' | 'sessionId' }>
}

/**
 * Append-only event log with a monotonically increasing `seq`, shared by every instance of a
 * deployment: each instance appends, readers tail by `seq`.
 *
 * Contract (`activityStoreConformance`, spec 25 §3):
 * - `append` assigns `seq` values that strictly increase across all appenders (also concurrent
 *   ones in several instances), never reuse one after pruning, and are increasing within a batch.
 * - `read` returns the records after a cursor, oldest first, deep copies.
 * - `prune` removes a prefix of the log (everything up to a boundary seq, minus the survivors),
 *   never the newest record, and raises `prunedThrough` (never lowers it).
 */
export interface ActivityStore {
  append(events: ActivityInput | readonly ActivityInput[]): Promise<ActivityRecord[]>
  read(query: ActivityReadQuery): Promise<ActivityRecord[]>
  /** Highest `seq` ever assigned (`0` for an empty log). */
  lastSeq(): Promise<number>
  /**
   * Highest `seq` removed by retention (`0` = nothing pruned). A reader whose cursor is below it
   * may have missed events and must refetch its state (`resync`).
   */
  prunedThrough(): Promise<number>
  prune(options: ActivityPruneOptions): Promise<{ deleted: number; prunedThrough: number }>
}

/** Where a turn came from, as the feed reports it. */
export type TurnSourceKind = 'user' | 'event' | 'wake' | 'respond' | 'regenerate'

/** A pending item as the feed names it. */
export interface PendingRef {
  kind: 'approval' | 'client-tool' | 'wait'
  /** `approvalId`, `toolCallId` or `waitId`. */
  id: string
  toolCallId: string
  toolName: string
}

/** Payloads of the events the `activity()` plugin emits, by event type (spec 25 §2). */
export interface SessionActivityPayloads {
  'turn-started': {
    turnId: string
    kind: 'send' | 'respond' | 'regenerate' | 'edit' | 'wake'
    source: TurnSourceKind
    queued: boolean
    parentSessionId?: string
  }
  'step-finished': {
    turnId: string | null
    stepIndex: number
    finishReason: string
    usage: { inputTokens: number; outputTokens: number; totalTokens: number }
    costUsd?: number
    toolCalls: string[]
  }
  'turn-ended': {
    turnId: string
    kind: 'send' | 'respond' | 'regenerate' | 'edit' | 'wake'
    stop: string
    messageId?: string
    steps: number
    durationMs: number
    usage: { inputTokens: number; outputTokens: number; totalTokens: number }
    costUsd?: number
    partial?: true
    error?: { code?: HarnessErrorCode | HarnessNoticeCode; message: string }
    parentSessionId?: string
  }
  'pending-changed': {
    turnId: string
    messageId?: string
    /** Items that wait for an answer now (a snapshot, empty = nothing waits any more). */
    waiting: PendingRef[]
    /** Items answered by a partial `respond()` that wait for the others of their batch. */
    answered: PendingRef[]
    parentSessionId?: string
  }
  'approval-decided': {
    toolName: string
    toolCallId: string
    approved: boolean
    by: string
    id?: string
    actor?: string
    reason?: string
  }
  'message-saved': {
    messageId: string
    role: string
    kind?: string
    stop?: string
    turnId?: string
  }
  /** Emitted on the PARENT session when a child's turn ends for good (not while it waits for an answer). */
  'child-reported': {
    childSessionId: string
    /** `completed`, `failed`, `stopped`, else the stop reason. */
    status: string
    stop: string
    toolCallId?: string
    /** The child's last assistant message. */
    messageId?: string
  }
  'session-recovered': { turnId?: string; messageId: string; reason: 'interrupted' }
  compaction: {
    markerId: string
    trigger?: string
    tokens?: { before: number; after: number }
  }
  /** Emitted by `answerAttention()`. */
  'attention-answered': {
    id: string
    kind: 'approval' | 'client-tool' | 'wait'
    status: 'resumed' | 'recorded' | 'already-answered' | 'not-found'
    remaining?: number
    approved?: boolean
    actor?: string
  }
}

/** Type names of the events the library emits. Apps must not reuse them with another payload. */
export type SessionActivityType = keyof SessionActivityPayloads

/** The event types the library emits. */
export const SESSION_ACTIVITY_TYPES: readonly SessionActivityType[] = [
  'turn-started',
  'step-finished',
  'turn-ended',
  'pending-changed',
  'approval-decided',
  'message-saved',
  'child-reported',
  'session-recovered',
  'compaction',
  'attention-answered',
]
