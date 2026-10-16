/**
 * "Tools in this session": what the agent is configured with (the last activation) against what
 * its newest model call carried, and the forced reload. Reads stored data only: no model call and
 * no session is opened.
 */
import type {
  AgentRepo,
  ChatToolsPort,
  ConnectionDrift,
  ConnectorsPort,
  ModelCallStore,
  ReloadView,
  SessionToolsPort,
} from '../../app/ports.ts'
import { conflict, notFound } from '../../domain/errors.ts'
import type { DriftFact } from '../../domain/health.ts'
import {
  blockedTools,
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
  agents: Pick<AgentRepo, 'list'>
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
    pinsCleared: r.pinsCleared,
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
      const blocked = blockedTools(
        deps.factory
          .drifts()
          .filter((d) => d.sessionId === id)
          .map((d) => ({ server: d.server, tools: d.tools, at: d.at })),
        out?.connections ?? [],
      )
      const { missing, extra } =
        call === null
          ? { missing: [], extra: [] }
          : compareTools(configured, call, new Set(blocked.map((b) => b.name)))
      return {
        sessionId: id,
        agentId: def.id,
        configured,
        lastCall: call,
        lastCallNote: note,
        missing,
        extra,
        blocked,
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
      const stored = deps.factory
        .pinnedSessions()
        .filter((p) => deps.resolve(p.sessionId)?.def.id === agent.id)
        .map((p) => p.sessionId)
      return view(await deps.factory.reloadAgent(agent, { stored }))
    },
    drifts() {
      const out: DriftFact[] = []
      for (const d of deps.factory.drifts()) {
        const found = deps.resolve(d.sessionId)
        if (found === undefined) continue
        const connections = deps.connectors.activated(found.def.id)?.connections ?? []
        out.push({
          sessionId: d.sessionId,
          agentId: found.def.id,
          link: null,
          at: d.at,
          connection: d.server,
          tools: blockedTools([d], connections).map((b) => b.name),
        })
      }
      return out
    },
    connectionDrift(connectionId): ConnectionDrift | null {
      const tools = new Set<string>()
      const sessions = new Set<string>()
      const agentIds = new Set<string>()
      for (const d of deps.factory.drifts()) {
        const found = deps.resolve(d.sessionId)
        const connections =
          found === undefined ? [] : (deps.connectors.activated(found.def.id)?.connections ?? [])
        if (
          found === undefined ||
          !connections.some((c) => c.connectionId === connectionId && c.slug === d.server)
        )
          continue
        for (const t of d.tools) tools.add(t)
        sessions.add(d.sessionId)
        agentIds.add(found.def.id)
      }
      return sessions.size === 0
        ? null
        : { tools: tools.size, sessions: sessions.size, agentIds: [...agentIds] }
    },
    async acceptConnection(connectionId) {
      const total = {
        sessions: 0,
        closed: 0,
        pending: false,
        tools: [] as string[],
        pinsCleared: 0,
        agents: 0,
      }
      const pinned = deps.factory.pinnedSessions()
      for (const def of deps.agents.list({ includeArchived: false })) {
        if (deps.connectors.activated(def.id) === undefined) {
          await deps.connectors.prepare([def]).catch(() => undefined)
        }
        const slug = deps.connectors
          .activated(def.id)
          ?.connections.find((c) => c.connectionId === connectionId)?.slug
        if (slug === undefined) continue
        const stored = pinned
          .filter((p) => p.servers.includes(slug) && deps.resolve(p.sessionId)?.def.id === def.id)
          .map((p) => p.sessionId)
        const r = await deps.factory.reloadAgent(def, { stored, servers: new Set([slug]) })
        total.agents++
        total.sessions += r.sessions
        total.closed += r.closed
        total.pending ||= r.pending > 0
        total.pinsCleared += r.pinsCleared
      }
      return total
    },
  }
}
