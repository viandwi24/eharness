/**
 * `StreamLogAdapter` (spec 04 §6.2, ADR-0039): the chunks of a turn, appended by the instance that
 * runs it and read by any instance that serves a resumed stream.
 *
 * `<prefix>stream_log` holds the head (status, length, retention); `<prefix>stream_chunks` the
 * chunks keyed by `(session_id, turn_id, seq)`; the cursor is `seq`. Every write is one
 * `BEGIN IMMEDIATE` transaction. An append with `at` is idempotent by length (a retried batch adds
 * nothing); a gap rejects. Retention: `expires_at` moves with every append and close and
 * `expire(key, ttl)` shortens it; an expired log reads as `missing` and is purged lazily.
 * `subscribe` polls (`pollMs`).
 */
import type { StreamLogAdapter, StreamLogKey, StreamLogStatus } from '../index.ts'
import type { SqlDriver } from './driver.ts'
import { type AdapterOptions, clock, createWatcher, one, tables } from './util.ts'

/** Options of {@link sqliteStreamLog}. */
export interface SqliteStreamLogOptions extends AdapterOptions {
  /** Retention of a log that is still open (and before `expire` is called). Default 10 minutes. */
  retentionMs?: number
  /** Polling of `subscribe` (ms). Default 250. */
  pollMs?: number
}

const DEFAULT_TTL_MS = 600_000

interface Head {
  status: Exclude<StreamLogStatus, 'missing'>
  length: number
  ttl_ms: number
  expires_at: number
}

const keyString = (key: StreamLogKey): string => `${key.sessionId}\u0000${key.turnId}`

export function sqliteStreamLog(
  driver: SqlDriver,
  options: SqliteStreamLogOptions = {},
): StreamLogAdapter {
  const names = tables(options.prefix)
  const log = names.streamLog
  const chunks = names.streamChunks
  const now = clock(options)
  const defaultTtl = options.retentionMs ?? DEFAULT_TTL_MS
  const pollMs = options.pollMs ?? 250
  const watchers = new Map<string, ReturnType<typeof createWatcher>>()

  const head = (key: StreamLogKey): Head | undefined =>
    one<Head>(
      driver,
      `SELECT status, length, ttl_ms, expires_at FROM ${log} WHERE session_id = ? AND turn_id = ?`,
      [key.sessionId, key.turnId],
    )

  const drop = (key: StreamLogKey): void => {
    driver.run(`DELETE FROM ${chunks} WHERE session_id = ? AND turn_id = ?`, [
      key.sessionId,
      key.turnId,
    ])
    driver.run(`DELETE FROM ${log} WHERE session_id = ? AND turn_id = ?`, [
      key.sessionId,
      key.turnId,
    ])
  }

  /** The live head of `key`; an expired log is purged and reads as absent. */
  const live = (key: StreamLogKey): Head | undefined => {
    const h = head(key)
    if (h !== undefined && h.expires_at <= now()) {
      drop(key)
      return undefined
    }
    return h
  }

  /** Purge every expired log (called on close, so a busy server cleans up as it goes). */
  const sweep = (): void => {
    const at = now()
    driver.run(
      `DELETE FROM ${chunks} WHERE EXISTS (
         SELECT 1 FROM ${log} l
         WHERE l.session_id = ${chunks}.session_id AND l.turn_id = ${chunks}.turn_id
           AND l.expires_at <= ?)`,
      [at],
    )
    driver.run(`DELETE FROM ${log} WHERE expires_at <= ?`, [at])
  }

  const create = (key: StreamLogKey, status: Head['status']): Head => {
    const h: Head = { status, length: 0, ttl_ms: defaultTtl, expires_at: now() + defaultTtl }
    driver.run(
      `INSERT INTO ${log} (session_id, turn_id, status, length, ttl_ms, expires_at) VALUES (?, ?, ?, 0, ?, ?)`,
      [key.sessionId, key.turnId, status, h.ttl_ms, h.expires_at],
    )
    return h
  }

  const signal = (key: StreamLogKey): void => watchers.get(keyString(key))?.fire()

  return {
    async append(key, batch, opts) {
      const length = driver.transaction(() => {
        const existing = live(key)
        if (existing === undefined && opts?.at !== undefined && opts.at > 0) {
          // plain-error: adapter contract: the same wording as the in-memory stream log
          throw new Error(`append at ${opts.at} leaves a gap: the log does not exist`)
        }
        const h = existing ?? create(key, 'streaming')
        if (h.status !== 'streaming') return h.length
        let fresh = batch
        if (opts?.at !== undefined) {
          if (opts.at > h.length) {
            // plain-error: adapter contract: the same wording as the in-memory stream log
            throw new Error(`append at ${opts.at} leaves a gap: the log has ${h.length}`)
          }
          fresh = batch.slice(h.length - opts.at)
        }
        let next = h.length
        for (const chunk of fresh) {
          driver.run(
            `INSERT INTO ${chunks} (session_id, turn_id, seq, chunk) VALUES (?, ?, ?, ?)`,
            [key.sessionId, key.turnId, next++, JSON.stringify(chunk)],
          )
        }
        driver.run(
          `UPDATE ${log} SET length = ?, expires_at = ? WHERE session_id = ? AND turn_id = ?`,
          [next, now() + h.ttl_ms, key.sessionId, key.turnId],
        )
        return next
      })
      signal(key)
      return length
    },

    async close(key, status) {
      driver.transaction(() => {
        sweep()
        const h = head(key)
        if (h === undefined) {
          create(key, status)
          return
        }
        if (h.status !== 'streaming') return // the first status wins
        driver.run(
          `UPDATE ${log} SET status = ?, expires_at = ? WHERE session_id = ? AND turn_id = ?`,
          [status, now() + h.ttl_ms, key.sessionId, key.turnId],
        )
      })
      signal(key)
    },

    async read(key, from, opts) {
      const start = Math.max(0, Math.floor(from))
      const h = live(key)
      if (h === undefined) return { chunks: [], next: start, status: 'missing' }
      const limit = opts?.limit === undefined ? -1 : Math.max(0, Math.floor(opts.limit))
      const rows = driver.query<{ chunk: string }>(
        `SELECT chunk FROM ${chunks} WHERE session_id = ? AND turn_id = ? AND seq >= ?
         ORDER BY seq LIMIT ?`,
        [key.sessionId, key.turnId, start, limit],
      )
      return {
        chunks: rows.map((r) => JSON.parse(r.chunk) as unknown),
        next: start + rows.length,
        status: h.status,
      }
    },

    async expire(key, ttlMs) {
      driver.transaction(() => {
        if (live(key) === undefined) return
        driver.run(
          `UPDATE ${log} SET ttl_ms = ?, expires_at = ? WHERE session_id = ? AND turn_id = ?`,
          [ttlMs, now() + ttlMs, key.sessionId, key.turnId],
        )
      })
    },

    subscribe(key, onAppend) {
      const id = keyString(key)
      let watcher = watchers.get(id)
      if (watcher === undefined) {
        watcher = createWatcher(() => {
          const h = head(key)
          return h === undefined ? 'missing' : `${h.length}:${h.status}`
        }, pollMs)
        watchers.set(id, watcher)
      }
      const remove = watcher.add(onAppend)
      return () => {
        remove()
        if (watcher.size() === 0 && watchers.get(id) === watcher) watchers.delete(id)
      }
    },
  }
}
