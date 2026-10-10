/** Connections switched off per chat (`chat_tool_overrides`), plain SQL on the shared connection. */
import type { Database } from 'bun:sqlite'

export interface ChatToolsStore {
  /** Connection ids switched off in this session (empty = none). */
  off(sessionId: string): string[]
  setOff(sessionId: string, off: string[], now: number): void
}

export function sqliteChatTools(sqlite: Database): ChatToolsStore {
  const read = sqlite.query<{ off: string }, [string]>(
    'SELECT off FROM chat_tool_overrides WHERE session_id = ?',
  )
  const write = sqlite.query(
    `INSERT INTO chat_tool_overrides (session_id, off, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (session_id) DO UPDATE SET off = excluded.off, updated_at = excluded.updated_at`,
  )
  return {
    off(sessionId) {
      const row = read.get(sessionId)
      if (row === null) return []
      try {
        const parsed: unknown = JSON.parse(row.off)
        return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
      } catch {
        return []
      }
    },
    setOff(sessionId, off, now) {
      write.run(sessionId, JSON.stringify([...new Set(off)].sort()), now)
    },
  }
}
