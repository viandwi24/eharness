/**
 * Routines on the durable inbox (docs/plans/P32-team-example.md §6.6, decision D3, ADR-0040),
 * scheduled by `eharness/scheduler` (spec 29, ADR-0063) over `schedule-store.ts`: the routines
 * table is the schedule store.
 *
 * Every instance runs `tick()`. One tick is one scheduler tick plus the app's part:
 *
 *  1. **Claim** (library): the due routines (`next_fire_at <= now + lookahead`) are claimed with a
 *     compare-and-set; of several instances exactly one fires a slot. The next slot comes from
 *     `croner` (IANA timezone), injected as the scheduler's `next`. A claim of a dead instance
 *     expires after the lease (`recoverAfterMs`) and is taken over: the slot is fired again.
 *  2. **Fire** (this file's callback): downtime policy (missed slots are skipped and recorded as one
 *     skipped run; with `catchUpWindowMs` the latest slot fires once when it is inside the window),
 *     then the run row of the slot (unique per slot, so a retried fire reuses it), the overlap
 *     check (`skip` looks at the previous run: `session.busy()`, the session's inbox, pending
 *     approvals) and `session.enqueue(prompt, { mode: 'queue', id, availableAt })`; `availableAt` is
 *     the slot when it is still ahead, so a tick a little early fires on time. The id
 *     `sched:<routineId>:<scheduledAt>` makes enqueueing again idempotent.
 *  3. **Sweep** inbox items nobody holds (an instance died after enqueueing): opening the session
 *     drains it.
 *
 * A fire that needs a person is not approved by anyone: its turn ends `tool-pending`, the run is
 * `needs_action`, and the approval waits in `GET /approvals` (a routine task session
 * `routine:<id>:<slot>` is a task of origin `routine`). The outcome of a run (`succeeded`,
 * `failed`, `needs_action`) arrives from the `routineOutcomes` plugin on turn end; consecutive
 * failures pause the routine (`maxFailures`).
 */
import type { Database } from 'bun:sqlite'
import { errorText, uuidv7 } from 'eharness'
import { createScheduler, type FireContext } from 'eharness/scheduler'
import { postNotice } from '../../app/briefings.ts'
import type {
  AgentRepo,
  Deps,
  EventAppender,
  ProgramRunner,
  ProgramStore,
  RoutineEngine,
  ScheduleCalc,
  SessionQueue,
} from '../../app/ports.ts'
import { conflict, notFound } from '../../domain/errors.ts'
import type { EventType } from '../../domain/events.ts'
import { parseSystemKey } from '../../domain/heartbeat.ts'
import { parseProgramSession } from '../../domain/programs.ts'
import {
  fireId,
  parseRoutineSession,
  type Routine,
  type RoutineRun,
  type RoutineSpec,
  routineSessionId,
} from '../../domain/routines.ts'
import { willRetryText } from '../../domain/turn-retry.ts'
import type { SqliteRoutineStore } from '../db/routines-repo.ts'
import type { TaskWriter } from '../db/tasks-repo.ts'
import type { AgentFactory } from './agent-factory.ts'
import type { SystemRunner } from './heartbeat-service.ts'
import { INSTRUCTION_METADATA } from './instruction-marks.ts'
import { sqliteScheduleStore } from './schedule-store.ts'

export interface RoutineEngineConfig {
  /** Ticker interval (ms). Default 15 000; 0 = no timer (tests call `tick()`). */
  tickMs?: number
  /** A slot up to this far ahead fires now with `availableAt = slot`. Default `tickMs`. */
  lookaheadMs?: number
  /** A slot later than this counts as missed (downtime), not late. Default max(2 × tick, 60 s). */
  graceMs?: number
  /** Claim lease: a dead instance's claim is taken over (and its slot fired again) after it. Default 30 s. */
  recoverAfterMs?: number
  /** Routines claimed per tick. Default 50. */
  maxPerTick?: number
}

export interface TickReport {
  /** Runs this tick enqueued (including recovered ones). */
  fired: RoutineRun[]
  skipped: Array<{ routineId: string; scheduledAt: number; reason: string }>
  /** Slots another instance won. */
  lost: number
  recovered: number
  swept: number
}

/** What the `routineOutcomes` plugin reports at the end of a turn. */
export interface TurnOutcome {
  sessionId: string
  /** `metadata.eharness.inboxId` of the turn's input, when it came from the inbox. */
  inboxId?: string
  stop: string
  errorMessage?: string
  /** `TurnResult.error.code` (always set when the turn failed). */
  errorCode?: string
  /** Approvals or questions wait for a person. */
  needsPerson: boolean
  /** The turn failed transiently and will be tried again (`turn-retry-service.ts`): the run is `retrying`. */
  retry?: { attempt: number; max: number; nextAt: number; errorMessage: string }
  /** The automatic retries are used up: the run fails, and says so. */
  retryGaveUp?: boolean
  /** Program runs: the status of the structured final report, when the turn produced one. */
  reportStatus?: string
  reportSummary?: string
}

export interface RoutineOutcomes {
  turnEnded(outcome: TurnOutcome): Promise<void>
}

export interface RoutineService extends RoutineEngine {
  tick(now?: number): Promise<TickReport>
  outcomes: RoutineOutcomes
  /** Start the ticker (no-op when `tickMs` is 0). */
  start(): void
  /** Stop the ticker and wait for a running tick. */
  stop(): Promise<void>
}

export interface RoutineServiceDeps {
  /** The shared connection: the schedule store runs on the `routines` table. */
  sqlite: Database
  agents: AgentRepo
  routines: SqliteRoutineStore
  schedule: ScheduleCalc
  tasks: TaskWriter
  events: EventAppender
  /**
   * Programs: a routine with a `programId` is the schedule of a program, and its fire starts a
   * program run (a task session with a structured report) instead of enqueueing a prompt.
   */
  programs?: { store: Pick<ProgramStore, 'get'>; runner: ProgramRunner }
  /**
   * The heartbeat and the daily digest (`sys:` routines, `domain/heartbeat.ts`): their fire goes to
   * this runner. Late-bound: it needs the app deps, which are built after the routine service.
   */
  system?: () => SystemRunner | undefined
  /**
   * The session a `sessionMode: 'dm'` routine fires into: a live chat thread of the agent (never an
   * archived one, P40 phase M follow-up). Default: the legacy `dm:<agentId>` session.
   */
  dmSession?: (agentId: string) => string
  /** Late-bound app deps: an auto-paused routine tells the bell (D10 of the e2e pass). */
  app?: () => Deps | undefined
  /** The inbox of sessions: shows and clears what keeps a routine from firing. */
  queue?: SessionQueue
  config?: RoutineEngineConfig
  now?: () => number
  log?: { warn(message: string): void }
}

/** What the person does about `EH_PROVIDER_AUTH` (shown as the reason of the failed run). */
const PROVIDER_AUTH_HINT = 'the model provider rejected the API key: set it in Settings > Providers'
const suffix = (message: string | undefined): string =>
  message === undefined ? '' : `: ${message}`

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Failure stops that count against `maxFailures`; the rest is a normal end. */
const NORMAL_STOPS = new Set(['complete', 'length', 'content-filter', 'blocked'])

export function createRoutineService(
  factory: AgentFactory,
  deps: RoutineServiceDeps,
): RoutineService {
  const { routines: store, schedule } = deps
  const clock = deps.now ?? (() => Date.now())
  const log = deps.log ?? { warn() {} }
  const tickMs = deps.config?.tickMs ?? 15_000
  const lookaheadMs = deps.config?.lookaheadMs ?? tickMs
  const graceMs = deps.config?.graceMs ?? Math.max(2 * tickMs, 60_000)
  const recoverAfterMs = deps.config?.recoverAfterMs ?? 30_000
  const sessionOf = (
    routine: Parameters<typeof routineSessionId>[0],
    scheduledAt: number,
  ): string =>
    routine.programId == null && routine.sessionMode === 'dm' && deps.dmSession !== undefined
      ? deps.dmSession(routine.agentId)
      : routineSessionId(routine, scheduledAt)
  const maxPerTick = deps.config?.maxPerTick ?? 50
  const owner = uuidv7()
  const scheduleStore = sqliteScheduleStore(deps.sqlite, {
    lookaheadMs,
    onPaused: (routineId, reason) => {
      const routine = store.get(routineId)
      if (routine !== undefined) {
        emit('routine-changed', routine, null, { change: 'paused', reason }, clock())
      }
    },
  })

  const emit = (
    type: EventType,
    routine: Pick<Routine, 'id' | 'agentId' | 'name'>,
    sessionId: string | null,
    payload: Record<string, unknown>,
    now: number,
  ): void => {
    deps.events.append({
      type,
      agentId: routine.agentId,
      sessionId,
      payload: { routineId: routine.id, name: routine.name, ...payload },
      at: now,
    })
  }

  /** A routine paused itself after too many failures: one bell notice with the reason. */
  const noticePaused = (routine: Routine, run: RoutineRun | undefined, now: number): void => {
    const app = deps.app?.()
    if (app === undefined) return
    const reason = run?.reason ?? routine.lastStatus ?? 'it failed repeatedly'
    try {
      postNotice(app, {
        key: `routine-paused:${routine.id}:${run?.id ?? now}`,
        title: `Routine "${routine.name}" paused itself`.slice(0, 160),
        body: `It failed ${routine.maxFailures} times in a row (last: ${reason}). Fix the cause, then resume it from the Routines page.`,
        link: routine.programId === null ? '/routines' : `/programs/${routine.programId}`,
        agentId: routine.agentId,
        at: now,
      })
    } catch (error) {
      deps.log?.warn(`pause notice of ${routine.id} not posted: ${errorText(error)}`)
    }
  }

  const emitRun = (routine: Routine, run: RoutineRun, now: number): void =>
    emit(
      'routine-fired',
      routine,
      run.sessionId,
      {
        runId: run.id,
        scheduledAt: run.scheduledAt,
        trigger: run.trigger,
        status: run.status,
        ...(run.reason === null ? {} : { reason: run.reason }),
      },
      now,
    )

  /** The latest slot in `(from, to]`, or null. Bounded: a window of a busy cron stays cheap. */
  function latestSlot(spec: RoutineSpec, from: number, to: number): number | null {
    let latest: number | null = null
    let slot = schedule.next(spec, from)
    for (let i = 0; slot !== null && slot <= to && i < 5000; i++) {
      latest = slot
      slot = schedule.next(spec, slot)
    }
    return latest
  }

  /** The session whose inbox keeps this routine from firing: its chat (`dm`) or its last run's. */
  function queueSessionOf(routine: Routine): string | null {
    if (routine.programId != null) return null
    if (routine.sessionMode === 'dm') return sessionOf(routine, clock())
    return store.runs(routine.id, 1)[0]?.sessionId ?? null
  }

  /** Why the previous fire is still in the way (`overlap: 'skip'`), or undefined. */
  async function overlapReason(routine: Routine, run: { id: string; sessionId: string }) {
    let sessionId: string
    if (routine.sessionMode === 'dm') {
      sessionId = run.sessionId
    } else {
      const previous = store.previousFiredRun(routine.id, run.id)
      if (previous === undefined) return undefined
      if (previous.status === 'claimed') return 'overlap: the previous fire is being started'
      if (previous.status === 'retrying') return 'overlap: the previous run is waiting to retry'
      sessionId = previous.sessionId
    }
    // read handle: looking never opens a session or runs its hooks
    const peek = factory.peek(sessionId)
    if ((await peek.busy()) !== null) return 'overlap: the previous run is still running'
    const inbox = await factory.storage.inbox.stats?.({ sessionId })
    if (inbox !== undefined && inbox.ready + inbox.claimed + inbox.delayed > 0) {
      return 'overlap: an input of the session is still queued'
    }
    if ((await peek.pending()) !== null) return 'overlap: the previous run waits for an approval'
    return undefined
  }

  /** Enqueue the fire of a claimed run. Idempotent: the same slot always has the same id. */
  async function dispatch(
    routine: Routine,
    run: RoutineRun,
    now: number,
    opts: { checkOverlap: boolean },
  ): Promise<RoutineRun> {
    const fail = (reason: string): RoutineRun => {
      const done = store.finishRun(run.id, { status: 'failed', reason }, now)
      if (done?.paused === true) {
        emit('routine-changed', routine, null, { change: 'paused', reason: 'max-failures' }, now)
        noticePaused(done.routine, done.run, now)
      }
      const after = done?.run ?? (store.getRun(run.id) as RoutineRun)
      emitRun(routine, after, now)
      return after
    }
    const def = deps.agents.get(routine.agentId)
    if (def === undefined || def.archivedAt !== null) return fail('the agent is archived')
    try {
      if (opts.checkOverlap && routine.overlap === 'skip') {
        const reason = await overlapReason(routine, run)
        if (reason !== undefined) {
          store.markSkipped(run.id, reason, now)
          const after = store.getRun(run.id) as RoutineRun
          emitRun(routine, after, now)
          return after
        }
      }
      if (parseSystemKey(routine.programId) !== undefined) {
        return await dispatchSystem(routine, run, now)
      }
      if (routine.programId != null) return await dispatchProgram(routine, run, now)
      await factory.prepare(def)
      const session = factory.openSession(def, run.sessionId)
      const ahead = run.scheduledAt > now && run.trigger === 'schedule'
      const result = await session.enqueue(routine.prompt, {
        mode: 'queue',
        id: fireId(routine.id, run.scheduledAt),
        ...(ahead ? { availableAt: run.scheduledAt } : {}),
        // a routine prompt is the system's: the web shows it as an Instructions card
        metadata: INSTRUCTION_METADATA,
      })
      store.markEnqueued(run.id, {
        inboxId: result.inboxId,
        // a slot claimed a little ahead runs at the slot (`availableAt`), never before it
        firedAt: ahead ? run.scheduledAt : now,
        ...(result.duplicate === true ? { reason: 'duplicate enqueue' } : {}),
      })
      const after = store.getRun(run.id) as RoutineRun
      emitRun(routine, after, now)
      return after
    } catch (error) {
      return fail(`enqueue failed: ${errorText(error)}`)
    }
  }

  /**
   * A fire of a program's routine: the run is the task session `program:<id>:<slot>`. The turn
   * carries a structured-output spec, which the durable inbox cannot hold, so the program runner
   * sends it directly; the deterministic session id keeps a recovered fire from running twice.
   */
  async function dispatchProgram(
    routine: Routine,
    run: RoutineRun,
    now: number,
  ): Promise<RoutineRun> {
    const programs = deps.programs
    const program = programs?.store.get(routine.programId as string)
    if (programs === undefined || program === undefined) {
      const done = store.finishRun(
        run.id,
        { status: 'failed', reason: 'the program was deleted' },
        now,
      )
      const after = done?.run ?? (store.getRun(run.id) as RoutineRun)
      emitRun(routine, after, now)
      return after
    }
    if (program.status !== 'active') {
      store.markSkipped(run.id, 'the program is paused', now)
      const after = store.getRun(run.id) as RoutineRun
      emitRun(routine, after, now)
      return after
    }
    let started: Awaited<ReturnType<typeof programs.runner.start>>
    try {
      started = await programs.runner.start(program, { runAt: run.scheduledAt, scheduled: true })
    } catch (error) {
      if ((error as { code?: unknown }).code !== 'PROGRAM_UNRUNNABLE') throw error
      // a configuration problem: every later tick would be refused the same way, so the schedule
      // pauses at the first refusal (not a failure; the reason is shown, resume after fixing it)
      const reason = error instanceof Error ? error.message : String(error)
      store.markSkipped(run.id, reason, now)
      store.update(
        routine.id,
        { status: 'paused', pausedReason: 'unrunnable', lastStatus: `paused: ${reason}` },
        now,
      )
      emit('routine-changed', routine, null, { change: 'paused', reason: 'unrunnable' }, now)
      const after = store.getRun(run.id) as RoutineRun
      emitRun(routine, after, now)
      return after
    }
    if (started.idle === true) {
      // a worker program with nothing queued: not a run, nothing to report
      store.markSkipped(run.id, 'no queued tasks', now)
      const after = store.getRun(run.id) as RoutineRun
      emitRun(routine, after, now)
      return after
    }
    store.markEnqueued(run.id, {
      inboxId: `direct:${started.sessionId}`,
      firedAt: now,
      ...(started.started ? {} : { reason: 'duplicate start' }),
    })
    const after = store.getRun(run.id) as RoutineRun
    emitRun(routine, after, now)
    return after
  }

  /**
   * A fire of the heartbeat or the digest: the runner decides (a skip costs no model call). The
   * routine run is finished here, because the beat itself ends in its own session; its outcome is
   * the beat history. These runs are internal: they never appear in a `TickReport`.
   */
  async function dispatchSystem(
    routine: Routine,
    run: RoutineRun,
    now: number,
  ): Promise<RoutineRun> {
    const system = deps.system?.()
    const key = parseSystemKey(routine.programId)
    if (system === undefined || key === undefined) {
      store.finishRun(run.id, { status: 'failed', reason: 'no heartbeat runner' }, now)
      return store.getRun(run.id) as RoutineRun
    }
    try {
      if (key.kind === 'reminder') {
        const out = (await system.reminder?.(key.id, { slot: run.scheduledAt })) ?? {
          posted: false,
          reason: 'reminders are not set up',
        }
        if (!out.posted) {
          store.markSkipped(run.id, out.reason ?? 'skipped', now)
          return store.getRun(run.id) as RoutineRun
        }
      } else if (key.kind === 'order') {
        // the exact wake of a deadline order: a beat for that order only
        const out = await system.heartbeat(key.agentId, {
          slot: run.scheduledAt,
          trigger: 'deadline',
          orderId: key.orderId,
        })
        if (!out.started) {
          store.markSkipped(run.id, out.reason ?? 'skipped', now)
          return store.getRun(run.id) as RoutineRun
        }
      } else if (key.kind === 'heartbeat') {
        const out = await system.heartbeat(key.agentId, { slot: run.scheduledAt })
        if (!out.started) {
          store.markSkipped(run.id, out.reason ?? 'skipped', now)
          return store.getRun(run.id) as RoutineRun
        }
      } else {
        const out = await system.digest({ slot: run.scheduledAt })
        if (out === 'duplicate' || out === 'off') {
          store.markSkipped(run.id, out === 'off' ? 'the digest is off' : 'already sent today', now)
          return store.getRun(run.id) as RoutineRun
        }
      }
      store.markEnqueued(run.id, { inboxId: `direct:${routine.programId}`, firedAt: now })
      store.finishRun(run.id, { status: 'succeeded' }, now)
    } catch (error) {
      store.finishRun(run.id, { status: 'failed', reason: errorText(error) }, now)
    }
    return store.getRun(run.id) as RoutineRun
  }

  /** One slot the scheduler hands over (spec 29 §3): the app's part of a fire. */
  async function fireSlot(ctx: FireContext, now: number, report: TickReport): Promise<void> {
    const row = store.get(ctx.schedule.id)
    if (row === undefined) return
    const scheduledAt = ctx.scheduledAt
    const def = deps.agents.get(row.agentId)
    if (def === undefined || def.archivedAt !== null) {
      if (store.pause(row.id, 'agent-archived', now)) {
        emit('routine-changed', row, null, { change: 'paused', reason: 'agent-archived' }, now)
      }
      return
    }
    const expected = ctx.schedule.nextFireAt as number
    if (now - expected > graceMs) {
      // downtime: never replay every missed slot; only the latest one inside the catch-up window
      const latest =
        row.catchUpWindowMs === null
          ? null
          : latestSlot(row.schedule, now - row.catchUpWindowMs, now)
      if (latest === null) {
        const { run, created } = store.openSlot({
          routineId: row.id,
          scheduledAt: expected,
          fire: false,
          status: 'skipped',
          reason: 'missed',
          sessionId: sessionOf(row, expected),
          now,
        })
        if (created) {
          report.skipped.push({ routineId: row.id, scheduledAt: expected, reason: 'missed' })
          emitRun(row, run, now)
        }
        return
      }
      if (scheduledAt !== latest) return
    }
    const { run, created } = store.openSlot({
      routineId: row.id,
      scheduledAt,
      fire: true,
      status: 'claimed',
      sessionId: sessionOf(row, scheduledAt),
      now,
    })
    // an existing row still `claimed` is a fire that died before it enqueued: dispatch it again
    // (the enqueue id dedupes, so no overlap check); any other status was handled already
    if (!created && run.status !== 'claimed') return
    const done = await dispatch(row, run, now, { checkOverlap: created })
    if (!created) {
      report.recovered++
      if (done.status === 'enqueued') report.fired.push(done)
      return
    }
    if (parseSystemKey(row.programId) !== undefined) return
    if (done.status === 'skipped') {
      report.skipped.push({ routineId: row.id, scheduledAt, reason: done.reason ?? '' })
    } else {
      report.fired.push(done)
    }
  }

  /**
   * Safety net: a run still `claimed` after the lease belongs to a fire that died after opening it
   * and whose slot is already behind the schedule (a lease takeover covers the rest). The first
   * attempt may already have enqueued (the id dedupes), so no overlap check here.
   */
  async function recover(now: number, report: TickReport): Promise<void> {
    for (const run of store.staleClaims(now - recoverAfterMs)) {
      const routine = store.get(run.routineId)
      if (routine === undefined) continue
      const done = await dispatch(routine, run, now, { checkOverlap: false })
      if (done.status === 'enqueued') report.fired.push(done)
      report.recovered++
    }
  }

  /** Open the sessions that have claimable inbox items nobody holds: opening drains them. */
  async function sweep(): Promise<number> {
    const ids = (await factory.storage.inbox.pending?.({ limit: 50 })) ?? []
    let opened = 0
    for (const sessionId of ids) {
      const parsed = parseRoutineSession(sessionId)
      const dm = /^dm:([^:]+)$/.exec(sessionId)
      const agentId =
        parsed !== undefined
          ? store.get(parsed.routineId)?.agentId
          : dm !== null
            ? (dm[1] as string)
            : deps.tasks.getBySession(sessionId)?.agentId
      const def = agentId === undefined ? undefined : deps.agents.get(agentId)
      if (def === undefined || def.archivedAt !== null) continue
      await factory.prepare(def)
      factory.openSession(def, sessionId)
      opened++
    }
    return opened
  }

  let stopped = false
  let ticking: Promise<TickReport> | undefined
  /** One-shot wake-ups at slots that are ahead of a tick (only while the ticker runs). */
  const wakeups = new Map<number, ReturnType<typeof setTimeout>>()
  function wakeAt(slot: number): void {
    if (timer === undefined || stopped || wakeups.has(slot)) return
    const wake = setTimeout(
      () => {
        wakeups.delete(slot)
        if (stopped) return
        void service.tick().catch((error) => log.warn(`routines: tick failed: ${errorText(error)}`))
      },
      Math.max(0, slot - clock()) + 5,
    )
    wake.unref()
    wakeups.set(slot, wake)
  }
  async function runTick(now: number): Promise<TickReport> {
    const report: TickReport = { fired: [], skipped: [], lost: 0, recovered: 0, swept: 0 }
    await recover(now, report).catch((e) => log.warn(`routines: recovery failed: ${errorText(e)}`))
    // The scheduler runs `lookaheadMs` ahead of the clock (a slot a little ahead is claimed and
    // fires with `availableAt`); its grace grows by the same amount, so a slot is missed when it
    // is more than `graceMs` behind the real clock.
    const scheduler = createScheduler({
      store: scheduleStore,
      now: () => now + lookaheadMs,
      graceMs: graceMs + lookaheadMs,
      leaseMs: recoverAfterMs,
      maxPerTick,
      owner,
      next: (expr, after, timezone) =>
        schedule.next({ kind: 'cron', expr, tz: timezone ?? 'UTC' }, after) ?? undefined,
      fire: (ctx) => fireSlot(ctx, now, report),
      onError: (error, context) =>
        log.warn(`routines: ${context.scheduleId ?? 'tick'} failed: ${errorText(error)}`),
    })
    await scheduler.tick().catch((e) => log.warn(`routines: tick failed: ${errorText(e)}`))
    if (timer !== undefined) {
      // programs and system routines are not fired ahead of their slot: a timer wakes the ticker
      const ahead = deps.sqlite
        .query<{ next_fire_at: number }, [number, number]>(
          `SELECT next_fire_at FROM routines WHERE status = 'active' AND program_id IS NOT NULL
             AND next_fire_at > ? AND next_fire_at <= ?`,
        )
        .all(now, now + lookaheadMs)
      for (const { next_fire_at } of ahead) wakeAt(next_fire_at)
    }
    report.swept = await sweep().catch((e) => {
      log.warn(`routines: sweep failed: ${errorText(e)}`)
      return 0
    })
    return report
  }

  /** DM runs whose own turn parked on a wait with no person involved: the next turn continues them. */
  const parked = new Map<string, Set<string>>()
  const outcomes: RoutineOutcomes = {
    async turnEnded(e) {
      if (stopped) return // the database may be closing
      const parsed = parseRoutineSession(e.sessionId)
      const program = parseProgramSession(e.sessionId)
      let runs: RoutineRun[] = []
      if (parsed !== undefined) {
        const run = store.getRunBySlot(parsed.routineId, parsed.scheduledAt)
        if (run !== undefined) runs = [run]
      } else if (program !== undefined) {
        // a scheduled run has a row of the program's routine; a manual run has none
        const owner = store.getByProgram(program.programId)
        const run = owner === undefined ? undefined : store.getRunBySlot(owner.id, program.runAt)
        if (run !== undefined) runs = [run]
      } else if (e.inboxId !== undefined) {
        // the run row learns its inbox id right after `enqueue` returns: a very fast turn can end first
        for (let i = 0; i < 80 && runs.length === 0 && !stopped; i++) {
          const run = store.getRunByInbox(e.inboxId)
          if (run !== undefined) runs = [run]
          else await sleep(25)
        }
      }
      if (stopped) return
      if (runs.length === 0 && /^dm:[^:]+$/.test(e.sessionId) && e.stop !== 'tool-pending') {
        // a DM run waited for an approval; this turn is its continuation
        runs = store.needsActionRuns(e.sessionId)
        // a run whose first turn parked on a wait (no inbox id on the continuation turn)
        const waiting = parked.get(e.sessionId)
        if (waiting !== undefined) {
          for (const id of waiting) {
            const run = store.getRun(id)
            if (run !== undefined && !runs.some((r) => r.id === run.id)) runs.push(run)
          }
          parked.delete(e.sessionId)
        }
      }
      const now = clock()
      for (const run of runs) {
        if (e.retry !== undefined) {
          // a transient failure waits for its retry: not failed, not counted, not over
          const waiting = store.markRetrying(
            run.id,
            `${willRetryText(e.retry)}; last error: ${e.retry.errorMessage}`.slice(0, 500),
          )
          const owner = waiting === undefined ? undefined : store.get(waiting.routineId)
          if (waiting !== undefined && owner !== undefined) emitRun(owner, waiting, now)
          continue
        }
        let outcome: Parameters<SqliteRoutineStore['finishRun']>[1]
        if (e.stop === 'tool-pending') {
          if (!e.needsPerson) {
            // waits on a delegated task: still running; the continuation turn ends the run
            if (/^dm:[^:]+$/.test(e.sessionId)) {
              const set = parked.get(e.sessionId) ?? new Set<string>()
              set.add(run.id)
              parked.set(e.sessionId, set)
            }
            continue
          }
          outcome = { status: 'needs_action' }
        } else if (e.stop === 'aborted') {
          outcome = { status: 'failed', reason: 'aborted', countFailure: false }
        } else if (NORMAL_STOPS.has(e.stop)) {
          // a program run that reports failure is a failed run (it counts toward pausing)
          outcome =
            e.reportStatus === 'failed'
              ? {
                  status: 'failed',
                  reason: `report: ${e.reportSummary ?? 'the run reported failure'}`,
                }
              : { status: 'succeeded' }
        } else if (e.stop === 'interrupted') {
          // the process died under the run (closed by the repair pass): not the routine's fault
          outcome = {
            status: 'failed',
            reason: 'interrupted (the server stopped)',
            countFailure: false,
          }
        } else if (e.errorCode === 'EH_LOCK_UNAVAILABLE') {
          // the lock service was down, not the routine: the run fails but does not count toward
          // pausing it (the next slot tries again)
          outcome = {
            status: 'failed',
            reason: 'storage unavailable (the session lock could not be taken)',
            countFailure: false,
          }
        } else if (e.errorCode === 'EH_PROVIDER_AUTH') {
          // every later run fails the same way until someone fixes the key
          outcome = { status: 'failed', reason: `${PROVIDER_AUTH_HINT}${suffix(e.errorMessage)}` }
        } else {
          outcome = {
            status: 'failed',
            reason: `${e.stop}${suffix(e.errorMessage)}${e.retryGaveUp === true ? ' (automatic retries did not help)' : ''}`,
          }
        }
        // a program run whose later turn (a decision hand-back) fails after the run was recorded
        // as succeeded ends failed: the run mirrors the task's final state
        const done = store.finishRun(
          run.id,
          program !== undefined && outcome.status === 'failed'
            ? { ...outcome, supersede: true }
            : outcome,
          now,
        )
        if (done === undefined) continue
        emitRun(done.routine, done.run, now)
        if (done.paused) {
          emit(
            'routine-changed',
            done.routine,
            null,
            { change: 'paused', reason: 'max-failures' },
            now,
          )
          noticePaused(done.routine, done.run, now)
        }
      }
    },
  }

  let timer: ReturnType<typeof setInterval> | undefined
  const service: RoutineService = {
    outcomes,

    tick(now = clock()) {
      // one tick at a time per instance; another instance may tick at the same moment
      ticking ??= runTick(now).finally(() => {
        ticking = undefined
      })
      return ticking
    },

    async queue(routine) {
      const sessionId = queueSessionOf(routine)
      if (sessionId === null || deps.queue === undefined) return { sessionId, items: [] }
      return { sessionId, items: await deps.queue.queued(sessionId) }
    },

    async clearQueue(routine) {
      const sessionId = queueSessionOf(routine)
      if (sessionId === null || deps.queue === undefined) return 0
      return deps.queue.clear(sessionId)
    },

    async runNow(routine) {
      const now = clock()
      const def = deps.agents.get(routine.agentId)
      if (def === undefined) throw notFound('agent', routine.agentId)
      const sessionId = sessionOf(routine, now)
      if (routine.overlap === 'skip') {
        const reason = await overlapReason(routine, { id: '', sessionId })
        if (reason !== undefined) throw conflict(reason, 'ROUTINE_BUSY')
      }
      const run = store.insertManualRun(routine.id, sessionId, now, now)
      if (run === undefined) throw conflict('a run for this instant already exists', 'ROUTINE_BUSY')
      return dispatch(routine, run, now, { checkOverlap: false })
    },

    start() {
      if (tickMs <= 0 || timer !== undefined) return
      timer = setInterval(() => {
        void service.tick().catch((error) => log.warn(`routines: tick failed: ${errorText(error)}`))
      }, tickMs)
      timer.unref()
    },

    async stop() {
      stopped = true
      if (timer !== undefined) clearInterval(timer)
      timer = undefined
      for (const wake of wakeups.values()) clearTimeout(wake)
      wakeups.clear()
      await ticking?.catch(() => undefined)
    },
  }
  return service
}
