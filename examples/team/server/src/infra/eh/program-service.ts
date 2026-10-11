/**
 * Program runs (docs/plans/P40-team-autonomous-operations.md, D4). A run is a task session
 * `program:<programId>:<runAt>` owned by the program's agent: the board and the task index see it
 * like any other task (origin `program`). The turn that starts it carries the run prompt (brief,
 * authority, gates, escalation, Execute -> Verify -> Report) and a structured-output spec, so the
 * run ends with a typed report that the `taskIndex` plugin stores on the task row.
 *
 * Why `send` and not the durable inbox the routines use: an inbox item cannot carry `output`
 * (the spec is not serializable, spec 05 §3.3 rule 7). The cost is that a run is not resumed
 * by another instance when its process dies mid-turn: crash recovery marks the turn
 * `interrupted` (the task shows it), and the program's next slot starts a fresh run. A fire that
 * is claimed but not started yet is re-dispatched by the routine recovery; the deterministic
 * session id makes that a no-op when the run already exists.
 *
 * A **worker program** (`program.worker`, D6) is a run over the work queue: the run claims the next
 * queued task of its agent in code (one atomic step, `claimNext`) and works it in a session of its
 * own, then the next one, up to `maxTasks`. The first task has the session of the run
 * (`program:<id>:<runAt>`), the next ones the same shape a millisecond later, so authority, budget,
 * history and the schedule's run row work unchanged. One session per task keeps each item's chat
 * and report apart on the board, and a task sent back gets a fresh session (the earlier ones stay
 * in the task's history).
 */
import { errorText } from 'eharness'
import { z } from 'zod'
import type { AgentRepo, EventAppender, ProgramRunner } from '../../app/ports.ts'
import type { AgentDef } from '../../domain/agents.ts'
import { conflict, notFound } from '../../domain/errors.ts'
import {
  PROGRAM_RUN_MAX_STEPS,
  type Program,
  programRunPrompt,
  programSessionId,
} from '../../domain/programs.ts'
import type { Task } from '../../domain/tasks.ts'
import { workItemPrompt } from '../../domain/work-queue.ts'
import type { SqliteTaskStore } from '../db/tasks-repo.ts'
import type { AgentFactory } from './agent-factory.ts'

/** The final report of a run (`TaskReport` in `domain/tasks.ts`). */
export const REPORT_SCHEMA = z.object({
  status: z
    .enum(['done', 'partial', 'failed', 'needs_decision'])
    .describe(
      'done: the brief is complete and verified. partial: some of it is done. failed: it did not work after the allowed attempts. needs_decision: something needs the client (a gate, missing authority).',
    ),
  summary: z
    .string()
    .min(1)
    .describe('What happened, in a few sentences. On failure: the diagnosis.'),
  outputs: z.array(z.string()).describe('Library paths of everything this run produced.'),
  notes: z
    .string()
    .optional()
    .describe('Anything the client should know that is not in the summary.'),
})

export interface ProgramServiceDeps {
  agents: AgentRepo
  tasks: SqliteTaskStore
  events: EventAppender
  now?: () => number
  log?: { warn(message: string): void }
}

export interface ProgramService extends ProgramRunner {
  /** Runs started by this process that have not ended (tests wait for them). */
  idle(): Promise<void>
}

export function createProgramService(
  factory: AgentFactory,
  deps: ProgramServiceDeps,
): ProgramService {
  const clock = deps.now ?? (() => Date.now())
  const log = deps.log ?? { warn() {} }
  const inflight = new Set<Promise<unknown>>()
  const track = (promise: Promise<unknown>): void => {
    inflight.add(promise)
    void promise.finally(() => inflight.delete(promise))
  }

  const announce = (def: AgentDef, sessionId: string, row: Task, created: boolean): void => {
    deps.events.append({
      type: 'task-changed',
      agentId: def.id,
      sessionId,
      payload: {
        taskId: row.id,
        status: 'running',
        pendingKind: null,
        title: row.title,
        parentSessionId: null,
        created,
      },
      at: clock(),
    })
  }

  /** Send the run prompt into the session; resolves with how the turn ended. */
  function send(def: AgentDef, sessionId: string, prompt: string): Promise<string | undefined> {
    const session = factory.openSession(def, sessionId)
    const run = session.send(prompt, {
      output: { schema: REPORT_SCHEMA, description: 'The final report of this program run.' },
      ifBusy: 'reject',
      maxSteps: PROGRAM_RUN_MAX_STEPS,
    })
    return run.result.then(
      (result) => (result as { stop?: string }).stop,
      (error: unknown) => {
        log.warn(`program run ${sessionId} failed: ${errorText(error)}`)
        return undefined
      },
    )
  }

  /** A session of this id has run, or is running. */
  async function exists(sessionId: string): Promise<boolean> {
    const peek = factory.peek(sessionId)
    return (await peek.busy()) !== null || (await peek.messages({ limit: 1 })).length > 0
  }

  async function startWorker(
    program: Program,
    def: AgentDef,
    runAt: number,
  ): Promise<{ sessionId: string; started: boolean; idle?: boolean }> {
    const maxTasks = program.worker?.maxTasks ?? 1
    const first = programSessionId(program.id, runAt)
    const base = programRunPrompt(program)
    // a recovered fire: its first task is claimed (and may have started)
    const claimed = deps.tasks.getBySession(first)
    if (claimed !== undefined && (await exists(first))) return { sessionId: first, started: false }
    const row = claimed ?? deps.tasks.claimNext(def.id, first, clock())
    if (row === undefined) return { sessionId: first, started: false, idle: true }
    announce(def, first, row, claimed === undefined)

    const firstEnd = send(def, first, workItemPrompt(program, row, base))
    track(
      (async () => {
        let stop = await firstEnd
        let done = 1
        let offset = 0
        while (done < maxTasks && (stop === 'complete' || stop === 'tool-pending')) {
          // the next task is claimed only now, so a run that stops early holds nothing back
          let sessionId: string
          do sessionId = programSessionId(program.id, runAt + ++offset)
          while (deps.tasks.getBySession(sessionId) !== undefined || (await exists(sessionId)))
          const next = deps.tasks.claimNext(def.id, sessionId, clock())
          if (next === undefined) break
          announce(def, sessionId, next, true)
          stop = await send(def, sessionId, workItemPrompt(program, next, base))
          done++
        }
      })().catch((error: unknown) =>
        log.warn(`worker run of ${program.id} failed: ${errorText(error)}`),
      ),
    )
    return { sessionId: first, started: true }
  }

  return {
    async start(program: Program, { runAt }) {
      const def = deps.agents.get(program.agentId)
      if (def === undefined) throw notFound('agent', program.agentId)
      if (def.archivedAt !== null) throw conflict('the agent is archived', 'AGENT_ARCHIVED')
      await factory.prepare(def)
      if (program.worker != null) return startWorker(program, def, runAt)
      const sessionId = programSessionId(program.id, runAt)

      // a recovered fire or a double click: the run exists already
      if (await exists(sessionId)) return { sessionId, started: false }

      const t = clock()
      const prompt = programRunPrompt(program)
      const before = deps.tasks.getBySession(sessionId)
      const row = deps.tasks.ensure({
        agentId: def.id,
        sessionId,
        parentSessionId: null,
        origin: 'program',
        title: `Program run: ${program.name}`,
        startedAt: t,
      })
      if (before === undefined) announce(def, sessionId, row, true)
      track(send(def, sessionId, prompt))
      return { sessionId, started: true }
    },

    async idle() {
      while (inflight.size > 0) await Promise.allSettled([...inflight])
    },
  }
}
