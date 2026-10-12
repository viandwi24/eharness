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
  DEFAULT_TASK_CONCURRENCY,
  MAX_NOTE_CHARS,
  normalizeGrants,
  type QueueReason,
  queueReason,
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

/** The most assigned tasks one agent works on at once (setting per agent, default 1). */
export const concurrencyOf = (deps: Deps, agentId: string): number =>
  Math.max(1, deps.agents.get(agentId)?.taskConcurrency ?? DEFAULT_TASK_CONCURRENCY)

/** An active worker program of the agent owns its queue (the standing order of before the redesign). */
export const hasWorkerProgram = (deps: Deps, agentId: string): boolean =>
  deps.programs.list({ agentId }).some((p) => p.worker !== null && p.status === 'active')

/** Tasks across the team that work now (they hold a slot of the team-wide cap). */
function runningTotal(deps: Deps): number {
  return (
    deps.tasks.list({ status: 'running', limit: 500 }).filter((t) => t.createdBy !== null).length +
    deps.tasks.list({ status: 'needs_action', limit: 500 }).filter((t) => t.createdBy !== null)
      .length
  )
}

/** Why each queued task of `tasks` has not started (undefined for tasks that are not queued). */
function queueReasons(deps: Deps, tasks: readonly Task[]): Map<string, QueueReason> {
  const out = new Map<string, QueueReason>()
  const queued = tasks.filter((t) => t.status === 'queued')
  if (queued.length === 0) return out
  const cap = deps.settings.get().spawnCap
  const total = runningTotal(deps)
  const perAgent = new Map<string, { worker: boolean; active: number; limit: number }>()
  for (const t of queued) {
    let info = perAgent.get(t.agentId)
    if (info === undefined) {
      info = {
        worker: hasWorkerProgram(deps, t.agentId),
        active: deps.tasks.running(t.agentId),
        limit: concurrencyOf(deps, t.agentId),
      }
      perAgent.set(t.agentId, info)
    }
    const reason = queueReason({
      hold: t.hold,
      workerProgram: info.worker,
      active: total >= cap ? Number.POSITIVE_INFINITY : info.active,
      limit: info.limit,
    })
    out.set(t.id, reason)
  }
  return out
}

/** Tasks with the column the board shows them in (a run parked on a decision is `waiting`) and, for queued ones, why they wait. */
export function withColumns(
  deps: Deps,
  tasks: readonly Task[],
): Array<Task & { column: ReturnType<typeof boardColumn>; queue: QueueReason | null }> {
  const columns = columnsOf(deps, tasks)
  const reasons = queueReasons(deps, tasks)
  return tasks.map((t) => ({
    ...t,
    column: columns.get(t.id) as ReturnType<typeof boardColumn>,
    queue: reasons.get(t.id) ?? null,
  }))
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
    hold: draft.hold ?? false,
    // review by default for the client; an agent that assigns work reads the result itself
    review: draft.review ?? (draft.createdBy ?? CLIENT) === CLIENT,
    grants: normalizeGrants(draft.grants),
    now: deps.clock.now(),
  })
  changed(deps, task, 'queued')
  dispatchQueue(deps, task.agentId)
  return task
}

/**
 * Start what can start: for every agent (or one) with queued tasks, take the next not held task
 * while the agent works on fewer than its concurrency and the team on fewer than the spawn cap.
 * An agent with an active worker program is left to that program. Safe to call at any time (task
 * created, released, sent back, one ended, the periodic pass): it only claims what has a free slot.
 * Returns how many tasks it started.
 */
export function dispatchQueue(deps: Deps, only?: string): number {
  const queued = deps.tasks.list({ status: 'queued', limit: 500 })
  const agentIds = [...new Set(queued.map((t) => t.agentId))].filter(
    (id) => only === undefined || id === only,
  )
  let started = 0
  let total = agentIds.length === 0 ? 0 : runningTotal(deps)
  const cap = deps.settings.get().spawnCap
  for (const agentId of agentIds) {
    const agent = deps.agents.get(agentId)
    if (agent === undefined || agent.archivedAt !== null) continue
    if (hasWorkerProgram(deps, agentId)) continue
    const limit = concurrencyOf(deps, agentId)
    while (total < cap) {
      const row = deps.tasks.claimAssigned(agentId, limit, deps.clock.now())
      if (row === undefined) break
      total++
      started++
      beginTask(deps, row)
    }
  }
  return started
}

/** Start the session of a claimed task; when it ends, the next waiting task may start. */
function beginTask(deps: Deps, task: Task): void {
  changed(deps, task, 'started')
  const { ended } = deps.programRunner.startTask(task)
  void ended.finally(() => {
    try {
      dispatchQueue(deps)
    } catch {
      // the periodic pass tries again
    }
  })
}

/** "Start now": the client starts a queued task at once (held, waiting for a slot or owned by a worker program). */
export function startTaskNow(deps: Deps, id: string): Task {
  const current = taskOrThrow(deps, id)
  if (current.status !== 'queued') {
    throw conflict('only a queued task can be started', 'TASK_NOT_QUEUED', {
      status: current.status,
    })
  }
  const agent = getAgent(deps, current.agentId)
  if (agent.archivedAt !== null) throw conflict('the agent is archived', 'AGENT_ARCHIVED')
  const row = deps.tasks.claimTask(id, deps.clock.now())
  if (row === undefined) throw conflict('the task was started meanwhile', 'TASK_NOT_QUEUED')
  beginTask(deps, row)
  return row
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
      ...(patch.hold === undefined ? {} : { hold: patch.hold }),
      ...(patch.review === undefined ? {} : { review: patch.review }),
      ...(patch.grants === undefined ? {} : { grants: normalizeGrants(patch.grants) }),
    },
    deps.clock.now(),
  )
  // a worker claimed it between the read and the write
  if (next === undefined) throw conflict('the task was claimed meanwhile', 'TASK_NOT_QUEUED')
  changed(deps, next, 'updated')
  // released, reassigned or re-prioritised: it may start now
  dispatchQueue(deps)
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
  dispatchQueue(deps, next.agentId)
  // it may have started already
  return deps.tasks.get(id) ?? next
}

/**
 * What the client must know after a send-back: the task is queued again and starts on its own
 * with the feedback, unless the agent has an active worker program (that program owns the queue),
 * the task is held, or the agent has no free slot.
 */
export function sendBackHint(deps: Deps, task: Task): string {
  const agent = deps.agents.get(task.agentId)
  const name = agent?.name ?? 'the agent'
  const current = deps.tasks.get(task.id) ?? task
  if (current.status !== 'queued') return `${name} is working on it again with your feedback.`
  if (current.hold) return 'Queued again and on hold: press Start now when you want it revised.'
  const worker = deps.programs
    .list({ agentId: task.agentId })
    .find((p) => p.worker !== null && p.status === 'active')
  if (worker !== undefined) {
    return worker.trigger.kind === 'schedule'
      ? `Queued again. The worker program "${worker.name}" picks it up at its next scheduled run (or press Start now).`
      : `Queued again. "${worker.name}" is a manual worker program: press Run now on the Programs page, or Start now here.`
  }
  return `Queued again: ${name} starts the revision as soon as a slot is free.`
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
