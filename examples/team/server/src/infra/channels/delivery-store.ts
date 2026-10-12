/**
 * SQLite stores of reliable delivery: the outbox (every message the gateway sends is a row before
 * it is sent) and the approvals announced in chat conversations. The outbox body is sealed with
 * the channel vault like the channel log.
 */
import type { Database } from 'bun:sqlite'
import { uuidv7 } from 'eharness'
import type { SecretVault } from 'eharness/providers'
import type { OutboundButton } from './types.ts'

// --- outbox ------------------------------------------------------------------------------------

/**
 * `reminder` rows are posts nobody is waiting on at a tool call: retried like a reply (a reminder
 * that cannot be sent right now goes out when the platform is back) and deduplicated per trigger
 * (`reminder:<id>:<slot>`), so a recovered routine fire never posts twice.
 */
export type OutboxKind = 'reply' | 'post' | 'approval' | 'reminder'
export type OutboxStatus = 'pending' | 'sending' | 'sent' | 'failed' | 'skipped'

/** What an outbox row says once opened. `conversationId` is the id of the node it goes to. */
export interface OutboxRow {
  id: string
  connectionId: string
  conversationId: string
  sessionId: string | null
  kind: OutboxKind
  triggerId: string | null
  chunkIndex: number
  chunkCount: number
  text: string
  replyTo?: string
  buttons?: OutboundButton[]
  /** The approval row an `approval` message announces. */
  approvalId?: string
  status: OutboxStatus
  attempts: number
  nextAt: number
  lastError: string | null
  platformId: string | null
  createdAt: number
  updatedAt: number
  sentAt: number | null
}

export interface NewOutbox {
  connectionId: string
  conversationId: string
  sessionId?: string | undefined
  kind: OutboxKind
  triggerId?: string | undefined
  chunkIndex: number
  chunkCount: number
  text: string
  replyTo?: string | undefined
  buttons?: OutboundButton[] | undefined
  approvalId?: string | undefined
}

interface OutboxDb {
  id: string
  connection_id: string
  conversation_id: string
  session_id: string | null
  kind: string
  trigger_id: string | null
  chunk_index: number
  chunk_count: number
  body: string
  status: string
  attempts: number
  next_at: number
  last_error: string | null
  platform_id: string | null
  created_at: number
  updated_at: number
  sent_at: number | null
}

interface OutboxBody {
  text: string
  replyTo?: string
  buttons?: OutboundButton[]
  approvalId?: string
}

export interface OutboxStore {
  /**
   * Queue the chunks of one message (ids in order). For a `reply`, a trigger that already has
   * reply rows in this conversation queues nothing and returns `[]` (a turn that ends twice never
   * answers twice).
   */
  enqueue(rows: NewOutbox[], now: number): Promise<string[]>
  get(id: string): Promise<OutboxRow | undefined>
  /** Atomically take a `pending` row (`sending`). False when somebody else did. */
  claim(id: string, now: number): boolean
  markSent(id: string, platformId: string, now: number): void
  /** Back to `pending` for a later attempt. */
  retryLater(id: string, error: string, nextAt: number, now: number): void
  markFailed(id: string, error: string, now: number): void
  markSkipped(id: string, reason: string, now: number): void
  /** Due `pending` rows of a connection, oldest first (so chunk order holds). */
  due(connectionId: string, now: number, limit: number): Promise<OutboxRow[]>
  /** Rows a crashed process left in `sending`. */
  sending(connectionId: string): Promise<OutboxRow[]>
  /** Earliest `next_at` after `now` among pending rows of a connection (for the retry timer). */
  nextDue(connectionId: string, now: number): number | undefined
  /** Boot: rows waiting for a retry are due now. */
  releaseAll(connectionId: string): void
  /** `post` rows (tool calls) that never reached the platform when the process died: not retried. */
  failStalePosts(connectionId: string, now: number): number
  /** A platform message id that a sent row already holds. */
  platformIdTaken(connectionId: string, platformId: string): boolean
  /** Whether an earlier chunk of the same message is still unsent (later chunks wait). */
  blockedBy(row: OutboxRow): boolean
  counts(connectionId?: string): Record<OutboxStatus, number>
  /** Delete finished rows older than `before`. */
  purge(before: number): number
}

export function sqliteOutboxStore(sqlite: Database, vault: SecretVault): OutboxStore {
  const context = (id: string): string => `channel-outbox:${id}`
  const open = async (r: OutboxDb): Promise<OutboxRow> => {
    const body = JSON.parse(await vault.open(r.body, context(r.id))) as OutboxBody
    return {
      id: r.id,
      connectionId: r.connection_id,
      conversationId: r.conversation_id,
      sessionId: r.session_id,
      kind: r.kind as OutboxKind,
      triggerId: r.trigger_id,
      chunkIndex: r.chunk_index,
      chunkCount: r.chunk_count,
      text: body.text,
      ...(body.replyTo === undefined ? {} : { replyTo: body.replyTo }),
      ...(body.buttons === undefined ? {} : { buttons: body.buttons }),
      ...(body.approvalId === undefined ? {} : { approvalId: body.approvalId }),
      status: r.status as OutboxStatus,
      attempts: r.attempts,
      nextAt: r.next_at,
      lastError: r.last_error,
      platformId: r.platform_id,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      sentAt: r.sent_at,
    }
  }
  const setStatus = (
    id: string,
    status: OutboxStatus,
    now: number,
    fields: { error?: string; platformId?: string } = {},
  ): void => {
    sqlite
      .query(
        `UPDATE channel_outbox SET status = ?, updated_at = ?, last_error = COALESCE(?, last_error),
           platform_id = COALESCE(?, platform_id), sent_at = CASE WHEN ? = 'sent' THEN ? ELSE sent_at END
         WHERE id = ?`,
      )
      .run(status, now, fields.error ?? null, fields.platformId ?? null, status, now, id)
  }

  return {
    async enqueue(rows, now) {
      const first = rows[0]
      if (first === undefined) return []
      if ((first.kind === 'reply' || first.kind === 'reminder') && first.triggerId !== undefined) {
        const exists = sqlite
          .query<{ n: number }, [string, string, string, string]>(
            `SELECT COUNT(*) AS n FROM channel_outbox
               WHERE kind = ? AND connection_id = ? AND conversation_id = ? AND trigger_id = ?`,
          )
          .get(first.kind, first.connectionId, first.conversationId, first.triggerId)
        if ((exists?.n ?? 0) > 0) return []
      }
      const sealed: Array<{ id: string; row: NewOutbox; body: string }> = []
      for (const row of rows) {
        const id = uuidv7()
        const body: OutboxBody = {
          text: row.text,
          ...(row.replyTo === undefined ? {} : { replyTo: row.replyTo }),
          ...(row.buttons === undefined ? {} : { buttons: row.buttons }),
          ...(row.approvalId === undefined ? {} : { approvalId: row.approvalId }),
        }
        sealed.push({ id, row, body: await vault.seal(JSON.stringify(body), context(id)) })
      }
      const insert = sqlite.query(
        `INSERT INTO channel_outbox (id, connection_id, conversation_id, session_id, kind, trigger_id,
           chunk_index, chunk_count, body, status, attempts, next_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, 0, ?, ?)`,
      )
      sqlite.transaction(() => {
        for (const { id, row, body } of sealed) {
          insert.run(
            id,
            row.connectionId,
            row.conversationId,
            row.sessionId ?? null,
            row.kind,
            row.triggerId ?? null,
            row.chunkIndex,
            row.chunkCount,
            body,
            now,
            now,
          )
        }
      })()
      return sealed.map((s) => s.id)
    },
    async get(id) {
      const r = sqlite
        .query<OutboxDb, [string]>('SELECT * FROM channel_outbox WHERE id = ?')
        .get(id)
      return r === null ? undefined : open(r)
    },
    claim(id, now) {
      return (
        sqlite
          .query(
            `UPDATE channel_outbox SET status = 'sending', attempts = attempts + 1, updated_at = ?
               WHERE id = ? AND status = 'pending'`,
          )
          .run(now, id).changes === 1
      )
    },
    markSent: (id, platformId, now) => setStatus(id, 'sent', now, { platformId }),
    retryLater(id, error, nextAt, now) {
      sqlite
        .query(
          `UPDATE channel_outbox SET status = 'pending', last_error = ?, next_at = ?, updated_at = ? WHERE id = ?`,
        )
        .run(error, nextAt, now, id)
    },
    markFailed: (id, error, now) => setStatus(id, 'failed', now, { error }),
    markSkipped: (id, reason, now) => setStatus(id, 'skipped', now, { error: reason }),
    async due(connectionId, now, limit) {
      const rows = sqlite
        .query<OutboxDb, [string, number, number]>(
          `SELECT * FROM channel_outbox WHERE connection_id = ? AND status = 'pending' AND next_at <= ?
             AND kind != 'post' ORDER BY id LIMIT ?`,
        )
        .all(connectionId, now, limit)
      return Promise.all(rows.map(open))
    },
    async sending(connectionId) {
      const rows = sqlite
        .query<OutboxDb, [string]>(
          `SELECT * FROM channel_outbox WHERE connection_id = ? AND status = 'sending' ORDER BY id`,
        )
        .all(connectionId)
      return Promise.all(rows.map(open))
    },
    nextDue(connectionId, now) {
      const r = sqlite
        .query<{ at: number | null }, [string, number]>(
          `SELECT MIN(next_at) AS at FROM channel_outbox
             WHERE connection_id = ? AND status = 'pending' AND kind != 'post' AND next_at > ?`,
        )
        .get(connectionId, now)
      return r?.at ?? undefined
    },
    releaseAll(connectionId) {
      sqlite
        .query(
          `UPDATE channel_outbox SET next_at = 0 WHERE connection_id = ? AND status = 'pending'`,
        )
        .run(connectionId)
    },
    failStalePosts(connectionId, now) {
      return sqlite
        .query(
          `UPDATE channel_outbox SET status = 'failed', updated_at = ?,
             last_error = 'interrupted before it was sent; a tool call is never re-executed'
             WHERE connection_id = ? AND kind = 'post' AND status = 'pending'`,
        )
        .run(now, connectionId).changes
    },
    platformIdTaken(connectionId, platformId) {
      return (
        sqlite
          .query<{ n: number }, [string, string]>(
            `SELECT COUNT(*) AS n FROM channel_outbox WHERE connection_id = ? AND platform_id = ?`,
          )
          .get(connectionId, platformId)?.n !== 0
      )
    },
    blockedBy(row) {
      if (row.chunkIndex === 0) return false
      const r = sqlite
        .query<{ n: number }, [string, string, string, string, number, string]>(
          `SELECT COUNT(*) AS n FROM channel_outbox
             WHERE connection_id = ? AND conversation_id = ? AND kind = ? AND COALESCE(trigger_id, '') = ?
               AND chunk_index < ? AND id < ? AND status IN ('pending', 'sending')`,
        )
        .get(
          row.connectionId,
          row.conversationId,
          row.kind,
          row.triggerId ?? '',
          row.chunkIndex,
          row.id,
        )
      return (r?.n ?? 0) > 0
    },
    counts(connectionId) {
      const rows =
        connectionId === undefined
          ? sqlite
              .query<{ status: string; n: number }, []>(
                'SELECT status, COUNT(*) AS n FROM channel_outbox GROUP BY status',
              )
              .all()
          : sqlite
              .query<{ status: string; n: number }, [string]>(
                'SELECT status, COUNT(*) AS n FROM channel_outbox WHERE connection_id = ? GROUP BY status',
              )
              .all(connectionId)
      const out: Record<OutboxStatus, number> = {
        pending: 0,
        sending: 0,
        sent: 0,
        failed: 0,
        skipped: 0,
      }
      for (const r of rows) out[r.status as OutboxStatus] = r.n
      return out
    },
    purge(before) {
      return sqlite
        .query(
          `DELETE FROM channel_outbox WHERE status IN ('sent', 'failed', 'skipped') AND updated_at < ?`,
        )
        .run(before).changes
    },
  }
}

// --- approvals announced in chat ---------------------------------------------------------------

export type ApprovalStatus = 'open' | 'answered'

export interface ApprovalRow {
  id: string
  connectionId: string
  conversationId: string
  sessionId: string
  agentId: string
  itemId: string
  itemKind: 'approval' | 'question'
  toolName: string
  triggerId: string | null
  requesterPeer: string | null
  requesterMember: string | null
  status: ApprovalStatus
  answeredBy: string | null
  outcome: string | null
  messageId: string | null
  consumed: boolean
  createdAt: number
  answeredAt: number | null
}

interface ApprovalDb {
  id: string
  connection_id: string
  conversation_id: string
  session_id: string
  agent_id: string
  item_id: string
  item_kind: string
  tool_name: string
  trigger_id: string | null
  requester_peer: string | null
  requester_member: string | null
  status: string
  answered_by: string | null
  outcome: string | null
  message_id: string | null
  consumed: number
  created_at: number
  answered_at: number | null
}

const toApproval = (r: ApprovalDb): ApprovalRow => ({
  id: r.id,
  connectionId: r.connection_id,
  conversationId: r.conversation_id,
  sessionId: r.session_id,
  agentId: r.agent_id,
  itemId: r.item_id,
  itemKind: r.item_kind === 'question' ? 'question' : 'approval',
  toolName: r.tool_name,
  triggerId: r.trigger_id,
  requesterPeer: r.requester_peer,
  requesterMember: r.requester_member,
  status: r.status === 'answered' ? 'answered' : 'open',
  answeredBy: r.answered_by,
  outcome: r.outcome,
  messageId: r.message_id,
  consumed: r.consumed === 1,
  createdAt: r.created_at,
  answeredAt: r.answered_at,
})

export interface NewApproval {
  connectionId: string
  conversationId: string
  sessionId: string
  agentId: string
  itemId: string
  itemKind: 'approval' | 'question'
  toolName: string
  triggerId: string | null
  requesterPeer: string | null
  requesterMember: string | null
}

export interface ApprovalStore {
  /** Record an announced item; undefined when this item of the session was announced already. */
  insert(input: NewApproval, now: number): ApprovalRow | undefined
  get(id: string): ApprovalRow | undefined
  /** The announcements whose request message has one of these platform ids (inbox view). */
  byMessages(connectionId: string, conversationId: string, messageIds: string[]): ApprovalRow[]
  setMessage(id: string, messageId: string): void
  /** Open rows of a session. */
  open(sessionId: string): ApprovalRow[]
  /** Open rows announced in a conversation, whatever session they belong to (a delegated agent's too). */
  openIn(conversationId: string): ApprovalRow[]
  /** Take an open row (`answered`): the first caller wins. False when it was not open. */
  answer(id: string, by: string, outcome: string, now: number): boolean
  /** The answer could not be recorded: the row is open again. */
  reopen(id: string): void
  /** The trigger of the channel-originated turn that is still running or parked in a session. */
  activeTrigger(sessionId: string): { triggerId: string | null } | undefined
  /** The unconsumed rows of a session now answer to another message (a new message continues the parked turn). */
  retrigger(sessionId: string, triggerId: string): void
  /** Open rows announced at or before `before`, oldest first (they expire). */
  openBefore(before: number): ApprovalRow[]
  /** The turn of the session finished: its rows no longer belong to a running turn. */
  consume(sessionId: string): void
}

export function sqliteApprovalStore(sqlite: Database): ApprovalStore {
  return {
    insert(input, now) {
      const id = uuidv7()
      const r = sqlite
        .query(
          `INSERT OR IGNORE INTO channel_approvals (id, connection_id, conversation_id, session_id, agent_id,
             item_id, item_kind, tool_name, trigger_id, requester_peer, requester_member, status, consumed, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', 0, ?)`,
        )
        .run(
          id,
          input.connectionId,
          input.conversationId,
          input.sessionId,
          input.agentId,
          input.itemId,
          input.itemKind,
          input.toolName,
          input.triggerId,
          input.requesterPeer,
          input.requesterMember,
          now,
        )
      if (r.changes === 0) return undefined
      return toApproval(
        sqlite
          .query<ApprovalDb, [string]>('SELECT * FROM channel_approvals WHERE id = ?')
          .get(id) as ApprovalDb,
      )
    },
    get(id) {
      const r = sqlite
        .query<ApprovalDb, [string]>('SELECT * FROM channel_approvals WHERE id = ?')
        .get(id)
      return r === null ? undefined : toApproval(r)
    },
    byMessages(connectionId, conversationId, messageIds) {
      if (messageIds.length === 0) return []
      return sqlite
        .query<ApprovalDb, string[]>(
          `SELECT * FROM channel_approvals WHERE connection_id = ? AND conversation_id = ?
             AND message_id IN (${messageIds.map(() => '?').join(',')})`,
        )
        .all(connectionId, conversationId, ...messageIds)
        .map(toApproval)
    },
    setMessage(id, messageId) {
      sqlite.query('UPDATE channel_approvals SET message_id = ? WHERE id = ?').run(messageId, id)
    },
    open(sessionId) {
      return sqlite
        .query<ApprovalDb, [string]>(
          `SELECT * FROM channel_approvals WHERE session_id = ? AND status = 'open' ORDER BY created_at, id`,
        )
        .all(sessionId)
        .map(toApproval)
    },
    openIn(conversationId) {
      return sqlite
        .query<ApprovalDb, [string]>(
          `SELECT * FROM channel_approvals WHERE conversation_id = ? AND status = 'open' ORDER BY created_at, id`,
        )
        .all(conversationId)
        .map(toApproval)
    },
    answer(id, by, outcome, now) {
      return (
        sqlite
          .query(
            `UPDATE channel_approvals SET status = 'answered', answered_by = ?, outcome = ?, answered_at = ?
               WHERE id = ? AND status = 'open'`,
          )
          .run(by, outcome, now, id).changes === 1
      )
    },
    reopen(id) {
      sqlite
        .query(
          `UPDATE channel_approvals SET status = 'open', answered_by = NULL, outcome = NULL, answered_at = NULL WHERE id = ?`,
        )
        .run(id)
    },
    activeTrigger(sessionId) {
      const r = sqlite
        .query<{ trigger_id: string | null }, [string]>(
          `SELECT trigger_id FROM channel_approvals WHERE session_id = ? AND consumed = 0
             ORDER BY created_at DESC, id DESC LIMIT 1`,
        )
        .get(sessionId)
      return r === null ? undefined : { triggerId: r.trigger_id }
    },
    consume(sessionId) {
      sqlite.query('UPDATE channel_approvals SET consumed = 1 WHERE session_id = ?').run(sessionId)
    },
    retrigger(sessionId, triggerId) {
      sqlite
        .query('UPDATE channel_approvals SET trigger_id = ? WHERE session_id = ? AND consumed = 0')
        .run(triggerId, sessionId)
    },
    openBefore(before) {
      return sqlite
        .query<ApprovalDb, [number]>(
          `SELECT * FROM channel_approvals WHERE status = 'open' AND consumed = 0 AND created_at <= ?
             ORDER BY created_at, id`,
        )
        .all(before)
        .map(toApproval)
    },
  }
}
