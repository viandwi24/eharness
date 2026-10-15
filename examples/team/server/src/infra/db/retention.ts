import type { Database } from 'bun:sqlite'

export interface TableRetention {
  /** Finished routine runs kept this many days (default 30; 0 = keep). */
  routineRunsDays?: number
  /** Finished tasks (done, failed, stopped, interrupted) kept this many days (default 90; 0 = keep). */
  tasksDays?: number
  /** Library history rows kept this many days, besides the per-path cap (default 180; 0 = keep). */
  libraryHistoryDays?: number
  /**
   * Tool media and browser screenshots kept this many days (default 3; 0 = keep). They live in the
   * library as files (`MEDIA_FOLDERS`) and a chat that still shows one then shows "expired".
   */
  mediaDays?: number
}

/** Library folders of generated media: screenshots of tools and of the browser. */
export const MEDIA_FOLDERS = ['/.eharness/tool-media/', '/.browser/shots/'] as const

/** SQL `LIKE` pattern matching `prefix` literally. */
const likePrefix = (prefix: string): string => `${prefix.replace(/[\\%_]/g, (c) => `\\${c}`)}%`

const DAY = 86_400_000

/** Default `mediaDays`. */
export const DEFAULT_MEDIA_DAYS = 3

/** Deletes the rows that retention no longer needs. Returns how many rows each table lost. */
export function pruneTables(
  sqlite: Database,
  retention: TableRetention = {},
  now: number = Date.now(),
): {
  routineRuns: number
  tasks: number
  libraryHistory: number
  inboxKeys: number
  media: number
} {
  const days = (v: number | undefined, fallback: number): number => v ?? fallback
  const run = (sql: string, ...params: Array<number | string>): number =>
    sqlite.query(sql).run(...params).changes
  const routineDays = days(retention.routineRunsDays, 30)
  const taskDays = days(retention.tasksDays, 90)
  const historyDays = days(retention.libraryHistoryDays, 180)
  const mediaDays = days(retention.mediaDays, DEFAULT_MEDIA_DAYS)
  const media = (): number => {
    const cutoff = now - mediaDays * DAY
    let removed = 0
    for (const folder of MEDIA_FOLDERS) {
      // `LIKE` ignores ASCII case: the folders are lower case and nothing else shares the prefix
      removed += run(
        "DELETE FROM library_files WHERE path LIKE ? ESCAPE '\\' AND updated_at < ?",
        likePrefix(folder),
        cutoff,
      )
      run(
        "DELETE FROM library_history WHERE path LIKE ? ESCAPE '\\' AND at < ?",
        likePrefix(folder),
        cutoff,
      )
    }
    return removed
  }
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
    media: mediaDays > 0 ? media() : 0,
    // dedupe keys of acked inbox items; enqueueOnce also sweeps them, this covers idle sessions
    inboxKeys: run(
      'DELETE FROM eh_inbox_keys WHERE expires_at IS NOT NULL AND expires_at <= ?',
      now,
    ),
  }
}

/**
 * Give freed pages back to the file system. Only a database in `auto_vacuum = INCREMENTAL` mode
 * can do it cheaply (`PRAGMA incremental_vacuum`); in the default `NONE` mode the freed pages are
 * reused by later writes, so the file stops growing but does not shrink (see `compactDatabase`).
 * Returns whether pages were released.
 */
export function reclaimSpace(sqlite: Database, pages = 20_000): boolean {
  const mode = sqlite.query<{ auto_vacuum: number }, []>('PRAGMA auto_vacuum').get()?.auto_vacuum
  if (mode !== 2) return false
  sqlite.run(`PRAGMA incremental_vacuum(${Math.max(1, Math.floor(pages))})`)
  return true
}

/**
 * One-time conversion of an existing database to `auto_vacuum = INCREMENTAL` (opt-in,
 * `TEAM_DB_COMPACT=1`): `VACUUM` rewrites the whole file, so it needs free disk of about the
 * database size, holds the write lock while it runs (other processes on the same file wait) and
 * takes seconds per GB. It runs only when the mode differs, so later boots skip it. Returns whether
 * it ran.
 */
export function compactDatabase(sqlite: Database): boolean {
  const mode = sqlite.query<{ auto_vacuum: number }, []>('PRAGMA auto_vacuum').get()?.auto_vacuum
  if (mode === 2) return false
  sqlite.run('PRAGMA auto_vacuum = INCREMENTAL')
  sqlite.run('VACUUM')
  sqlite.run('PRAGMA wal_checkpoint(TRUNCATE)')
  return true
}
