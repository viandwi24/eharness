/**
 * The workspace pause gate (`domain/pause.ts`): one row `workspace-pause` of the `settings` table.
 * Read from the database on every decision (a single-row read), so every instance sees a pause
 * or a resume at once and it survives restarts. The row is absent while the workspace runs.
 */
import type { Database } from 'bun:sqlite'
import type { PauseStore } from '../../app/ports.ts'
import { NOT_PAUSED, type WorkspacePause } from '../../domain/pause.ts'

export const PAUSE_KEY = 'workspace-pause'
/** The window of the last pause, kept after Resume: one-shot slots that came due in it still fire. */
export const PAUSE_WINDOW_KEY = 'workspace-pause-window'

export function sqlitePauseStore(sqlite: Database): PauseStore {
  return {
    get() {
      const row = sqlite
        .query<{ value: string }, [string]>('SELECT value FROM settings WHERE key = ?')
        .get(PAUSE_KEY)
      if (row === null) return NOT_PAUSED
      try {
        return { ...NOT_PAUSED, ...(JSON.parse(row.value) as Partial<WorkspacePause>) }
      } catch {
        return NOT_PAUSED
      }
    },
    set(state, now) {
      sqlite
        .query(
          `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
           ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        )
        .run(PAUSE_KEY, JSON.stringify(state), now)
    },
    clear(now) {
      const was = this.get()
      sqlite.transaction(() => {
        sqlite.query('DELETE FROM settings WHERE key = ?').run(PAUSE_KEY)
        if (was.pausedAt !== null) {
          sqlite
            .query(
              `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
               ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
            )
            .run(PAUSE_WINDOW_KEY, JSON.stringify({ pausedAt: was.pausedAt, resumedAt: now }), now)
        }
      })()
    },
    lastWindow() {
      const row = sqlite
        .query<{ value: string }, [string]>('SELECT value FROM settings WHERE key = ?')
        .get(PAUSE_WINDOW_KEY)
      if (row === null) return null
      try {
        return JSON.parse(row.value) as { pausedAt: number; resumedAt: number }
      } catch {
        return null
      }
    },
  }
}
