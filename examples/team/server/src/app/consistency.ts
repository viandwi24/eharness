/**
 * Consistency scan: gathers the facts the detectors of `domain/consistency.ts` compare (programs,
 * standing orders, routines, decisions, connections, memory files) and runs them. No model call; a
 * source that fails to read is left out, so one broken store never hides the rest.
 *
 * The memory scan is capped (files, characters per file, characters in total): the job runs every
 * 10 minutes and must stay cheap.
 */
import type { AgentDef } from '../domain/agents.ts'
import {
  type AgentConnectionFact,
  type AgentToolsFact,
  CONSISTENCY,
  type ConnectionFact,
  type ConsistencyFinding,
  detectConsistency,
  type MemoryFact,
} from '../domain/consistency.ts'
import { CHECKLIST_FILE } from '../domain/heartbeat.ts'
import { agentMemory, WORKSPACE_MEMORY } from '../domain/memory.ts'
import { parseProgramSession } from '../domain/programs.ts'
import type { StandingOrder } from '../domain/standing-orders.ts'
import { parseChatSession } from '../domain/threads.ts'
import type { Deps } from './ports.ts'
import { listOrders } from './standing-orders.ts'

export type { ConsistencyFinding, ConsistencyKind } from '../domain/consistency.ts'

const PROGRAM_PROBLEMS = new Set(['tool-unavailable', 'tool-off', 'channel-not-bound'])

async function safe<T>(label: string, fallback: T, run: () => Promise<T> | T): Promise<T> {
  try {
    return await run()
  } catch (error) {
    console.warn(`team: consistency: ${label} unreadable: ${String(error)}`)
    return fallback
  }
}

/** `phone` of `phone_screenshot`, when every tool of the connection shares it (two tools at least). */
function prefixOf(names: readonly string[]): string | undefined {
  if (names.length < 2) return undefined
  const first = (n: string): string => n.split('_')[0] ?? ''
  const p = first(names[0] as string)
  return p !== '' && names.every((n) => n.includes('_') && first(n) === p) ? p : undefined
}

async function memoryOf(deps: Deps, agentId: string | null): Promise<MemoryFact[]> {
  const root = agentId === null ? WORKSPACE_MEMORY : agentMemory(agentId)
  const prefix = `${root}/`
  const metas = deps.library
    .list({ prefix, limit: CONSISTENCY.memoryMaxFiles * 2 })
    .filter((m) => m.path.slice(prefix.length) !== CHECKLIST_FILE)
    .slice(0, CONSISTENCY.memoryMaxFiles)
  const out: MemoryFact[] = []
  let total = 0
  for (const m of metas) {
    if (m.size > CONSISTENCY.memoryMaxChars * 4 || total >= CONSISTENCY.memoryMaxTotalChars)
      continue
    const file = await deps.library.read(m.path)
    if (file?.text == null) continue
    const text = file.text.slice(0, CONSISTENCY.memoryMaxChars)
    total += text.length
    out.push({
      agentId,
      path: m.path.slice(prefix.length),
      text,
      updatedAt: m.updatedAt,
    })
  }
  return out
}

/**
 * The contradictions and stale state of the workspace now. `agentId` narrows it to one agent (and
 * leaves workspace memory out).
 */
export async function consistencyFindings(
  deps: Deps,
  opts: { agentId?: string; now?: number } = {},
): Promise<ConsistencyFinding[]> {
  const now = opts.now ?? deps.clock.now()
  const agents: AgentDef[] = deps.agents
    .list()
    .filter((a) => opts.agentId === undefined || a.id === opts.agentId)
  const agentIds = new Set(agents.map((a) => a.id))
  const programs = deps.programs.list({}).filter((p) => agentIds.has(p.agentId))

  const connections: ConnectionFact[] = []
  const agentConnections = new Map<string, AgentConnectionFact[]>()
  const tools = new Map<string, AgentToolsFact>()
  const prefixByConnection = new Map<string, string>()
  const views = new Map<string, Awaited<ReturnType<Deps['connectors']['agentConnectors']>>>()
  for (const agent of agents) {
    views.set(
      agent.id,
      await safe('agent connectors', [], () => deps.connectors.agentConnectors(agent)),
    )
  }
  for (const [agentId, list] of views) {
    const available: string[] = []
    const prefixes = new Set<string>()
    const conns: AgentConnectionFact[] = []
    for (const v of list) {
      const names = v.capabilities
        .filter((c) => c.mode !== 'off')
        .flatMap((c) => c.agentTools ?? [])
      const prefix = prefixOf(v.capabilities.flatMap((c) => c.agentTools ?? []))
      if (prefix !== undefined) prefixByConnection.set(v.connectionId, prefix)
      if (v.enabled) {
        available.push(...names)
        if (prefix !== undefined) prefixes.add(prefix)
        conns.push({
          connectionId: v.connectionId,
          label: v.label,
          status: v.status,
          statusMessage: v.statusMessage,
          explicit: v.state === 'on',
        })
      }
    }
    agentConnections.set(agentId, conns)
    // tool names are unknown until the agent was prepared: then no tool claim is judged
    if (available.length > 0) tools.set(agentId, { available, prefixes: [...prefixes] })
  }
  for (const c of await safe('connections', [], () => deps.connectors.connections())) {
    const prefix = prefixByConnection.get(c.id)
    connections.push({
      id: c.id,
      connectorId: c.definitionId,
      label: c.label,
      status: c.status,
      statusMessage: c.statusMessage,
      names: prefix === undefined ? [] : [prefix, `${prefix}_`],
    })
  }

  const orders: Array<{ agentId: string; order: StandingOrder }> = []
  for (const a of agents) {
    for (const order of await safe('orders', [], () => listOrders(deps, a.id))) {
      orders.push({ agentId: a.id, order })
    }
  }
  const routines = agents.flatMap((a) => deps.routines.list({ agentId: a.id }))
  const decisions = deps.decisions.list({ limit: 1000 })

  const knownIds = new Set<string>()
  const know = (id: string): void => void knownIds.add(id.toLowerCase())
  for (const a of deps.agents.list({ includeArchived: true })) know(a.id)
  for (const p of deps.programs.list({})) {
    know(p.id)
    for (const t of deps.tasks.ofProgram(p.id, 50)) know(t.id)
  }
  for (const d of decisions) know(d.id)
  for (const c of connections) know(c.id)
  for (const o of orders) know(o.order.id)
  for (const r of routines) know(r.id)

  const programToolProblems = new Map<string, string[]>()
  for (const p of programs) {
    const problems: string[] = []
    await safe('program tools', undefined, async () => {
      const warnings = await deps.programRunner.check({
        agentId: p.agentId,
        authority: p.authority,
        budget: p.budget,
      })
      for (const w of warnings) if (PROGRAM_PROBLEMS.has(w.code)) problems.push(w.message)
      for (const e of deps.programRunner.inspect(p.agentId, p.authority)?.errors ?? []) {
        problems.push(e)
      }
    })
    if (problems.length > 0) programToolProblems.set(p.id, problems)
  }

  const memory: MemoryFact[] = []
  for (const a of agents) memory.push(...(await safe('memory', [], () => memoryOf(deps, a.id))))
  if (opts.agentId === undefined) {
    memory.push(...(await safe('workspace memory', [], () => memoryOf(deps, null))))
  }

  const sessionExists = (sessionId: string): boolean => {
    const run = parseProgramSession(sessionId)
    if (run !== undefined) return deps.programs.get(run.programId) !== undefined
    if (sessionId.startsWith('task:')) return deps.tasks.getBySession(sessionId) !== undefined
    const chat = parseChatSession(sessionId)
    if (chat !== undefined) return deps.agents.get(chat.agentId) !== undefined
    // other kinds of session (routines, channels): not judged
    return true
  }

  return detectConsistency({
    now,
    agents: agents.map((a) => ({ id: a.id, name: a.name, slug: a.slug })),
    programs,
    programToolProblems,
    orders,
    routines,
    decisions: decisions
      .filter((d) => opts.agentId === undefined || d.agentId === opts.agentId)
      .map((d) => ({
        id: d.id,
        kind: d.kind,
        status: d.status,
        title: d.title,
        agentId: d.agentId,
        sessionId: d.sessionId,
        programId: d.programId,
        createdAt: d.createdAt,
      })),
    sessionExists,
    connections,
    agentConnections,
    tools,
    knownIds,
    memory,
  })
}
