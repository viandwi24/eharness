/**
 * Workspace usage: what every agent spent, by where the work came from. One source of truth (D14 of
 * the e2e pass): the model call log, the same rows as the Logs page and the daily digest, so the
 * pages agree and every source is counted (heartbeat and test runs included). The log is kept for
 * `TEAM_LOG_RETENTION_DAYS` / `TEAM_LOG_MAX_ROWS`; `since` says how far back it reaches.
 */
import type { Deps } from './ports.ts'

export const USAGE_SOURCES = [
  'chat',
  'task',
  'delegated',
  'routine',
  'program',
  'heartbeat',
  'rehearsal',
  'other',
] as const
export type UsageSource = (typeof USAGE_SOURCES)[number]

export interface SourceUsage {
  source: UsageSource
  /** Chat and heartbeat: turns that called a model. The others: runs (sessions). */
  count: number
  /** Model calls (a turn or a run makes several; the Logs page counts these). */
  calls: number
  tokens: number
  costUsd: number
}

export interface UsageTotal {
  count: number
  calls: number
  tokens: number
  costUsd: number
}

export interface WorkspaceUsage {
  /** Start of the oldest call still in the log (the totals cover from then on); null = no calls. */
  since: number | null
  total: UsageTotal
  /** Every source, in a fixed order (zero rows included). */
  bySource: SourceUsage[]
  agents: Array<{
    id: string
    name: string
    color?: string | undefined
    bySource: SourceUsage[]
    total: UsageTotal
  }>
}

const empty = (): SourceUsage[] =>
  USAGE_SOURCES.map((source) => ({ source, count: 0, calls: 0, tokens: 0, costUsd: 0 }))

const sum = (rows: SourceUsage[]): UsageTotal => ({
  count: rows.reduce((n, r) => n + r.count, 0),
  calls: rows.reduce((n, r) => n + r.calls, 0),
  tokens: rows.reduce((n, r) => n + r.tokens, 0),
  costUsd: rows.reduce((n, r) => n + r.costUsd, 0),
})

export function workspaceUsage(deps: Deps): WorkspaceUsage {
  const agents = deps.agents.list({ includeArchived: true })
  const { since, rows } = deps.modelCalls.usage()
  const perAgent = new Map<string, SourceUsage[]>(agents.map((a) => [a.id, empty()]))
  const bySource = empty()
  for (const r of rows) {
    const index = USAGE_SOURCES.indexOf(r.source as UsageSource)
    const at = index < 0 ? USAGE_SOURCES.indexOf('other') : index
    const countsTurns = r.source === 'chat' || r.source === 'heartbeat'
    const add = (row: SourceUsage | undefined): void => {
      if (row === undefined) return
      row.count += countsTurns ? r.turns : r.sessions
      row.calls += r.calls
      row.tokens += r.tokens
      row.costUsd += r.costUsd
    }
    add(bySource[at])
    // a call of an agent that is not in the list (deleted) still counts in the totals
    if (r.agentId !== null) add(perAgent.get(r.agentId)?.[at])
  }
  return {
    since,
    total: sum(bySource),
    bySource,
    agents: agents.map((a) => {
      const rows = perAgent.get(a.id) ?? empty()
      return { id: a.id, name: a.name, color: a.color, bySource: rows, total: sum(rows) }
    }),
  }
}
