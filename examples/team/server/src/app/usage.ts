/** Workspace usage: what every agent spent, by where the work came from (chats, tasks, routines, programs). */
import type { Deps } from './ports.ts'
import { ensureFirstThread } from './threads.ts'

export const USAGE_SOURCES = ['chat', 'task', 'delegated', 'routine', 'program'] as const
export type UsageSource = (typeof USAGE_SOURCES)[number]

export interface SourceUsage {
  source: UsageSource
  /** Chat: turns. Others: runs (tasks). */
  count: number
  tokens: number
  costUsd: number
}

export interface WorkspaceUsage {
  total: { count: number; tokens: number; costUsd: number }
  /** Every source, in a fixed order (zero rows included). */
  bySource: SourceUsage[]
  agents: Array<{
    id: string
    name: string
    color?: string | undefined
    bySource: SourceUsage[]
    total: { count: number; tokens: number; costUsd: number }
  }>
}

const SOURCE_OF_ORIGIN = {
  user: 'task',
  lead: 'delegated',
  routine: 'routine',
  program: 'program',
} as const

const empty = (): SourceUsage[] =>
  USAGE_SOURCES.map((source) => ({ source, count: 0, tokens: 0, costUsd: 0 }))

const sum = (rows: SourceUsage[]): { count: number; tokens: number; costUsd: number } => ({
  count: rows.reduce((n, r) => n + r.count, 0),
  tokens: rows.reduce((n, r) => n + r.tokens, 0),
  costUsd: rows.reduce((n, r) => n + r.costUsd, 0),
})

/**
 * Chat usage comes from the stats of every thread session of an agent; the rest from the task rows
 * (each task, routine run and program run is its own session with its cost and tokens).
 */
export async function workspaceUsage(deps: Deps): Promise<WorkspaceUsage> {
  const agents = deps.agents.list({ includeArchived: true })
  const tasks = deps.tasks.list({ limit: 1_000_000 })
  const perAgent = new Map<string, SourceUsage[]>()
  for (const agent of agents) {
    const rows = empty()
    ensureFirstThread(deps, agent)
    for (const thread of deps.threads.list(agent.id)) {
      try {
        const u = (await deps.chat.stats(agent, thread.sessionId)).usage
        const chat = rows[0] as SourceUsage
        chat.count += u.turns
        chat.tokens += u.totalTokens
        chat.costUsd += u.costUsd
      } catch {
        // a thread whose session cannot be read adds nothing
      }
    }
    perAgent.set(agent.id, rows)
  }
  for (const t of tasks) {
    const rows = perAgent.get(t.agentId)
    if (rows === undefined) continue
    const row = rows.find((r) => r.source === SOURCE_OF_ORIGIN[t.origin]) as SourceUsage
    row.count += 1
    row.tokens += t.tokens
    row.costUsd += t.costUsd
  }
  const bySource = empty()
  for (const rows of perAgent.values()) {
    rows.forEach((r, i) => {
      const b = bySource[i] as SourceUsage
      b.count += r.count
      b.tokens += r.tokens
      b.costUsd += r.costUsd
    })
  }
  return {
    total: sum(bySource),
    bySource,
    agents: agents.map((a) => {
      const rows = perAgent.get(a.id) ?? empty()
      return { id: a.id, name: a.name, color: a.color, bySource: rows, total: sum(rows) }
    }),
  }
}
