/**
 * `ScheduleStore` (`eharness/scheduler`, spec 29 §2) over the existing `routines` table, so no data
 * moves: a routine row IS a schedule. What the library does not know (prompt, name, failures,
 * `max_fires`, `end_at`, program owner) stays in its own columns; the scheduler columns
 * (`sched_version`, `claimed_by`, `claimed_until`, `sched_payload`) were added by a migration.
 *
 * Mapping:
 *  - `sessionId` <-> `agent_id` (the app routes a fire from the agent; the library never opens it),
 *  - `spec`: `cron{expr,tz}` <-> `cron{expr,timezone}`, `every` <-> `interval`, `at` <-> `once`,
 *  - `state`: `status = 'active'` <-> `active`, anything else <-> `paused`,
 *  - `version` <-> `sched_version` (claims and completions bump it; the editors' `version` column
 *    is untouched, so a tick never makes an open editor conflict),
 *  - `catchUp` always reads `once` and `overlap` `skip`: the app's fire callback applies the catch-up
 *    window (`catch_up_window_ms`) and the overlap check itself, and records a skipped run.
 *
 * `complete` also applies the routine policy that lives in the row: past `end_at` or `max_fires`
 * the schedule pauses itself (`ended`, `max-fires`), and an exhausted one pauses as `completed`
 * (an `at` routine) or `ended`; `onPaused` tells the service so it can emit the event.
 */
import type { Database } from 'bun:sqlite'
import type {
  Schedule,
  ScheduleListQuery,
  ScheduleListResult,
  ScheduleSpec,
  ScheduleStore,
} from 'eharness/scheduler'
import type { PausedReason, RoutineSpec } from '../../domain/routines.ts'

interface Row {
  id: string
  agent_id: string
  spec: string
  overlap: string
  catch_up_window_ms: number | null
  status: string
  next_fire_at: number | null
  last_fire_at: number | null
  max_fires: number | null
  end_at: number | null
  fire_count: number
  version: number
  sched_version: number
  claimed_by: string | null
  claimed_until: number | null
  sched_payload: string | null
}

const toSpec = (raw: string): ScheduleSpec => {
  const s = JSON.parse(raw) as RoutineSpec
  if (s.kind === 'cron') return { kind: 'cron', expr: s.expr, timezone: s.tz }
  if (s.kind === 'every') return { kind: 'interval', everyMs: s.everyMs }
  return { kind: 'once', at: s.at }
}

const fromSpec = (s: ScheduleSpec): RoutineSpec => {
  if (s.kind === 'cron') return { kind: 'cron', expr: s.expr, tz: s.timezone ?? 'UTC' }
  if (s.kind === 'interval') return { kind: 'every', everyMs: s.everyMs }
  return { kind: 'at', at: s.at }
}

const toSchedule = (r: Row): Schedule => ({
  id: r.id,
  sessionId: r.agent_id,
  spec: toSpec(r.spec),
  payload: r.sched_payload === null ? null : JSON.parse(r.sched_payload),
  state: r.status === 'active' ? 'active' : 'paused',
  overlap: 'skip',
  catchUp: 'once',
  nextFireAt: r.next_fire_at,
  ...(r.last_fire_at === null ? {} : { lastFireAt: r.last_fire_at }),
  ...(r.claimed_by === null ? {} : { claimedBy: r.claimed_by }),
  ...(r.claimed_until === null ? {} : { claimedUntil: r.claimed_until }),
  version: r.sched_version,
})

export interface ScheduleStoreOptions {
  /**
   * The scheduler runs with `now + lookaheadMs` so a slot a little ahead fires on time (the fire
   * carries `availableAt`). The rows of programs and system routines are held back until their
   * slot: `due` hides them while `next_fire_at > now` (`now` = the scheduler's clock - lookahead).
   * Default 0.
   */
  lookaheadMs?: number
  /** A routine paused itself on completion (`ended`, `max-fires`, `completed`). */
  onPaused?: (routineId: string, reason: PausedReason) => void
}

export function sqliteScheduleStore(
  sqlite: Database,
  options: ScheduleStoreOptions = {},
): ScheduleStore {
  const lookahead = options.lookaheadMs ?? 0
  const byId = sqlite.query<Row, [string]>('SELECT * FROM routines WHERE id = ?')
  const immediate = <T>(fn: () => T): T => sqlite.transaction(fn).immediate()
  /** The editors' `version` at claim time: a `complete` after an edit must not overwrite it. */
  const claimedAt = new Map<string, number>()

  const read = (id: string): Schedule | undefined => {
    const row = byId.get(id)
    return row === null ? undefined : toSchedule(row)
  }

  const put = (s: Schedule): Schedule =>
    immediate(() => {
      const spec = JSON.stringify(fromSpec(s.spec))
      const payload =
        s.payload === null || s.payload === undefined ? null : JSON.stringify(s.payload)
      const status = s.state === 'active' ? 'active' : 'paused'
      const existing = byId.get(s.id)
      if (existing === null) {
        const now = Date.now()
        sqlite
          .query(
            `INSERT INTO routines (id, agent_id, name, prompt, spec, session_mode, overlap,
               catch_up_window_ms, status, next_fire_at, last_fire_at, created_at, updated_at,
               sched_version, claimed_by, claimed_until, sched_payload)
             VALUES (?, ?, ?, '', ?, 'task', ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
          )
          .run(
            s.id,
            s.sessionId,
            s.id,
            spec,
            s.overlap,
            s.catchUp === 'skip' ? null : 0,
            status,
            s.nextFireAt,
            s.lastFireAt ?? null,
            now,
            now,
            s.claimedBy ?? null,
            s.claimedUntil ?? null,
            payload,
          )
      } else {
        // the app-owned columns (name, prompt, overlap, catch-up window, failures) are not ours
        sqlite
          .query(
            `UPDATE routines SET agent_id = ?, spec = ?, status = ?, next_fire_at = ?,
               last_fire_at = ?, claimed_by = ?, claimed_until = ?, sched_payload = ?,
               updated_at = ?, sched_version = sched_version + 1
             WHERE id = ?`,
          )
          .run(
            s.sessionId,
            spec,
            status,
            s.nextFireAt,
            s.lastFireAt ?? null,
            s.claimedBy ?? null,
            s.claimedUntil ?? null,
            payload,
            Date.now(),
            s.id,
          )
      }
      return read(s.id) as Schedule
    })

  return {
    async get(id) {
      return read(id)
    },

    async list(query: ScheduleListQuery = {}): Promise<ScheduleListResult> {
      const limit = query.limit ?? 100
      const where: string[] = []
      const params: Array<string | number> = []
      if (query.sessionId !== undefined) {
        where.push('agent_id = ?')
        params.push(query.sessionId)
      }
      if (query.state === 'active') where.push("status = 'active'")
      else if (query.state === 'paused') where.push("status != 'active'")
      if (query.cursor !== undefined) {
        where.push('id > ?')
        params.push(query.cursor)
      }
      const rows = sqlite
        .query<Row, Array<string | number>>(
          `SELECT * FROM routines ${where.length === 0 ? '' : `WHERE ${where.join(' AND ')}`}
             ORDER BY id LIMIT ?`,
        )
        .all(...params, limit + 1)
      const page = rows.slice(0, limit)
      const last = page[page.length - 1]
      return {
        items: page.map(toSchedule),
        ...(rows.length > limit && last !== undefined ? { nextCursor: last.id } : {}),
      }
    },

    async put(schedule) {
      return put(schedule)
    },

    async delete(id) {
      return immediate(() => {
        sqlite.query('DELETE FROM routine_runs WHERE routine_id = ?').run(id)
        return sqlite.query('DELETE FROM routines WHERE id = ?').run(id).changes > 0
      })
    },

    async due(now, limit) {
      return sqlite
        .query<Row, [number, number, number, number]>(
          `SELECT * FROM routines WHERE status = 'active' AND next_fire_at IS NOT NULL
             AND (claimed_by IS NULL OR claimed_until IS NULL OR claimed_until <= ?)
             AND next_fire_at <= CASE WHEN program_id IS NULL THEN ? ELSE ? END
             ORDER BY next_fire_at, id LIMIT ?`,
        )
        .all(now, now, now - lookahead, limit)
        .map(toSchedule)
    },

    async claim(id, version, owner, leaseUntil) {
      return immediate(() => {
        const changed = sqlite
          .query(
            `UPDATE routines SET claimed_by = ?, claimed_until = ?, sched_version = sched_version + 1
               WHERE id = ? AND sched_version = ? AND status = 'active'`,
          )
          .run(owner, leaseUntil, id, version).changes
        if (changed !== 1) return undefined
        const row = byId.get(id) as Row
        claimedAt.set(id, row.version)
        return toSchedule(row)
      })
    },

    async complete(id, owner, advance) {
      let paused: PausedReason | undefined
      const done = immediate(() => {
        const row = byId.get(id)
        if (row === null || row.claimed_by !== owner) return undefined
        const edited = claimedAt.get(id) !== undefined && claimedAt.get(id) !== row.version
        claimedAt.delete(id)
        if (edited || row.status !== 'active') {
          // an editor (or a pause) got in while the fire ran: its next slot wins, only the claim goes
          sqlite
            .query(
              `UPDATE routines SET claimed_by = NULL, claimed_until = NULL,
                 last_fire_at = COALESCE(?, last_fire_at), sched_version = sched_version + 1
                 WHERE id = ?`,
            )
            .run(advance.lastFireAt ?? null, id)
          return read(id)
        }
        let next = advance.nextFireAt
        const fired = advance.lastFireAt !== undefined
        if (next !== null && row.end_at !== null && next > row.end_at) {
          next = null
          paused = 'ended'
        }
        if (fired && row.max_fires !== null && row.fire_count >= row.max_fires) {
          next = null
          paused = 'max-fires'
        }
        if (next === null && paused === undefined) {
          paused = (JSON.parse(row.spec) as RoutineSpec).kind === 'at' ? 'completed' : 'ended'
        }
        sqlite
          .query(
            `UPDATE routines SET next_fire_at = ?, last_fire_at = COALESCE(?, last_fire_at),
               claimed_by = NULL, claimed_until = NULL, sched_version = sched_version + 1,
               status = CASE WHEN ? IS NULL THEN status ELSE 'paused' END,
               paused_reason = CASE WHEN ? IS NULL THEN paused_reason ELSE ? END,
               updated_at = ?
               WHERE id = ?`,
          )
          .run(
            next,
            advance.lastFireAt ?? null,
            paused ?? null,
            paused ?? null,
            paused ?? null,
            Date.now(),
            id,
          )
        return read(id)
      })
      if (done !== undefined && paused !== undefined) options.onPaused?.(id, paused)
      return done
    },

    async release(id, owner) {
      return immediate(() => {
        claimedAt.delete(id)
        return (
          sqlite
            .query(
              `UPDATE routines SET claimed_by = NULL, claimed_until = NULL,
                 sched_version = sched_version + 1 WHERE id = ? AND claimed_by = ?`,
            )
            .run(id, owner).changes === 1
        )
      })
    },
  }
}
