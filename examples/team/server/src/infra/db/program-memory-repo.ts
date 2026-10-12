/** Remembered decisions of programs, in the `settings` key-value table (no migration needed). */
import type { Database } from 'bun:sqlite'
import type { ProgramMemoryStore } from '../../app/ports.ts'
import { MAX_REMEMBERED, type RememberedDecision } from '../../domain/decision-memory.ts'

const keyOf = (programId: string): string => `program-memory:${programId}`

export function sqliteProgramMemory(sqlite: Database): ProgramMemoryStore {
  const read = (programId: string): RememberedDecision[] => {
    const row = sqlite
      .query<{ value: string }, [string]>('SELECT value FROM settings WHERE key = ?')
      .get(keyOf(programId))
    if (row === null) return []
    try {
      return JSON.parse(row.value) as RememberedDecision[]
    } catch {
      return []
    }
  }
  const write = (programId: string, items: RememberedDecision[], now: number): void => {
    if (items.length === 0) {
      sqlite.query('DELETE FROM settings WHERE key = ?').run(keyOf(programId))
      return
    }
    sqlite
      .query(
        `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(keyOf(programId), JSON.stringify(items), now)
  }
  return {
    list: read,
    remember(item) {
      // one answer per subject: a newer one replaces the older
      const rest = read(item.programId).filter((m) => m.subject !== item.subject)
      write(item.programId, [item, ...rest].slice(0, MAX_REMEMBERED), item.decidedAt)
    },
    forget(programId, id, now) {
      const items = read(programId)
      const next = items.filter((m) => m.id !== id)
      if (next.length === items.length) return false
      write(programId, next, now)
      return true
    },
    deleteByProgram(programId) {
      sqlite.query('DELETE FROM settings WHERE key = ?').run(keyOf(programId))
    },
  }
}
