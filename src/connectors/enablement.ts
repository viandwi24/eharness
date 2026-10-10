/**
 * Enablement and mode resolution: which connections an agent uses and how freely.
 *
 * Mode precedence per tool: the agent's tool override, the agent's capability mode, the
 * connection's default, the capability's default. The result is then combined with the app's own
 * permission rules by taking the most restrictive (`off` over `ask` over `allow`).
 *
 * @see docs/specs/24-connectors.md#3-enablement-and-precedence
 */
import type {
  CapabilityDef,
  CapabilityMode,
  ConnectionEnablement,
  ConnectionRecord,
  ResolvedCapability,
} from './types.ts'

const RANK: Record<CapabilityMode, number> = { allow: 0, ask: 1, off: 2 }
const isMode = (value: unknown): value is CapabilityMode =>
  value === 'allow' || value === 'ask' || value === 'off'

/** The most restrictive of several modes (`off` over `ask` over `allow`); `allow` for none. */
export function mostRestrictive(...modes: Array<CapabilityMode | undefined>): CapabilityMode {
  let out: CapabilityMode = 'allow'
  for (const mode of modes) if (mode !== undefined && RANK[mode] > RANK[out]) out = mode
  return out
}

/** Who asks: the agent and, for user-scoped connections, the user. */
export interface EnablementSubject {
  agentId: string
  userId?: string
}

/**
 * Whether an agent uses a connection. A connection that is disabled does not apply. `agent`
 * scope applies to its own agent only (an `off` entry still switches it off); `workspace` and
 * `user` scope follow `defaultEnabled` unless the agent says `on` or `off` (a `user` connection
 * only applies to its own user).
 */
export function isConnectionEnabled(
  record: ConnectionRecord,
  enablement: ConnectionEnablement | undefined,
  subject: EnablementSubject,
): boolean {
  if (!record.enabled) return false
  const state = enablement?.enabled ?? 'inherit'
  if (state === 'off') return false
  if (record.scope === 'agent') return record.scopeId === subject.agentId
  if (record.scope === 'user' && record.scopeId !== subject.userId) return false
  return state === 'on' ? true : record.defaultEnabled
}

/** Modes of a connection's capabilities for one agent. */
export interface ResolvedModes {
  /** Mode of every capability (`off` ones included). */
  modes: Record<string, CapabilityMode>
  /** Mode of every tool (per-tool overrides applied). */
  toolModes: Record<string, CapabilityMode>
  /** The capabilities that are not `off`, with their modes. */
  capabilities: ResolvedCapability[]
  /** The tool names that are not `off`. */
  tools: string[]
}

/** Resolve capability and tool modes (agent override, connection default, capability default). */
export function resolveModes(
  capabilities: readonly CapabilityDef[],
  record: Pick<ConnectionRecord, 'defaultModes'>,
  enablement: ConnectionEnablement | undefined,
): ResolvedModes {
  const modes: Record<string, CapabilityMode> = {}
  const toolModes: Record<string, CapabilityMode> = {}
  const resolved: ResolvedCapability[] = []
  const tools: string[] = []
  for (const cap of capabilities) {
    const agent = enablement?.capabilities?.[cap.id]
    const connection = record.defaultModes?.[cap.id]
    const mode = isMode(agent) ? agent : isMode(connection) ? connection : cap.defaultMode
    modes[cap.id] = mode
    if (mode !== 'off') resolved.push({ ...cap, tools: [...cap.tools], mode })
    for (const tool of cap.tools) {
      const override = enablement?.tools?.[tool]
      const toolMode = isMode(override) ? override : mode
      toolModes[tool] = toolMode
      if (toolMode !== 'off') tools.push(tool)
    }
  }
  return { modes, toolModes, capabilities: resolved, tools }
}
