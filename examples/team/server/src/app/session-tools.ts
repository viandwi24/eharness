/** "Tools in this session" use cases (the chat's side panel and the agent's Connectors tab). */
import { getAgent } from './agents.ts'
import type { Deps, ReloadView, SessionToolsView } from './ports.ts'

export const sessionTools = (deps: Deps, sessionId: string): Promise<SessionToolsView> =>
  deps.sessionTools.tools(sessionId)

export const reloadSessionTools = (deps: Deps, sessionId: string): Promise<ReloadView> =>
  deps.sessionTools.reload(sessionId)

export const reloadAgentTools = (deps: Deps, agentId: string): Promise<ReloadView> =>
  deps.sessionTools.reloadAgent(getAgent(deps, agentId))
