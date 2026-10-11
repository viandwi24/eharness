/**
 * The work queue (docs/plans/P40-team-autonomous-operations.md, decision D6). Pure.
 *
 * A queued task is a row of the task board that exists before its session: an owner agent, a
 * brief, inputs (library paths), a priority and a due date. A **worker program** claims the next
 * queued task of its agent and runs it in a session of its own (`program:<id>:<ms>`, so the
 * authority, the budget and the run history of phase A apply unchanged); finishing moves the task
 * to Review, where the client accepts it or sends it back with a note (the task is queued again
 * with the note appended to its brief).
 */
import { deliverablesPromptSection, type TokenContext } from './deliverables.ts'
import { invalid } from './errors.ts'
import { MAX_ATTEMPTS, MAX_BRIEF_CHARS, type Program } from './programs.ts'
import { previewOf, TASK_PRIORITIES, type Task, type TaskPriority } from './tasks.ts'

export const MAX_TITLE_CHARS = 200
export const MAX_INPUTS = 50
export const MAX_NOTE_CHARS = 4_000
/** Most queued tasks a worker program may take in one run. */

export interface TaskDraft {
  agentId: string
  title: string
  brief?: string | undefined
  inputs?: string[] | undefined
  priority?: TaskPriority | undefined
  dueAt?: number | null | undefined
}

export type TaskPatch = Partial<Omit<TaskDraft, 'dueAt'>> & { dueAt?: number | null | undefined }

/** Rank of a priority: the queue is taken highest first. */
export const PRIORITY_RANK: Record<TaskPriority, number> = {
  low: 0,
  normal: 1,
  high: 2,
  urgent: 3,
}

/** The placeholder session of a task that has none yet (`session_id` is unique and required). */
export const queuedSessionId = (taskId: string): string => `queued:${taskId}`
export const isQueuedSession = (sessionId: string): boolean => sessionId.startsWith('queued:')

const INPUT = /^\/[^\n]*$/

/** Shape checks of a task draft or patch (title, brief, inputs, priority, due). */
export function checkTaskFields(f: TaskPatch): void {
  if (f.title !== undefined && (f.title.trim() === '' || f.title.length > MAX_TITLE_CHARS)) {
    throw invalid(`title must be 1-${MAX_TITLE_CHARS} characters`, 'INVALID_TASK')
  }
  if (f.brief !== undefined && f.brief.length > MAX_BRIEF_CHARS) {
    throw invalid(`brief must be at most ${MAX_BRIEF_CHARS} characters`, 'INVALID_TASK')
  }
  if (f.inputs !== undefined) {
    if (f.inputs.length > MAX_INPUTS) {
      throw invalid(`inputs has at most ${MAX_INPUTS} entries`, 'INVALID_TASK')
    }
    for (const path of f.inputs) {
      if (!INPUT.test(path.trim()) || path.includes('..') || path.length > 500) {
        throw invalid(`inputs: "${path}" must be a library path starting with /`, 'INVALID_TASK')
      }
    }
  }
  if (f.priority !== undefined && !(TASK_PRIORITIES as readonly string[]).includes(f.priority)) {
    throw invalid(`priority must be one of ${TASK_PRIORITIES.join(', ')}`, 'INVALID_TASK')
  }
  if (f.dueAt != null && (!Number.isFinite(f.dueAt) || f.dueAt <= 0)) {
    throw invalid('dueAt must be a time in milliseconds or null', 'INVALID_TASK')
  }
}

export const cleanInputs = (inputs: readonly string[]): string[] => [
  ...new Set(inputs.map((i) => i.trim()).filter((i) => i !== '')),
]

/** The brief after the client sent the work back: the note joins it, the next run revises. */
export function briefWithFeedback(brief: string | null, round: number, note: string): string {
  const feedback = [`## Feedback from the client (round ${round})`, '', note.trim()].join('\n')
  const base = (brief ?? '').trimEnd()
  return base === '' ? feedback : `${base}\n\n${feedback}`
}

/** What the client reads of a due date. */
export const dueText = (at: number): string => new Date(at).toISOString().slice(0, 10)

/** The text of a queued task for a model (the claim result, `list_tasks`). */
export function describeTask(t: Task): string {
  return [
    `Task ${t.id} — ${t.title}`,
    `Owner: ${t.agentId} · priority ${t.priority}${t.dueAt === null ? '' : ` · due ${dueText(t.dueAt)}`} · status ${t.status}${t.round > 1 ? ` · round ${t.round}` : ''}`,
    ...(t.inputs.length === 0 ? [] : [`Inputs: ${t.inputs.join(', ')}`]),
    ...(t.brief === null || t.brief.trim() === '' ? [] : ['', t.brief.trim()]),
  ].join('\n')
}

/** One line per task for `list_tasks`. */
export const taskLine = (t: Task, column: string): string =>
  `- ${t.id} [${column}] ${t.title} (${t.agentId}, ${t.priority}${t.dueAt === null ? '' : `, due ${dueText(t.dueAt)}`})${
    t.summary === null ? '' : ` — ${previewOf(t.summary, 140)}`
  }`

/**
 * The run prompt of a worker program for one claimed task: the program's standing order (brief,
 * authority, gates, escalation, Execute -> Verify -> Report) and the task on top of it.
 */
export function workItemPrompt(
  program: Program,
  task: Task,
  basePrompt: string,
  run?: TokenContext,
): string {
  return [
    basePrompt,
    '',
    '## The task you work on in this run',
    'This run is one item of the work queue. Work on this task only; the queue gives you the next',
    'one in a later session. Save what you produce in the paths you may write.',
    '',
    describeTask(task),
    '',
    ...(run === undefined ? [] : deliverablesPromptSection(program.deliverables, run)),
    ...(task.round > 1
      ? [
          'The client sent this task back: the feedback at the end of the brief says what to change.',
          'Revise your earlier outputs (read them first), do not start over.',
        ]
      : []),
    'When the work is done and verified, call complete_task with a short summary and the library',
    'paths of what you made (they must exist), then give the final report.',
    `Program: ${program.name}. At most ${MAX_ATTEMPTS} attempts, then report the diagnosis.`,
  ].join('\n')
}
