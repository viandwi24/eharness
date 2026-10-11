/** Event feed and sidebar markers. */
import type { TeamEvent } from '../domain/events.ts'
import { getAgent } from './agents.ts'
import type { Deps } from './ports.ts'

export function listEvents(
  deps: Deps,
  query: { after: number; limit: number },
): Promise<{ events: TeamEvent[]; lastSeq: number; resync?: true }> {
  return deps.feed.page(query)
}

export function markAgentRead(
  deps: Deps,
  idOrSlug: string,
): { agentId: string; lastReadSeq: number } {
  const agent = getAgent(deps, idOrSlug)
  return { agentId: agent.id, lastReadSeq: deps.tasks.markRead(agent.id) }
}
