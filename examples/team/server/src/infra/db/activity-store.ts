/**
 * The `ActivityStore` of `eharness/activity` on the shared SQLite connection: the `events` table is
 * the log (`seq` is AUTOINCREMENT, so it is never reused), the retention mark lives in `settings`.
 * Every statement is atomic, so several instances (processes on one file) append and prune safely;
 * the library's conformance suite runs against this adapter (test/activity-store.test.ts).
 *
 * Retention keeps the newest event (the head cursors compare to) and, through `keepLatestOf`, the
 * latest `message-added` of every agent (the sidebar preview).
 */
import type { Database } from 'bun:sqlite'
import type { ActivityInput, ActivityRecord, ActivityStore } from 'eharness/activity'

interface EventRow {
  seq: number
  type: string
  agent_id: string | null
  session_id: string | null
  payload: string
  created_at: number
}

const toRecord = (r: EventRow): ActivityRecord => ({
  seq: r.seq,
  type: r.type,
  agentId: r.agent_id,
  sessionId: r.session_id,
  payload: JSON.parse(r.payload) as Record<string, unknown>,
  createdAt: r.created_at,
})

/** `settings` key holding the highest event `seq` removed by retention. */
const PRUNED_KEY = 'events-pruned-through'

export function sqliteActivityStore(
  sqlite: Database,
  options: { now?: () => number } = {},
): ActivityStore {
  const now = options.now ?? ((): number => Date.now())
  const insert = sqlite.query<
    { seq: number },
    [string, string | null, string | null, string, number]
  >(
    'INSERT INTO events (type, agent_id, session_id, payload, created_at) VALUES (?, ?, ?, ?, ?) RETURNING seq',
  )
  const head = (): number =>
    sqlite.query<{ seq: number | null }, []>('SELECT MAX(seq) AS seq FROM events').get()?.seq ?? 0
  const mark = (): number => {
    const row = sqlite
      .query<{ value: string }, [string]>('SELECT value FROM settings WHERE key = ?')
      .get(PRUNED_KEY)
    return row === null ? 0 : Number(JSON.parse(row.value))
  }

  return {
    // no await inside: the rows are written when `append` is called (fire-and-forget callers rely on it)
    async append(events) {
      const list: readonly ActivityInput[] = Array.isArray(events)
        ? (events as readonly ActivityInput[])
        : [events as ActivityInput]
      return sqlite
        .transaction((): ActivityRecord[] =>
          list.map((e) => {
            const createdAt = e.at ?? now()
            const payload = e.payload ?? {}
            const row = insert.get(
              e.type,
              e.agentId ?? null,
              e.sessionId ?? null,
              JSON.stringify(payload),
              createdAt,
            ) as { seq: number }
            return {
              seq: row.seq,
              type: e.type,
              agentId: e.agentId ?? null,
              sessionId: e.sessionId ?? null,
              payload: JSON.parse(JSON.stringify(payload)) as Record<string, unknown>,
              createdAt,
            }
          }),
        )
        .immediate()
    },

    async read(q) {
      const where = ['seq > ?']
      const params: Array<string | number> = [q.after]
      if (q.types !== undefined) {
        if (q.types.length === 0) return []
        where.push(`type IN (${q.types.map(() => '?').join(', ')})`)
        params.push(...q.types)
      }
      if (q.sessionId !== undefined) {
        where.push('session_id = ?')
        params.push(q.sessionId)
      }
      return sqlite
        .query<EventRow, Array<string | number>>(
          `SELECT seq, type, agent_id, session_id, payload, created_at FROM events WHERE ${where.join(' AND ')} ORDER BY seq LIMIT ?`,
        )
        .all(...params, q.limit)
        .map(toRecord)
    },

    async lastSeq() {
      return head()
    },

    async prunedThrough() {
      return mark()
    },

    async prune(o) {
      return sqlite
        .transaction(() => {
          const top = head()
          let boundary = 0
          if (o.olderThan !== undefined) {
            boundary =
              sqlite
                .query<{ seq: number | null }, [number]>(
                  'SELECT MAX(seq) AS seq FROM events WHERE created_at < ?',
                )
                .get(o.olderThan)?.seq ?? 0
          }
          if (o.keepLast !== undefined && o.keepLast >= 1) {
            const cut = sqlite
              .query<{ seq: number }, [number]>(
                'SELECT seq FROM events ORDER BY seq DESC LIMIT 1 OFFSET ?',
              )
              .get(o.keepLast)
            if (cut !== null) boundary = Math.max(boundary, cut.seq)
          }
          boundary = Math.min(boundary, top - 1)
          const known = mark()
          if (boundary <= 0) return { deleted: 0, prunedThrough: known }
          const keep = (o.keepLatestOf ?? []).map(({ type, by }) => {
            const column = by === 'agentId' ? 'agent_id' : 'session_id'
            return {
              sql: `SELECT MAX(seq) FROM events WHERE type = ? AND ${column} IS NOT NULL GROUP BY ${column}`,
              type,
            }
          })
          const survivors = keep.map((k) => `seq NOT IN (${k.sql})`).join(' AND ')
          const { changes } = sqlite
            .query(
              `DELETE FROM events WHERE seq <= ?${survivors === '' ? '' : ` AND ${survivors}`}`,
            )
            .run(boundary, ...keep.map((k) => k.type))
          const next = Math.max(boundary, known)
          sqlite
            .query(
              `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
               ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
            )
            .run(PRUNED_KEY, JSON.stringify(next), Date.now())
          return { deleted: changes, prunedThrough: next }
        })
        .immediate()
    },
  }
}
