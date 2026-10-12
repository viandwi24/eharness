/**
 * Work queue use cases (docs/plans/P40-team-autonomous-operations.md, D6). A queued task is a row
 * of the task board without a session: the client (web) or a manager agent (`create_task`) writes
 * it, a worker program claims it (`infra/eh/program-service.ts`), the client accepts the result in
 * Review or sends it back with a note.
 */
import { conflict, invalid, notFound } from '../domain/errors.ts'
import { parseProgramSession } from '../domain/programs.ts'
import {
  boardColumn,
  isWorkItem,
  type Task,
  type TaskPriority,
  titleFromText,
} from '../domain/tasks.ts'
import {
  checkTaskFields,
  cleanInputs,
  MAX_NOTE_CHARS,
  type TaskDraft,
  type TaskPatch,
} from '../domain/work-queue.ts'
import { getAgent } from './agents.ts'
import type { Deps } from './ports.ts'

export const CLIENT = 'client'

function taskOrThrow(deps: Deps, id: string): Task {
  const task = deps.tasks.get(id)
  if (task === undefined) throw notFound('task', id)
  return task
}

const changed = (deps: Deps, task: Task, change: string): void =>
  deps.events.append({
    type: 'task-changed',
    agentId: task.agentId,
    sessionId: task.sessionId,
    payload: {
      taskId: task.id,
      status: task.status,
      pendingKind: task.pendingKind,
      title: task.title,
      parentSessionId: task.parentSessionId,
      change,
    },
  })

/** Sessions whose run waits on an open decision (for "Waiting for you"). */
export function sessionsWithOpenDecision(deps: Deps): Set<string> {
  const out = new Set<string>()
  for (const d of deps.decisions.list({ status: 'open', limit: 500 })) {
    if (d.sessionId !== null) out.add(d.sessionId)
  }
  return out
}

/** The board column of tasks as the client sees them. */
export function columnsOf(
  deps: Deps,
  tasks: readonly Task[],
): Map<string, ReturnType<typeof boardColumn>> {
  const waiting = sessionsWithOpenDecision(deps)
  return new Map(tasks.map((t) => [t.id, boardColumn(t, waiting.has(t.sessionId))]))
}

/** Tasks with the column the board shows them in (a run parked on a decision is `waiting`). */
export function withColumns(
  deps: Deps,
  tasks: readonly Task[],
): Array<Task & { column: ReturnType<typeof boardColumn> }> {
  const columns = columnsOf(deps, tasks)
  return tasks.map((t) => ({ ...t, column: columns.get(t.id) as ReturnType<typeof boardColumn> }))
}

/** Queue a task. `createdBy` is `client` or the id of the agent that wrote it. */
export function createTask(deps: Deps, draft: TaskDraft & { createdBy?: string }): Task {
  const agent = getAgent(deps, draft.agentId)
  if (agent.archivedAt !== null) throw conflict('the agent is archived', 'AGENT_ARCHIVED')
  checkTaskFields(draft)
  const task = deps.tasks.enqueue({
    agentId: agent.id,
    // a title is a short human label: a pasted prompt is shortened to its first line
    title:
      draft.title.trim().length > 80 || draft.title.includes('\n')
        ? titleFromText(draft.title)
        : draft.title.trim(),
    brief: draft.brief === undefined || draft.brief.trim() === '' ? null : draft.brief.trim(),
    inputs: cleanInputs(draft.inputs ?? []),
    priority: draft.priority ?? 'normal',
    dueAt: draft.dueAt ?? null,
    createdBy: draft.createdBy ?? CLIENT,
    now: deps.clock.now(),
  })
  changed(deps, task, 'queued')
  return task
}

/** Change a task that has not started (re-prioritise, reassign, rewrite). */
export function updateQueuedTask(deps: Deps, id: string, patch: TaskPatch): Task {
  const current = taskOrThrow(deps, id)
  if (current.status !== 'queued') {
    throw conflict('only a queued task can be changed', 'TASK_NOT_QUEUED', {
      status: current.status,
    })
  }
  checkTaskFields(patch)
  const agentId = patch.agentId === undefined ? undefined : getAgent(deps, patch.agentId).id
  const next = deps.tasks.patchQueued(
    id,
    {
      ...(agentId === undefined ? {} : { agentId }),
      ...(patch.title === undefined ? {} : { title: patch.title.trim() }),
      ...(patch.brief === undefined
        ? {}
        : { brief: patch.brief.trim() === '' ? null : patch.brief.trim() }),
      ...(patch.inputs === undefined ? {} : { inputs: cleanInputs(patch.inputs) }),
      ...(patch.priority === undefined ? {} : { priority: patch.priority as TaskPriority }),
      ...(patch.dueAt === undefined ? {} : { dueAt: patch.dueAt }),
    },
    deps.clock.now(),
  )
  // a worker claimed it between the read and the write
  if (next === undefined) throw conflict('the task was claimed meanwhile', 'TASK_NOT_QUEUED')
  changed(deps, next, 'updated')
  return next
}

/** Cancel a queued task (it ends `stopped`). */
export function cancelQueuedTask(deps: Deps, id: string): Task {
  const current = taskOrThrow(deps, id)
  const next = deps.tasks.cancelQueued(id, deps.clock.now())
  if (next === undefined) {
    throw conflict('only a queued task can be cancelled', 'TASK_NOT_QUEUED', {
      status: current.status,
    })
  }
  changed(deps, next, 'cancelled')
  return next
}

/** Accept finished work: it leaves Review. */
export function acceptTask(deps: Deps, id: string): Task {
  const current = taskOrThrow(deps, id)
  // failing deliverables keep a work item out of Review: fix them (or decide) first
  const next =
    current.deliverables?.status === 'fail' ? undefined : deps.tasks.accept(id, deps.clock.now())
  if (next === undefined) {
    throw conflict('only finished work in Review can be accepted', 'TASK_NOT_IN_REVIEW', {
      status: current.status,
      workItem: isWorkItem(current),
    })
  }
  changed(deps, next, 'accepted')
  return next
}

/** Send finished work back: queued again, the note appended to the brief, the next run revises. */
export function sendBackTask(deps: Deps, id: string, note: string): Task {
  const text = note.trim()
  if (text === '' || text.length > MAX_NOTE_CHARS) {
    throw invalid(`note must be 1-${MAX_NOTE_CHARS} characters`, 'INVALID_TASK')
  }
  const current = taskOrThrow(deps, id)
  const next = deps.tasks.sendBack(id, text, deps.clock.now())
  if (next === undefined) {
    throw conflict('only finished work in Review can be sent back', 'TASK_NOT_IN_REVIEW', {
      status: current.status,
      workItem: isWorkItem(current),
    })
  }
  changed(deps, next, 'sent-back')
  return next
}

/**
 * What the client must know after a send-back: the task is queued again, but only a worker
 * program of its agent picks it up (D11 of the e2e pass). A scheduled worker does it at its next
 * run; a manual one waits for "Run now"; none means nothing will run it.
 */
export function sendBackHint(deps: Deps, task: Task): string {
  const workers = deps.programs
    .list({})
    .filter((p) => p.worker !== null && p.agentId === task.agentId && p.status === 'active')
  const scheduled = workers.find((p) => p.trigger.kind === 'schedule')
  if (scheduled !== undefined) {
    return `Queued again. The worker program "${scheduled.name}" picks it up at its next scheduled run.`
  }
  const manual = workers[0]
  if (manual !== undefined) {
    return `Queued again. "${manual.name}" is a manual worker program: press Run now on the Programs page for it to pick this up.`
  }
  const agent = deps.agents.get(task.agentId)
  return `Queued again, but no active worker program runs the queue of ${agent?.name ?? 'this agent'}: create one on the Programs page (with Work queue on) or the task stays queued.`
}

export interface TaskQuery {
  column?: ReturnType<typeof boardColumn> | undefined
  /** Only the runs of this program (id or name). */
  program?: string | undefined
  /** Agent id or slug. */
  agentId?: string | undefined
  limit?: number | undefined
}

/** The tasks the board shows, with their column, newest activity first (`list_tasks`). */
export function listBoard(
  deps: Deps,
  query: TaskQuery,
): Array<{ task: Task; column: ReturnType<typeof boardColumn> }> {
  const agentId = query.agentId === undefined ? undefined : getAgent(deps, query.agentId).id
  let tasks = deps.tasks.list({ ...(agentId === undefined ? {} : { agentId }), limit: 500 })
  if (query.program !== undefined) {
    const wanted = query.program.trim().toLowerCase()
    const program = deps.programs
      .list({})
      .find((p) => p.id === query.program || p.name.toLowerCase() === wanted)
    if (program === undefined) throw notFound('program', query.program)
    tasks = tasks.filter((t) => parseProgramSession(t.sessionId)?.programId === program.id)
  }
  const columns = columnsOf(deps, tasks)
  return tasks
    .map((task) => ({ task, column: columns.get(task.id) as ReturnType<typeof boardColumn> }))
    .filter((row) => query.column === undefined || row.column === query.column)
    .slice(0, query.limit ?? 50)
}

/**
 * `complete_task`: the work item of this session is done. Every output must exist in the library
 * (a missing file is the model's to fix, not an error to throw). The task moves to Review when the
 * turn ends with its final report; this call stores the summary and the outputs.
 */
export async function completeTask(
  deps: Deps,
  sessionId: string,
  input: { summary: string; outputs: string[] },
): Promise<{ ok: true; task: Task } | { ok: false; error: string }> {
  const task = deps.tasks.getBySession(sessionId)
  if (task === undefined || task.createdBy === null) {
    return {
      ok: false,
      error:
        'This run has no queued task to complete. Give your final report; complete_task is for the tasks of the work queue.',
    }
  }
  const outputs = cleanInputs(input.outputs)
  const missing: string[] = []
  for (const path of outputs) {
    if ((await deps.library.read(path)) === undefined) missing.push(path)
  }
  if (missing.length > 0) {
    return {
      ok: false,
      error: `These outputs do not exist in the library: ${missing.join(', ')}. Write them first (or list only what you made), then call complete_task again.`,
    }
  }
  const summary = input.summary.trim()
  if (summary === '') return { ok: false, error: 'summary must not be empty' }
  const next = deps.tasks.complete(
    sessionId,
    { status: 'done', summary, outputs },
    deps.clock.now(),
  )
  if (next === undefined) {
    return { ok: false, error: 'The task is not running any more, so it cannot be completed.' }
  }
  return { ok: true, task: next }
}
