/**
 * SQLite stores of reliable delivery: the outbox (every message the gateway sends is a row before
 * it is sent) and the approvals announced in chat conversations. The outbox body is sealed with
 * the channel vault like the channel log.
 */
import type { Database } from 'bun:sqlite'
import { uuidv7 } from 'eharness'
import type {
  ClaimOptions,
  Json,
  OutboxStore as LibOutboxStore,
  OutboxRecord,
  OutboxState,
} from 'eharness/channels'
import type { SecretVault } from 'eharness/providers'
import type { OutboundButton } from './types.ts'

// --- outbox ------------------------------------------------------------------------------------

/**
 * `reminder` rows are posts nobody is waiting on at a tool call: retried like a reply (a reminder
 * that cannot be sent right now goes out when the platform is back) and deduplicated per trigger
 * (`reminder:<id>:<slot>`), so a recovered routine fire never posts twice.
 */
export type OutboxKind = 'reply' | 'post' | 'approval' | 'reminder'
/**
 * `held`: a row whose lease ran out (or that a stopped process left `sending`): it may or may not
 * have reached the platform, so it is checked against the platform before it is resent.
 */
export type OutboxStatus = 'pending' | 'sending' | 'held' | 'sent' | 'failed' | 'skipped'

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
  /** When a person dismissed this failed row from "Needs a look"; null = not reviewed. */
  reviewedAt: number | null
}

/** A row a person may need to look at: delivery uncertain (held) or failed and not yet dismissed. */
export interface AttentionQuery {
  /** Page size (default 20, at most 100). */
  limit?: number
  /** Rows older than this id (ids sort by creation time). */
  before?: string
  /** Failed rows older than this are not listed (default: no limit). */
  since?: number
}

export interface AttentionPage {
  rows: OutboxRow[]
  /** Pass as `before` for the next page; undefined on the last one. */
  next?: string
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
  owner: string | null
  lease_until: number | null
  max_attempts: number | null
  result: string | null
  reviewed_at: number | null
}

interface OutboxBody {
  text: string
  replyTo?: string
  buttons?: OutboundButton[]
  approvalId?: string
}

export interface QueueOptions {
  /** Only this connection's rows are claimed (one library outbox per connection). */
  connectionId?: string
  /** Claim nothing while this says no (the connection has no adapter yet, or boot recovery is pending). */
  ready?: () => boolean
}

export interface OutboxStore {
  /**
   * Queue the chunks of one message (ids in order). For a `reply`, a trigger that already has
   * reply rows in this conversation queues nothing and returns `[]` (a turn that ends twice never
   * answers twice).
   */
  enqueue(rows: NewOutbox[], now: number): Promise<string[]>
  get(id: string): Promise<OutboxRow | undefined>
  /**
   * The library `OutboxStore` port over the same table, for `createOutbox` (spec 31 §3.1). Claims
   * leave out `post` rows (a tool call is answered at once and never retried) and keep the order
   * of a conversation: a later chunk of a message waits for the earlier chunks, and a row waits
   * while an earlier row of its conversation is being sent, is held or waits for a retry.
   */
  queue(options?: QueueOptions): LibOutboxStore & {
    /** Leave the row `sending` when the next `fail` comes (the process is stopping: boot recovery checks it). */
    hold(id: string): void
  }
  /** Atomically take a `pending` row for a direct send (`sending`, never reclaimed). False when somebody else did. */
  claimNow(id: string, now: number): boolean
  markSent(id: string, platformId: string, now: number): void
  /** Back to `pending` for a later attempt. */
  retryLater(id: string, error: string, nextAt: number, now: number): void
  markFailed(id: string, error: string, now: number): void
  markSkipped(id: string, reason: string, now: number): void
  /** Boot: this process owns the connection now, so every row a previous process left `sending` is `held`. */
  holdStale(connectionId: string): number
  /** Rows waiting for a decision (see {@link OutboxStatus}). */
  held(connectionId: string): Promise<OutboxRow[]>
  /** Earliest `next_at` after `now` among pending rows of a connection (for the retry timer). */
  nextDue(connectionId: string, now: number): number | undefined
  /** Boot: rows waiting for a retry are due now. */
  releaseAll(connectionId: string): void
  /** `post` rows (tool calls) that never reached the platform when the process died: not retried. */
  failStalePosts(connectionId: string, now: number): number
  /** A platform message id that a sent row already holds. */
  platformIdTaken(connectionId: string, platformId: string): boolean
  counts(connectionId?: string): Record<OutboxStatus, number>
  /**
   * Held rows (being checked) and failed rows nobody dismissed yet, newest first, one page at a
   * time. `post` rows (tool calls) are listed as well: they are never re-run, so they are only
   * told about.
   */
  attention(connectionId: string, query?: AttentionQuery): Promise<AttentionPage>
  /**
   * Re-queue a failed row (not a `post`): pending again, due now, a fresh set of attempts.
   * False when the row is not a failed, retryable row of this connection.
   */
  retry(connectionId: string, id: string, now: number): boolean
  /** Mark a failed row reviewed so it leaves "Needs a look". Nothing is deleted. False when there is nothing to dismiss. */
  dismiss(connectionId: string, id: string, now: number): boolean
  /** Delete finished rows older than `before`. */
  purge(before: number): number
}

export interface SqliteOutboxOptions {
  /** Clock of the library port (lease and settle times). Default `Date.now`. */
  now?: () => number
  /** Attempts of a row that has no `max_attempts` of its own. Default 10. */
  defaultMaxAttempts?: number
}

const LIB_STATES: Record<OutboxState, string[]> = {
  pending: ['pending'],
  claimed: ['sending'],
  held: ['held'],
  done: ['sent'],
  dead: ['failed'],
  skipped: ['skipped'],
}

export function sqliteOutboxStore(
  sqlite: Database,
  vault: SecretVault,
  options: SqliteOutboxOptions = {},
): OutboxStore {
  const clock = options.now ?? Date.now
  const defaultMax = options.defaultMaxAttempts ?? 10
  const context = (id: string): string => `channel-outbox:${id}`
  const bodyOf = async (r: OutboxDb): Promise<OutboxBody> =>
    JSON.parse(await vault.open(r.body, context(r.id))) as OutboxBody
  const open = async (r: OutboxDb): Promise<OutboxRow> => {
    const body = await bodyOf(r)
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
      reviewedAt: r.reviewed_at,
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
           platform_id = COALESCE(?, platform_id), sent_at = CASE WHEN ? = 'sent' THEN ? ELSE sent_at END,
           owner = NULL, lease_until = NULL
         WHERE id = ?`,
      )
      .run(status, now, fields.error ?? null, fields.platformId ?? null, status, now, id)
  }

  // --- the library port ------------------------------------------------------------------------

  const stateOf = (status: string): OutboxState =>
    status === 'sending'
      ? 'claimed'
      : status === 'held'
        ? 'held'
        : status === 'sent'
          ? 'done'
          : status === 'skipped'
            ? 'skipped'
            : status === 'failed'
              ? 'dead'
              : 'pending'
  /** The target of a record is its connection: breaker, park and lane of the library worker. */
  const toRecord = async (r: OutboxDb): Promise<OutboxRecord> => ({
    id: r.id,
    target: r.connection_id,
    payload: JSON.parse(await vault.open(r.body, context(r.id))) as Json,
    availableAt: r.next_at,
    attempts: r.attempts,
    maxAttempts: r.max_attempts ?? defaultMax,
    state: stateOf(r.status),
    ...(r.owner === null ? {} : { owner: r.owner }),
    ...(r.lease_until === null ? {} : { leaseUntil: r.lease_until }),
    ...(r.result === null ? {} : { result: JSON.parse(r.result) as Json }),
    ...(r.last_error === null ? {} : { error: r.last_error }),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  })

  /**
   * Order inside a conversation (rows with a conversation id; items enqueued through the generic
   * port have none). A row is not claimed while an earlier row of its conversation is being sent
   * or waits for a retry, nor while an earlier chunk of its own message is unsent.
   */
  const BLOCKED = `NOT (r.conversation_id <> '' AND EXISTS (
      SELECT 1 FROM channel_outbox o
        WHERE o.connection_id = r.connection_id AND o.conversation_id = r.conversation_id
          AND o.kind != 'post' AND o.id < r.id
          AND (
            (o.kind = r.kind AND COALESCE(o.trigger_id, '') = COALESCE(r.trigger_id, '')
               AND o.chunk_index < r.chunk_index AND o.status IN ('pending', 'sending', 'held'))
            OR o.status IN ('sending', 'held')
            OR (o.status = 'pending' AND o.attempts > 0)
          )))`

  const queue: OutboxStore['queue'] = (queueOptions = {}) => {
    const scope = queueOptions.connectionId
    const scoped = scope === undefined ? '' : ' AND r.connection_id = ?'
    const scopeArgs: string[] = scope === undefined ? [] : [scope]
    const held = new Set<string>()
    return {
      hold(id) {
        held.add(id)
      },
      async enqueue(item) {
        const existing = sqlite
          .query<OutboxDb, [string]>('SELECT * FROM channel_outbox WHERE id = ?')
          .get(item.id)
        if (existing !== null) return { created: false, record: await toRecord(existing) }
        const t = clock()
        const body = await vault.seal(JSON.stringify(item.payload), context(item.id))
        sqlite
          .query(
            `INSERT INTO channel_outbox (id, connection_id, conversation_id, kind, chunk_index, chunk_count,
               body, status, attempts, next_at, max_attempts, created_at, updated_at)
             VALUES (?, ?, '', 'reply', 0, 1, ?, 'pending', ?, ?, ?, ?, ?)`,
          )
          .run(item.id, item.target, body, item.attempts, item.availableAt, item.maxAttempts, t, t)
        const row = sqlite
          .query<OutboxDb, [string]>('SELECT * FROM channel_outbox WHERE id = ?')
          .get(item.id) as OutboxDb
        return { created: true, record: await toRecord(row) }
      },
      async claim(now, owner, leaseMs, limit, claimOptions: ClaimOptions = {}) {
        if (queueOptions.ready !== undefined && !queueOptions.ready()) return []
        const reclaim = claimOptions.reclaimExpired !== false
        const taken = sqlite.transaction((): OutboxDb[] => {
          // a lease that ran out on a row with no attempts left is dead-lettered, not claimed
          if (reclaim) {
            sqlite
              .query(
                `UPDATE channel_outbox AS r SET status = 'failed', updated_at = ?, owner = NULL, lease_until = NULL,
                   last_error = COALESCE(last_error, 'the lease ran out')
                   WHERE status = 'sending' AND lease_until IS NOT NULL AND lease_until <= ?
                     AND attempts >= COALESCE(max_attempts, ?)${scoped}`,
              )
              .run(now, now, defaultMax, ...scopeArgs)
          }
          const due = sqlite
            .query<OutboxDb, (string | number)[]>(
              `SELECT r.* FROM channel_outbox AS r
                 WHERE r.kind != 'post'
                   AND ((r.status = 'pending' AND r.next_at <= ?)
                     ${
                       reclaim
                         ? "OR (r.status = 'sending' AND r.lease_until IS NOT NULL AND r.lease_until <= ?)"
                         : ''
                     })
                   AND ${BLOCKED}${scoped}
                 ORDER BY r.next_at, r.id LIMIT ?`,
            )
            .all(...(reclaim ? [now, now] : [now]), ...scopeArgs, limit)
          const take = sqlite.query(
            `UPDATE channel_outbox SET status = 'sending', owner = ?, lease_until = ?,
               attempts = attempts + 1, updated_at = ? WHERE id = ?`,
          )
          for (const r of due) take.run(owner, now + leaseMs, now, r.id)
          return due.map((r) => ({
            ...r,
            status: 'sending',
            owner,
            lease_until: now + leaseMs,
            attempts: r.attempts + 1,
            updated_at: now,
          }))
        })()
        return Promise.all(taken.map(toRecord))
      },
      async holdExpired(now) {
        return Promise.all(
          sqlite
            .transaction((): OutboxDb[] => {
              const rows = sqlite
                .query<OutboxDb, (string | number)[]>(
                  `SELECT r.* FROM channel_outbox AS r
                     WHERE r.status = 'sending' AND r.lease_until IS NOT NULL AND r.lease_until <= ?${scoped}
                     ORDER BY r.id`,
                )
                .all(now, ...scopeArgs)
              const t = clock()
              const hold = sqlite.query(
                `UPDATE channel_outbox SET status = 'held', owner = NULL, lease_until = NULL, updated_at = ?,
                   last_error = 'the lease ran out while sending; delivery unknown' WHERE id = ?`,
              )
              for (const r of rows) hold.run(t, r.id)
              return rows.map((r) => ({
                ...r,
                status: 'held',
                owner: null,
                lease_until: null,
                updated_at: t,
                last_error: 'the lease ran out while sending; delivery unknown',
              }))
            })()
            .map(toRecord),
        )
      },
      async release(id, resolution, now) {
        const changed =
          resolution === 'retry'
            ? sqlite
                .query(
                  `UPDATE channel_outbox SET status = 'pending', next_at = ?, updated_at = ?
                     WHERE id = ? AND status = 'held'`,
                )
                .run(now, now, id).changes
            : sqlite
                .query(
                  `UPDATE channel_outbox SET status = 'skipped', updated_at = ?,
                     last_error = 'dropped after the lease ran out' WHERE id = ? AND status = 'held'`,
                )
                .run(now, id).changes
        if (changed !== 1) return undefined
        return toRecord(
          sqlite
            .query<OutboxDb, [string]>('SELECT * FROM channel_outbox WHERE id = ?')
            .get(id) as OutboxDb,
        )
      },
      async skip(id, owner, reason) {
        return (
          sqlite
            .query(
              `UPDATE channel_outbox SET status = 'skipped', updated_at = ?, owner = NULL, lease_until = NULL,
                 last_error = ? WHERE id = ? AND status = 'sending' AND owner = ?`,
            )
            .run(clock(), reason, id, owner).changes === 1
        )
      },
      async succeed(id, owner, result) {
        const t = clock()
        const nativeId =
          result !== null &&
          typeof result === 'object' &&
          !Array.isArray(result) &&
          typeof result.nativeId === 'string'
            ? result.nativeId
            : null
        return (
          sqlite
            .query(
              `UPDATE channel_outbox SET status = 'sent', updated_at = ?, owner = NULL, lease_until = NULL,
                 platform_id = COALESCE(?, platform_id), result = ?, sent_at = ?
               WHERE id = ? AND status = 'sending' AND owner = ?`,
            )
            .run(t, nativeId, result === undefined ? null : JSON.stringify(result), t, id, owner)
            .changes === 1
        )
      },
      async fail(id, owner, failure) {
        const r = sqlite
          .query<OutboxDb, [string, string]>(
            `SELECT * FROM channel_outbox WHERE id = ? AND status = 'sending' AND owner = ?`,
          )
          .get(id, owner)
        if (r === null) return undefined
        if (held.delete(id)) return 'pending' // stopping: the row stays `sending` for boot recovery
        const t = clock()
        const dead = failure.permanent === true || r.attempts >= (r.max_attempts ?? defaultMax)
        if (dead) {
          setStatus(id, 'failed', t, { error: failure.error })
          return 'dead'
        }
        sqlite
          .query(
            `UPDATE channel_outbox SET status = 'pending', next_at = ?, last_error = ?, updated_at = ?,
               owner = NULL, lease_until = NULL WHERE id = ?`,
          )
          .run(failure.retryAt ?? t, failure.error, t, id)
        return 'pending'
      },
      async defer(id, owner, availableAt) {
        return (
          sqlite
            .query(
              `UPDATE channel_outbox SET status = 'pending', next_at = ?, attempts = MAX(0, attempts - 1),
                 updated_at = ?, owner = NULL, lease_until = NULL
               WHERE id = ? AND status = 'sending' AND owner = ?`,
            )
            .run(availableAt, clock(), id, owner).changes === 1
        )
      },
      async get(id) {
        const r = sqlite
          .query<OutboxDb, [string]>('SELECT * FROM channel_outbox WHERE id = ?')
          .get(id)
        return r === null ? undefined : toRecord(r)
      },
      async list(query = {}) {
        const statuses = query.state === undefined ? undefined : LIB_STATES[query.state]
        const rows = sqlite
          .query<OutboxDb, (string | number)[]>(
            `SELECT * FROM channel_outbox${
              statuses === undefined
                ? ''
                : ` WHERE status IN (${statuses.map(() => '?').join(',')})`
            } ORDER BY next_at, id LIMIT ?`,
          )
          .all(...(statuses ?? []), query.limit ?? 1000)
        return Promise.all(rows.map(toRecord))
      },
      async purge(olderThan) {
        return sqlite
          .query(
            `DELETE FROM channel_outbox WHERE status IN ('sent', 'failed', 'skipped') AND updated_at < ?`,
          )
          .run(olderThan).changes
      },
    }
  }

  return {
    queue,
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
    claimNow(id, now) {
      return (
        sqlite
          .query(
            `UPDATE channel_outbox SET status = 'sending', attempts = attempts + 1, updated_at = ?,
               owner = 'direct', lease_until = NULL
               WHERE id = ? AND status = 'pending'`,
          )
          .run(now, id).changes === 1
      )
    },
    markSent: (id, platformId, now) => setStatus(id, 'sent', now, { platformId }),
    retryLater(id, error, nextAt, now) {
      sqlite
        .query(
          `UPDATE channel_outbox SET status = 'pending', last_error = ?, next_at = ?, updated_at = ?,
             owner = NULL, lease_until = NULL WHERE id = ?`,
        )
        .run(error, nextAt, now, id)
    },
    markFailed: (id, error, now) => setStatus(id, 'failed', now, { error }),
    markSkipped: (id, reason, now) => setStatus(id, 'skipped', now, { error: reason }),
    holdStale(connectionId) {
      return sqlite
        .query(
          `UPDATE channel_outbox SET status = 'held', owner = NULL, lease_until = NULL, updated_at = ?,
             last_error = 'the process stopped while sending' WHERE connection_id = ? AND status = 'sending'`,
        )
        .run(clock(), connectionId).changes
    },
    async held(connectionId) {
      const rows = sqlite
        .query<OutboxDb, [string]>(
          `SELECT * FROM channel_outbox WHERE connection_id = ? AND status = 'held' ORDER BY id`,
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
    async attention(connectionId, query = {}) {
      const limit = Math.min(Math.max(query.limit ?? 20, 1), 100)
      const rows = sqlite
        .query<OutboxDb, (string | number)[]>(
          `SELECT * FROM channel_outbox
             WHERE connection_id = ? AND id < ?
               AND (status = 'held' OR (status = 'failed' AND reviewed_at IS NULL AND updated_at >= ?))
             ORDER BY id DESC LIMIT ?`,
        )
        .all(connectionId, query.before ?? '\uffff', query.since ?? 0, limit + 1)
      const page = rows.slice(0, limit)
      const last = page[page.length - 1]
      return {
        rows: await Promise.all(page.map(open)),
        ...(rows.length > limit && last !== undefined ? { next: last.id } : {}),
      }
    },
    retry(connectionId, id, now) {
      return (
        sqlite
          .query(
            `UPDATE channel_outbox SET status = 'pending', next_at = ?, attempts = 0, updated_at = ?,
               reviewed_at = NULL, owner = NULL, lease_until = NULL
               WHERE id = ? AND connection_id = ? AND status = 'failed' AND kind != 'post'`,
          )
          .run(now, now, id, connectionId).changes === 1
      )
    },
    dismiss(connectionId, id, now) {
      return (
        sqlite
          .query(
            `UPDATE channel_outbox SET reviewed_at = ?
               WHERE id = ? AND connection_id = ? AND status = 'failed' AND reviewed_at IS NULL`,
          )
          .run(now, id, connectionId).changes === 1
      )
    },
    counts(connectionId) {
      // a failed row a person dismissed no longer counts: it was looked at
      const rows =
        connectionId === undefined
          ? sqlite
              .query<{ status: string; n: number }, []>(
                `SELECT status, COUNT(*) AS n FROM channel_outbox
                   WHERE NOT (status = 'failed' AND reviewed_at IS NOT NULL) GROUP BY status`,
              )
              .all()
          : sqlite
              .query<{ status: string; n: number }, [string]>(
                `SELECT status, COUNT(*) AS n FROM channel_outbox
                   WHERE connection_id = ? AND NOT (status = 'failed' AND reviewed_at IS NOT NULL) GROUP BY status`,
              )
              .all(connectionId)
      const out: Record<OutboxStatus, number> = {
        pending: 0,
        sending: 0,
        held: 0,
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
