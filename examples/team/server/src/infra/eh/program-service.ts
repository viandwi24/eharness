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
 */
import { errorText } from 'eharness'
import { z } from 'zod'
import type { AgentRepo, EventAppender, ProgramRunner } from '../../app/ports.ts'
import { conflict, notFound } from '../../domain/errors.ts'
import { type Program, programRunPrompt, programSessionId } from '../../domain/programs.ts'
import type { TaskWriter } from '../db/tasks-repo.ts'
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
  tasks: TaskWriter
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

  return {
    async start(program: Program, { runAt }) {
      const def = deps.agents.get(program.agentId)
      if (def === undefined) throw notFound('agent', program.agentId)
      if (def.archivedAt !== null) throw conflict('the agent is archived', 'AGENT_ARCHIVED')
      const sessionId = programSessionId(program.id, runAt)
      await factory.prepare(def)

      // a recovered fire or a double click: the run exists already
      const peek = factory.peek(sessionId)
      if ((await peek.busy()) !== null || (await peek.messages({ limit: 1 })).length > 0) {
        return { sessionId, started: false }
      }

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
      if (before === undefined) {
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
            created: true,
          },
          at: t,
        })
      }

      const session = factory.openSession(def, sessionId)
      const run = session.send(prompt, {
        output: { schema: REPORT_SCHEMA, description: 'The final report of this program run.' },
        ifBusy: 'reject',
      })
      const watched = run.result.then(
        () => undefined,
        (error: unknown) => log.warn(`program run ${sessionId} failed: ${errorText(error)}`),
      )
      inflight.add(watched)
      void watched.finally(() => inflight.delete(watched))
      return { sessionId, started: true }
    },

    async idle() {
      while (inflight.size > 0) await Promise.allSettled([...inflight])
    },
  }
}
