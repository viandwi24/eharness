/**
 * `ActivityStore` (spec 25) on `<prefix>activity`: `seq` is `AUTOINCREMENT`, assigned inside the
 * write transaction, so it is unique and never reused across processes on one file. The retention
 * mark lives in `<prefix>activity_meta`. Retention keeps the newest event (the head cursors compare
 * to) and, through `keepLatestOf`, the latest event of a type per agent or session.
 */
import type { ActivityInput, ActivityRecord, ActivityStore } from 'eharness/activity'
import type { SqlDriver, SqlParam } from './driver.ts'
import { type AdapterOptions, clock, one, tables } from './util.ts'

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

/** `activity_meta` key holding the highest `seq` removed by retention. */
const PRUNED_KEY = 'pruned-through'

export function sqliteActivityStore(
  driver: SqlDriver,
  options: AdapterOptions = {},
): ActivityStore {
  const names = tables(options.prefix)
  const t = names.activity
  const meta = names.activityMeta
  const now = clock(options)

  const head = (): number =>
    Number(one<{ seq: number | null }>(driver, `SELECT MAX(seq) AS seq FROM ${t}`)?.seq ?? 0)
  const mark = (): number => {
    const row = one<{ value: string }>(driver, `SELECT value FROM ${meta} WHERE key = ?`, [
      PRUNED_KEY,
    ])
    return row === undefined ? 0 : Number(row.value)
  }

  return {
    // no await inside: the rows are written when `append` is called (fire-and-forget callers rely on it)
    async append(events) {
      const list: readonly ActivityInput[] = Array.isArray(events)
        ? (events as readonly ActivityInput[])
        : [events as ActivityInput]
      return driver.transaction((): ActivityRecord[] =>
        list.map((e) => {
          const createdAt = e.at ?? now()
          const payload = e.payload ?? {}
          const row = driver.query<{ seq: number }>(
            `INSERT INTO ${t} (type, agent_id, session_id, payload, created_at)
             VALUES (?, ?, ?, ?, ?) RETURNING seq`,
            [e.type, e.agentId ?? null, e.sessionId ?? null, JSON.stringify(payload), createdAt],
          )[0] as { seq: number }
          return {
            seq: Number(row.seq),
            type: e.type,
            agentId: e.agentId ?? null,
            sessionId: e.sessionId ?? null,
            payload: JSON.parse(JSON.stringify(payload)) as Record<string, unknown>,
            createdAt,
          }
        }),
      )
    },

    async read(q) {
      const where = ['seq > ?']
      const params: SqlParam[] = [q.after]
      if (q.types !== undefined) {
        if (q.types.length === 0) return []
        where.push(`type IN (${q.types.map(() => '?').join(', ')})`)
        params.push(...q.types)
      }
      if (q.sessionId !== undefined) {
        where.push('session_id = ?')
        params.push(q.sessionId)
      }
      return driver
        .query<EventRow>(
          `SELECT seq, type, agent_id, session_id, payload, created_at FROM ${t}
           WHERE ${where.join(' AND ')} ORDER BY seq LIMIT ?`,
          [...params, q.limit],
        )
        .map(toRecord)
    },

    async lastSeq() {
      return head()
    },

    async prunedThrough() {
      return mark()
    },

    async prune(o) {
      return driver.transaction(() => {
        const top = head()
        let boundary = 0
        if (o.olderThan !== undefined) {
          boundary = Number(
            one<{ seq: number | null }>(
              driver,
              `SELECT MAX(seq) AS seq FROM ${t} WHERE created_at < ?`,
              [o.olderThan],
            )?.seq ?? 0,
          )
        }
        if (o.keepLast !== undefined && o.keepLast >= 1) {
          const cut = one<{ seq: number }>(
            driver,
            `SELECT seq FROM ${t} ORDER BY seq DESC LIMIT 1 OFFSET ?`,
            [o.keepLast],
          )
          if (cut !== undefined) boundary = Math.max(boundary, Number(cut.seq))
        }
        boundary = Math.min(boundary, top - 1)
        const known = mark()
        if (boundary <= 0) return { deleted: 0, prunedThrough: known }
        const keep = (o.keepLatestOf ?? []).map(({ type, by }) => {
          const column = by === 'agentId' ? 'agent_id' : 'session_id'
          return {
            sql: `SELECT MAX(seq) FROM ${t} WHERE type = ? AND ${column} IS NOT NULL GROUP BY ${column}`,
            type,
          }
        })
        const survivors = keep.map((k) => `seq NOT IN (${k.sql})`).join(' AND ')
        const { changes } = driver.run(
          `DELETE FROM ${t} WHERE seq <= ?${survivors === '' ? '' : ` AND ${survivors}`}`,
          [boundary, ...keep.map((k) => k.type)],
        )
        const next = Math.max(boundary, known)
        driver.run(
          `INSERT INTO ${meta} (key, value) VALUES (?, ?)
           ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
          [PRUNED_KEY, String(next)],
        )
        return { deleted: changes, prunedThrough: next }
      })
    },
  }
}
