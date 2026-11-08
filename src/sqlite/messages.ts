/** `MessageAdapter` and `StateAdapter` (spec 05 §4, §7) on `<prefix>messages` and `<prefix>state`. */
import type { UIMessage } from 'ai'
import type { MessageAdapter, SessionStateSnapshot, StateAdapter } from '../index.ts'
import type { SqlDriver } from './driver.ts'
import { type AdapterOptions, clock, one, tables } from './util.ts'

interface MessageRow {
  id: string
  role: string
  parts: string
  metadata: string | null
}

const toMessage = (row: MessageRow): UIMessage => ({
  id: row.id,
  role: row.role as UIMessage['role'],
  parts: JSON.parse(row.parts),
  ...(row.metadata === null ? {} : { metadata: JSON.parse(row.metadata) }),
})

/** `MessageAdapter`: every query is a range scan on the primary key `(session_id, id)`. */
export function sqliteMessages(driver: SqlDriver, options: AdapterOptions = {}): MessageAdapter {
  const t = tables(options.prefix).messages
  const now = clock(options)
  const cols = 'id, role, parts, metadata'
  return {
    async load({ sessionId, fromId, beforeId, limit }) {
      if (fromId !== undefined && beforeId !== undefined) {
        // plain-error: argument misuse, mirrors the MessageAdapter contract
        throw new TypeError('load: pass either fromId or beforeId, not both')
      }
      if (fromId !== undefined) {
        return driver
          .query<MessageRow>(
            `SELECT ${cols} FROM ${t} WHERE session_id = ? AND id >= ? ORDER BY id`,
            [sessionId, fromId],
          )
          .map(toMessage)
      }
      if (limit !== undefined && limit <= 0) return []
      const before = beforeId ?? null
      if (limit === undefined) {
        return driver
          .query<MessageRow>(
            `SELECT ${cols} FROM ${t} WHERE session_id = ? AND (? IS NULL OR id < ?) ORDER BY id`,
            [sessionId, before, before],
          )
          .map(toMessage)
      }
      const rows = driver.query<MessageRow>(
        `SELECT ${cols} FROM ${t} WHERE session_id = ? AND (? IS NULL OR id < ?) ORDER BY id DESC LIMIT ?`,
        [sessionId, before, before, Math.floor(limit)],
      )
      return rows.reverse().map(toMessage) // newest `limit`, chronological
    },
    async save(sessionId, batch) {
      const at = now()
      driver.transaction(() => {
        for (const m of batch) {
          driver.run(
            `INSERT INTO ${t} (session_id, id, role, parts, metadata, created_at)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT (session_id, id) DO UPDATE
               SET role = excluded.role, parts = excluded.parts, metadata = excluded.metadata`,
            [
              sessionId,
              m.id,
              m.role,
              JSON.stringify(m.parts),
              m.metadata === undefined ? null : JSON.stringify(m.metadata),
              at,
            ],
          )
        }
      })
    },
    async lastId(sessionId) {
      return (
        one<{ id: string }>(
          driver,
          `SELECT id FROM ${t} WHERE session_id = ? ORDER BY id DESC LIMIT 1`,
          [sessionId],
        )?.id ?? null
      )
    },
  }
}

/** `StateAdapter`; `setIf` is one conditional statement (compare-and-set on `rev`). */
export function sqliteState(driver: SqlDriver, options: AdapterOptions = {}): StateAdapter {
  const t = tables(options.prefix).state
  const now = clock(options)
  return {
    async get(sessionId) {
      const row = one<{ state: string }>(driver, `SELECT state FROM ${t} WHERE session_id = ?`, [
        sessionId,
      ])
      return row === undefined ? null : (JSON.parse(row.state) as SessionStateSnapshot)
    },
    async set(sessionId, state) {
      driver.run(
        `INSERT INTO ${t} (session_id, state, rev, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (session_id) DO UPDATE
           SET state = excluded.state, rev = excluded.rev, updated_at = excluded.updated_at`,
        [sessionId, JSON.stringify(state), state.rev, now()],
      )
    },
    async setIf(sessionId, state, expectedRev) {
      const json = JSON.stringify(state)
      const result =
        expectedRev === null
          ? driver.run(
              `INSERT INTO ${t} (session_id, state, rev, updated_at) VALUES (?, ?, ?, ?)
               ON CONFLICT (session_id) DO NOTHING`,
              [sessionId, json, state.rev, now()],
            )
          : driver.run(
              `UPDATE ${t} SET state = ?, rev = ?, updated_at = ? WHERE session_id = ? AND rev = ?`,
              [json, state.rev, now(), sessionId, expectedRev],
            )
      return result.changes === 1
    },
  }
}
