/** Tasks and the board: status is derived from session facts (plan §6.4). Pure. */
import type { DeliverableResult } from './deliverables.ts'
import type { ProgramAuthority } from './programs.ts'

export const TASK_STATUSES = [
  'queued',
  'needs_action',
  'running',
  'done',
  'failed',
  'stopped',
  'interrupted',
  'timed_out',
] as const
export type TaskStatus = (typeof TASK_STATUSES)[number]
export const TASK_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const
export type TaskPriority = (typeof TASK_PRIORITIES)[number]
export type TaskOrigin = 'user' | 'lead' | 'routine' | 'program'
export type PendingKind = 'approval' | 'question'

/** The structured report a program run ends with (`SendOptions.output`, stored on the task row). */
export interface TaskReport {
  status: 'done' | 'partial' | 'failed' | 'needs_decision'
  summary: string
  /** Library paths of what the run produced. */
  outputs: string[]
  notes?: string | undefined
}

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
  /** The structured final report of a program run (`domain/programs.ts`); null for other tasks. */
  report: TaskReport | null
  /** The deliverable checks of a program run (`domain/deliverables.ts`); null when it had none. */
  deliverables: DeliverableResult | null
  /**
   * The work queue (P40 D6). A task made through the queue (the client or an agent made it before
   * its session exists) has a `createdBy`; tasks that just happened (delegations, routine runs,
   * program runs) have none and never wait in Review.
   */
  brief: string | null
  /** Library paths the task starts from. */
  inputs: string[]
  priority: TaskPriority
  dueAt: number | null
  /** `client` or the id of the agent that queued it; null when the task did not come from the queue. */
  createdBy: string | null
  /** When the client accepted the finished work; null until then. */
  acceptedAt: number | null
  /** 1 for the first run, +1 for every time the client sent the work back. */
  round: number
  /** Sessions of earlier rounds (their chats stay readable). */
  history: string[]
  /** Queued only: do not start on its own; the client starts it ("Start now"). */
  hold: boolean
  /** Finished work waits in Review for the client (client-made tasks); false = it goes to Done. */
  review: boolean
  /** Extra permissions given with the task on top of the agent's own (null = none). */
  grants: ProgramAuthority | null
}

/** The board of the web app: where a task is shown. */
export const BOARD_COLUMNS = ['queued', 'running', 'waiting', 'review', 'done'] as const
export type BoardColumn = (typeof BOARD_COLUMNS)[number]

/** A task that went through the work queue. */
export const isWorkItem = (t: Pick<Task, 'createdBy'>): boolean => t.createdBy !== null

/** A finished work item whose report says the work is there and that the client has not accepted yet. */
export function inReview(
  t: Pick<Task, 'status' | 'createdBy' | 'acceptedAt' | 'report'> &
    Partial<Pick<Task, 'deliverables' | 'review'>>,
): boolean {
  return (
    t.status === 'done' &&
    // the creator did not ask for review (agent-made tasks: the delegator reads the result)
    t.review !== false &&
    // failing deliverables keep the item out of Review until they are fixed or decided (phase H)
    t.deliverables?.status !== 'fail' &&
    isWorkItem(t) &&
    t.acceptedAt === null &&
    (t.report?.status === 'done' || t.report?.status === 'partial')
  )
}

/**
 * The board column of a task. `waiting` (Waiting for you): an approval or question waits for a
 * person, or the session parked on an open decision of the Decision Center (a parked run shows
 * `running`, the decision is what tells it is the client's turn).
 */
export function boardColumn(
  t: Pick<Task, 'status' | 'createdBy' | 'acceptedAt' | 'report'> &
    Partial<Pick<Task, 'deliverables' | 'review'>>,
  openDecision: boolean,
): BoardColumn {
  if (t.status === 'queued') return 'queued'
  if (t.status === 'needs_action' || (t.status === 'running' && openDecision)) return 'waiting'
  if (t.status === 'running') return 'running'
  // a finished run whose deliverables failed and that waits on a decision is the client's turn
  if (t.deliverables?.status === 'fail' && openDecision) return 'waiting'
  return inReview(t) ? 'review' : 'done'
}
export const isTerminal = (status: TaskStatus): boolean =>
  status === 'done' || status === 'failed' || status === 'stopped' || status === 'interrupted'

/** What a session reports about itself. */
export interface SessionFacts {
  pendingApprovals: number
  pendingQuestions: number
  /** A turn runs and its heartbeat is fresh. */
  activeTurn: boolean
  /** A turn is recorded but its heartbeat is stale: the process died. */
  staleTurn: boolean
  /** The crash-recovery notice of an interrupted turn is stored (the turn left no reply). */
  interruptedNotice?: boolean
  lastStop: string | null
}

/** Status of a task session from the stop reason of the last turn (turn end hook). */
export function statusFromStop(stop: string): TaskStatus {
  if (stop === 'tool-pending') return 'needs_action'
  if (stop === 'aborted') return 'stopped'
  if (stop === 'interrupted') return 'interrupted'
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
  if (facts.staleTurn) return { status: 'interrupted', pendingKind: null }
  if (facts.lastStop === null && facts.interruptedNotice === true)
    return { status: 'interrupted', pendingKind: null }
  if (facts.lastStop === null) return { status: 'running', pendingKind: null }
  // `tool-pending` without pending approvals: waiting on an external wait (a child's own park)
  if (facts.lastStop === 'tool-pending') return { status: 'running', pendingKind: null }
  return { status: statusFromStop(facts.lastStop), pendingKind: null }
}

/**
 * One-line title from a prompt: never the raw prompt. Role boilerplate ("You are ...") and markdown
 * marks are skipped, a "Title:" / "Task:" / "Goal:" line wins, and the first sentence is used when
 * it is short enough. At most `max` characters.
 */
export function titleFromText(text: string, max = 80): string {
  const lines = text
    .split('\n')
    .map((l) =>
      l
        .trim()
        .replace(/^[#>*\-\s]+/, '')
        .replace(/[*_`]+/g, '')
        .trim(),
    )
    .filter((l) => l !== '')
  const labelled = lines.find((l) => /^(title|task|goal)\s*:/i.test(l))
  const first = lines.find((l) => !/^you are\b/i.test(l)) ?? lines[0] ?? ''
  const line = (labelled ?? first).replace(/^(title|task|goal)\s*:\s*/i, '')
  const clean = line.replace(/\s+/g, ' ')
  const sentence = /^(.{12,}?[.!?:])(\s|$)/.exec(clean)?.[1]?.replace(/[:.]$/, '')
  const picked = sentence !== undefined && sentence.length <= max ? sentence : clean
  return picked.length > max ? `${picked.slice(0, max - 1)}…` : picked === '' ? 'Task' : picked
}

/** Short preview of a message body for the sidebar and the feed. */
export function previewOf(text: string, max = 140): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean
}
