/** Connector use cases (the HTTP routes call these; the port does the work). */
import type {
  AgentConnectors,
  ConnectionChoices,
  ConnectionPatchInput,
  FlowActInput,
  FlowStartInput,
} from '../domain/connectors.ts'
import { normalizeConnectors } from '../domain/connectors.ts'
import { invalid } from '../domain/errors.ts'
import { getAgent } from './agents.ts'
import type { Deps } from './ports.ts'

export const listCatalog = (deps: Deps) => deps.connectors.catalog()
export const listConnections = (
  deps: Deps,
  query?: { scope?: 'workspace' | 'agent'; scopeId?: string },
) => deps.connectors.connections(query)
export const startConnectFlow = (deps: Deps, input: FlowStartInput) => {
  const agent =
    input.scopeId === undefined ? undefined : (deps.agents.get(input.scopeId) ?? undefined)
  // the agent may be given by slug (as everywhere else in the API)
  const scopeId =
    input.scopeId === undefined
      ? undefined
      : (agent?.id ?? deps.agents.getBySlug(input.scopeId)?.id)
  return deps.connectors.startFlow({
    ...input,
    ...(input.scopeId === undefined ? {} : { scopeId: scopeId ?? input.scopeId }),
  })
}
export const getConnectFlow = (deps: Deps, id: string) => deps.connectors.getFlow(id)
export const actOnFlow = (deps: Deps, id: string, input: FlowActInput) =>
  deps.connectors.act(id, input)
export const oauthCallback = (
  deps: Deps,
  query: Parameters<Deps['connectors']['oauthCallback']>[0],
) => deps.connectors.oauthCallback(query)
export const updateConnection = (deps: Deps, id: string, patch: ConnectionPatchInput) =>
  deps.connectors.updateConnection(id, patch)
export const removeConnection = (deps: Deps, id: string) => deps.connectors.removeConnection(id)
export const testConnection = (deps: Deps, id: string) => deps.connectors.testConnection(id)

export async function getAgentConnectors(deps: Deps, agentId: string) {
  return deps.connectors.agentConnectors(getAgent(deps, agentId))
}

/** Replace the choices of the given connections; `null` goes back to inherit. */
export async function putAgentConnectors(
  deps: Deps,
  agentId: string,
  changes: Record<string, ConnectionChoices | null>,
) {
  const agent = getAgent(deps, agentId)
  const clean: Record<string, ConnectionChoices | null> = {}
  const keep: AgentConnectors = normalizeConnectors(
    Object.fromEntries(Object.entries(changes).filter(([, v]) => v !== null)),
  )
  for (const [id, v] of Object.entries(changes)) clean[id] = v === null ? null : (keep[id] ?? {})
  if (Object.keys(clean).length === 0) throw invalid('no connections given')
  return deps.connectors.setAgentConnectors(agent, clean)
}

export const setOAuthClient = (
  deps: Deps,
  definitionId: string,
  input: { clientId: string; clientSecret?: string },
) => deps.connectors.setOAuthClient(definitionId, input)
export const removeOAuthClient = (deps: Deps, definitionId: string) =>
  deps.connectors.removeOAuthClient(definitionId)
