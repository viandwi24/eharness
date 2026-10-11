/** Briefings and notifications (P40 phase M). Pure. */

/** One line of a briefing that can be talked about (`Discuss in chat`). */
export interface BriefingItem {
  kind: 'run' | 'decision' | 'waiting' | 'noticed' | 'cost'
  title: string
  detail: string
  /** An app path (`/tasks/<id>`, `/decisions`) or a library path, when there is one. */
  link: string | null
}

/** The daily digest, kept as a page: one per local day. */
export interface Briefing {
  id: string
  /** Local day `YYYY-MM-DD` (the digest timezone). */
  day: string
  title: string
  /** The digest as markdown. */
  body: string
  items: BriefingItem[]
  createdAt: number
}

export const NOTIFICATION_KINDS = ['alert', 'briefing'] as const
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number]

/** What the bell shows: an urgent finding of the heartbeat, or "your briefing is ready". */
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

export const briefingTitle = (day: string): string => `Briefing ${day}`

/** The lead's read-only tool for the briefings of the Briefing page (any chat thread). */
export const READ_BRIEFINGS_TOOL = 'read_briefings'
export const READ_BRIEFINGS_DESCRIPTION =
  'Read the daily briefings the client sees on the Briefing page: what ran, what waits for them, ' +
  'what the heartbeat noticed and the cost. Without arguments the latest one; `days` returns that ' +
  'many (up to 7), `day` a given local day (YYYY-MM-DD). Read-only. Use it when the client asks ' +
  'about their briefing or what happened lately.'
