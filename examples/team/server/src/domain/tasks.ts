/** Tasks and the board: status is derived from session facts (plan §6.4). Pure. */
export const TASK_STATUSES = ['needs_action', 'running', 'done', 'failed', 'stopped'] as const
export type TaskStatus = (typeof TASK_STATUSES)[number]
export type TaskOrigin = 'user' | 'lead' | 'routine'
export type PendingKind = 'approval' | 'question'

export interface Task {
  id: string
  /** Owner: the agent that runs the task session. */
  agentId: string
  sessionId: string
  parentSessionId: string | null
  origin: TaskOrigin
  title: string
  status: TaskStatus
  pendingKind: PendingKind | null
  startedAt: number
  endedAt: number | null
  summary: string | null
  lastActivityAt: number
  costUsd: number
  tokens: number
}

export const isTerminal = (status: TaskStatus): boolean =>
  status === 'done' || status === 'failed' || status === 'stopped'

/** What a session reports about itself. */
export interface SessionFacts {
  pendingApprovals: number
  pendingQuestions: number
  /** A turn runs and its heartbeat is fresh. */
  activeTurn: boolean
  /** A turn is recorded but its heartbeat is stale: the process died. */
  staleTurn: boolean
  lastStop: string | null
}

/** Status of a task session from the stop reason of the last turn (turn end hook). */
export function statusFromStop(stop: string): TaskStatus {
  if (stop === 'tool-pending') return 'needs_action'
  if (stop === 'aborted') return 'stopped'
  if (stop === 'error' || stop === 'timeout') return 'failed'
  return 'done'
}

export function deriveTaskStatus(facts: SessionFacts): {
  status: TaskStatus
  pendingKind: PendingKind | null
} {
  if (facts.pendingApprovals + facts.pendingQuestions > 0) {
    return {
      status: 'needs_action',
      pendingKind: facts.pendingApprovals > 0 ? 'approval' : 'question',
    }
  }
  if (facts.activeTurn) return { status: 'running', pendingKind: null }
  // a stale heartbeat means the process holding the turn is gone
  if (facts.staleTurn) return { status: 'failed', pendingKind: null }
  if (facts.lastStop === null) return { status: 'running', pendingKind: null }
  // `tool-pending` without pending approvals: waiting on an external wait (a child's own park)
  if (facts.lastStop === 'tool-pending') return { status: 'running', pendingKind: null }
  return { status: statusFromStop(facts.lastStop), pendingKind: null }
}

/** One-line title from the first text of a prompt. */
export function titleFromText(text: string, max = 80): string {
  const line =
    text
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l !== '') ?? ''
  const clean = line.replace(/\s+/g, ' ')
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean === '' ? 'Task' : clean
}

/** Short preview of a message body for the sidebar and the feed. */
export function previewOf(text: string, max = 140): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean
}
