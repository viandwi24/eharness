/** Notifications (the bell, the daily digest included), plain SQL on the shared connection. */
import type { Database } from 'bun:sqlite'
import type { NotificationStore } from '../../app/ports.ts'
import type { Notification } from '../../domain/briefings.ts'

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
