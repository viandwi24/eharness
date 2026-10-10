/**
 * Per-chat connector switches (the composer tools menu): which connectors of the agent this chat
 * offers to the model. The list is the agent's own enabled connections; the picks are stored per
 * session (`chat_tool_overrides`) and applied by the `chatTools` plugin at every step.
 */
import type { ChatToolsPort } from '../../app/ports.ts'
import type { AgentDef } from '../../domain/agents.ts'
import { dmSessionId } from '../../domain/chat.ts'
import { invalid } from '../../domain/errors.ts'
import type { ChatToolsStore } from '../db/chat-tools-repo.ts'

type AgentConnectors = (agent: AgentDef) => Promise<
  Array<{
    connectionId: string
    connectorId: string
    name: string
    icon?: string
    label: string
    accountLabel?: string
    source: 'builtin' | 'curated' | 'custom'
    status: string
    enabled: boolean
    capabilities: Array<{ toolModes: Array<{ mode: string }> }>
  }>
>

export function createChatToolsService(deps: {
  store: ChatToolsStore
  agentConnectors: AgentConnectors
}): ChatToolsPort {
  /** Connections a person can switch: not the always-on built-ins, except web search. */
  const switchable = async (agent: AgentDef) =>
    (await deps.agentConnectors(agent)).filter(
      (c) =>
        c.enabled && c.status !== 'disabled' && (c.source !== 'builtin' || c.connectorId === 'web'),
    )
  const get = async (agent: AgentDef) => {
    const off = new Set(deps.store.off(dmSessionId(agent.id)))
    const rows = await switchable(agent)
    const connectors = rows.map((c) => ({
      connectionId: c.connectionId,
      connectorId: c.connectorId,
      name: c.name,
      ...(c.icon === undefined ? {} : { icon: c.icon }),
      label: c.label,
      ...(c.accountLabel === undefined ? {} : { accountLabel: c.accountLabel }),
      source: c.source,
      status: c.status as 'connected' | 'needs-auth' | 'error',
      on: !off.has(c.connectionId),
      tools: c.capabilities.reduce(
        (n, cap) => n + cap.toolModes.filter((t) => t.mode !== 'off').length,
        0,
      ),
    }))
    return { connectors, offCount: connectors.filter((c) => !c.on).length }
  }
  return {
    get,
    async set(agent, off, now) {
      const known = new Set((await switchable(agent)).map((c) => c.connectionId))
      const unknown = off.filter((id) => !known.has(id))
      if (unknown.length > 0) {
        throw invalid(`not a connector of this agent: ${unknown.join(', ')}`, 'UNKNOWN_CONNECTION')
      }
      deps.store.setOff(dmSessionId(agent.id), off, now)
      return get(agent)
    },
  }
}
