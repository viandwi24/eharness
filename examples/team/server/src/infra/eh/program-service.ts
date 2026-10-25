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
import type { FileUIPart } from 'ai'
import { errorText } from 'eharness'
import { z } from 'zod'
import { postNotice } from '../../app/briefings.ts'
import { checkRun, finishRun } from '../../app/deliverables.ts'
import type { AgentRepo, Deps, EventAppender, ProgramRunner } from '../../app/ports.ts'
import { resolveProgramText } from '../../app/program-files.ts'
import { journalProgramRun } from '../../app/works-journal.ts'
import type { AgentDef } from '../../domain/agents.ts'
import {
  isAllowedMediaType,
  libraryUrl,
  MAX_UPLOAD_BYTES,
  uploadPathOfUrl,
} from '../../domain/chat.ts'
import { allPass, fixUpPrompt } from '../../domain/deliverables.ts'
import { conflict, notFound } from '../../domain/errors.ts'
import { UPLOADS_ROOT } from '../../domain/library.ts'
import {
  budgetWarnings,
  inspectAuthority,
  PROGRAM_RUN_MAX_STEPS,
  type Program,
  parseProgramSession,
  programRunPrompt,
  programSessionId,
  toolWarnings,
} from '../../domain/programs.ts'
import { inReview, type Task } from '../../domain/tasks.ts'
import { taskRunPrompt, workItemPrompt } from '../../domain/work-queue.ts'
import type { SqliteTaskStore } from '../db/tasks-repo.ts'
import type { AgentFactory } from './agent-factory.ts'
import { withInstruction } from './instruction-marks.ts'

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
  /** Late-bound app deps: the deliverable checks read the library and open decisions. */
  app?: () => Deps | undefined
  now?: () => number
  log?: { warn(message: string): void }
}

export interface ProgramService extends ProgramRunner {
  /**
   * A run that parked on a decision (`escalate`, `request_authority`) and finished in the turn the
   * answer continued: its deliverables are checked now, with the same fix-up turn, unless they
   * were checked already. Resolves when the checks (and the fix-up turn) are done.
   */
  verifyResumed(sessionId: string): Promise<void>
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
  function send(
    def: AgentDef,
    sessionId: string,
    prompt: string,
    files: FileUIPart[] = [],
  ): Promise<string | undefined> {
    const session = factory.openSession(def, sessionId)
    // the prompt is the system's, not a person's: the stored message is flagged `instruction`
    return withInstruction(sessionId, () => {
      const run = session.send(files.length === 0 ? prompt : { text: prompt, files }, {
        output: { schema: REPORT_SCHEMA, description: 'The final report of this program run.' },
        ifBusy: 'reject',
        maxSteps: PROGRAM_RUN_MAX_STEPS,
        // every call reserves its worst case against the budgets: a run gets the cap its budget can
        // afford, not the agent-wide one (`programMaxOutputTokens`)
        ...factory.programTurn(def, sessionId),
      })
      return run.result.then(
        (result) => (result as { stop?: string }).stop,
        (error: unknown) => {
          log.warn(`program run ${sessionId} failed: ${errorText(error)}`)
          return undefined
        },
      )
    })
  }

  /**
   * One run of a program: the turn, then the deliverable checks (phase H). Failing files get ONE
   * fix-up turn in the same session with the exact problems (the real Verify step); still failing:
   * the run is partial and a decision is open (`app/deliverables.ts`). A run whose report says
   * failed or needs_decision is not checked: that report already asks for attention.
   */
  async function runChecked(
    program: Program,
    def: AgentDef,
    sessionId: string,
    prompt: string,
    task?: Task,
  ): Promise<string | undefined> {
    const stop = await send(
      def,
      sessionId,
      prompt,
      task === undefined ? [] : await inputFiles(task),
    )
    const out = await verify(program, def, sessionId, stop)
    noticeReview(sessionId)
    await journalRun(program, sessionId)
    return out
  }

  /** One line in the daily works journal for a run that ended (not one that parked or is running). */
  async function journalRun(program: Program, sessionId: string): Promise<void> {
    const app = deps.app?.()
    const task = deps.tasks.getBySession(sessionId)
    if (app === undefined || task === undefined || task.status === 'running') return
    await journalProgramRun(app, program, task)
  }

  /**
   * Work waiting in Review tells the bell, once per task round (D11 of the e2e pass): finished work
   * the client has not looked at is the client's turn, and no page they are not on says so.
   */
  function noticeReview(sessionId: string): void {
    const app = deps.app?.()
    const task = deps.tasks.getBySession(sessionId)
    if (app === undefined || task === undefined || !inReview(task)) return
    try {
      postNotice(app, {
        key: `review:${task.id}:${task.round}`,
        title: `Ready for review: ${task.title}`.slice(0, 160),
        body: task.summary ?? 'The work is done and waits for you to accept it or send it back.',
        link: `/tasks/${task.id}`,
        agentId: task.agentId,
        at: clock(),
      })
    } catch (error) {
      log.warn(`review notice of ${task.id} not posted: ${errorText(error)}`)
    }
  }

  /**
   * The deliverable checks after a turn (see `runChecked`). Shared by a run that ended in its own
   * turn and by a run that parked on a decision and ended in the turn the answer continued.
   */
  async function verify(
    program: Program,
    def: AgentDef,
    sessionId: string,
    stop: string | undefined,
  ): Promise<string | undefined> {
    const app = deps.app?.()
    if (program.deliverables.length === 0 || app === undefined || stop !== 'complete') return stop
    const reported = (): boolean => {
      const status = deps.tasks.getBySession(sessionId)?.report?.status
      return status === 'done' || status === 'partial'
    }
    try {
      if (!reported()) return stop
      let task = deps.tasks.getBySession(sessionId) as Task
      let checks = await checkRun(app, program, task)
      if (allPass(checks)) {
        finishRun(app, program, task, checks, 1)
        return stop
      }
      const second = await send(def, sessionId, fixUpPrompt(checks))
      if (second !== 'complete' || !reported()) return second
      task = deps.tasks.getBySession(sessionId) as Task
      checks = await checkRun(app, program, task)
      finishRun(app, program, task, checks, 2)
      return second
    } catch (error) {
      log.warn(`deliverable checks of ${sessionId} failed: ${errorText(error)}`)
      return stop
    }
  }

  /**
   * The image and PDF uploads among the task inputs, as file parts of the first message, so a
   * worker that must see a photo sees it (the path stays in the prompt). Same rules as a chat
   * attachment: under /uploads, allowed type, at most MAX_UPLOAD_BYTES. Text-like uploads and
   * other library paths stay paths the worker reads with its tools. An input that fails a check is
   * left as a path.
   */
  async function inputFiles(task: Task): Promise<FileUIPart[]> {
    const uploads = deps.app?.()?.uploads
    if (uploads === undefined) return []
    const out: FileUIPart[] = []
    for (const input of task.inputs) {
      try {
        if (!input.startsWith(`${UPLOADS_ROOT}/`)) continue
        const path = uploadPathOfUrl(libraryUrl(input))
        if (path === undefined) continue
        const meta = await uploads.stat(path)
        if (meta === undefined || meta.size > MAX_UPLOAD_BYTES) continue
        const type = meta.mediaType.toLowerCase().split(';')[0]?.trim() ?? ''
        if (!isAllowedMediaType(type)) continue
        if (!type.startsWith('image/') && type !== 'application/pdf') continue
        out.push({
          type: 'file',
          mediaType: meta.mediaType,
          url: libraryUrl(path),
          filename: path.split('/').pop() ?? path,
        })
      } catch (error) {
        log.warn(`task input ${input} not attached: ${errorText(error)}`)
      }
    }
    return out
  }

  /**
   * Why a run can not start at all, or undefined. Only what makes a run loop: tools the authority
   * names that channel-less agents never have. Everything else the run finds out itself, with a
   * refusal it can read.
   */
  function unrunnable(program: Program, def: AgentDef): string | undefined {
    const problems = toolWarnings(
      program.authority,
      factory.toolAvailability(def, program.authority),
    )
      .filter((w) => w.code === 'channel-not-bound')
      .map((w) => w.message)
    return problems.length === 0
      ? undefined
      : `Program "${program.name}" cannot run: ${problems.join(' ')}`
  }

  /**
   * A run that cannot start is refused before it exists: no task, no session, nothing on the board
   * (a refused run is not a failed run, so it never counts in the digest or the heartbeat). A
   * manual start gets the 409 with the reason, and the editor warned at save. A scheduled start
   * pauses its routine, and the owner is told once by the routine-paused alarm (P54), not here.
   */
  function refuse(_program: Program, _def: AgentDef, reason: string, _scheduled: boolean): never {
    throw conflict(reason, 'PROGRAM_UNRUNNABLE')
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
    const promptOf = (task: Task, at: number): string =>
      workItemPrompt(program, task, base, {
        title: task.title,
        programId: program.id,
        runAt: at,
      })
    // a recovered fire: its first task is claimed (and may have started)
    const claimed = deps.tasks.getBySession(first)
    if (claimed !== undefined && (await exists(first))) return { sessionId: first, started: false }
    const row = claimed ?? deps.tasks.claimNext(def.id, first, clock())
    if (row === undefined) return { sessionId: first, started: false, idle: true }
    announce(def, first, row, claimed === undefined)

    const firstEnd = runChecked(program, def, first, promptOf(row, runAt), row)
    track(
      (async () => {
        let stop = await firstEnd
        let done = 1
        let offset = 0
        while (done < maxTasks && (stop === 'complete' || stop === 'tool-pending')) {
          // the next task is claimed only now, so a run that stops early holds nothing back
          let sessionId: string
          let at: number
          do {
            at = runAt + ++offset
            sessionId = programSessionId(program.id, at)
          } while (deps.tasks.getBySession(sessionId) !== undefined || (await exists(sessionId)))
          const next = deps.tasks.claimNext(def.id, sessionId, clock())
          if (next === undefined) break
          announce(def, sessionId, next, true)
          stop = await runChecked(program, def, sessionId, promptOf(next, at), next)
          done++
        }
      })().catch((error: unknown) =>
        log.warn(`worker run of ${program.id} failed: ${errorText(error)}`),
      ),
    )
    return { sessionId: first, started: true }
  }

  return {
    async start(stored: Program, { runAt, scheduled }) {
      const def = deps.agents.get(stored.agentId)
      if (def === undefined) throw notFound('agent', stored.agentId)
      if (def.archivedAt !== null) throw conflict('the agent is archived', 'AGENT_ARCHIVED')
      await factory.prepare(def)
      // file mode (P57): the brief and agreements are read from their library files now; a file
      // that cannot be read leaves the saved copy and raises an alarm (authority never comes from files)
      const app = deps.app?.()
      const program = app === undefined ? stored : (await resolveProgramText(app, stored)).program
      const sessionId = programSessionId(program.id, runAt)
      if (program.worker != null) {
        const reason = unrunnable(program, def)
        // nothing is claimed for a run that cannot work: the queue keeps its tasks
        if (reason !== undefined && !(await exists(sessionId)))
          refuse(program, def, reason, scheduled === true)
        return startWorker(program, def, runAt)
      }

      // a recovered fire or a double click: the run exists already
      if (await exists(sessionId)) return { sessionId, started: false }
      const reason = unrunnable(program, def)
      if (reason !== undefined) refuse(program, def, reason, scheduled === true)

      const t = clock()
      const prompt = programRunPrompt(
        program,
        { title: program.name, programId: program.id, runAt },
        deps.app?.()?.programMemory.list(program.id) ?? [],
        t,
      )
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
      track(runChecked(program, def, sessionId, prompt))
      return { sessionId, started: true }
    },

    startTask(task) {
      const def = deps.agents.get(task.agentId)
      const failed = (why: string): void => {
        // the row was claimed as running: a run that cannot start must not stay "running" forever
        const row = deps.tasks.update(task.sessionId, {
          status: 'failed',
          pendingKind: null,
          now: clock(),
          summary: why,
        })
        if (row !== undefined) {
          deps.events.append({
            type: 'task-changed',
            agentId: row.agentId,
            sessionId: row.sessionId,
            payload: {
              taskId: row.id,
              status: row.status,
              pendingKind: null,
              title: row.title,
              parentSessionId: null,
            },
            at: clock(),
          })
        }
      }
      const ended = (async (): Promise<void> => {
        if (def === undefined || def.archivedAt !== null) {
          failed('The agent is gone or archived, so the task could not start.')
          return
        }
        try {
          await factory.prepare(def)
          announce(def, task.sessionId, task, false)
          const stop = await send(def, task.sessionId, taskRunPrompt(task), await inputFiles(task))
          noticeReview(task.sessionId)
          // the turn never started (the provider or the session was unavailable): say so
          if (stop === undefined && deps.tasks.getBySession(task.sessionId)?.status === 'running') {
            failed('The task could not start: the session or the model provider was unavailable.')
          }
        } catch (error) {
          log.warn(`task ${task.id} failed to start: ${errorText(error)}`)
          failed(`The task could not start: ${errorText(error)}`.slice(0, 500))
        }
      })()
      track(ended)
      return { ended }
    },

    inspect(agentId, authority) {
      const def = deps.agents.get(agentId)
      if (def === undefined) return undefined
      const sources = factory.authoritySources(def, authority)
      return sources === undefined ? undefined : inspectAuthority(authority, sources)
    },

    async prepare(agentId) {
      const def = deps.agents.get(agentId)
      if (def !== undefined) await factory.prepare(def)
    },

    async check({ agentId, authority, budget }) {
      const def = deps.agents.get(agentId)
      if (def === undefined) throw notFound('agent', agentId)
      await factory.prepare(def)
      return [
        ...toolWarnings(authority, factory.toolAvailability(def, authority)),
        ...budgetWarnings(budget, factory.modelInfo(def)),
      ]
    },

    async verifyResumed(sessionId) {
      const parsed = parseProgramSession(sessionId)
      const task = deps.tasks.getBySession(sessionId)
      // not a program run, or already checked (a failing check is re-checked by the decision)
      if (parsed === undefined || task === undefined || task.deliverables != null) return
      const program = deps.app?.()?.programs.get(parsed.programId)
      const def = program === undefined ? undefined : deps.agents.get(program.agentId)
      if (program === undefined || def === undefined) return
      await verify(program, def, sessionId, 'complete')
      noticeReview(sessionId)
    },

    async idle() {
      while (inflight.size > 0) await Promise.allSettled([...inflight])
    },
  }
}
