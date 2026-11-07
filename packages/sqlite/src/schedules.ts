/**
 * `ScheduleStore` (spec 29 §2) on `<prefix>schedules`: the schedule is one JSON document, with the
 * columns the queries need (`state`, `next_fire_at`, `claimed_until`, `version`) next to it.
 * `claim`, `complete`, `release` and `update` are compare-and-set operations inside one write
 * transaction, so several processes on one file never claim the same slot twice.
 */
import type {
  Schedule,
  ScheduleListQuery,
  ScheduleListResult,
  ScheduleStore,
} from 'eharness/scheduler'
import type { SqlDriver, SqlParam } from './driver.ts'
import { type AdapterOptions, one, tables } from './util.ts'

interface Row {
  doc: string
  version: number
}

const toSchedule = (row: Row): Schedule => ({
  ...(JSON.parse(row.doc) as Schedule),
  version: row.version,
})

export function sqliteScheduleStore(
  driver: SqlDriver,
  options: AdapterOptions = {},
): ScheduleStore {
  const t = tables(options.prefix).schedules

  const read = (id: string): Schedule | undefined => {
    const row = one<Row>(driver, `SELECT doc, version FROM ${t} WHERE id = ?`, [id])
    return row === undefined ? undefined : toSchedule(row)
  }

  /** Write `schedule` at `version` (the caller read the previous one inside the transaction). */
  const write = (schedule: Schedule, version: number): Schedule => {
    const stored: Schedule = { ...structuredClone(schedule), version }
    driver.run(
      `INSERT INTO ${t} (id, session_id, state, next_fire_at, claimed_until, version, doc)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET session_id = excluded.session_id, state = excluded.state,
         next_fire_at = excluded.next_fire_at, claimed_until = excluded.claimed_until,
         version = excluded.version, doc = excluded.doc`,
      [
        stored.id,
        stored.sessionId,
        stored.state,
        stored.nextFireAt,
        stored.claimedBy === undefined ? null : (stored.claimedUntil ?? 0),
        version,
        JSON.stringify(stored),
      ],
    )
    return stored
  }

  return {
    async get(id) {
      return read(id)
    },

    async list(query: ScheduleListQuery = {}): Promise<ScheduleListResult> {
      const limit = query.limit ?? 100
      const where: string[] = []
      const params: SqlParam[] = []
      if (query.sessionId !== undefined) {
        where.push('session_id = ?')
        params.push(query.sessionId)
      }
      if (query.state !== undefined) {
        where.push('state = ?')
        params.push(query.state)
      }
      if (query.cursor !== undefined) {
        where.push('id > ?')
        params.push(query.cursor)
      }
      const rows = driver.query<Row & { id: string }>(
        `SELECT id, doc, version FROM ${t} ${where.length === 0 ? '' : `WHERE ${where.join(' AND ')}`}
         ORDER BY id LIMIT ?`,
        [...params, limit + 1],
      )
      const page = rows.slice(0, limit)
      const last = page[page.length - 1]
      return {
        items: page.map(toSchedule),
        ...(rows.length > limit && last !== undefined ? { nextCursor: last.id } : {}),
      }
    },

    async put(schedule) {
      return driver.transaction(() => write(schedule, (read(schedule.id)?.version ?? 0) + 1))
    },

    async update(schedule, expectedVersion) {
      return driver.transaction(() => {
        const current = read(schedule.id)
        if (current === undefined || current.version !== expectedVersion) return undefined
        return write(schedule, expectedVersion + 1)
      })
    },

    async delete(id) {
      return driver.run(`DELETE FROM ${t} WHERE id = ?`, [id]).changes > 0
    },

    async due(now, limit) {
      return driver
        .query<Row>(
          `SELECT doc, version FROM ${t}
           WHERE state = 'active' AND next_fire_at IS NOT NULL AND next_fire_at <= ?
             AND (claimed_until IS NULL OR claimed_until <= ?)
           ORDER BY next_fire_at, id LIMIT ?`,
          [now, now, limit],
        )
        .map(toSchedule)
    },

    async claim(id, version, owner, leaseUntil) {
      return driver.transaction(() => {
        const current = read(id)
        if (current === undefined || current.version !== version || current.state !== 'active') {
          return undefined
        }
        return write({ ...current, claimedBy: owner, claimedUntil: leaseUntil }, version + 1)
      })
    },

    async complete(id, owner, advance) {
      return driver.transaction(() => {
        const current = read(id)
        if (current === undefined || current.claimedBy !== owner) return undefined
        const next: Schedule = { ...current, nextFireAt: advance.nextFireAt }
        if (advance.lastFireAt !== undefined) next.lastFireAt = advance.lastFireAt
        delete next.claimedBy
        delete next.claimedUntil
        return write(next, current.version + 1)
      })
    },

    async release(id, owner) {
      return driver.transaction(() => {
        const current = read(id)
        if (current === undefined || current.claimedBy !== owner) return false
        const next: Schedule = { ...current }
        delete next.claimedBy
        delete next.claimedUntil
        write(next, current.version + 1)
        return true
      })
    },
  }
}
