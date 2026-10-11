/**
 * Deliverable checks of a program run (docs/plans/P40-team-autonomous-operations.md, phase H).
 * The program service calls `checkRun` when a run ends (and again after the one fix-up turn);
 * `finishRun` stores the result, and a run that still fails becomes `partial` with a decision.
 * `recheck` is the client's (or a decision's) way to check again without another turn.
 */
import {
  allPass,
  type DeliverableCheck,
  type DeliverableResult,
  evaluateDeliverables,
  failureText,
  type TokenContext,
} from '../domain/deliverables.ts'
import { notFound } from '../domain/errors.ts'
import { type Program, parseProgramSession } from '../domain/programs.ts'
import { isWorkItem, type Task, type TaskReport } from '../domain/tasks.ts'
import { createDeliverablesEscalation } from './decisions.ts'
import type { Deps } from './ports.ts'

/** The tokens of a run: the program name (the task title for a work item) and the run's time. */
export function tokenContext(program: Program, task: Task): TokenContext {
  return {
    title: isWorkItem(task) ? task.title : program.name,
    programId: program.id,
    runAt: parseProgramSession(task.sessionId)?.runAt ?? task.startedAt,
  }
}

/** Check the program's deliverables against the library now. */
export async function checkRun(
  deps: Deps,
  program: Program,
  task: Task,
): Promise<DeliverableCheck[]> {
  return evaluateDeliverables(program.deliverables, tokenContext(program, task), async (path) => {
    const file = await deps.library.read(path)
    return file === undefined ? undefined : { text: file.text }
  })
}

/** The report of a run whose deliverables failed: partial, with the failures spelled out. */
export function partialReport(report: TaskReport | null, checks: DeliverableCheck[]): TaskReport {
  const why = `Deliverables not met:\n${failureText(checks)}`
  return {
    status: 'partial',
    summary: report === null ? why : `${report.summary}\n\n${why}`,
    outputs: report?.outputs ?? [],
    ...(report?.notes === undefined ? {} : { notes: report.notes }),
  }
}

const changed = (deps: Deps, task: Task): void =>
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
      change: 'deliverables',
    },
  })

/**
 * Store the outcome of checking a run. All pass: the report stands. Otherwise the run is
 * `partial`, the task shows the failures and a decision (escalation) is opened.
 */
export function finishRun(
  deps: Deps,
  program: Program,
  task: Task,
  checks: DeliverableCheck[],
  attempts: number,
): Task {
  const ok = allPass(checks)
  const result: DeliverableResult = {
    status: ok ? 'pass' : 'fail',
    attempts,
    checkedAt: deps.clock.now(),
    checks,
  }
  const report = ok ? null : partialReport(task.report, checks)
  const next =
    deps.tasks.recordDeliverables(
      task.sessionId,
      result,
      report === null ? null : { report, summary: report.summary.slice(0, 500) },
      deps.clock.now(),
    ) ?? task
  if (!ok) createDeliverablesEscalation(deps, { program, task: next, checks })
  changed(deps, next)
  return next
}

/**
 * Check a finished run again (no fix-up turn): after the client or the agent repaired the files.
 * Passing makes a work item eligible for Review again.
 */
export async function recheckTask(deps: Deps, taskId: string): Promise<Task> {
  const task = deps.tasks.get(taskId)
  if (task === undefined) throw notFound('task', taskId)
  const programId = parseProgramSession(task.sessionId)?.programId
  const program = programId === undefined ? undefined : deps.programs.get(programId)
  if (program === undefined || program.deliverables.length === 0) return task
  const checks = await checkRun(deps, program, task)
  return finishRun(deps, program, task, checks, task.deliverables?.attempts ?? 1)
}
