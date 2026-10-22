/** Notifications: the bell (P40 phase M; the daily digest lives here since P55). Pure. */

/** One line of the digest (`buildDigest` also returns the digest as items). */
export interface BriefingItem {
  kind: 'run' | 'decision' | 'waiting' | 'noticed' | 'cost'
  title: string
  detail: string
  /** An app path (`/tasks/<id>`, `/decisions`) or a library path, when there is one. */
  link: string | null
}

/** `briefing` is the daily digest (the stored kind of the rows the Briefing page used to announce). */
export const NOTIFICATION_KINDS = ['alert', 'briefing'] as const
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number]

/** What the bell shows: an urgent finding of the heartbeat, or the daily digest. */
export interface Notification {
  id: string
  kind: NotificationKind
  title: string
  body: string
  link: string | null
  agentId: string | null
  createdAt: number
  dismissedAt: number | null
}

export const digestTitle = (day: string): string => `Daily digest ${day}`
