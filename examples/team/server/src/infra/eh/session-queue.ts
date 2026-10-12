/**
 * What waits in the inbox of a session, and clearing it. A routine in the agent's chat is skipped
 * ("overlap: an input of the session is still queued") for as long as an input of that session sits
 * in the inbox; the owner could neither see it nor clear it. Reads and deletes `eh_inbox` rows of
 * one session that are not dead (a dead item is already out of the way).
 */
import type { Database } from 'bun:sqlite'
import type { SessionQueue } from '../../app/ports.ts'

interface Row {
  id: string
  kind: string
  item: string
  claimed_until: number | null
  available_at: number | null
}

/** First readable text of a stored inbox item (a message part, a reminder), shortened. */
function previewOf(item: string): string {
  try {
    const found: string[] = []
    const walk = (v: unknown, depth: number): void => {
      if (found.length > 0 || depth > 6 || v === null) return
      if (typeof v === 'string') return
      if (Array.isArray(v)) {
        for (const x of v) walk(x, depth + 1)
        return
      }
      if (typeof v === 'object') {
        const o = v as Record<string, unknown>
        if (typeof o.text === 'string' && o.text.trim() !== '') {
          found.push(o.text.trim())
          return
        }
        for (const x of Object.values(o)) walk(x, depth + 1)
      }
    }
    walk(JSON.parse(item), 0)
    const text = (found[0] ?? '').replace(/\s+/g, ' ')
    return text.length > 160 ? `${text.slice(0, 157)}...` : text
  } catch {
    return ''
  }
}

export function sqliteSessionQueue(sqlite: Database, now: () => number = Date.now): SessionQueue {
  return {
    async queued(sessionId) {
      const rows = sqlite
        .query<Row, [string]>(
          `SELECT id, kind, item, claimed_until, available_at FROM eh_inbox
           WHERE session_id = ? AND dead_at IS NULL ORDER BY id`,
        )
        .all(sessionId)
      const t = now()
      return rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        preview: previewOf(r.item),
        // a live claim means a holder is working on it right now
        claimed: r.claimed_until !== null && r.claimed_until > t,
        availableAt: r.available_at,
      }))
    },
    async clear(sessionId) {
      return sqlite.transaction(() => {
        const ids = sqlite
          .query<{ id: string }, [string]>(
            'SELECT id FROM eh_inbox WHERE session_id = ? AND dead_at IS NULL',
          )
          .all(sessionId)
          .map((r) => r.id)
        for (const id of ids) {
          sqlite.query('DELETE FROM eh_inbox_keys WHERE item_id = ?').run(id)
          sqlite.query('DELETE FROM eh_inbox WHERE id = ?').run(id)
        }
        return ids.length
      })()
    },
  }
}
