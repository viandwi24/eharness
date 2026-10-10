/** Event feed and sidebar markers. */
import type { TeamEvent } from '../domain/events.ts'
import { getAgent } from './agents.ts'
import type { Deps } from './ports.ts'

export function listEvents(
  deps: Deps,
  query: { after: number; limit: number },
): { events: TeamEvent[]; lastSeq: number; resync?: true } {
  const events = deps.tasks.events(query.after, query.limit)
  const prunedThrough = deps.tasks.prunedThrough()
  // a cursor below the retention mark may have missed events: tell the client to refetch
  const resync = query.after > 0 && query.after < prunedThrough
  return {
    events,
    lastSeq: events.at(-1)?.seq ?? Math.max(query.after, deps.tasks.lastSeq()),
    ...(resync ? { resync: true as const } : {}),
  }
}

export function markAgentRead(
  deps: Deps,
  idOrSlug: string,
): { agentId: string; lastReadSeq: number } {
  const agent = getAgent(deps, idOrSlug)
  return { agentId: agent.id, lastReadSeq: deps.tasks.markRead(agent.id) }
}
