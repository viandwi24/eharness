/** Alarms (`domain/alarms.ts`), plain SQL on the shared connection. */
import type { Database } from 'bun:sqlite'
import type { AlarmStore } from '../../app/ports.ts'
import { type Alarm, isAlarmKind } from '../../domain/alarms.ts'

interface AlarmRow {
  id: string
  kind: string
  key: string
  subject: string
  agent_id: string | null
  text: string
  refs: string
  created_at: number
  acked_at: number | null
  acked_by: string | null
  delivered_at: number | null
}

const toAlarm = (r: AlarmRow): Alarm => {
  let refs: string[] = []
  try {
    const parsed: unknown = JSON.parse(r.refs)
    if (Array.isArray(parsed)) refs = parsed.filter((x): x is string => typeof x === 'string')
  } catch {
    refs = []
  }
  return {
    id: r.id,
    kind: isAlarmKind(r.kind) ? r.kind : 'system',
    key: r.key,
    subject: r.subject,
    agentId: r.agent_id,
    text: r.text,
    refs,
    createdAt: r.created_at,
    ackedAt: r.acked_at,
    ackedBy: r.acked_by === 'owner' || r.acked_by === 'auto' ? r.acked_by : null,
    deliveredAt: r.delivered_at,
  }
}

export function sqliteAlarmStore(sqlite: Database): AlarmStore {
  const byId = sqlite.query<AlarmRow, [string]>('SELECT * FROM alarms WHERE id = ?')
  const byKey = sqlite.query<AlarmRow, [string]>('SELECT * FROM alarms WHERE key = ?')
  const get = (id: string): Alarm | undefined => {
    const r = byId.get(id)
    return r === null ? undefined : toAlarm(r)
  }
  return {
    get,
    byKey: (key) => {
      const r = byKey.get(key)
      return r === null ? undefined : toAlarm(r)
    },
    list({ open, limit }) {
      const where = open ? 'WHERE acked_at IS NULL' : ''
      return sqlite
        .query<AlarmRow, [number]>(
          `SELECT * FROM alarms ${where} ORDER BY created_at DESC, id DESC LIMIT ?`,
        )
        .all(limit)
        .map(toAlarm)
    },
    countOpen: () =>
      sqlite
        .query<{ n: number }, []>('SELECT COUNT(*) AS n FROM alarms WHERE acked_at IS NULL')
        .get()?.n ?? 0,
    openOf(subject, kind) {
      const rows =
        kind === undefined
          ? sqlite
              .query<AlarmRow, [string]>(
                'SELECT * FROM alarms WHERE subject = ? AND acked_at IS NULL ORDER BY created_at',
              )
              .all(subject)
          : sqlite
              .query<AlarmRow, [string, string]>(
                'SELECT * FROM alarms WHERE subject = ? AND kind = ? AND acked_at IS NULL ORDER BY created_at',
              )
              .all(subject, kind)
      return rows.map(toAlarm)
    },
    countOf: (subject, kind) =>
      sqlite
        .query<{ n: number }, [string, string]>(
          'SELECT COUNT(*) AS n FROM alarms WHERE subject = ? AND kind = ?',
        )
        .get(subject, kind)?.n ?? 0,
    insert(a) {
      const res = sqlite
        .query(
          `INSERT INTO alarms (id, kind, key, subject, agent_id, text, refs, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (key) DO NOTHING`,
        )
        .run(
          a.id,
          a.kind,
          a.key,
          a.subject,
          a.agentId ?? null,
          a.text,
          JSON.stringify(a.refs ?? []),
          a.createdAt,
        )
      return res.changes === 0 ? undefined : get(a.id)
    },
    ack(id, by, now) {
      sqlite
        .query('UPDATE alarms SET acked_at = ?, acked_by = ? WHERE id = ? AND acked_at IS NULL')
        .run(now, by, id)
      return get(id)
    },
    pending() {
      return sqlite
        .query<AlarmRow, []>(
          'SELECT * FROM alarms WHERE acked_at IS NULL AND delivered_at IS NULL ORDER BY created_at, id',
        )
        .all()
        .map(toAlarm)
    },
    deliveredSince(since) {
      return sqlite
        .query<{ subject: string; delivered_at: number }, [number]>(
          'SELECT subject, delivered_at FROM alarms WHERE delivered_at >= ?',
        )
        .all(since)
        .map((r) => ({ subject: r.subject, deliveredAt: r.delivered_at }))
    },
    markDelivered(ids, now) {
      const q = sqlite.query('UPDATE alarms SET delivered_at = ? WHERE id = ?')
      for (const id of ids) q.run(now, id)
    },
  }
}
