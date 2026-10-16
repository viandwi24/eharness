/**
 * Order hygiene and the weekly review of standing orders (docs/plans/P52-context-and-orders.md).
 * Pure: the server looks at the orders on every beat, with no model call, and the Heartbeat tab and
 * the Health page show what it finds.
 *
 * Findings: the destination of an order is gone, its giver is no longer an owner or admin (or is
 * gone), it expired, a deadline passed with no outcome, and orders that overlap: two orders that
 * report the same topic to different places, or from different givers. Overlap is a hint, not a
 * proof (telling that two instructions contradict is hard), so it becomes a question to the owners,
 * never an action.
 */
import { localDay } from './heartbeat.ts'
import {
  destKey,
  isLive,
  isStaffRole,
  type OrderDestination,
  orderState,
  type StandingOrder,
} from './standing-orders.ts'

export const HYGIENE_KINDS = [
  'destination-gone',
  'giver-gone',
  'giver-not-staff',
  'expired',
  'overdue',
  'conflict',
] as const
export type HygieneKind = (typeof HYGIENE_KINDS)[number]

export interface HygieneFinding {
  kind: HygieneKind
  /** The orders it is about (two for a conflict). */
  orderIds: string[]
  severity: 'high' | 'medium' | 'low'
  /** One sentence: what is wrong. */
  text: string
  /** What to do about it. */
  fix: string
  /** Stable: the same problem has the same fingerprint every beat. */
  fingerprint: string
}

/** A deadline that passed this long ago without an outcome is overdue. */
export const OVERDUE_MS = 2 * 3_600_000
/** Two orders overlap when their words share at least this many topic words. */
export const CONFLICT_SHARED_WORDS = 2

const STOP = new Set(
  (
    'this that with from have will when what which their there about into than then them they were been being ' +
    'your yours dari yang untuk dengan atau juga pada kalau jika apabila agar akan sudah belum telah saat ' +
    'report laporkan kabari tell tulis give kasih kepada ke di ' +
    'order standing watch pantau awasi monitor check cek'
  ).split(/\s+/),
)

/** The words an order is about (lowercase, 4+ letters, no filler). */
export function topicWords(text: string): Set<string> {
  const out = new Set<string>()
  for (const w of text
    .toLowerCase()
    .normalize('NFKD')
    .split(/[^a-z0-9]+/)) {
    if (w.length >= 4 && !STOP.has(w) && !/^\d+$/.test(w)) out.add(w)
  }
  return out
}

const shared = (a: ReadonlySet<string>, b: ReadonlySet<string>): string[] =>
  [...a].filter((w) => b.has(w))

export interface HygieneInput {
  now: number
  orders: readonly StandingOrder[]
  /** The place an order reports to still exists. */
  destinationExists: (d: OrderDestination) => boolean
  /** The role of the giver today; undefined = the giver is gone. */
  giverRole: (o: StandingOrder) => string | undefined
}

const short = (o: StandingOrder): string => {
  const t = o.text.length > 60 ? `${o.text.slice(0, 59)}…` : o.text
  return `"${t}"`
}

export function orderHygiene(input: HygieneInput): HygieneFinding[] {
  const { now } = input
  const out: HygieneFinding[] = []
  const add = (
    kind: HygieneKind,
    orders: StandingOrder[],
    severity: HygieneFinding['severity'],
    text: string,
    fix: string,
  ): void => {
    const ids = orders.map((o) => o.id).sort()
    out.push({
      kind,
      orderIds: ids,
      severity,
      text,
      fix,
      fingerprint: `hygiene:${kind}:${ids.join('+')}`,
    })
  }
  for (const o of input.orders) {
    const state = orderState(o, now)
    if (state === 'done') continue
    if (state === 'expired') {
      add(
        'expired',
        [o],
        'low',
        `The standing order ${short(o)} expired and is inactive.`,
        'Remove it, or give a new one if it still matters.',
      )
      continue
    }
    if (state === 'paused') continue
    if (!input.destinationExists(o.report)) {
      add(
        'destination-gone',
        [o],
        'medium',
        `The standing order ${short(o)} reports to a chat that no longer exists or is closed.`,
        'Remove the order, or give it again with a chat the agent can post to.',
      )
    }
    if (o.kind === 'deadline' && o.due !== undefined && now - o.due > OVERDUE_MS) {
      add(
        'overdue',
        [o],
        'medium',
        `The deadline of ${short(o)} passed without an outcome.`,
        'Open the Heartbeat tab: run a beat now, or remove the order.',
      )
    }
    // a member's order never had more than a private report: only staff orders carry tools
    if (isStaffRole(o.role) && o.by !== 'web:owner') {
      const role = input.giverRole(o)
      if (role === undefined) {
        add(
          'giver-gone',
          [o],
          'medium',
          `The person who gave ${short(o)} is no longer known to the team.`,
          'Remove the order, or confirm it with a current owner or admin.',
        )
      } else if (!isStaffRole(role)) {
        add(
          'giver-not-staff',
          [o],
          'medium',
          `The person who gave ${short(o)} is not an owner or admin any more (now ${role}); its tools and ledger are off.`,
          'Remove the order, or let an owner or admin give it again.',
        )
      }
    }
  }
  // overlap between live orders
  const live = input.orders.filter((o) => isLive(o, now))
  const words = new Map(live.map((o) => [o.id, topicWords(o.text)]))
  for (let i = 0; i < live.length; i++) {
    for (let j = i + 1; j < live.length; j++) {
      const a = live[i] as StandingOrder
      const b = live[j] as StandingOrder
      const common = shared(words.get(a.id) as Set<string>, words.get(b.id) as Set<string>)
      if (common.length < CONFLICT_SHARED_WORDS) continue
      const otherPlace = destKey(a.report) !== destKey(b.report)
      const otherGiver = a.by !== b.by
      if (!otherPlace && !otherGiver) continue
      const why = [
        otherPlace ? 'report to different places' : '',
        otherGiver ? 'come from different people' : '',
      ].filter(Boolean)
      add(
        'conflict',
        [a, b],
        'medium',
        `The standing orders ${short(a)} and ${short(b)} are about the same thing (${common.slice(0, 4).join(', ')}) and ${why.join(' and ')}.`,
        'Keep one, or make clear which one wins. The owners are asked in the Decision Center.',
      )
    }
  }
  return out
}

// --- the weekly review -------------------------------------------------------------------------

const DAY_MS = 24 * 3_600_000

/** What the server learned of an order's life: how often it led to a report or an escalation. */
export interface OrderFired {
  count: number
  lastAt: number
}

/** The Monday (`YYYY-MM-DD`, in `timezone`) of the week an instant is in. */
export function mondayOf(at: number, timezone: string): string {
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short' }).format(
    new Date(at),
  )
  const back = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(weekday)
  return localDay(at - Math.max(back, 0) * DAY_MS, timezone)
}

export const isMonday = (at: number, timezone: string): boolean =>
  new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short' }).format(
    new Date(at),
  ) === 'Mon'

/** An order the weekly review would retire, and why. */
export interface RetireCandidate {
  order: StandingOrder
  reason: string
}

/** Orders that never triggered in two weeks, or whose deadline is over. Proposals only. */
export function retireCandidates(input: {
  now: number
  orders: readonly StandingOrder[]
  fired: Readonly<Record<string, OrderFired>>
}): RetireCandidate[] {
  const out: RetireCandidate[] = []
  for (const o of input.orders) {
    const state = orderState(o, input.now)
    if (state === 'paused') continue
    if (state === 'done') {
      if (input.now - (o.done?.at ?? input.now) >= 7 * DAY_MS) {
        out.push({ order: o, reason: 'its deadline is over and it has an outcome' })
      }
      continue
    }
    if (state === 'expired') {
      out.push({ order: o, reason: 'it expired' })
      continue
    }
    if (o.kind === 'deadline') {
      if (o.due !== undefined && input.now - o.due >= DAY_MS) {
        out.push({ order: o, reason: 'its deadline passed a day ago with no outcome' })
      }
      continue
    }
    const age = input.now - o.at
    if (age >= 14 * DAY_MS && input.fired[o.id] === undefined) {
      out.push({
        order: o,
        reason: `it never led to a report in ${Math.floor(age / DAY_MS)} days`,
      })
    }
  }
  return out
}
