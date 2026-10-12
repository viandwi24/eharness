/**
 * Rehearsals (docs/plans/P40-team-autonomous-operations.md, phase K): a program runs on sample
 * data in a safe mode so the client sees what it does before activating it.
 *
 * The run is an ordinary session `rehearsal:<programId>:<ts>` of the program's agent, under the
 * authority of the program, with the differences the rest of the server enforces by session id:
 * the file tools see an overlay (`rehearsal-registry.ts`), the permission gate simulates external
 * writes, the decision tools record "would ask", the budget is a ledger scope of its own, and the
 * run profile makes it no task (so no board, run history, digest or heartbeat effect).
 *
 * This service creates the overlay (sample files copied from the library or attached), starts the
 * turn with the program's run prompt plus a short rehearsal note, runs the deliverable checks
 * against the overlay (with the same one fix-up turn as a real run), records the result and, for a
 * test case, judges the expectations. The rehearsal row is saved as it goes, so the web shows the
 * simulated actions and would-ask decisions of a run that is still going.
 */
import { errorText } from 'eharness'
import type { FileSystem } from 'eharness/filesystem'
import { inMemoryFs } from 'eharness/filesystem/memory'
import { z } from 'zod'
import type {
  AgentRepo,
  ProgramStore,
  ProgramTestStore,
  RehearsalRunner,
  RehearsalStore,
} from '../../app/ports.ts'
import type { AgentDef } from '../../domain/agents.ts'
import {
  allPass,
  type DeliverableCheck,
  type DeliverableResult,
  evaluateDeliverables,
  fixUpPrompt,
  type TokenContext,
} from '../../domain/deliverables.ts'
import { conflict, invalid, notFound } from '../../domain/errors.ts'
import {
  PROGRAM_RUN_MAX_STEPS,
  type Program,
  parseReport,
  programRunPrompt,
} from '../../domain/programs.ts'
import {
  copyTarget,
  evaluateExpect,
  KEEP_REHEARSALS,
  MAX_COPIED_BYTES,
  MAX_COPIED_FILES,
  MAX_RECORDED_ACTIONS,
  MAX_RESULT_FILE_BYTES,
  MAX_RESULT_FILES,
  MAX_RESULT_TOTAL_BYTES,
  MAX_RUNNING_REHEARSALS,
  programFingerprint,
  REHEARSAL_DEFAULT_BUDGET_USD,
  REHEARSAL_NOTE,
  type Rehearsal,
  type RehearsalFile,
  type RehearsalSample,
  rehearsalSessionId,
  type TestResult,
} from '../../domain/rehearsal.ts'
import type { Task } from '../../domain/tasks.ts'
import { workItemPrompt } from '../../domain/work-queue.ts'
import type { AgentFactory } from './agent-factory.ts'
import { clearInstruction, markInstruction } from './instruction-marks.ts'
import { type OverlayFs, overlayFs } from './overlay-fs.ts'
import { type RehearsalRecorder, rehearsalSessions } from './rehearsal-registry.ts'

/** The structured report of a program run (same shape as `program-service.ts`). */
const REPORT_SCHEMA = z.object({
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

export interface RehearsalServiceDeps {
  agents: AgentRepo
  rehearsals: RehearsalStore
  tests: ProgramTestStore
  programs: Pick<ProgramStore, 'get'>
  /** The real library: copied from into the overlay and read through it, never written. */
  library: FileSystem
  ids: () => string
  now?: () => number
  log?: { warn(message: string): void }
}

export interface RehearsalService extends RehearsalRunner {
  /** Rehearsals and test chains started by this process that have not ended (tests wait for them). */
  idle(): Promise<void>
}

export function createRehearsalService(
  factory: AgentFactory,
  deps: RehearsalServiceDeps,
): RehearsalService {
  const clock = deps.now ?? (() => Date.now())
  const log = deps.log ?? { warn() {} }
  const inflight = new Set<Promise<unknown>>()
  const track = <T>(promise: Promise<T>): Promise<T> => {
    inflight.add(promise)
    void promise.finally(() => inflight.delete(promise))
    return promise
  }
  const running = new Set<string>() // rehearsal ids running in this process
  const runningPrograms = new Set<string>()

  // --- the overlay -----------------------------------------------------------------------------

  /** Copy a library file or directory into the scratch; the number of files copied. */
  async function copyInto(
    scratch: FileSystem,
    entry: string,
    budget: { files: number; bytes: number },
  ): Promise<number> {
    const target = copyTarget(entry)
    const paths =
      target.kind === 'dir'
        ? (await deps.library.list(target.path)).map((m) => m.path)
        : (await deps.library.stat?.(target.path)) == null
          ? []
          : [target.path]
    for (const path of paths) {
      if (++budget.files > MAX_COPIED_FILES) {
        throw invalid(`the sample copies more than ${MAX_COPIED_FILES} files`, 'INVALID_SAMPLE')
      }
      const file = await deps.library.readBytes?.(path)
      if (file === null || file === undefined) continue
      budget.bytes += file.bytes.byteLength
      if (budget.bytes > MAX_COPIED_BYTES) {
        throw invalid(`the sample copies more than ${MAX_COPIED_BYTES} bytes`, 'INVALID_SAMPLE')
      }
      await scratch.writeBytes?.(path, file.bytes, {
        ...(file.mediaType === undefined ? {} : { mediaType: file.mediaType }),
      })
    }
    return paths.length
  }

  /** The scratch with the sample in it, and the overlay over the library (or over nothing). */
  async function prepare(
    sample: RehearsalSample,
  ): Promise<{ overlay: OverlayFs; seeded: Map<string, string> }> {
    const scratch = inMemoryFs()
    const budget = { files: 0, bytes: 0 }
    for (const entry of sample.copy) {
      if ((await copyInto(scratch, entry, budget)) === 0) {
        throw invalid(`the sample copies ${entry}, but nothing is there`, 'INVALID_SAMPLE')
      }
    }
    // the inputs of a sample task are library paths: with `reads: sample` they must be in the overlay
    if (sample.reads === 'sample') {
      for (const input of sample.task?.inputs ?? []) await copyInto(scratch, input, budget)
    }
    for (const file of sample.files) await scratch.write(file.path, file.content)
    const seeded = new Map((await scratch.list('/')).map((m) => [m.path, m.version]))
    const overlay = overlayFs({ base: sample.reads === 'library' ? deps.library : null, scratch })
    return { overlay, seeded }
  }

  // --- the result ------------------------------------------------------------------------------

  /** What the run produced: new or changed files of the scratch, with their content up to the caps. */
  async function producedFiles(
    overlay: OverlayFs,
    seeded: Map<string, string>,
  ): Promise<RehearsalFile[]> {
    const out: RehearsalFile[] = []
    let total = 0
    for (const meta of await overlay.scratch.list('/')) {
      if (seeded.get(meta.path) === meta.version) continue
      if (out.length >= MAX_RESULT_FILES) break
      const file = await overlay.scratch.readBytes?.(meta.path)
      const size = file?.bytes.byteLength ?? meta.size
      const mediaType = file?.mediaType ?? meta.mediaType ?? null
      const keep =
        file !== null &&
        file !== undefined &&
        size <= MAX_RESULT_FILE_BYTES &&
        total + size <= MAX_RESULT_TOTAL_BYTES
      if (!keep) {
        out.push({ path: meta.path, size, mediaType, text: null, base64: null, truncated: true })
        continue
      }
      total += size
      if (meta.binary === true) {
        out.push({
          path: meta.path,
          size,
          mediaType,
          text: null,
          base64: Buffer.from(file.bytes).toString('base64'),
          truncated: false,
        })
      } else {
        out.push({
          path: meta.path,
          size,
          mediaType,
          text: new TextDecoder().decode(file.bytes),
          base64: null,
          truncated: false,
        })
      }
    }
    return out
  }

  /** Every tool the session called, in order (the final answer tool excluded). */
  async function toolsCalledIn(sessionId: string): Promise<string[]> {
    const names: string[] = []
    const messages = await factory.peek(sessionId).messages({ limit: 1000 })
    for (const message of messages) {
      for (const part of message.parts as Array<{ type: string; toolName?: string }>) {
        const name =
          part.type === 'dynamic-tool'
            ? part.toolName
            : part.type.startsWith('tool-')
              ? part.type.slice('tool-'.length)
              : undefined
        if (name !== undefined && name !== 'final_answer') names.push(name)
      }
    }
    return names
  }

  // --- the run ---------------------------------------------------------------------------------

  /** Send one turn; how it ended and the report it gave. */
  async function turn(
    def: AgentDef,
    sessionId: string,
    prompt: string,
  ): Promise<{ stop: string; report: Rehearsal['report']; error: string | null }> {
    const session = factory.openSession(def, sessionId)
    // the prompt is the system's: the stored message is flagged `instruction`
    markInstruction(sessionId)
    const run = session.send(prompt, {
      output: { schema: REPORT_SCHEMA, description: 'The final report of this program run.' },
      ifBusy: 'reject',
      maxSteps: PROGRAM_RUN_MAX_STEPS,
    })
    try {
      const result = (await run.result) as {
        stop: string
        output?: unknown
        error?: { message?: string }
      }
      return {
        stop: result.stop,
        report: parseReport(result.output) ?? null,
        error: result.error?.message ?? null,
      }
    } catch (error) {
      return { stop: 'error', report: null, error: errorText(error) }
    } finally {
      clearInstruction(sessionId)
    }
  }

  const draftTask = (
    def: AgentDef,
    sessionId: string,
    sample: RehearsalSample,
    at: number,
  ): Task => ({
    id: 'rehearsal-task',
    agentId: def.id,
    sessionId,
    parentSessionId: null,
    origin: 'program',
    title: sample.task?.title ?? 'Sample task',
    status: 'running',
    pendingKind: null,
    startedAt: at,
    endedAt: null,
    summary: null,
    lastActivityAt: at,
    costUsd: 0,
    tokens: 0,
    report: null,
    deliverables: null,
    brief: sample.task?.brief ?? null,
    inputs: sample.task?.inputs ?? [],
    priority: 'normal',
    dueAt: null,
    createdBy: 'client',
    acceptedAt: null,
    round: 1,
    history: [],
    hold: false,
    review: true,
    grants: null,
  })

  async function execute(
    program: Program,
    def: AgentDef,
    initial: Rehearsal,
    overlay: OverlayFs,
    seeded: Map<string, string>,
  ): Promise<void> {
    let current: Rehearsal = initial
    const save = (): void => deps.rehearsals.save(current)
    const recorder: RehearsalRecorder = {
      simulated(action) {
        if (current.simulated.length >= MAX_RECORDED_ACTIONS) return
        current.simulated.push({ ...action, input: plain(action.input), at: clock() })
        save()
      },
      wouldAsk(entry) {
        const again = current.wouldAsk.some(
          (a) => a.kind === entry.kind && a.title === entry.title && a.question === entry.question,
        )
        if (again || current.wouldAsk.length >= MAX_RECORDED_ACTIONS) return
        current.wouldAsk.push({ ...entry, at: clock() })
        save()
      },
    }
    rehearsalSessions.register({
      rehearsalId: current.id,
      sessionId: current.sessionId,
      programId: program.id,
      fs: overlay,
      budgetUsd: current.budgetUsd,
      worker: program.worker != null,
      recorder,
    })
    try {
      const ctx: TokenContext = {
        title: program.worker != null ? (current.sample.task?.title ?? program.name) : program.name,
        programId: program.id,
        runAt: current.startedAt,
      }
      const base = programRunPrompt(program, ctx)
      const prompt = [
        program.worker != null
          ? workItemPrompt(
              program,
              draftTask(def, current.sessionId, current.sample, current.startedAt),
              base,
              ctx,
            )
          : base,
        '',
        REHEARSAL_NOTE,
      ].join('\n')

      const check = async (): Promise<DeliverableCheck[]> =>
        evaluateDeliverables(program.deliverables, ctx, async (path) => {
          const file = await overlay.stat(path)
          if (file === null) return undefined
          try {
            const entry = await overlay.read(path)
            return entry === null ? undefined : { text: entry.content }
          } catch {
            return { text: null } // a binary file
          }
        })

      let first = await turn(def, current.sessionId, prompt)
      let checks: DeliverableCheck[] | null = null
      let attempts = 1
      if (program.deliverables.length > 0 && first.stop === 'complete') {
        checks = await check()
        const reported = first.report?.status === 'done' || first.report?.status === 'partial'
        if (!allPass(checks) && reported) {
          // the same one fix-up turn a real run gets
          const second = await turn(def, current.sessionId, fixUpPrompt(checks))
          attempts = 2
          first = { ...second, report: second.report ?? first.report }
          if (second.stop === 'complete') checks = await check()
        }
      }
      const deliverables: DeliverableResult | null =
        checks === null
          ? null
          : { status: allPass(checks) ? 'pass' : 'fail', attempts, checkedAt: clock(), checks }

      current = {
        ...current,
        status: first.stop === 'complete' ? 'done' : 'failed',
        stop: first.stop,
        error:
          first.stop === 'complete' ? null : failureOf(first.stop, first.error, current.budgetUsd),
        report: first.report,
        deliverables,
      }
    } catch (error) {
      log.warn(`rehearsal ${current.id} failed: ${errorText(error)}`)
      current = { ...current, status: 'failed', stop: 'error', error: errorText(error) }
    }
    // the files, the tools and the cost are read while the overlay still exists
    try {
      current.files = await producedFiles(overlay, seeded)
      current.deleted = overlay.deletedPaths()
      current.toolsCalled = await toolsCalledIn(current.sessionId)
      const stats = await factory.peek(current.sessionId).stats()
      current.costUsd = stats.usage.costUsd ?? 0
    } catch (error) {
      log.warn(`rehearsal ${current.id}: could not read the result: ${errorText(error)}`)
    }
    current.endedAt = clock()
    save()
    rehearsalSessions.release(current.sessionId)
    if (current.testId !== null) judge(program, current)
  }

  /** Judge a test case against the finished rehearsal and store the result on the case. */
  function judge(program: Program, run: Rehearsal): void {
    if (run.testId === null) return
    const test = deps.tests.get(run.testId)
    if (test === undefined) return
    const verdict = evaluateExpect(test.expect, run, program.deliverables.length > 0)
    const result: TestResult = {
      status: verdict.status,
      rehearsalId: run.id,
      programFingerprint: run.programFingerprint,
      failures: verdict.failures,
      at: clock(),
    }
    deps.tests.setResult(test.id, result)
  }

  // --- API -------------------------------------------------------------------------------------

  async function begin(
    program: Program,
    options: { sample: RehearsalSample; budgetUsd: number; testId?: string | null },
  ): Promise<{ rehearsal: Rehearsal; done: Promise<void> }> {
    const def = deps.agents.get(program.agentId)
    if (def === undefined) throw notFound('agent', program.agentId)
    if (def.archivedAt !== null) throw conflict('the agent is archived', 'AGENT_ARCHIVED')
    if (runningPrograms.has(program.id)) {
      throw conflict('a rehearsal of this program is already running', 'REHEARSAL_BUSY')
    }
    if (running.size >= MAX_RUNNING_REHEARSALS) {
      throw conflict(
        `${MAX_RUNNING_REHEARSALS} rehearsals are running: wait for one to finish`,
        'REHEARSAL_BUSY',
      )
    }
    if (program.worker != null && options.sample.task === null) {
      throw invalid(
        'a worker program works on a task: give the rehearsal a sample task (title and brief)',
        'INVALID_SAMPLE',
      )
    }
    await factory.prepare(def)
    const { overlay, seeded } = await prepare(options.sample)

    let startedAt = clock()
    while (deps.rehearsals.getBySession(rehearsalSessionId(program.id, startedAt)) !== undefined) {
      startedAt++
    }
    const rehearsal: Rehearsal = {
      id: deps.ids(),
      programId: program.id,
      programVersion: program.version,
      programFingerprint: programFingerprint(program),
      sessionId: rehearsalSessionId(program.id, startedAt),
      testId: options.testId ?? null,
      status: 'running',
      stop: null,
      error: null,
      sample: options.sample,
      budgetUsd: options.budgetUsd,
      startedAt,
      endedAt: null,
      report: null,
      deliverables: null,
      simulated: [],
      wouldAsk: [],
      toolsCalled: [],
      files: [],
      deleted: [],
      costUsd: 0,
    }
    deps.rehearsals.save(rehearsal)
    deps.rehearsals.prune(program.id, KEEP_REHEARSALS)
    running.add(rehearsal.id)
    runningPrograms.add(program.id)
    const done = track(
      execute(program, def, rehearsal, overlay, seeded)
        .catch((error: unknown) => {
          log.warn(`rehearsal ${rehearsal.id} failed: ${errorText(error)}`)
          const row = deps.rehearsals.get(rehearsal.id) ?? rehearsal
          deps.rehearsals.save({
            ...row,
            status: 'failed',
            error: errorText(error),
            endedAt: clock(),
          })
          rehearsalSessions.release(rehearsal.sessionId)
        })
        .finally(() => {
          running.delete(rehearsal.id)
          runningPrograms.delete(program.id)
        }),
    )
    return { rehearsal, done }
  }

  return {
    async start(program, options) {
      return (await begin(program, options)).rehearsal
    },

    runCases(program, cases) {
      const t = clock()
      for (const c of cases) {
        deps.tests.setResult(c.id, {
          status: 'running',
          rehearsalId: null,
          programFingerprint: programFingerprint(program),
          failures: [],
          at: t,
        })
      }
      track(
        (async () => {
          for (const c of cases) {
            // the case or the program may have changed or gone while earlier cases ran
            const test = deps.tests.get(c.id)
            const fresh = deps.programs.get(program.id)
            if (test === undefined || fresh === undefined) continue
            try {
              const { done } = await begin(fresh, {
                sample: test.sample,
                budgetUsd: REHEARSAL_DEFAULT_BUDGET_USD,
                testId: test.id,
              })
              await done
            } catch (error) {
              deps.tests.setResult(c.id, {
                status: 'error',
                rehearsalId: null,
                programFingerprint: programFingerprint(fresh),
                failures: [`could not start the rehearsal: ${errorText(error)}`],
                at: clock(),
              })
            }
          }
        })(),
      )
    },

    runningCount: () => running.size,

    async messages(sessionId) {
      return factory.peek(sessionId).messages({ limit: 1000 })
    },

    async idle() {
      while (inflight.size > 0) await Promise.allSettled([...inflight])
    },
  }
}

/** A recorded input, as plain JSON (a tool input can hold anything the model sent). */
function plain(value: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(value ?? null))
  } catch {
    return String(value)
  }
}

function failureOf(stop: string, message: string | null, budgetUsd: number): string {
  if (stop === 'cost-cap') return `The rehearsal reached its budget cap of $${budgetUsd}.`
  if (stop === 'tool-pending') {
    return 'The run stopped waiting for an answer that cannot come in a rehearsal.'
  }
  return message === null ? `The run ended with ${stop}.` : `The run ended with ${stop}: ${message}`
}
