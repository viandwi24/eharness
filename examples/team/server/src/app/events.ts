/** Sidebar read markers (the feed itself is `eharness/http`'s `activity` routes). */
import { getAgent } from './agents.ts'
import type { Deps } from './ports.ts'

export function markAgentRead(
  deps: Deps,
  idOrSlug: string,
): { agentId: string; lastReadSeq: number } {
  const agent = getAgent(deps, idOrSlug)
  return { agentId: agent.id, lastReadSeq: deps.tasks.markRead(agent.id) }
}
