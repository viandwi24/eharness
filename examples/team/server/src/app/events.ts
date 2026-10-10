/** Event feed and sidebar markers. */
import type { TeamEvent } from '../domain/events.ts'
import { getAgent } from './agents.ts'
import type { Deps } from './ports.ts'

export function listEvents(
  deps: Deps,
  query: { after: number; limit: number },
): { events: TeamEvent[]; lastSeq: number } {
  const events = deps.tasks.events(query.after, query.limit)
  return { events, lastSeq: events.at(-1)?.seq ?? Math.max(query.after, deps.tasks.lastSeq()) }
}

export function markAgentRead(
  deps: Deps,
  idOrSlug: string,
): { agentId: string; lastReadSeq: number } {
  const agent = getAgent(deps, idOrSlug)
  return { agentId: agent.id, lastReadSeq: deps.tasks.markRead(agent.id) }
}
