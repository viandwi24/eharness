/** Notifications (the bell) and briefings (the digest page), plain SQL on the shared connection. */
import type { Database } from 'bun:sqlite'
import type { BriefingStore, NotificationStore } from '../../app/ports.ts'
import type { Briefing, BriefingItem, Notification } from '../../domain/briefings.ts'

interface NotificationRow {
  id: string
  kind: string
  key: string
  title: string
  body: string
  link: string | null
  agent_id: string | null
  created_at: number
  dismissed_at: number | null
}

const toNotification = (r: NotificationRow): Notification => ({
  id: r.id,
  kind: r.kind === 'briefing' ? 'briefing' : 'alert',
  title: r.title,
  body: r.body,
  link: r.link,
  agentId: r.agent_id,
  createdAt: r.created_at,
  dismissedAt: r.dismissed_at,
})

export function sqliteNotificationStore(sqlite: Database): NotificationStore {
  const byId = sqlite.query<NotificationRow, [string]>('SELECT * FROM notifications WHERE id = ?')
  const byKey = sqlite.query<NotificationRow, [string]>('SELECT * FROM notifications WHERE key = ?')
  return {
    get: (id) => {
      const r = byId.get(id)
      return r === null ? undefined : toNotification(r)
    },
    list({ open, limit }) {
      const where = open ? 'WHERE dismissed_at IS NULL' : ''
      return sqlite
        .query<NotificationRow, [number]>(
          `SELECT * FROM notifications ${where} ORDER BY created_at DESC, id DESC LIMIT ?`,
        )
        .all(limit)
        .map(toNotification)
    },
    countOpen: () =>
      sqlite
        .query<{ n: number }, []>(
          'SELECT COUNT(*) AS n FROM notifications WHERE dismissed_at IS NULL',
        )
        .get()?.n ?? 0,
    insert(n) {
      const res = sqlite
        .query(
          `INSERT INTO notifications (id, kind, key, title, body, link, agent_id, created_at, dismissed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL) ON CONFLICT (key) DO NOTHING`,
        )
        .run(n.id, n.kind, n.key, n.title, n.body, n.link, n.agentId, n.createdAt)
      return res.changes === 0 ? undefined : toNotification(byId.get(n.id) as NotificationRow)
    },
    dismiss(id, now) {
      sqlite
        .query('UPDATE notifications SET dismissed_at = ? WHERE id = ? AND dismissed_at IS NULL')
        .run(now, id)
      const r = byId.get(id)
      return r === null ? undefined : toNotification(r)
    },
    dismissAll(now) {
      return sqlite
        .query('UPDATE notifications SET dismissed_at = ? WHERE dismissed_at IS NULL')
        .run(now).changes
    },
    dismissByKeyPrefix(prefix, now) {
      return sqlite
        .query(
          "UPDATE notifications SET dismissed_at = ? WHERE dismissed_at IS NULL AND key LIKE ? ESCAPE '\\'",
        )
        .run(now, `${prefix.replace(/[\\%_]/g, '\\$&')}%`).changes
    },
    byKey: (key) => {
      const r = byKey.get(key)
      return r === null ? undefined : toNotification(r)
    },
  }
}

interface BriefingRow {
  id: string
  day: string
  title: string
  body: string
  items: string
  created_at: number
}

const toBriefing = (r: BriefingRow): Briefing => {
  let items: BriefingItem[] = []
  try {
    const parsed: unknown = JSON.parse(r.items)
    if (Array.isArray(parsed)) items = parsed as BriefingItem[]
  } catch {
    items = []
  }
  return { id: r.id, day: r.day, title: r.title, body: r.body, items, createdAt: r.created_at }
}

export function sqliteBriefingStore(sqlite: Database): BriefingStore {
  const byId = sqlite.query<BriefingRow, [string]>('SELECT * FROM briefings WHERE id = ?')
  const byDay = sqlite.query<BriefingRow, [string]>('SELECT * FROM briefings WHERE day = ?')
  return {
    get: (id) => {
      const r = byId.get(id)
      return r === null ? undefined : toBriefing(r)
    },
    getByDay: (day) => {
      const r = byDay.get(day)
      return r === null ? undefined : toBriefing(r)
    },
    list: (limit) =>
      sqlite
        .query<BriefingRow, [number]>('SELECT * FROM briefings ORDER BY day DESC LIMIT ?')
        .all(limit)
        .map(toBriefing),
    insert(b) {
      const res = sqlite
        .query(
          `INSERT INTO briefings (id, day, title, body, items, created_at) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (day) DO NOTHING`,
        )
        .run(b.id, b.day, b.title, b.body, JSON.stringify(b.items), b.createdAt)
      return res.changes === 0 ? undefined : toBriefing(byId.get(b.id) as BriefingRow)
    },
  }
}
