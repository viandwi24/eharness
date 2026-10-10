/** Tasks and the board: state is derived from session facts (plan §6.4). Pure. */
export const TASK_STATES = ['needs_action', 'running', 'done', 'failed', 'cancelled'] as const
export type TaskState = (typeof TASK_STATES)[number]
export type TaskOrigin = 'user' | 'lead' | 'routine'

export interface Task {
  id: string
  agentId: string
  sessionId: string
  parentSessionId: string | null
  origin: TaskOrigin
  title: string
  state: TaskState
  pendingKind: 'approval' | 'question' | null
  startedAt: number
  endedAt: number | null
  summary: string | null
}

/** What a session reports about itself. */
export interface SessionFacts {
  pendingApprovals: number
  pendingQuestions: number
  activeTurn: boolean
  lastStop: string | null
  aborted: boolean
}

export function deriveTaskState(facts: SessionFacts): {
  state: TaskState
  pendingKind: Task['pendingKind']
} {
  if (facts.pendingApprovals + facts.pendingQuestions > 0) {
    return {
      state: 'needs_action',
      pendingKind: facts.pendingApprovals > 0 ? 'approval' : 'question',
    }
  }
  if (facts.activeTurn) return { state: 'running', pendingKind: null }
  if (facts.aborted) return { state: 'cancelled', pendingKind: null }
  if (facts.lastStop === 'error') return { state: 'failed', pendingKind: null }
  return { state: 'done', pendingKind: null }
}
