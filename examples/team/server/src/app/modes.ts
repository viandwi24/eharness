/** Permission mode use cases of an agent's DM chat (`domain/modes.ts`). */

import { dmSessionId } from '../domain/chat.ts'
import { conflict } from '../domain/errors.ts'
import type { TeamMode } from '../domain/modes.ts'
import { getAgent } from './agents.ts'
import type { Deps, ModeState } from './ports.ts'

export function getMode(deps: Deps, idOrSlug: string): ModeState {
  return deps.modes.get(getAgent(deps, idOrSlug))
}

/**
 * Pick the mode of the agent's DM chat. It takes effect at the next tool call (a running turn
 * included). A mode the agent's ceiling forbids, or Auto without a classifier, is a 409.
 */
export function setMode(deps: Deps, idOrSlug: string, mode: TeamMode): ModeState {
  const agent = getAgent(deps, idOrSlug)
  if (agent.archivedAt !== null) {
    throw conflict(`agent is archived: ${agent.slug}`, 'AGENT_ARCHIVED')
  }
  const current = deps.modes.get(agent)
  if (!current.available.includes(mode)) {
    const why =
      mode === 'auto' && !current.autoAvailable
        ? 'Auto mode needs a classifier model, which this server does not have'
        : `this agent's own mode (${current.agentMode}) does not allow ${mode}`
    throw conflict(`mode ${mode} is not available: ${why}`, 'MODE_NOT_ALLOWED')
  }
  const next = deps.modes.set(agent, mode, deps.clock.now())
  deps.events.append({
    type: 'mode-changed',
    agentId: agent.id,
    sessionId: dmSessionId(agent.id),
    payload: { mode: next.mode, autoPaused: next.auto.paused },
  })
  return next
}
