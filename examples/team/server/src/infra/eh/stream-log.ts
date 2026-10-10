/**
 * `StreamLogAdapter` on SQLite (spec 04 §6.2, ADR-0039): the chunks of a turn, appended by the
 * instance that runs it and read by any instance that serves a resumed stream.
 *
 * - `eh_stream_log` holds the head (status, length, retention); `eh_stream_chunks` the chunks keyed
 *   by `(session_id, turn_id, idx)`. The cursor is `idx`.
 * - Every write runs in `BEGIN IMMEDIATE`, so two processes on one WAL file serialize. An append
 *   with `at` is idempotent by length (a retried batch adds nothing); a gap rejects.
 * - Retention: `expires_at` moves with every append / close (`ttl_ms`, default 10 minutes) and
 *   `expire(key, ttl)` shortens it. An expired log reads as `missing` and is purged lazily.
 * - No `subscribe`: SQLite has no cross-process notification, so readers poll (`streams.pollMs`).
 */
import type { Database } from 'bun:sqlite'
import type { StreamLogAdapter, StreamLogKey, StreamLogStatus } from 'eharness'

const DEFAULT_TTL_MS = 600_000

interface Head {
  status: Exclude<StreamLogStatus, 'missing'>
  length: number
  ttl_ms: number
  expires_at: number
}

export interface SqliteStreamLogOptions {
  /** Retention of a log that is still open (and before `expire` is called). Default 10 minutes. */
  retentionMs?: number
  /** Clock (tests). Default `Date.now`. */
  now?: () => number
}

export function sqliteStreamLog(
  sqlite: Database,
  options: SqliteStreamLogOptions = {},
): StreamLogAdapter {
  const now = options.now ?? (() => Date.now())
  const defaultTtl = options.retentionMs ?? DEFAULT_TTL_MS

  const head = (key: StreamLogKey): Head | null =>
    sqlite
      .query<Head, [string, string]>(
        'SELECT status, length, ttl_ms, expires_at FROM eh_stream_log WHERE session_id = ? AND turn_id = ?',
      )
      .get(key.sessionId, key.turnId)

  const drop = (key: StreamLogKey): void => {
    sqlite
      .query('DELETE FROM eh_stream_chunks WHERE session_id = ? AND turn_id = ?')
      .run(key.sessionId, key.turnId)
    sqlite
      .query('DELETE FROM eh_stream_log WHERE session_id = ? AND turn_id = ?')
      .run(key.sessionId, key.turnId)
  }

  /** The live head of `key`; an expired log is purged and reads as absent. */
  const live = (key: StreamLogKey): Head | null => {
    const h = head(key)
    if (h !== null && h.expires_at <= now()) {
      drop(key)
      return null
    }
    return h
  }

  /** Purge every expired log (called on close, so a busy server cleans up as it goes). */
  const sweep = (): void => {
    const t = now()
    sqlite
      .query(
        `DELETE FROM eh_stream_chunks WHERE EXISTS (
         SELECT 1 FROM eh_stream_log l
         WHERE l.session_id = eh_stream_chunks.session_id
           AND l.turn_id = eh_stream_chunks.turn_id AND l.expires_at <= ?)`,
      )
      .run(t)
    sqlite.query('DELETE FROM eh_stream_log WHERE expires_at <= ?').run(t)
  }

  const create = (key: StreamLogKey, status: Head['status']): Head => {
    const h: Head = { status, length: 0, ttl_ms: defaultTtl, expires_at: now() + defaultTtl }
    sqlite
      .query(
        'INSERT INTO eh_stream_log (session_id, turn_id, status, length, ttl_ms, expires_at) VALUES (?, ?, ?, 0, ?, ?)',
      )
      .run(key.sessionId, key.turnId, status, h.ttl_ms, h.expires_at)
    return h
  }

  const write = <T>(fn: () => T): T => sqlite.transaction(fn).immediate()

  return {
    async append(key, chunks, opts) {
      return write(() => {
        const h = live(key) ?? create(key, 'streaming')
        if (h.status !== 'streaming') return h.length
        let fresh = chunks
        if (opts?.at !== undefined) {
          if (opts.at > h.length) {
            throw new Error(`append at ${opts.at} leaves a gap: the log has ${h.length}`)
          }
          fresh = chunks.slice(h.length - opts.at)
        }
        const insert = sqlite.query(
          'INSERT INTO eh_stream_chunks (session_id, turn_id, idx, chunk) VALUES (?, ?, ?, ?)',
        )
        let length = h.length
        for (const chunk of fresh)
          insert.run(key.sessionId, key.turnId, length++, JSON.stringify(chunk))
        sqlite
          .query(
            'UPDATE eh_stream_log SET length = ?, expires_at = ? WHERE session_id = ? AND turn_id = ?',
          )
          .run(length, now() + h.ttl_ms, key.sessionId, key.turnId)
        return length
      })
    },

    async close(key, status) {
      write(() => {
        sweep()
        const h = head(key)
        if (h === null) {
          create(key, status)
          return
        }
        if (h.status !== 'streaming') return // the first status wins
        sqlite
          .query(
            'UPDATE eh_stream_log SET status = ?, expires_at = ? WHERE session_id = ? AND turn_id = ?',
          )
          .run(status, now() + h.ttl_ms, key.sessionId, key.turnId)
      })
    },

    async read(key, from, opts) {
      const start = Math.max(0, Math.floor(from))
      const h = live(key)
      if (h === null) return { chunks: [], next: start, status: 'missing' }
      const limit = opts?.limit === undefined ? -1 : Math.max(0, Math.floor(opts.limit))
      const rows = sqlite
        .query<{ chunk: string }, [string, string, number, number]>(
          `SELECT chunk FROM eh_stream_chunks WHERE session_id = ? AND turn_id = ? AND idx >= ?
           ORDER BY idx LIMIT ?`,
        )
        .all(key.sessionId, key.turnId, start, limit)
      return {
        chunks: rows.map((r) => JSON.parse(r.chunk) as unknown),
        next: start + rows.length,
        status: h.status,
      }
    },

    async expire(key, ttlMs) {
      write(() => {
        if (live(key) === null) return
        sqlite
          .query(
            'UPDATE eh_stream_log SET ttl_ms = ?, expires_at = ? WHERE session_id = ? AND turn_id = ?',
          )
          .run(ttlMs, now() + ttlMs, key.sessionId, key.turnId)
      })
    },
  }
}
