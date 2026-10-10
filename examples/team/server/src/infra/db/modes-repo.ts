/** The mode a person picked per session (`session_modes`), plain SQL on the shared connection. */
import type { Database } from 'bun:sqlite'
import { TEAM_MODES, type TeamMode } from '../../domain/modes.ts'

export interface SessionModeStore {
  get(sessionId: string): TeamMode | undefined
  set(sessionId: string, mode: TeamMode, now: number): void
}

export function sqliteSessionModes(sqlite: Database): SessionModeStore {
  const read = sqlite.query<{ mode: string }, [string]>(
    'SELECT mode FROM session_modes WHERE session_id = ?',
  )
  const write = sqlite.query(
    `INSERT INTO session_modes (session_id, mode, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (session_id) DO UPDATE SET mode = excluded.mode, updated_at = excluded.updated_at`,
  )
  return {
    get(sessionId) {
      const mode = read.get(sessionId)?.mode
      return TEAM_MODES.find((m) => m === mode)
    },
    set(sessionId, mode, now) {
      write.run(sessionId, mode, now)
    },
  }
}
