/**
 * Standing orders use cases (docs/plans/P51-proactive-and-health.md). The orders are lines of the
 * agent's own memory file `HEARTBEAT.md` (`domain/standing-orders.ts`): the file is the source of
 * truth, so the owner reads and edits them as text, and the agent sees them in its memory. These
 * functions read the file, change one line and write it back (compare-and-set, serialised per
 * agent in this process).
 */
import { invalid } from '../domain/errors.ts'
import { checklistPath } from '../domain/heartbeat.ts'
import {
  cleanOrderText,
  type OrderDestination,
  parseChecklist,
  type StandingOrder,
  sameOrder,
  withOrder,
  withoutOrder,
} from '../domain/standing-orders.ts'
import { getAgent } from './agents.ts'
import { syncHeartbeatRoutine } from './heartbeat.ts'
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
  const text = cleanOrderText(input.text)
  if (text === '') throw invalid('a standing order needs the instruction text', 'INVALID_ORDER')
  const order: StandingOrder = {
    id: deps.ids.next(),
    text,
    by: input.by,
    name: input.name,
    role: input.role,
    ...(input.uid === undefined ? {} : { uid: input.uid }),
    report: input.report,
    mention: input.mention,
    at: deps.clock.now(),
    active: true,
  }
  const out = await editFile(deps, agent.id, (current) => {
    const existing = parseChecklist(current).active.find((o) => sameOrder(o, order))
    if (existing !== undefined) return { result: { order: existing, created: false } }
    return { text: withOrder(current, order), result: { order, created: true } }
  })
  if (out.created) {
    // an order makes the heartbeat run: its routine is on even if it was never created
    syncHeartbeatRoutine(deps, agent.id)
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
  if (removed !== undefined) changed(deps, agent.id, 'orders')
  return removed
}

/** The chats the agent may report to (named other chats are checked against this). */
export const chatDestinations = (deps: Deps, agentId: string) =>
  deps.heartbeat.channels?.destinations(agentId) ?? []
