/**
 * The bell (P40 phase M; P55 folded the Briefing page into it). System news leaves the chat: the
 * daily digest is one bell notification per local day carrying the whole digest text, and an urgent
 * heartbeat finding is an alert in the bell. Both are idempotent, so a recovered fire or a retried
 * beat adds nothing twice. The legacy `briefings` table stays in place and is no longer written.
 */
import { digestTitle, type Notification } from '../domain/briefings.ts'
import { notFound } from '../domain/errors.ts'
import type { BeatItem } from '../domain/heartbeat.ts'
import type { Deps } from './ports.ts'

const changed = (
  deps: Deps,
  type: 'notification-changed',
  payload: Record<string, unknown>,
): void => deps.events.append({ type, payload })

/** Longest digest text a notification keeps. */
const DIGEST_BODY_MAX = 8000

/** Post the digest of a day to the bell. false: that day has one already (even a dismissed one). */
export function postDigest(deps: Deps, input: { day: string; body: string; at: number }): boolean {
  const n = deps.notifications.insert({
    id: deps.ids.next(),
    kind: 'briefing',
    key: `briefing:${input.day}`,
    title: digestTitle(input.day),
    body: input.body.slice(0, DIGEST_BODY_MAX),
    link: null,
    agentId: null,
    createdAt: input.at,
  })
  if (n === undefined) return false
  changed(deps, 'notification-changed', { kind: 'briefing' })
  return true
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

/** A one-off alert in the bell, deduplicated by `key` (a dismissed one is not posted again). */
export function postNotice(
  deps: Deps,
  input: {
    key: string
    title: string
    body: string
    link: string | null
    agentId: string | null
    at: number
  },
): boolean {
  const n = deps.notifications.insert({
    id: deps.ids.next(),
    kind: 'alert',
    key: input.key,
    title: input.title,
    body: input.body.replace(/\s+/g, ' ').trim().slice(0, 600),
    link: input.link,
    agentId: input.agentId,
    createdAt: input.at,
  })
  if (n === undefined) return false
  changed(deps, 'notification-changed', { kind: 'alert', added: 1 })
  return true
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
