/**
 * Care for standing orders (docs/plans/P52-context-and-orders.md): what the server does around the
 * orders of an agent on every beat, with no model call.
 *
 *  - exact wakes: a `deadline` order has a one-shot system routine that fires at its `due` time
 *  - grants: what the live orders of owners and admins open for the beat (tools, ledger, sessions)
 *  - hygiene: destination gone, giver gone, expired, overdue and overlapping orders
 *  - the weekly review: orders that never triggered or whose deadline passed become a question to
 *    the owners (never removed on their own), and the model condenses last week's notes
 *  - the notes a beat reads (references that no longer resolve are marked) and the patterns it writes
 */
import { checkBody, checkTitle } from '../domain/decisions.ts'
import type { Finding as HealthFinding } from '../domain/health.ts'
import { checklistPath, localDay, notesPath, orderKey } from '../domain/heartbeat.ts'
import {
  checkPattern,
  markUnresolved,
  patternLine,
  patternsPath,
} from '../domain/heartbeat-notes.ts'
import {
  type HygieneFinding,
  isMonday,
  mondayOf,
  orderHygiene,
  retireCandidates,
} from '../domain/order-hygiene.ts'
import { sessionRefsIn } from '../domain/session-context.ts'
import {
  grantsOf,
  isLive,
  type OrderDestination,
  orderState,
  parseChecklist,
  type StandingOrder,
  WEB_OWNER,
} from '../domain/standing-orders.ts'
import { changed } from './decisions.ts'
import type { Deps } from './ports.ts'

const HOUR = 3_600_000
const DAY = 24 * HOUR
/** A deadline wake missed during downtime still fires if the server is back within this long. */
const WAKE_CATCH_UP_MS = 12 * HOUR

// --- exact wakes -------------------------------------------------------------------------------

/**
 * Make the one-shot wakes match the orders: a live deadline order that is still ahead has its
 * routine (`sys:order:<agent>:<order>`, fires once at `due`); every other wake of the agent goes.
 * Straight on the store like the other system routines: these rows are internal.
 */
export function syncOrderWakes(
  deps: Deps,
  agent: { id: string; name: string },
  orders: readonly StandingOrder[],
  now: number,
): void {
  for (const o of orders) {
    const key = orderKey(agent.id, o.id)
    const existing = deps.routines.getByProgram(key)
    const ahead = o.kind === 'deadline' && o.due !== undefined && o.due > now && isLive(o, now)
    if (!ahead) {
      // done, removed, paused or expired: no wake. A live order whose time has passed keeps its
      // row (it fired, or it is being fired right now)
      if (existing !== undefined && (o.kind !== 'deadline' || orderState(o, now) !== 'active')) {
        deps.routines.delete(existing.id)
      }
      continue
    }
    const schedule = { kind: 'at' as const, at: o.due as number }
    if (existing !== undefined) {
      if (
        JSON.stringify(existing.schedule) === JSON.stringify(schedule) &&
        existing.status === 'active'
      ) {
        continue
      }
      deps.routines.update(
        existing.id,
        { schedule, status: 'active', pausedReason: null, failures: 0, nextFireAt: schedule.at },
        now,
      )
      continue
    }
    deps.routines.insert({
      id: deps.ids.next(),
      agentId: agent.id,
      name: `Deadline: ${o.text}`.slice(0, 120),
      prompt: `Deadline order ${o.id}`,
      schedule,
      sessionMode: 'task',
      overlap: 'queue',
      catchUpWindowMs: WAKE_CATCH_UP_MS,
      maxFailures: 3,
      maxFires: 1,
      endAt: null,
      nextFireAt: schedule.at,
      programId: key,
      now,
    })
  }
}

/** Drop the wake of one order (it is done or removed). */
export function dropOrderWake(deps: Deps, agentId: string, orderId: string): void {
  const r = deps.routines.getByProgram(orderKey(agentId, orderId))
  if (r !== undefined) deps.routines.delete(r.id)
}

// --- roles and destinations --------------------------------------------------------------------

/** What the giver of an order is today; undefined = gone. The web owner is always the owner. */
export function giverRole(deps: Deps, o: StandingOrder): string | undefined {
  if (o.by === WEB_OWNER) return 'owner'
  const channels = deps.heartbeat.channels
  // no chat side to ask: what was stored when the order was given
  return channels?.roleOf === undefined ? o.role : channels.roleOf(o.by)
}

function destinationExists(deps: Deps, agentId: string, d: OrderDestination): boolean {
  if (d.kind === 'web') return true
  const channels = deps.heartbeat.channels
  if (channels === undefined) return true
  return channels.nodes(agentId).some((n) => n.nodeId === d.nodeId)
}

// --- grants ------------------------------------------------------------------------------------

/**
 * What the live orders open for the beat that starts now: the needs and ledgers of orders whose
 * giver is an owner or an admin today, and the sessions every live order names (the heartbeat may
 * read a web chat only when an order names it).
 */
export function grantsFor(
  deps: Deps,
  agentId: string,
  orders: readonly StandingOrder[],
  now: number,
): { needs: string[]; writes: string[]; sessions: string[] } {
  const { needs, writes } = grantsOf(orders, (o) => giverRole(deps, o), now)
  const sessions = new Set<string>()
  for (const o of orders) {
    if (!isLive(o, now)) continue
    // a member's order can only name what that member may read: only staff orders open web chats
    if (o.role !== 'owner' && o.role !== 'admin') continue
    for (const ref of o.refs) for (const s of sessionRefsIn(ref)) sessions.add(s)
    for (const s of sessionRefsIn(o.text)) sessions.add(s)
  }
  void agentId
  return { needs, writes, sessions: [...sessions] }
}

// --- hygiene -----------------------------------------------------------------------------------

export function hygieneOf(
  deps: Deps,
  agentId: string,
  orders: readonly StandingOrder[],
  now: number,
): HygieneFinding[] {
  return orderHygiene({
    now,
    orders,
    destinationExists: (d) => destinationExists(deps, agentId, d),
    giverRole: (o) => giverRole(deps, o),
  })
}

const questionOf = (f: HygieneFinding): string => f.text

/**
 * Overlapping orders become one question to the owners in the Decision Center (the other findings
 * stay on the Heartbeat tab and the Health page). One open question per pair.
 */
export function raiseConflicts(
  deps: Deps,
  agent: { id: string; name: string },
  findings: readonly HygieneFinding[],
  orders: readonly StandingOrder[],
  now: number,
): number {
  let raised = 0
  const open = deps.decisions.list({ status: 'open', agentId: agent.id, limit: 100 })
  for (const f of findings) {
    if (f.kind !== 'conflict') continue
    const title = checkTitle(
      `${agent.name}: two standing orders overlap [${f.orderIds.join(' + ')}]`,
    )
    if (open.some((d) => d.title === title)) continue
    const lines = f.orderIds.flatMap((id) => {
      const o = orders.find((x) => x.id === id)
      return o === undefined
        ? []
        : [`- **${o.id}** (${o.kind}, from ${o.name === '' ? o.by : o.name}): ${o.text}`]
    })
    const d = deps.decisions.insert({
      id: deps.ids.next(),
      kind: 'escalation',
      title,
      body: checkBody([questionOf(f), '', ...lines, '', f.fix].join('\n')),
      agentId: agent.id,
      sessionId: null,
      programId: null,
      payload: {
        question: 'These standing orders may disagree. Which should the agent follow?',
        options: ['Keep both', 'I will remove one'],
        source: 'report',
      },
      waitId: null,
      createdAt: now,
    })
    changed(deps, d, 'created')
    open.push(d)
    raised++
  }
  return raised
}

// --- the weekly review -------------------------------------------------------------------------

/**
 * The first beat of a week (Monday, team timezone): ask the owners about orders that never
 * triggered or whose deadline passed, and tell the beat which days of last week have notes so it
 * condenses them. The question is never an action: nothing is removed here. Returns the part of
 * the prompt, or undefined when this is not the first beat of the week.
 */
export async function weeklyReview(
  deps: Deps,
  agent: { id: string; name: string; slug: string },
  orders: readonly StandingOrder[],
  now: number,
): Promise<{ days: string[]; patterns: string } | undefined> {
  const tz = deps.settings.get().timezone
  if (!isMonday(now, tz)) return undefined
  const week = mondayOf(now, tz)
  const state = deps.heartbeat.store.state(agent.id)
  if (state.review?.week === week) return undefined
  deps.heartbeat.store.updateState(agent.id, (s) => ({ ...s, review: { week, at: now } }), now)

  const open = deps.decisions.list({ status: 'open', agentId: agent.id, limit: 100 })
  for (const c of retireCandidates({ now, orders, fired: state.fired ?? {} })) {
    const title = checkTitle(`${agent.name}: retire a standing order? [${c.order.id}]`)
    if (open.some((d) => d.title === title)) continue
    const d = deps.decisions.insert({
      id: deps.ids.next(),
      kind: 'escalation',
      title,
      body: checkBody(
        [
          `Weekly review: ${c.reason}.`,
          '',
          `- **${c.order.id}** (${c.order.kind}, from ${c.order.name === '' ? c.order.by : c.order.name}): ${c.order.text}`,
          '',
          'Nothing was removed. Remove it on the Heartbeat tab (or tell the agent to stop) if it is no longer needed.',
        ].join('\n'),
      ),
      agentId: agent.id,
      sessionId: null,
      programId: null,
      payload: {
        question: `Retire the standing order "${c.order.text.slice(0, 80)}"?`,
        options: ['Retire it (I will remove it)', 'Keep it'],
        source: 'report',
      },
      waitId: null,
      createdAt: now,
    })
    changed(deps, d, 'created')
  }

  // the days of last week (Monday to Sunday before this Monday) that have notes
  const days: string[] = []
  for (let back = 7; back >= 1; back--) {
    const day = localDay(now - back * DAY, tz)
    if ((await deps.library.read(notesPath(agent.slug, day))) !== undefined) days.push(day)
  }
  return { days, patterns: patternsPath(agent.slug) }
}

/** Count that an order led to a report or an escalation (the weekly review reads it). */
export function noteFired(deps: Deps, agentId: string, orderId: string, at: number): void {
  deps.heartbeat.store.updateState(
    agentId,
    (s) => {
      const prev = s.fired?.[orderId]
      return {
        ...s,
        fired: { ...(s.fired ?? {}), [orderId]: { count: (prev?.count ?? 0) + 1, lastAt: at } },
      }
    },
    at,
  )
}

// --- notes and patterns a beat reads and writes ------------------------------------------------

/**
 * The notes of the given days (`YYYY-MM-DD`, team timezone), a line whose library path or session
 * no longer resolves marked as such. A missing file is "none".
 */
export async function readNotes(
  deps: Deps,
  agent: { slug: string },
  days: readonly string[],
): Promise<string> {
  const out: string[] = []
  for (const day of days.slice(0, 8)) {
    const file = await deps.library.read(notesPath(agent.slug, day))
    if (file === undefined) {
      out.push(`## ${day}\n(no notes)`)
      continue
    }
    // existence of what the notes point at, looked up once per reference
    const paths = new Set<string>()
    const sessions = new Set<string>()
    for (const m of (file.text ?? '').matchAll(/(\/library\/[^\s,;)]+)/g)) paths.add(m[1] as string)
    for (const m of (file.text ?? '').matchAll(/session:([^\s#,;)]+)#/g))
      sessions.add(m[1] as string)
    const okPaths = new Set<string>()
    for (const p of paths) if ((await deps.library.read(p)) !== undefined) okPaths.add(p)
    const okSessions = new Set<string>()
    for (const s of sessions) {
      if ((await deps.heartbeat.sessionExists?.(s)) !== false) okSessions.add(s)
    }
    out.push(
      `## ${day}\n${markUnresolved(file.text ?? '', {
        library: (p) => okPaths.has(p),
        session: (s) => okSessions.has(s),
      })}`,
    )
  }
  return out.join('\n\n')
}

/** Append one confirmed pattern (evidence on at least two days) to the agent's patterns file. */
export async function appendPattern(
  deps: Deps,
  agent: { slug: string },
  input: { pattern: string; days: string[] },
  now: number,
): Promise<string> {
  const tz = deps.settings.get().timezone
  const haveNotes = new Set<string>()
  for (const d of new Set(input.days.map((x) => x.trim()))) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue
    if ((await deps.library.read(notesPath(agent.slug, d))) !== undefined) haveNotes.add(d)
  }
  const refusal = checkPattern({ pattern: input.pattern, days: input.days, haveNotes })
  if (refusal !== undefined) return refusal
  const path = patternsPath(agent.slug)
  const current =
    (await deps.library.read(path))?.text ??
    '# Confirmed patterns\n\nOnly what has evidence on at least two different days.\n\n'
  const line = patternLine({ pattern: input.pattern, days: [...haveNotes] })
  const heading = `## Week of ${mondayOf(now, tz)}`
  const body = current.includes(heading)
    ? current
    : `${current.replace(/\s*$/, '\n')}\n${heading}\n\n`
  await deps.library.writeText(path, `${body.replace(/\s*$/, '\n')}${line}\n`)
  return `Written to ${path}.`
}

// --- health ------------------------------------------------------------------------------------

/** The hygiene findings of the agents as findings of the Health page (kind `order-hygiene`). */
export async function hygieneFindings(deps: Deps, now: number): Promise<HealthFinding[]> {
  const out: HealthFinding[] = []
  for (const agent of deps.agents.list()) {
    const file = await deps.library.read(checklistPath(agent.id))
    if (file === undefined) continue
    const orders = parseChecklist(file.text ?? '').orders
    for (const f of hygieneOf(deps, agent.id, orders, now)) {
      out.push({
        fingerprint: `${f.fingerprint}:${agent.id}`,
        kind: 'order-hygiene',
        severity: f.severity,
        agentId: agent.id,
        sessionId: null,
        programId: null,
        link: `/a/${agent.slug}?tab=heartbeat`,
        firstSeen: now,
        lastSeen: now,
        count: 1,
        explanation: f.text,
        fix: f.fix,
      })
    }
  }
  return out
}
