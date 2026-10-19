/**
 * Standing orders use cases (docs/plans/P51-proactive-and-health.md). The orders are lines of the
 * agent's own memory file `HEARTBEAT.md` (`domain/standing-orders.ts`): the file is the source of
 * truth, so the owner reads and edits them as text, and the agent sees them in its memory. These
 * functions read the file, change one line and write it back (compare-and-set, serialised per
 * agent in this process).
 */

import { invalid } from '../domain/errors.ts'
import { checklistPath } from '../domain/heartbeat.ts'
import { sameInstruction } from '../domain/order-hygiene.ts'
import {
  cleanOrderText,
  cleanRefs,
  defaultLedgerPath,
  isLedgerPath,
  NEEDS_HELP,
  normalizeNeeds,
  type OrderDestination,
  type OrderKind,
  orderState,
  parseChecklist,
  type StandingOrder,
  sameOrder,
  withOrder,
  withOrderChanged,
  withoutOrder,
} from '../domain/standing-orders.ts'
import { getAgent } from './agents.ts'
import { syncHeartbeatRoutine } from './heartbeat.ts'
import { dropOrderWake, syncOrderWakes } from './order-care.ts'
import type { Deps } from './ports.ts'

const chain = new Map<string, Promise<unknown>>()
function serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = chain.get(key) ?? Promise.resolve()
  const next = prev.then(fn, fn)
  chain.set(
    key,
    next.catch(() => undefined),
  )
  return next
}

const MAX_WRITE_TRIES = 4

/** Read the file, let `change` return the new text (or undefined = no change), write it back. */
async function editFile<T>(
  deps: Deps,
  agentId: string,
  change: (text: string | undefined) => { text?: string; result: T },
): Promise<T> {
  const path = checklistPath(agentId)
  return serial(agentId, async () => {
    for (let i = 0; i < MAX_WRITE_TRIES; i++) {
      const file = await deps.library.read(path)
      const out = change(file?.text ?? undefined)
      if (out.text === undefined) return out.result
      const written = await deps.library.writeText(
        path,
        out.text,
        file === undefined ? null : file.meta.version,
      )
      if (written.ok) return out.result
    }
    throw invalid('HEARTBEAT.md keeps changing; try again', 'INVALID_ORDER')
  })
}

const changed = (deps: Deps, agentId: string, change: string): void =>
  deps.events.append({ type: 'heartbeat-changed', agentId, payload: { change } })

/** Every order of the agent's file (also paused ones), oldest first. */
export async function listOrders(deps: Deps, agentId: string): Promise<StandingOrder[]> {
  const file = await deps.library.read(checklistPath(agentId))
  return parseChecklist(file?.text).orders
}

export interface NewOrder {
  text: string
  by: string
  name: string
  role: string
  uid?: string | undefined
  report: OrderDestination
  mention: boolean
  /** Default `watch`. */
  kind?: OrderKind | undefined
  /** `deadline`: the instant of the exact wake (epoch ms). */
  due?: number | undefined
  expires?: number | undefined
  refs?: readonly string[] | undefined
  needs?: readonly string[] | undefined
  /** A library path for the order's tracker; a `ledger` order gets a default one. */
  ledger?: string | undefined
}

/**
 * Add an order. The same words from the same person to the same place are not stacked: the
 * existing order is returned (`created: false`).
 */
export async function addOrder(
  deps: Deps,
  agentId: string,
  input: NewOrder,
): Promise<{ order: StandingOrder; created: boolean }> {
  const agent = getAgent(deps, agentId)
  const now = deps.clock.now()
  const text = cleanOrderText(input.text)
  if (text === '') throw invalid('a standing order needs the instruction text', 'INVALID_ORDER')
  const kind = input.kind ?? 'watch'
  if (kind === 'deadline' && input.due === undefined) {
    throw invalid('a deadline order needs due: the time it must be checked', 'INVALID_ORDER')
  }
  if (input.due !== undefined && kind !== 'deadline') {
    throw invalid('due belongs to a deadline order (kind "deadline")', 'INVALID_ORDER')
  }
  if (input.due !== undefined && input.due <= now) {
    throw invalid('due is in the past: give the time it must be checked', 'INVALID_ORDER')
  }
  if (input.expires !== undefined && input.expires <= now) {
    throw invalid('expires is in the past', 'INVALID_ORDER')
  }
  if (input.due !== undefined && input.expires !== undefined && input.expires < input.due) {
    throw invalid('expires is before due', 'INVALID_ORDER')
  }
  // one message saved as a program's standing agreement and again as an order would be done twice
  for (const program of deps.programs.list({})) {
    if (program.agentId !== agentId) continue
    const note = program.notes.find((n) => sameInstruction(n, text))
    if (note !== undefined) {
      throw invalid(
        `already a standing agreement of the program "${program.name}" ("${note.slice(0, 120)}"): its runs do it. Do not save it again as a standing order: one place is enough. If it must also be watched between runs, ask the person which one they want.`,
        'DUPLICATE_OF_PROGRAM',
      )
    }
  }
  const { needs, invalid: badNeeds } = normalizeNeeds(input.needs ?? [])
  if (badNeeds.length > 0) {
    throw invalid(`unknown need "${badNeeds[0]}". ${NEEDS_HELP}`, 'INVALID_ORDER')
  }
  if (input.ledger !== undefined && !isLedgerPath(input.ledger)) {
    throw invalid(
      'ledger must be a plain file path in the library, such as /library/trackers/videos.md',
      'INVALID_ORDER',
    )
  }
  const id = deps.ids.next()
  const out = await editFile(deps, agent.id, (current) => {
    const parsed = parseChecklist(current, now)
    const ledger =
      input.ledger ??
      (kind === 'ledger'
        ? defaultLedgerPath(
            text,
            id,
            parsed.orders.flatMap((o) => (o.ledger === undefined ? [] : [o.ledger])),
          )
        : undefined)
    const order: StandingOrder = {
      id,
      text,
      by: input.by,
      name: input.name,
      role: input.role,
      ...(input.uid === undefined ? {} : { uid: input.uid }),
      report: input.report,
      mention: input.mention,
      at: now,
      active: true,
      kind,
      ...(input.due === undefined ? {} : { due: input.due }),
      ...(input.expires === undefined ? {} : { expires: input.expires }),
      refs: cleanRefs(input.refs ?? []),
      needs,
      ...(ledger === undefined ? {} : { ledger }),
    }
    const existing = parsed.active.find((o) => sameOrder(o, order))
    if (existing !== undefined) return { result: { order: existing, created: false } }
    return { text: withOrder(current, order), result: { order, created: true } }
  })
  if (out.created) {
    // an order makes the heartbeat run: its routine is on even if it was never created
    syncHeartbeatRoutine(deps, agent.id)
    if (out.order.kind === 'deadline') syncOrderWakes(deps, agent, [out.order], now)
    changed(deps, agent.id, 'orders')
  }
  return out
}

/** Remove an order (its line goes, the rest of the file stays). undefined: there is no such order. */
export async function removeOrder(
  deps: Deps,
  agentId: string,
  id: string,
): Promise<StandingOrder | undefined> {
  const agent = getAgent(deps, agentId)
  const removed = await editFile(deps, agent.id, (current) => {
    const found = parseChecklist(current).orders.find((o) => o.id === id)
    if (found === undefined || current === undefined) return { result: undefined }
    return { text: withoutOrder(current, id), result: found }
  })
  if (removed !== undefined) {
    dropOrderWake(deps, agent.id, id)
    changed(deps, agent.id, 'orders')
  }
  return removed
}

/**
 * Pause an order with a reason (`active:no` and a `why` in its tail; the line stays, the beat stops
 * acting on it and its wake goes). undefined: no such order, or it was not live (nothing changed).
 */
export async function pauseOrder(
  deps: Deps,
  agentId: string,
  id: string,
  reason: string,
): Promise<StandingOrder | undefined> {
  const agent = getAgent(deps, agentId)
  const now = deps.clock.now()
  const paused = await editFile(deps, agent.id, (current) => {
    const found = parseChecklist(current).orders.find((o) => o.id === id)
    if (found === undefined || current === undefined || orderState(found, now) !== 'active') {
      return { result: undefined }
    }
    const next: StandingOrder = {
      ...found,
      active: false,
      pausedReason: reason.replace(/\s+/g, ' ').trim().slice(0, 200),
    }
    return { text: withOrderChanged(current, id, () => next), result: next }
  })
  if (paused !== undefined) {
    dropOrderWake(deps, agent.id, id)
    changed(deps, agent.id, 'orders')
  }
  return paused
}

/**
 * Finish a deadline order with its outcome (the order stays in the file as `done`, collapsed in the
 * Heartbeat tab; its wake goes). undefined: no such order; the order unchanged if it was done.
 */
export async function completeOrder(
  deps: Deps,
  agentId: string,
  id: string,
  outcome: string,
): Promise<StandingOrder | undefined> {
  const agent = getAgent(deps, agentId)
  const now = deps.clock.now()
  const clean = outcome.replace(/\s+/g, ' ').trim().slice(0, 600)
  const done = await editFile(deps, agent.id, (current) => {
    const found = parseChecklist(current).orders.find((o) => o.id === id)
    if (found === undefined || current === undefined) return { result: undefined }
    if (found.done !== undefined) return { result: found }
    const next: StandingOrder = { ...found, done: { at: now, outcome: clean || 'done' } }
    return { text: withOrderChanged(current, id, () => next), result: next }
  })
  if (done !== undefined) {
    dropOrderWake(deps, agent.id, id)
    changed(deps, agent.id, 'orders')
  }
  return done
}

/** The chats the agent may report to (named other chats are checked against this). */
export const chatDestinations = (deps: Deps, agentId: string) =>
  deps.heartbeat.channels?.destinations(agentId) ?? []
