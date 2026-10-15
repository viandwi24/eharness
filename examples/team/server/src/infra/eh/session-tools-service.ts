/**
 * "Tools in this session": what the agent is configured with (the last activation) against what
 * its newest model call carried, and the forced reload. Reads stored data only: no model call and
 * no session is opened.
 */
import type {
  ChatToolsPort,
  ConnectorsPort,
  ModelCallStore,
  ReloadView,
  SessionToolsPort,
} from '../../app/ports.ts'
import { conflict, notFound } from '../../domain/errors.ts'
import {
  type ConfiguredGroup,
  compareTools,
  isTruncatedBody,
  type LastCallTools,
  toolsOfRequestBody,
} from '../../domain/session-tools.ts'
import type { AgentFactory, ReloadResult } from './agent-factory.ts'
import type { ConnectorsRuntime } from './connectors.ts'
import type { SessionResolver } from './session-resolve.ts'

export function createSessionToolsService(deps: {
  factory: AgentFactory
  connectors: ConnectorsRuntime & Pick<ConnectorsPort, 'agentConnectors'>
  resolve: SessionResolver
  modelCalls: ModelCallStore
  chatTools: ChatToolsPort
}): SessionToolsPort {
  const need = (sessionId: string) => {
    const found = deps.resolve(sessionId)
    if (found === undefined) throw notFound('session', sessionId)
    return found
  }

  const view = (r: ReloadResult): ReloadView => ({
    sessions: r.sessions,
    closed: r.closed,
    pending: r.pending > 0,
    tools: r.tools,
  })

  /** The tool names of the newest model call of the session, or why they are not known. */
  const lastCallOf = (sessionId: string): { call: LastCallTools | null; note: string | null } => {
    const [newest] = deps.modelCalls.list({ sessionId, kind: 'step', limit: 1 }).items
    if (newest === undefined) {
      return { call: null, note: 'No model call of this session is in the log yet.' }
    }
    const detail = deps.modelCalls.get(newest.id, {})
    if (detail === undefined) return { call: null, note: 'The model call was pruned from the log.' }
    if (isTruncatedBody(detail.requestBody)) {
      return {
        call: null,
        note: 'The request of the last model call was too large to keep in full, so its tools cannot be read.',
      }
    }
    const tools = toolsOfRequestBody(detail.requestBody)
    if (tools === undefined) {
      return { call: null, note: 'The last model call has no stored request with a tools list.' }
    }
    return { call: { id: detail.id, at: detail.startedAt, ...tools }, note: null }
  }

  return {
    async tools(sessionId) {
      const { def, id } = need(sessionId)
      if (deps.connectors.activated(def.id) === undefined) await deps.connectors.prepare([def])
      const out = deps.connectors.activated(def.id)
      const views = await deps.connectors.agentConnectors(def)
      const byConnection = new Map(views.map((v) => [v.connectionId, v]))
      const chatOff = new Set(
        (await deps.chatTools.get(def, id)).connectors
          .filter((c) => !c.on)
          .map((c) => c.connectionId),
      )
      const groups = new Map<string, ConfiguredGroup>()
      const rules = out?.rules
      for (const [name, origin] of Object.entries(out?.toolNameMap ?? {})) {
        const connectionId = origin.connectionIds[0] ?? null
        const key = connectionId ?? `connector:${origin.connectorId}`
        let group = groups.get(key)
        if (group === undefined) {
          const v = connectionId === null ? undefined : byConnection.get(connectionId)
          group = {
            connectionId,
            connectorId: origin.connectorId,
            name: v?.name ?? origin.connectorId,
            label: v?.label ?? origin.connectorId,
            tools: [],
          }
          groups.set(key, group)
        }
        const ownedByOff =
          origin.connectionIds.length > 0 && origin.connectionIds.every((c) => chatOff.has(c))
        group.tools.push({
          name,
          mode: rules?.deny.includes(name)
            ? 'off'
            : rules?.ask.includes(name) || rules?.pinnedAsk.includes(name)
              ? 'ask'
              : 'allow',
          chatOff: ownedByOff,
        })
      }
      const configured = [...groups.values()]
      const { call, note } = lastCallOf(id)
      const { missing, extra } =
        call === null ? { missing: [], extra: [] } : compareTools(configured, call)
      return {
        sessionId: id,
        agentId: def.id,
        configured,
        lastCall: call,
        lastCallNote: note,
        missing,
        extra,
      }
    },
    async reload(sessionId) {
      const { def, id } = need(sessionId)
      if (def.archivedAt !== null)
        throw conflict(`agent is archived: ${def.slug}`, 'AGENT_ARCHIVED')
      return view(await deps.factory.reloadSession(def, id))
    },
    async reloadAgent(agent) {
      if (agent.archivedAt !== null) {
        throw conflict(`agent is archived: ${agent.slug}`, 'AGENT_ARCHIVED')
      }
      return view(await deps.factory.reloadAgent(agent))
    },
  }
}
