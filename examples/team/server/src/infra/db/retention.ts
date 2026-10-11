import type { Database } from 'bun:sqlite'

export interface TableRetention {
  /** Finished routine runs kept this many days (default 30; 0 = keep). */
  routineRunsDays?: number
  /** Finished tasks (done, failed, stopped, interrupted) kept this many days (default 90; 0 = keep). */
  tasksDays?: number
  /** Library history rows kept this many days, besides the per-path cap (default 180; 0 = keep). */
  libraryHistoryDays?: number
}

const DAY = 86_400_000

/** Deletes the rows that retention no longer needs. Returns how many rows each table lost. */
export function pruneTables(
  sqlite: Database,
  retention: TableRetention = {},
  now: number = Date.now(),
): { routineRuns: number; tasks: number; libraryHistory: number; inboxKeys: number } {
  const days = (v: number | undefined, fallback: number): number => v ?? fallback
  const run = (sql: string, ...params: number[]): number => sqlite.query(sql).run(...params).changes
  const routineDays = days(retention.routineRunsDays, 30)
  const taskDays = days(retention.tasksDays, 90)
  const historyDays = days(retention.libraryHistoryDays, 180)
  return {
    routineRuns:
      routineDays > 0
        ? run(
            `DELETE FROM routine_runs
              WHERE status IN ('succeeded', 'failed', 'skipped')
                AND COALESCE(finished_at, claimed_at) < ?`,
            now - routineDays * DAY,
          )
        : 0,
    tasks:
      taskDays > 0
        ? run(
            `DELETE FROM tasks
              WHERE state IN ('done', 'failed', 'stopped', 'interrupted')
                AND ended_at IS NOT NULL AND ended_at < ?`,
            now - taskDays * DAY,
          )
        : 0,
    libraryHistory:
      historyDays > 0
        ? run('DELETE FROM library_history WHERE at < ?', now - historyDays * DAY)
        : 0,
    // dedupe keys of acked inbox items; enqueueOnce also sweeps them, this covers idle sessions
    inboxKeys: run(
      'DELETE FROM eh_inbox_keys WHERE expires_at IS NOT NULL AND expires_at <= ?',
      now,
    ),
  }
}
