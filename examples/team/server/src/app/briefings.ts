/**
 * Briefings and the bell (P40 phase M). System news leaves the chat: the daily digest is a page
 * (one entry per local day, plus one bell notification) and an urgent heartbeat finding is an
 * alert in the bell. Both are idempotent, so a recovered fire or a retried beat adds nothing twice.
 * Channels will deliver the same two things later; this is the one place that creates them.
 */
import {
  type Briefing,
  type BriefingItem,
  briefingTitle,
  type Notification,
} from '../domain/briefings.ts'
import { notFound } from '../domain/errors.ts'
import type { BeatItem } from '../domain/heartbeat.ts'
import type { Deps } from './ports.ts'

const changed = (
  deps: Deps,
  type: 'notification-changed' | 'briefing-added',
  payload: Record<string, unknown>,
): void => deps.events.append({ type, payload })

/** Store the briefing of a day and tell the bell. undefined: that day has one already. */
export function postBriefing(
  deps: Deps,
  input: { day: string; body: string; items: BriefingItem[]; at: number },
): Briefing | undefined {
  const briefing = deps.briefings.insert({
    id: deps.ids.next(),
    day: input.day,
    title: briefingTitle(input.day),
    body: input.body,
    items: input.items,
    createdAt: input.at,
  })
  if (briefing === undefined) return undefined
  deps.notifications.insert({
    id: deps.ids.next(),
    kind: 'briefing',
    key: `briefing:${briefing.day}`,
    title: `Your briefing for ${briefing.day} is ready`,
    body: `${briefing.items.length} item(s)`,
    link: `/briefings?id=${briefing.id}`,
    agentId: null,
    createdAt: input.at,
  })
  changed(deps, 'briefing-added', { briefingId: briefing.id, day: briefing.day })
  changed(deps, 'notification-changed', { kind: 'briefing' })
  return briefing
}

/** An urgent finding of a beat goes to the bell, one alert per finding (deduplicated by its fingerprint). */
export function postAlerts(
  deps: Deps,
  input: { agentId: string; beatId: string; items: readonly BeatItem[]; at: number },
): number {
  let added = 0
  for (const item of input.items) {
    const n = deps.notifications.insert({
      id: deps.ids.next(),
      kind: 'alert',
      key: `alert:${input.beatId}:${item.fingerprint}`,
      title: item.title.replace(/\s+/g, ' ').trim().slice(0, 160),
      body: item.detail.replace(/\s+/g, ' ').trim().slice(0, 600),
      link: item.links[0] ?? null,
      agentId: input.agentId,
      createdAt: input.at,
    })
    if (n !== undefined) added++
  }
  if (added > 0) changed(deps, 'notification-changed', { kind: 'alert', added })
  return added
}

export function listNotifications(deps: Deps, opts: { all?: boolean; limit?: number } = {}) {
  return {
    notifications: deps.notifications.list({ open: opts.all !== true, limit: opts.limit ?? 50 }),
    open: deps.notifications.countOpen(),
  }
}

export function dismissNotification(deps: Deps, id: string): Notification {
  const found = deps.notifications.get(id)
  if (found === undefined) throw notFound('notification', id)
  const next = deps.notifications.dismiss(id, deps.clock.now()) as Notification
  changed(deps, 'notification-changed', { kind: next.kind, dismissed: id })
  return next
}

export function dismissAllNotifications(deps: Deps): number {
  const n = deps.notifications.dismissAll(deps.clock.now())
  if (n > 0) changed(deps, 'notification-changed', { dismissed: 'all' })
  return n
}

export function listBriefings(deps: Deps, limit = 60): Briefing[] {
  return deps.briefings.list(limit)
}

/** Opening a briefing clears its "ready" notification. */
export function getBriefing(deps: Deps, id: string): Briefing {
  const b = deps.briefings.get(id)
  if (b === undefined) throw notFound('briefing', id)
  return b
}

export function markBriefingSeen(deps: Deps, id: string): void {
  const b = getBriefing(deps, id)
  const n = deps.notifications.dismissByKeyPrefix(`briefing:${b.day}`, deps.clock.now())
  if (n > 0) changed(deps, 'notification-changed', { kind: 'briefing', dismissed: b.id })
}

/** What the lead's `read_briefings` tool returns: the latest briefings as text. */
export function briefingsText(deps: Deps, opts: { limit?: number; day?: string } = {}): string {
  const found =
    opts.day === undefined
      ? deps.briefings.list(Math.min(Math.max(opts.limit ?? 1, 1), 7))
      : [deps.briefings.getByDay(opts.day)].filter((b): b is Briefing => b !== undefined)
  if (found.length === 0) return 'No briefing found.'
  return found.map((b) => `# ${b.title}\n\n${b.body}`).join('\n\n---\n\n')
}
