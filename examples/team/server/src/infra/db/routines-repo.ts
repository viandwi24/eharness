/**
 * Routines and their runs on SQLite (plain SQL on the shared connection). The scheduler's two
 * atomic steps live here:
 *
 *  - `claimSlot`: compare-and-set of `next_fire_at` plus the insert of the slot's run row in one
 *    `BEGIN IMMEDIATE` transaction. Of two instances that tick at once exactly one changes the
 *    row; the unique `(routine_id, scheduled_at)` makes a slot fire at most once.
 *  - `finishRun`: the outcome of a run and the routine's failure counter / auto-pause, atomically.
 */
import type { Database } from 'bun:sqlite'
import { uuidv7 } from 'eharness'
import type { NewRoutine, RoutinePatch, RoutineStore } from '../../app/ports.ts'
import type {
  PausedReason,
  Routine,
  RoutineRun,
  RoutineSpec,
  RunStatus,
} from '../../domain/routines.ts'

interface RoutineRow {
  id: string
  agent_id: string
  name: string
  prompt: string
  spec: string
  session_mode: string
  overlap: string
  catch_up_window_ms: number | null
  status: string
  paused_reason: string | null
  next_fire_at: number | null
  last_fire_at: number | null
  last_status: string | null
  failures: number
  max_failures: number
  fire_count: number
  max_fires: number | null
  end_at: number | null
  created_at: number
  updated_at: number
  version: number
}

const toRoutine = (r: RoutineRow): Routine => ({
  id: r.id,
  agentId: r.agent_id,
  name: r.name,
  prompt: r.prompt,
  schedule: JSON.parse(r.spec) as RoutineSpec,
  sessionMode: r.session_mode as Routine['sessionMode'],
  overlap: r.overlap as Routine['overlap'],
  catchUpWindowMs: r.catch_up_window_ms,
  status: r.status as Routine['status'],
  pausedReason: r.paused_reason as PausedReason | null,
  nextFireAt: r.next_fire_at,
  lastFireAt: r.last_fire_at,
  lastStatus: r.last_status,
  failures: r.failures,
  maxFailures: r.max_failures,
  fireCount: r.fire_count,
  maxFires: r.max_fires,
  endAt: r.end_at,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  version: r.version,
})

interface RunRow {
  id: string
  routine_id: string
  scheduled_at: number
  trigger: string
  status: string
  session_id: string
  inbox_id: string | null
  reason: string | null
  claimed_at: number
  fired_at: number | null
  finished_at: number | null
}

const toRun = (r: RunRow): RoutineRun => ({
  id: r.id,
  routineId: r.routine_id,
  scheduledAt: r.scheduled_at,
  trigger: r.trigger as RoutineRun['trigger'],
  status: r.status as RunStatus,
  sessionId: r.session_id,
  inboxId: r.inbox_id,
  reason: r.reason,
  claimedAt: r.claimed_at,
  firedAt: r.fired_at,
  finishedAt: r.finished_at,
})

/** What the winner of a slot writes to the routine row. */
export interface SlotClaim {
  routineId: string
  /** The `next_fire_at` the claimer read: the compare-and-set expects it. */
  expectedNext: number
  /** The slot the run is for (a missed slot is recorded as skipped). */
  scheduledAt: number
  nextFireAt: number | null
  /** Set when the routine pauses itself (`at` done, `endAt`, `maxFires`). */
  pause?: PausedReason
  /** Count the fire (a skipped or missed slot is not a fire). */
  fire: boolean
  status: 'claimed' | 'skipped'
  reason?: string
  sessionId: string
  now: number
}

export interface SqliteRoutineStore extends RoutineStore {
  /** Active routines whose slot is at or before `horizon`, oldest slot first. */
  due(horizon: number, limit: number): Routine[]
  /** The winner gets the run; a loser (another instance moved the slot) gets undefined. */
  claimSlot(claim: SlotClaim): RoutineRun | undefined
  /**
   * Pause a routine only while its slot is still `expectedNext` (e.g. its agent was archived);
   * true when this call did it.
   */
  pauseSlot(routineId: string, expectedNext: number, reason: PausedReason, now: number): boolean
  /** A manual run: a run row for `scheduledAt = now`, the schedule untouched. */
  insertManualRun(
    routineId: string,
    sessionId: string,
    scheduledAt: number,
    now: number,
  ): RoutineRun | undefined
  getRunBySlot(routineId: string, scheduledAt: number): RoutineRun | undefined
  getRunByInbox(inboxId: string): RoutineRun | undefined
  /** Runs still `claimed` since before `before`: a tick that died between claim and enqueue. */
  staleClaims(before: number): RoutineRun[]
  /** Newest run that is not skipped and not `exceptId`. */
  previousFiredRun(routineId: string, exceptId: string): RoutineRun | undefined
  markEnqueued(runId: string, info: { inboxId: string; firedAt: number; reason?: string }): void
  markSkipped(runId: string, reason: string, now: number): void
  /** Runs whose session needs an answer (a DM run waiting for an approval). */
  needsActionRuns(sessionId: string): RoutineRun[]
  /**
   * Record the outcome of a run, once: a finished run is never rewritten. `succeeded` resets the
   * failure counter, `failed` counts (unless `countFailure` is false: a stop pressed by a person)
   * and pauses the routine at `maxFailures`. Returns the routine when it paused.
   */
  finishRun(
    runId: string,
    outcome: {
      status: 'succeeded' | 'failed' | 'needs_action'
      reason?: string
      countFailure?: boolean
    },
    now: number,
  ): { run: RoutineRun; routine: Routine; paused: boolean } | undefined
}

export function sqliteRoutineStore(sqlite: Database): SqliteRoutineStore {
  const routineById = sqlite.query<RoutineRow, [string]>('SELECT * FROM routines WHERE id = ?')
  const runById = sqlite.query<RunRow, [string]>('SELECT * FROM routine_runs WHERE id = ?')
  const immediate = <T>(fn: () => T): T => sqlite.transaction(fn).immediate()

  const get = (id: string): Routine | undefined => {
    const row = routineById.get(id)
    return row === null ? undefined : toRoutine(row)
  }
  const getRun = (id: string): RoutineRun | undefined => {
    const row = runById.get(id)
    return row === null ? undefined : toRun(row)
  }

  return {
    list({ agentId }) {
      const rows =
        agentId === undefined
          ? sqlite.query<RoutineRow, []>('SELECT * FROM routines ORDER BY created_at, id').all()
          : sqlite
              .query<RoutineRow, [string]>(
                'SELECT * FROM routines WHERE agent_id = ? ORDER BY created_at, id',
              )
              .all(agentId)
      return rows.map(toRoutine)
    },

    get,

    insert(r: NewRoutine) {
      sqlite
        .query(
          `INSERT INTO routines (id, agent_id, name, prompt, spec, session_mode, overlap,
             catch_up_window_ms, status, next_fire_at, max_failures, max_fires, end_at,
             created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          r.id,
          r.agentId,
          r.name,
          r.prompt,
          JSON.stringify(r.schedule),
          r.sessionMode,
          r.overlap,
          r.catchUpWindowMs,
          r.nextFireAt,
          r.maxFailures,
          r.maxFires,
          r.endAt,
          r.now,
          r.now,
        )
      return get(r.id) as Routine
    },

    update(id, patch: RoutinePatch, now) {
      const sets: string[] = []
      const params: Array<string | number | null> = []
      const set = (column: string, value: string | number | null): void => {
        sets.push(`${column} = ?`)
        params.push(value)
      }
      if (patch.name !== undefined) set('name', patch.name)
      if (patch.prompt !== undefined) set('prompt', patch.prompt)
      if (patch.schedule !== undefined) set('spec', JSON.stringify(patch.schedule))
      if (patch.sessionMode !== undefined) set('session_mode', patch.sessionMode)
      if (patch.overlap !== undefined) set('overlap', patch.overlap)
      if (patch.catchUpWindowMs !== undefined) set('catch_up_window_ms', patch.catchUpWindowMs)
      if (patch.maxFailures !== undefined) set('max_failures', patch.maxFailures)
      if (patch.maxFires !== undefined) set('max_fires', patch.maxFires)
      if (patch.endAt !== undefined) set('end_at', patch.endAt)
      if (patch.status !== undefined) set('status', patch.status)
      if (patch.pausedReason !== undefined) set('paused_reason', patch.pausedReason)
      if (patch.nextFireAt !== undefined) set('next_fire_at', patch.nextFireAt)
      if (patch.failures !== undefined) set('failures', patch.failures)
      set('updated_at', now)
      sets.push('version = version + 1')
      sqlite.query(`UPDATE routines SET ${sets.join(', ')} WHERE id = ?`).run(...params, id)
      return get(id)
    },

    delete(id) {
      return immediate(() => {
        sqlite.query('DELETE FROM routine_runs WHERE routine_id = ?').run(id)
        return sqlite.query('DELETE FROM routines WHERE id = ?').run(id).changes > 0
      })
    },

    runs(routineId, limit) {
      return sqlite
        .query<RunRow, [string, number]>(
          'SELECT * FROM routine_runs WHERE routine_id = ? ORDER BY scheduled_at DESC, id DESC LIMIT ?',
        )
        .all(routineId, limit)
        .map(toRun)
    },

    getRun,

    due(horizon, limit) {
      return sqlite
        .query<RoutineRow, [number, number]>(
          `SELECT * FROM routines WHERE status = 'active' AND next_fire_at IS NOT NULL
             AND next_fire_at <= ? ORDER BY next_fire_at, id LIMIT ?`,
        )
        .all(horizon, limit)
        .map(toRoutine)
    },

    claimSlot(c) {
      return immediate(() => {
        const changed = sqlite
          .query(
            `UPDATE routines SET next_fire_at = ?, updated_at = ?,
                 last_fire_at = CASE WHEN ? = 1 THEN ? ELSE last_fire_at END,
                 fire_count = fire_count + ?,
                 status = CASE WHEN ? IS NULL THEN status ELSE 'paused' END,
                 paused_reason = CASE WHEN ? IS NULL THEN paused_reason ELSE ? END
               WHERE id = ? AND status = 'active' AND next_fire_at = ?`,
          )
          .run(
            c.nextFireAt,
            c.now,
            c.fire ? 1 : 0,
            c.now,
            c.fire ? 1 : 0,
            c.pause ?? null,
            c.pause ?? null,
            c.pause ?? null,
            c.routineId,
            c.expectedNext,
          ).changes
        if (changed !== 1) return undefined
        const id = uuidv7()
        const inserted = sqlite
          .query(
            `INSERT OR IGNORE INTO routine_runs
               (id, routine_id, scheduled_at, trigger, status, session_id, reason, claimed_at, finished_at)
             VALUES (?, ?, ?, 'schedule', ?, ?, ?, ?, ?)`,
          )
          .run(
            id,
            c.routineId,
            c.scheduledAt,
            c.status,
            c.sessionId,
            c.reason ?? null,
            c.now,
            c.status === 'skipped' ? c.now : null,
          ).changes
        if (inserted !== 1) return undefined
        if (c.status === 'skipped') {
          sqlite
            .query('UPDATE routines SET last_status = ? WHERE id = ?')
            .run(`skipped: ${c.reason ?? ''}`, c.routineId)
        }
        return getRun(id)
      })
    },

    pauseSlot(routineId, expectedNext, reason, now) {
      return (
        sqlite
          .query(
            `UPDATE routines SET status = 'paused', paused_reason = ?, updated_at = ?
               WHERE id = ? AND status = 'active' AND next_fire_at = ?`,
          )
          .run(reason, now, routineId, expectedNext).changes === 1
      )
    },

    insertManualRun(routineId, sessionId, scheduledAt, now) {
      return immediate(() => {
        const id = uuidv7()
        const inserted = sqlite
          .query(
            `INSERT OR IGNORE INTO routine_runs
               (id, routine_id, scheduled_at, trigger, status, session_id, claimed_at)
             VALUES (?, ?, ?, 'manual', 'claimed', ?, ?)`,
          )
          .run(id, routineId, scheduledAt, sessionId, now).changes
        if (inserted !== 1) return undefined
        sqlite
          .query('UPDATE routines SET last_fire_at = ?, updated_at = ? WHERE id = ?')
          .run(now, now, routineId)
        return getRun(id)
      })
    },

    getRunBySlot(routineId, scheduledAt) {
      const row = sqlite
        .query<RunRow, [string, number]>(
          'SELECT * FROM routine_runs WHERE routine_id = ? AND scheduled_at = ?',
        )
        .get(routineId, scheduledAt)
      return row === null ? undefined : toRun(row)
    },

    getRunByInbox(inboxId) {
      const row = sqlite
        .query<RunRow, [string]>('SELECT * FROM routine_runs WHERE inbox_id = ?')
        .get(inboxId)
      return row === null ? undefined : toRun(row)
    },

    staleClaims(before) {
      return sqlite
        .query<RunRow, [number]>(
          `SELECT * FROM routine_runs WHERE status = 'claimed' AND claimed_at <= ? ORDER BY claimed_at LIMIT 100`,
        )
        .all(before)
        .map(toRun)
    },

    previousFiredRun(routineId, exceptId) {
      const row = sqlite
        .query<RunRow, [string, string]>(
          `SELECT * FROM routine_runs WHERE routine_id = ? AND id != ? AND status != 'skipped'
             ORDER BY scheduled_at DESC, id DESC LIMIT 1`,
        )
        .get(routineId, exceptId)
      return row === null ? undefined : toRun(row)
    },

    markEnqueued(runId, info) {
      sqlite
        .query(
          `UPDATE routine_runs SET status = 'enqueued', inbox_id = ?, fired_at = ?, reason = COALESCE(?, reason)
             WHERE id = ? AND status = 'claimed'`,
        )
        .run(info.inboxId, info.firedAt, info.reason ?? null, runId)
    },

    markSkipped(runId, reason, now) {
      sqlite
        .query(
          `UPDATE routine_runs SET status = 'skipped', reason = ?, finished_at = ?
             WHERE id = ? AND status = 'claimed'`,
        )
        .run(reason, now, runId)
      sqlite
        .query(
          `UPDATE routines SET last_status = ? WHERE id = (SELECT routine_id FROM routine_runs WHERE id = ?)`,
        )
        .run(`skipped: ${reason}`, runId)
    },

    needsActionRuns(sessionId) {
      return sqlite
        .query<RunRow, [string]>(
          `SELECT * FROM routine_runs WHERE session_id = ? AND status = 'needs_action'`,
        )
        .all(sessionId)
        .map(toRun)
    },

    finishRun(runId, outcome, now) {
      return immediate(() => {
        const run = getRun(runId)
        if (run === undefined) return undefined
        // finished runs are final; needs_action may still turn into succeeded / failed
        if (run.status === 'succeeded' || run.status === 'failed' || run.status === 'skipped') {
          return undefined
        }
        const finished = outcome.status !== 'needs_action'
        sqlite
          .query(
            `UPDATE routine_runs SET status = ?, reason = COALESCE(?, reason), finished_at = ? WHERE id = ?`,
          )
          .run(outcome.status, outcome.reason ?? null, finished ? now : null, runId)
        const routine = get(run.routineId)
        if (routine === undefined) return undefined
        let paused = false
        if (outcome.status === 'succeeded') {
          sqlite
            .query('UPDATE routines SET failures = 0, last_status = ?, updated_at = ? WHERE id = ?')
            .run('succeeded', now, routine.id)
        } else if (outcome.status === 'failed') {
          const failures = routine.failures + (outcome.countFailure === false ? 0 : 1)
          paused = routine.status === 'active' && failures >= routine.maxFailures
          sqlite
            .query(
              `UPDATE routines SET failures = ?, last_status = ?, updated_at = ?,
                   status = CASE WHEN ? = 1 THEN 'paused' ELSE status END,
                   paused_reason = CASE WHEN ? = 1 THEN 'max-failures' ELSE paused_reason END
                 WHERE id = ?`,
            )
            .run(
              failures,
              `failed: ${outcome.reason ?? ''}`,
              now,
              paused ? 1 : 0,
              paused ? 1 : 0,
              routine.id,
            )
        } else {
          sqlite
            .query('UPDATE routines SET last_status = ?, updated_at = ? WHERE id = ?')
            .run('needs_action', now, routine.id)
        }
        return {
          run: getRun(runId) as RoutineRun,
          routine: get(routine.id) as Routine,
          paused,
        }
      })
    },
  }
}
