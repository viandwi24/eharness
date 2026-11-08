/**
 * `InboxAdapter` (spec 05 §12) on `<prefix>inbox` and `<prefix>inbox_keys`: head-of-line claims
 * with leases, `availableAt` timers, retry delays, dead letters, stats, and `enqueueOnce`
 * de-duplication. `claim` is one `BEGIN IMMEDIATE` transaction, so claimers in several processes
 * never take the same item. `subscribe` polls (`pollMs`): SQLite has no notification channel.
 */
import {
  type DeadInboxItem,
  type InboxAdapter,
  type InboxItem,
  type InboxItemInput,
  type InboxStats,
  uuidv7,
} from '../index.ts'
import type { SqlDriver, SqlParam } from './driver.ts'
import { type AdapterOptions, clock, createWatcher, one, placeholders, tables } from './util.ts'

/** Options of {@link sqliteInbox}. */
export interface SqliteInboxOptions extends AdapterOptions {
  /** How long the caller id of an acked item keeps de-duplicating (ms). Default 24 hours. */
  dedupeWindowMs?: number
  /** Wake-up polling of `subscribe` (ms). Default 250. */
  pollMs?: number
}

interface InboxRow {
  id: string
  session_id: string
  kind: string
  item: string
  attempts: number
  last_error: string | null
  dead_at: number | null
  dead_reason: string | null
}

const toItem = (row: InboxRow): InboxItem => {
  const item: InboxItem = { ...JSON.parse(row.item), id: row.id, attempts: row.attempts }
  if (row.last_error !== null) item.lastError = row.last_error
  return item
}

/** The 24 h minimum of spec 05 §12 rule 17. */
const DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1000

export function sqliteInbox(driver: SqlDriver, options: SqliteInboxOptions = {}): InboxAdapter {
  const names = tables(options.prefix)
  const t = names.inbox
  const keys = names.inboxKeys
  const now = clock(options)
  const dedupeWindowMs = options.dedupeWindowMs ?? DEDUPE_WINDOW_MS
  const pollMs = options.pollMs ?? 250
  const watchers = new Map<string, ReturnType<typeof createWatcher>>()

  const insertItem = (sessionId: string, item: InboxItemInput): string => {
    const id = uuidv7()
    driver.run(
      `INSERT INTO ${t} (id, session_id, kind, item, available_at) VALUES (?, ?, ?, ?, ?)`,
      [id, sessionId, item.kind, JSON.stringify(item), item.availableAt ?? null],
    )
    return id
  }

  /** Changes whenever a new item becomes claimable for the session. */
  const readySignature = (sessionId: string): string => {
    const at = now()
    const row = one<{ n: number; last: string | null }>(
      driver,
      `SELECT count(*) AS n, max(id) AS last FROM ${t}
       WHERE session_id = ? AND dead_at IS NULL
         AND (claimed_until IS NULL OR claimed_until <= ?)
         AND (available_at IS NULL OR available_at <= ?)
         AND (delayed_until IS NULL OR delayed_until <= ?)`,
      [sessionId, at, at, at],
    )
    return `${row?.n ?? 0}:${row?.last ?? ''}`
  }

  return {
    async enqueue(sessionId, item) {
      return driver.transaction(() => insertItem(sessionId, item))
    },

    /**
     * Idempotent enqueue (rule 17): the key lives in `inbox_keys` next to the item, in one
     * transaction, so racing producers (also in other processes) store exactly one item. The key
     * has no expiry while the item is stored (ready, claimed, delayed, dead) and keeps
     * de-duplicating for `dedupeWindowMs` after the ack.
     */
    async enqueueOnce(sessionId, item) {
      return driver.transaction(() => {
        driver.run(`DELETE FROM ${keys} WHERE expires_at IS NOT NULL AND expires_at <= ?`, [now()])
        const known = one<{ item_id: string }>(
          driver,
          `SELECT item_id FROM ${keys} WHERE session_id = ? AND dedupe_key = ?`,
          [sessionId, item.dedupeKey],
        )
        if (known !== undefined) return { id: known.item_id, duplicate: true }
        const id = insertItem(sessionId, item)
        driver.run(
          `INSERT INTO ${keys} (session_id, dedupe_key, item_id, expires_at) VALUES (?, ?, ?, NULL)`,
          [sessionId, item.dedupeKey, id],
        )
        return { id, duplicate: false }
      })
    },

    async claim(sessionId, owner, opts = {}) {
      const ttl = Math.max(1, Math.round(opts.claimTtlMs ?? 120_000))
      return driver.transaction(() => {
        const at = now()
        const until = at + ttl
        // renew the claims the owner already holds (not returned again, attempts unchanged)
        driver.run(
          `UPDATE ${t} SET claimed_until = ?
           WHERE session_id = ? AND claimed_by = ? AND claimed_until > ? AND dead_at IS NULL`,
          [until, sessionId, owner, at],
        )
        // head of line: oldest row another owner still holds
        const head = one<{ id: string }>(
          driver,
          `SELECT id FROM ${t}
           WHERE session_id = ? AND dead_at IS NULL AND claimed_until > ? AND claimed_by IS NOT ?
           ORDER BY id LIMIT 1`,
          [sessionId, at, owner],
        )?.id
        // oldest delayed (retry backoff) row: holds back everything after it except aborts
        const delay = one<{ id: string }>(
          driver,
          `SELECT id FROM ${t}
           WHERE session_id = ? AND dead_at IS NULL AND delayed_until > ?
             AND (claimed_until IS NULL OR claimed_until <= ?)
             AND (available_at IS NULL OR available_at <= ?)
           ORDER BY id LIMIT 1`,
          [sessionId, at, at, at],
        )?.id
        const candidates = driver.query<InboxRow>(
          `SELECT * FROM ${t}
           WHERE session_id = ? AND dead_at IS NULL
             AND (claimed_until IS NULL OR claimed_until <= ?)
             AND (available_at IS NULL OR available_at <= ?)
             AND (delayed_until IS NULL OR delayed_until <= ?)
           ORDER BY id`,
          [sessionId, at, at, at],
        )
        const limit = opts.limit ?? Number.POSITIVE_INFINITY
        const claimed: InboxItem[] = []
        for (const row of candidates) {
          if (claimed.length >= limit) break
          if (head !== undefined && row.id > head) continue
          if (delay !== undefined && row.id > delay && row.kind !== 'abort') continue
          driver.run(
            `UPDATE ${t} SET claimed_by = ?, claimed_until = ?, attempts = attempts + 1,
               delayed_until = NULL WHERE id = ?`,
            [owner, until, row.id],
          )
          claimed.push(toItem({ ...row, attempts: row.attempts + 1 }))
        }
        return claimed
      })
    },

    async ack(ids) {
      if (ids.length === 0) return
      driver.transaction(() => {
        // the caller ids of acked items keep de-duplicating for the window
        driver.run(
          `UPDATE ${keys} SET expires_at = ? WHERE item_id IN (${placeholders(ids.length)})`,
          [now() + dedupeWindowMs, ...ids],
        )
        driver.run(`DELETE FROM ${t} WHERE id IN (${placeholders(ids.length)})`, ids)
      })
    },

    async release(ids, opts = {}) {
      if (ids.length === 0) return
      const delayUntil =
        opts.delayMs !== undefined && opts.delayMs > 0 ? now() + Math.round(opts.delayMs) : null
      const params: SqlParam[] = [
        opts.uncount === true ? 1 : 0,
        delayUntil,
        delayUntil,
        opts.lastError ?? null,
        ...ids,
        opts.owner ?? null,
        opts.owner ?? null,
      ]
      driver.transaction(() =>
        driver.run(
          `UPDATE ${t} SET claimed_by = NULL, claimed_until = NULL,
             attempts = CASE WHEN ? = 1 THEN MAX(0, attempts - 1) ELSE attempts END,
             delayed_until = CASE WHEN ? IS NOT NULL THEN ? ELSE delayed_until END,
             last_error = COALESCE(?, last_error)
           WHERE id IN (${placeholders(ids.length)})
             AND dead_at IS NULL AND claimed_by IS NOT NULL
             AND (? IS NULL OR claimed_by = ?)`,
          params,
        ),
      )
    },

    async deadLetter(ids, info) {
      if (ids.length === 0) return
      driver.run(
        `UPDATE ${t} SET claimed_by = NULL, claimed_until = NULL, delayed_until = NULL,
           dead_at = ?, dead_reason = ?, last_error = COALESCE(?, last_error)
         WHERE id IN (${placeholders(ids.length)}) AND dead_at IS NULL`,
        [now(), info.reason, info.lastError ?? null, ...ids],
      )
    },

    async redrive(ids) {
      if (ids.length === 0) return
      driver.run(
        `UPDATE ${t} SET dead_at = NULL, dead_reason = NULL, attempts = 0, last_error = NULL
         WHERE id IN (${placeholders(ids.length)}) AND dead_at IS NOT NULL`,
        ids,
      )
    },

    async listDead(opts = {}) {
      return driver
        .query<InboxRow>(
          `SELECT * FROM ${t} WHERE dead_at IS NOT NULL AND (? IS NULL OR session_id = ?)
           ORDER BY id LIMIT ?`,
          [opts.sessionId ?? null, opts.sessionId ?? null, opts.limit ?? -1],
        )
        .map(
          (row): DeadInboxItem => ({
            ...toItem(row),
            sessionId: row.session_id,
            deadAt: row.dead_at as number,
            reason: row.dead_reason as string,
          }),
        )
    },

    async stats(opts = {}): Promise<InboxStats> {
      const at = now()
      const row = one<{ ready: number; claimed: number; delayed: number; dead: number }>(
        driver,
        `SELECT
           coalesce(sum(dead_at IS NOT NULL), 0) AS dead,
           coalesce(sum(dead_at IS NULL AND claimed_until > ?), 0) AS claimed,
           coalesce(sum(dead_at IS NULL AND (claimed_until IS NULL OR claimed_until <= ?)
             AND (delayed_until > ? OR available_at > ?)), 0) AS delayed,
           coalesce(sum(dead_at IS NULL AND (claimed_until IS NULL OR claimed_until <= ?)
             AND (delayed_until IS NULL OR delayed_until <= ?)
             AND (available_at IS NULL OR available_at <= ?)), 0) AS ready
         FROM ${t} WHERE (? IS NULL OR session_id = ?)`,
        [at, at, at, at, at, at, at, opts.sessionId ?? null, opts.sessionId ?? null],
      )
      return {
        ready: Number(row?.ready ?? 0),
        claimed: Number(row?.claimed ?? 0),
        delayed: Number(row?.delayed ?? 0),
        dead: Number(row?.dead ?? 0),
      }
    },

    async pending(opts = {}) {
      const at = now()
      return driver
        .query<{ session_id: string }>(
          `SELECT DISTINCT c.session_id FROM ${t} AS c
           WHERE c.dead_at IS NULL
             AND (c.claimed_until IS NULL OR c.claimed_until <= ?)
             AND (c.available_at IS NULL OR c.available_at <= ?)
             AND (c.delayed_until IS NULL OR c.delayed_until <= ?)
             AND NOT EXISTS (SELECT 1 FROM ${t} AS h WHERE h.session_id = c.session_id
               AND h.id < c.id AND h.dead_at IS NULL AND h.claimed_until > ?)
             AND (c.kind = 'abort' OR NOT EXISTS (SELECT 1 FROM ${t} AS d
               WHERE d.session_id = c.session_id AND d.id < c.id AND d.dead_at IS NULL
                 AND d.delayed_until > ?
                 AND (d.claimed_until IS NULL OR d.claimed_until <= ?)
                 AND (d.available_at IS NULL OR d.available_at <= ?)))
           LIMIT ?`,
          [at, at, at, at, at, at, at, opts.limit ?? -1],
        )
        .map((r) => r.session_id)
    },

    async notify(sessionId) {
      watchers.get(sessionId)?.fire()
    },

    subscribe(sessionId, onNotify) {
      let watcher = watchers.get(sessionId)
      if (watcher === undefined) {
        watcher = createWatcher(() => readySignature(sessionId), pollMs)
        watchers.set(sessionId, watcher)
      }
      const remove = watcher.add(onNotify)
      return () => {
        remove()
        if (watcher.size() === 0 && watchers.get(sessionId) === watcher) watchers.delete(sessionId)
      }
    },
  }
}
