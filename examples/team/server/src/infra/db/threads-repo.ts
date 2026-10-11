/** Chat threads (`chat_threads`), plain SQL on the shared connection. */
import type { Database } from 'bun:sqlite'
import type { ThreadStore } from '../../app/ports.ts'
import type { Thread, ThreadSeed, ThreadSource } from '../../domain/threads.ts'

interface Row {
  id: string
  agent_id: string
  session_id: string
  title: string | null
  source: string
  source_label: string | null
  seed: string | null
  created_at: number
  updated_at: number
  last_message_at: number | null
  preview: string | null
  archived_at: number | null
}

const toThread = (r: Row): Thread => {
  let seed: ThreadSeed | null = null
  if (r.seed !== null) {
    try {
      seed = JSON.parse(r.seed) as ThreadSeed
    } catch {
      seed = null
    }
  }
  return {
    id: r.id,
    agentId: r.agent_id,
    sessionId: r.session_id,
    title: r.title,
    source: (r.source === 'channel' ? 'channel' : 'web') as ThreadSource,
    sourceLabel: r.source_label,
    seed,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    lastMessageAt: r.last_message_at,
    preview: r.preview,
    archivedAt: r.archived_at,
  }
}

export function sqliteThreadStore(sqlite: Database): ThreadStore {
  const byId = sqlite.query<Row, [string]>('SELECT * FROM chat_threads WHERE id = ?')
  const bySession = sqlite.query<Row, [string]>('SELECT * FROM chat_threads WHERE session_id = ?')
  const ofAgent = sqlite.query<Row, [string]>(
    'SELECT * FROM chat_threads WHERE agent_id = ? ORDER BY COALESCE(last_message_at, updated_at) DESC, id DESC',
  )
  const store: ThreadStore = {
    get: (id) => {
      const r = byId.get(id)
      return r === null ? undefined : toThread(r)
    },
    getBySession(sessionId) {
      const r = bySession.get(sessionId)
      return r === null ? undefined : toThread(r)
    },
    list: (agentId) => ofAgent.all(agentId).map(toThread),
    sessionsOf: (agentId) =>
      sqlite
        .query<{ session_id: string }, [string]>(
          'SELECT session_id FROM chat_threads WHERE agent_id = ?',
        )
        .all(agentId)
        .map((r) => r.session_id),
    allSessions: () =>
      sqlite
        .query<{ agent_id: string; session_id: string }, []>(
          'SELECT agent_id, session_id FROM chat_threads WHERE archived_at IS NULL',
        )
        .all()
        .map((r) => ({ agentId: r.agent_id, sessionId: r.session_id })),
    insert(t) {
      sqlite
        .query(
          `INSERT INTO chat_threads (id, agent_id, session_id, title, source, source_label, seed, created_at, updated_at, last_message_at, preview, archived_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)
           ON CONFLICT (session_id) DO NOTHING`,
        )
        .run(
          t.id,
          t.agentId,
          t.sessionId,
          t.title,
          t.source,
          t.sourceLabel,
          t.seed === null ? null : JSON.stringify(t.seed),
          t.now,
          t.now,
        )
      return toThread(bySession.get(t.sessionId) as Row)
    },
    patch(id, patch, now) {
      const sets: string[] = ['updated_at = ?']
      const args: Array<string | number | null> = [now]
      if (patch.title !== undefined) {
        sets.push('title = ?')
        args.push(patch.title)
      }
      if (patch.archivedAt !== undefined) {
        sets.push('archived_at = ?')
        args.push(patch.archivedAt)
      }
      args.push(id)
      sqlite.query(`UPDATE chat_threads SET ${sets.join(', ')} WHERE id = ?`).run(...args)
      return store.get(id)
    },
    touch(sessionId, info) {
      // a message does not rename or restore a thread; it moves the activity and names an unnamed one
      sqlite
        .query(
          `UPDATE chat_threads
              SET last_message_at = MAX(COALESCE(last_message_at, 0), ?), preview = ?,
                  title = CASE WHEN title IS NULL AND ? IS NOT NULL THEN ? ELSE title END
            WHERE session_id = ?`,
        )
        .run(info.at, info.preview, info.title, info.title, sessionId)
    },
  }
  return store
}
