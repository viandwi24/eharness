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
  pairKey,
  retireCandidates,
} from '../domain/order-hygiene.ts'
import { sessionRefsIn } from '../domain/session-context.ts'
import {
  grantsOf,
  isLive,
  isStaffRole,
  type OrderDestination,
  orderState,
  parseChecklist,
  privatePostRefusal,
  type ReadScope,
  readRefusal,
  readScopeOf,
  type StandingOrder,
  WEB_OWNER,
} from '../domain/standing-orders.ts'
import { changed } from './decisions.ts'
import type { Deps } from './ports.ts'
import { pauseOrder, removeOrder } from './standing-orders.ts'

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

export const CONFLICT_KEEP_A = 'Keep A, remove B'
export const CONFLICT_KEEP_B = 'Keep B, remove A'
export const CONFLICT_KEEP_BOTH = 'Keep both'
export const CONFLICT_EDIT = 'I will edit them myself'
export const RETIRE_REMOVE = 'Retire it (remove the order)'
export const RETIRE_PAUSE = 'Pause it'
export const RETIRE_KEEP = 'Keep it'
export const GONE_REMOVE = 'Remove the order'
export const GONE_KEEP = 'Keep it paused'
/** "Keep it" to a retire question silences it for this long. */
const RETIRE_KEPT_MS = 28 * DAY
/** "I will edit them myself" holds the same conflict question back for this long. */
const CONFLICT_EDIT_MS = 7 * DAY

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
  // a question about two orders that no longer overlap (an order changed or went, or the check got
  // stricter) is closed, so the owners are not asked about a conflict that is not there
  const prefix = `${agent.name}: two standing orders overlap [`
  const current = new Set(
    findings.filter((f) => f.kind === 'conflict').map((f) => f.orderIds.join(' + ')),
  )
  for (const d of [...open]) {
    if (!d.title.startsWith(prefix) || d.kind !== 'escalation') continue
    const pair = d.title.slice(prefix.length).replace(/\]$/, '')
    if (current.has(pair)) continue
    const closed = deps.decisions.decide(d.id, {
      status: 'expired',
      decidedBy: 'system',
      decidedAt: now,
      note: 'These orders no longer overlap: nothing to decide.',
    })
    if (closed !== undefined) changed(deps, closed, 'decided')
    open.splice(open.indexOf(d), 1)
  }
  const kept = deps.heartbeat.store.state(agent.id).keptPairs ?? {}
  for (const f of findings) {
    if (f.kind !== 'conflict') continue
    const pair = f.orderIds.map((id) => orders.find((x) => x.id === id))
    const [oa, ob] = pair
    // the owners answered this very pair (and neither order changed since): not asked again
    if (oa !== undefined && ob !== undefined && (kept[pairKey(oa, ob)] ?? 0) > now) continue
    const title = checkTitle(
      `${agent.name}: two standing orders overlap [${f.orderIds.join(' + ')}]`,
    )
    if (open.some((d) => d.title === title)) continue
    const lines = f.orderIds.flatMap((id, i) => {
      const o = orders.find((x) => x.id === id)
      return o === undefined
        ? []
        : [
            `- **${i === 0 ? 'A' : 'B'}** (order ${o.id}, ${o.kind}, from ${o.name === '' ? o.by : o.name}): ${o.text}`,
          ]
    })
    // a pair is answered with one click: the server removes the loser or remembers the pair
    const [ida, idb] = f.orderIds
    const actions: Record<string, string> | undefined =
      oa === undefined || ob === undefined || ida === undefined || idb === undefined
        ? undefined
        : {
            [CONFLICT_KEEP_A]: `remove:${idb}`,
            [CONFLICT_KEEP_B]: `remove:${ida}`,
            [CONFLICT_KEEP_BOTH]: `keep-both:${pairKey(oa, ob)}`,
            [CONFLICT_EDIT]: `edit:${pairKey(oa, ob)}`,
          }
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
        options:
          actions === undefined
            ? ['Keep both', 'I will remove one']
            : [CONFLICT_KEEP_A, CONFLICT_KEEP_B, CONFLICT_KEEP_BOTH, CONFLICT_EDIT],
        ...(actions === undefined ? {} : { orderActions: actions }),
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
 * condenses them. Nothing is removed here: the answer to the question does it (`applyOrderAnswer`). Returns the part of
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
    if ((state.keptOrders?.[c.order.id] ?? 0) > now) continue
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
          'Nothing was changed yet: your answer does it. "Retire it" removes the line from HEARTBEAT.md, "Pause it" keeps it but stops it, "Keep it" leaves it and this is not asked again for four weeks.',
        ].join('\n'),
      ),
      agentId: agent.id,
      sessionId: null,
      programId: null,
      payload: {
        question: `Retire the standing order "${c.order.text.slice(0, 80)}"?`,
        options: [RETIRE_REMOVE, RETIRE_PAUSE, RETIRE_KEEP],
        orderActions: {
          [RETIRE_REMOVE]: `remove:${c.order.id}`,
          [RETIRE_PAUSE]: `pause:${c.order.id}`,
          [RETIRE_KEEP]: `keep:${c.order.id}`,
        },
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

// --- answers that are carried out --------------------------------------------------------------

const clip = (t: string, n = 60): string => (t.length > n ? `${t.slice(0, n - 1)}…` : t)

/**
 * A question about standing orders was answered: do what the chosen option says
 * (`payload.orderActions`) through the standing-orders layer, and return what was done in words (the
 * outcome of the decision). undefined = this decision carries no such action. Never throws: a
 * failure is the effect text.
 */
export async function applyOrderAnswer(
  deps: Deps,
  d: { kind: string; agentId: string; payload: unknown },
  choice: string,
): Promise<string | undefined> {
  if (d.kind !== 'escalation') return undefined
  const actions = (d.payload as { orderActions?: Record<string, string> }).orderActions
  const command = actions?.[choice]
  if (command === undefined) return undefined
  const i = command.indexOf(':')
  const verb = i < 0 ? command : command.slice(0, i)
  const arg = i < 0 ? '' : command.slice(i + 1)
  const now = deps.clock.now()
  const kept = (field: 'keptOrders' | 'keptPairs', key: string, until: number): void => {
    deps.heartbeat.store.updateState(
      d.agentId,
      (s) => ({ ...s, [field]: { ...(s[field] ?? {}), [key]: until } }),
      now,
    )
  }
  try {
    switch (verb) {
      case 'remove': {
        const gone = await removeOrder(deps, d.agentId, arg)
        return gone === undefined
          ? `Nothing to remove: order ${arg} was already gone.`
          : `Removed order ${arg} ("${clip(gone.text)}") from HEARTBEAT.md.`
      }
      case 'pause': {
        const done = await pauseOrder(
          deps,
          d.agentId,
          arg,
          'paused by an answer in the Decision Center',
        )
        return done === undefined
          ? `Nothing to pause: order ${arg} is gone or not active.`
          : `Paused order ${arg} ("${clip(done.text)}"): it stays in HEARTBEAT.md and does nothing until it is switched on again.`
      }
      case 'keep':
        kept('keptOrders', arg, now + RETIRE_KEPT_MS)
        return `Kept order ${arg}; the weekly review will not ask about it again for four weeks.`
      case 'keep-both':
        kept('keptPairs', arg, Number.MAX_SAFE_INTEGER)
        return `Kept both orders (${arg.split(':')[0]}); they are not asked about again unless one of them is edited.`
      case 'edit':
        kept('keptPairs', arg, now + CONFLICT_EDIT_MS)
        return `Both orders (${arg.split(':')[0]}) were left as they are: edit them on the Heartbeat tab. Not asked again for a week unless one is edited.`
      default:
        return 'Nothing was changed.'
    }
  } catch (error) {
    return `The answer could not be carried out: ${error instanceof Error ? error.message : String(error)}`
  }
}

// --- a chat that is gone -----------------------------------------------------------------------

/**
 * Orders whose report chat is gone or closed are paused (with the reason, in the file) and the
 * owners get one question; a paused order is not retried on every beat. Returns the ids paused.
 * Called on a beat, never on a read.
 */
export async function pauseGoneDestinations(
  deps: Deps,
  agent: { id: string; name: string },
  findings: readonly HygieneFinding[],
  orders: readonly StandingOrder[],
  now: number,
): Promise<string[]> {
  const out: string[] = []
  for (const f of findings) {
    if (f.kind !== 'destination-gone') continue
    for (const id of f.orderIds) {
      const o = orders.find((x) => x.id === id)
      const paused = await pauseOrder(deps, agent.id, id, 'its report chat is gone or closed')
      if (paused === undefined || o === undefined) continue
      out.push(id)
      const title = checkTitle(`${agent.name}: the chat of a standing order is gone [${id}]`)
      const open = deps.decisions.list({ status: 'open', agentId: agent.id, limit: 100 })
      if (open.some((d) => d.title === title)) continue
      const d = deps.decisions.insert({
        id: deps.ids.next(),
        kind: 'escalation',
        title,
        body: checkBody(
          [
            `The chat this order reports to no longer exists or is closed, so the order was **paused** (it is not retried on every beat).`,
            '',
            `- **${o.id}** (${o.kind}, from ${o.name === '' ? o.by : o.name}): ${o.text}`,
            '',
            'To have it report to another chat, remove it and ask the agent again in that chat.',
          ].join('\n'),
        ),
        agentId: agent.id,
        sessionId: null,
        programId: null,
        payload: {
          question: `The chat of the standing order "${clip(o.text, 80)}" is gone. Remove the order?`,
          options: [GONE_REMOVE, GONE_KEEP],
          orderActions: { [GONE_REMOVE]: `remove:${id}`, [GONE_KEEP]: 'none' },
          source: 'report',
        },
        waitId: null,
        createdAt: now,
      })
      changed(deps, d, 'created')
    }
  }
  return out
}

// --- what a beat may read, and where it may carry it ------------------------------------------

/**
 * The read scope of the beat that starts now (`readScopeOf`): the chats the givers of its live
 * orders can read, plus all allowed chats for the owner's own plain checklist items.
 */
export function beatReadScope(
  deps: Deps,
  agentId: string,
  orders: readonly StandingOrder[],
  plainItems: boolean,
): ReadScope {
  const channels = deps.heartbeat.channels
  return readScopeOf({
    orders,
    plainItems,
    nodes: channels?.nodes(agentId) ?? [],
    giverRole: (o) => giverRole(deps, o),
    giverCanRead: (o, nodeId) => {
      if (o.by === WEB_OWNER) return true
      const role = giverRole(deps, o)
      if (role === undefined) return false
      if (isStaffRole(role)) return true
      if (channels?.canRead !== undefined) return channels.canRead(o.by, nodeId)
      // no directory to ask: a member reads the place they report to (their own direct chat)
      return o.report.kind === 'chat' && o.report.nodeId === nodeId
    },
  })
}

/**
 * The gate asks, on every content read of a beat: may it read this chat (the node and its
 * ancestors)? A refusal is a readable reason. An allowed read of a direct chat is remembered, so a
 * later post is checked against it (`postPrivacy`).
 */
export function checkChatRead(
  deps: Deps,
  agentId: string,
  target: { nodeId: string; title: string; ids: readonly string[]; direct: boolean },
): string | undefined {
  const scope = deps.heartbeat.store.state(agentId).reads
  const refusal = readRefusal(scope, target)
  if (refusal !== undefined) return refusal
  if (target.direct && scope !== undefined && !scope.seen.includes(target.nodeId)) {
    deps.heartbeat.store.updateState(
      agentId,
      (s) =>
        s.reads === undefined || s.reads.seen.includes(target.nodeId)
          ? s
          : { ...s, reads: { ...s.reads, seen: [...s.reads.seen, target.nodeId] } },
      deps.clock.now(),
    )
  }
  return undefined
}

/** A post of the beat to `to` (`destKey`): refused when it would carry what a DM said into a group. */
export function postPrivacy(deps: Deps, agentId: string, to: string): string | undefined {
  const scope = deps.heartbeat.store.state(agentId).reads
  const nodes = deps.heartbeat.channels?.nodes(agentId) ?? []
  return privatePostRefusal(scope, to, (id) => nodes.find((n) => n.nodeId === id)?.title ?? id)
}
