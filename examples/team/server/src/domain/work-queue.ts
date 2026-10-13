/**
 * The work queue (docs/plans/P40-team-autonomous-operations.md, decision D6 and the work-queue
 * redesign, phase N). Pure.
 *
 * A queued task is a row of the task board that exists before its session: an owner agent, a
 * brief, inputs (library paths), a priority and a due date. Assigning it starts it: the agent works
 * on it in a session of its own (`task:<taskId>:<round>`) with its normal tools and permissions, as
 * in chat, plus the optional grants given with the task. The agent takes `taskConcurrency` tasks at
 * once (default 1); the others wait as Queued ("waiting for a slot") and start when one ends. A
 * task marked **hold** does not start on its own. An agent with an active **worker program** keeps
 * the old behaviour: that program owns the queue and runs it under its standing authority.
 *
 * When the work finishes it goes to Review if the creator asked for review (client-made tasks by
 * default), where the client accepts it or sends it back with a note (queued again, started again).
 */
import { deliverablesPromptSection, type TokenContext } from './deliverables.ts'
import { invalid } from './errors.ts'
import {
  cleanList,
  globRule,
  MAX_ATTEMPTS,
  MAX_BRIEF_CHARS,
  MAX_ITEM_CHARS,
  MAX_LIST_ITEMS,
  normalizeAuthority,
  type Program,
  type ProgramAuthority,
  readRules,
  type ToolSourceInfo,
} from './programs.ts'
import { previewOf, TASK_PRIORITIES, type Task, type TaskPriority } from './tasks.ts'

export const MAX_TITLE_CHARS = 200
export const MAX_INPUTS = 50
export const MAX_NOTE_CHARS = 4_000
export const DEFAULT_TASK_CONCURRENCY = 1
export const MAX_TASK_CONCURRENCY = 8

export interface TaskDraft {
  agentId: string
  title: string
  brief?: string | undefined
  inputs?: string[] | undefined
  priority?: TaskPriority | undefined
  dueAt?: number | null | undefined
  /** Do not start on its own. */
  hold?: boolean | undefined
  /** Finished work waits in Review. Default: yes for the client, no for an agent. */
  review?: boolean | undefined
  /** Extra permissions for this task on top of the agent's own. */
  grants?: Partial<ProgramAuthority> | null | undefined
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

/** The session of an assigned task (one per round: a task sent back gets a fresh session). */
export const assignedSessionId = (taskId: string, round: number): string =>
  `task:${taskId}:${round}`

export function parseAssignedSession(
  sessionId: string,
): { taskId: string; round: number } | undefined {
  const m = /^task:([^:]+):(\d+)$/.exec(sessionId)
  return m === null ? undefined : { taskId: m[1] as string, round: Number(m[2]) }
}

/** Why a queued task has not started: held, owned by a worker program, waiting for a slot, or about to start. */
export const QUEUE_REASONS = ['hold', 'worker', 'slot', 'starting'] as const
export type QueueReason = (typeof QUEUE_REASONS)[number]

export function queueReason(input: {
  hold: boolean
  workerProgram: boolean
  /** Tasks of the agent that run (or wait for the client) now. */
  active: number
  limit: number
}): QueueReason {
  if (input.hold) return 'hold'
  if (input.workerProgram) return 'worker'
  return input.active >= input.limit ? 'slot' : 'starting'
}

/** The grants of a draft or patch, cleaned; null when it grants nothing. */
export function normalizeGrants(
  g: Partial<ProgramAuthority> | null | undefined,
): ProgramAuthority | null {
  if (g == null) return null
  const a = normalizeAuthority(g)
  return a.tools.length + a.connectors.length + a.read.length + a.write.length === 0 ? null : a
}

/**
 * The allow rules the grants of a task add to the permission engine of its session (same shapes as
 * a program's authority): named tools, every tool of a connector, `Read(glob)` and `Edit(glob)`.
 * The agent's own deny rules still win.
 */
export function taskGrantRules(
  grants: ProgramAuthority,
  tools: readonly ToolSourceInfo[] = [],
): string[] {
  const connectorTools = tools
    .filter(
      (t) =>
        grants.connectors.includes(t.connectorId) ||
        t.connectionIds.some((c) => grants.connectors.includes(c)),
    )
    .map((t) => t.name)
  return cleanList([
    ...grants.tools,
    ...connectorTools,
    ...grants.read.flatMap(readRules),
    ...grants.write.flatMap(readRules),
    ...grants.write.map((g) => globRule('Edit', g)),
  ])
}

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
  if (f.grants != null) {
    for (const [name, list] of Object.entries(f.grants)) {
      if (!Array.isArray(list) || list.length > MAX_LIST_ITEMS) {
        throw invalid(`grants.${name} has at most ${MAX_LIST_ITEMS} entries`, 'INVALID_TASK')
      }
      for (const item of list as string[]) {
        if (typeof item !== 'string' || item.length > MAX_ITEM_CHARS) {
          throw invalid(`grants.${name}: an entry is too long`, 'INVALID_TASK')
        }
        if (
          (name === 'read' || name === 'write') &&
          item.trim() !== '' &&
          !item.trim().startsWith('/')
        ) {
          throw invalid(
            `grants.${name}: "${item}" must be a library path starting with /`,
            'INVALID_TASK',
          )
        }
      }
    }
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

export const costText = (usd: number): string => `$${usd >= 1 ? usd.toFixed(2) : usd.toFixed(4)}`

/** One line per task for `list_tasks`: the cost is what the session really spent (ledger / call log). */
export const taskLine = (t: Task, column: string): string =>
  `- ${t.id} [${column}] ${t.title} (${t.agentId}, ${t.priority}${t.dueAt === null ? '' : `, due ${dueText(t.dueAt)}`}${t.status === 'queued' ? '' : `, cost ${costText(t.costUsd)}`})${
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

/**
 * The first message of an assigned task session. The agent works as in chat (its own tools and
 * permissions: what needs approval asks the client, which the board shows as "Waiting for you"),
 * then ends with a structured report so the board and Review have a summary and the outputs.
 */
export function taskRunPrompt(task: Task): string {
  const g = task.grants
  const granted =
    g === null
      ? []
      : [
          ...g.tools,
          ...g.connectors.map((c) => `every tool of connector ${c}`),
          ...g.read.map((p) => `read ${p}`),
          ...g.write.map((p) => `read and write ${p}`),
        ]
  return [
    `Assigned task: ${task.title}`,
    '',
    'The client (or a manager agent) put this task on the task board for you. Do it the way you',
    'would in a chat: use your own tools; a call that needs approval asks the client, who sees it',
    'on the board. Nobody waits in this conversation, so do not end with a question: when something',
    'blocks you or needs a decision, call escalate (the question goes to the client, the run carries on; use escalate_wait to pause until the answer).',
    '',
    describeTask(task),
    ...(granted.length === 0
      ? []
      : ['', 'Pre-approved for this task (no approval needed):', ...granted.map((i) => `- ${i}`)]),
    '',
    ...(task.round > 1
      ? [
          'The client sent this task back: the feedback at the end of the brief says what to change.',
          'Revise your earlier outputs (read them first), do not start over.',
          '',
        ]
      : []),
    'Save what you produce in the library and name the paths in your report.',
    'End with the final_answer tool: status (done, partial, failed or needs_decision), a short',
    'summary of what you did (the client reads it in Review), outputs (library paths of what you',
    'made) and optional notes.',
  ].join('\n')
}
