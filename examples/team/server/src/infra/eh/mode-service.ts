/**
 * Permission modes of DM chats on the agent factory (`domain/modes.ts`): reads the effective mode
 * and the Auto counters, stores a person's pick in `session_modes`.
 */
import type { ModePort, ModeState } from '../../app/ports.ts'
import type { AgentDef } from '../../domain/agents.ts'
import { dmSessionId } from '../../domain/chat.ts'
import { agentModeChoice, allowedModes, teamModeOf } from '../../domain/modes.ts'
import type { SessionModeStore } from '../db/modes-repo.ts'
import type { AgentFactory } from './agent-factory.ts'

export function createModeService(
  factory: AgentFactory,
  deps: {
    store: SessionModeStore
    workspaceDefault: () => string
  },
): ModePort {
  const stateOf = (agent: AgentDef): ModeState => {
    const sessionId = dmSessionId(agent.id)
    const resolved = factory.modes.resolve(agent, sessionId)
    const { paused, consecutive, total } = factory.modes.autoState(sessionId)
    return {
      mode: resolved.mode,
      source: resolved.source,
      agentMode: agentModeChoice(agent.permissionMode),
      workspaceDefault: teamModeOf(deps.workspaceDefault()),
      available: allowedModes(resolved.ceiling, factory.modes.autoAvailable),
      autoAvailable: factory.modes.autoAvailable,
      auto: { paused, consecutive, total },
    }
  }
  return {
    get: stateOf,
    set(agent, mode, now) {
      const sessionId = dmSessionId(agent.id)
      deps.store.set(sessionId, mode, now)
      // picking Auto again resumes a paused classifier (spec 18 §12)
      if (mode === 'auto') factory.modes.resumeAuto(sessionId)
      return stateOf(agent)
    },
  }
}
