/**
 * Routines on the durable inbox (docs/plans/P32-team-example.md §6.6, decision D3, ADR-0040).
 * eharness ships no scheduler: this is the app-side pattern of the multi-instance guide.
 *
 * Every instance runs `tick()`. One iteration:
 *
 *  1. **Recover** runs a dead tick left `claimed` (claimed, not yet enqueued): the deterministic
 *     id `sched:<routineId>:<scheduledAt>` makes enqueueing them again idempotent.
 *  2. **Claim** the due routines (`next_fire_at <= now + lookahead`) with a compare-and-set on
 *     `next_fire_at`: of several instances exactly one moves the slot forward and fires it.
 *     The next slot comes from `croner` (IANA timezone). After downtime the missed slots are
 *     skipped (recorded as one skipped run); with `catchUpWindowMs` the latest missed slot fires
 *     once when it is younger than the window.
 *  3. **Fire**: overlap `skip` looks at the previous run (`session.busy()`, the session's inbox,
 *     pending approvals), then `session.enqueue(prompt, { mode: 'queue', id, availableAt })`;
 *     `availableAt` is the slot when it is still ahead, so a tick a little early fires on time.
 *  4. **Sweep** inbox items nobody holds (an instance died after enqueueing): opening the session
 *     drains it.
 *
 * A fire that needs a person is not approved by anyone: its turn ends `tool-pending`, the run is
 * `needs_action`, and the approval waits in `GET /approvals` (a routine task session
 * `routine:<id>:<slot>` is a task of origin `routine`). The outcome of a run (`succeeded`,
 * `failed`, `needs_action`) arrives from the `routineOutcomes` plugin on turn end; consecutive
 * failures pause the routine (`maxFailures`).
 */
import { errorText } from 'eharness'
import type { AgentRepo, EventAppender, RoutineEngine, ScheduleCalc } from '../../app/ports.ts'
import { conflict, notFound } from '../../domain/errors.ts'
import type { EventType } from '../../domain/events.ts'
import {
  fireId,
  type PausedReason,
  parseRoutineSession,
  type Routine,
  type RoutineRun,
  type RoutineSpec,
  routineSessionId,
} from '../../domain/routines.ts'
import type { SqliteRoutineStore } from '../db/routines-repo.ts'
import type { TaskWriter } from '../db/tasks-repo.ts'
import type { AgentFactory } from './agent-factory.ts'

export interface RoutineEngineConfig {
  /** Ticker interval (ms). Default 15 000; 0 = no timer (tests call `tick()`). */
  tickMs?: number
  /** A slot up to this far ahead fires now with `availableAt = slot`. Default `tickMs`. */
  lookaheadMs?: number
  /** A slot later than this counts as missed (downtime), not late. Default max(2 × tick, 60 s). */
  graceMs?: number
  /** A `claimed` run older than this is re-enqueued by recovery. Default 30 s. */
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
  agents: AgentRepo
  routines: SqliteRoutineStore
  schedule: ScheduleCalc
  tasks: TaskWriter
  events: EventAppender
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
  const maxPerTick = deps.config?.maxPerTick ?? 50

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

  /** Why the previous fire is still in the way (`overlap: 'skip'`), or undefined. */
  async function overlapReason(routine: Routine, run: { id: string; sessionId: string }) {
    let sessionId: string
    if (routine.sessionMode === 'dm') {
      sessionId = run.sessionId
    } else {
      const previous = store.previousFiredRun(routine.id, run.id)
      if (previous === undefined) return undefined
      if (previous.status === 'claimed') return 'overlap: the previous fire is being started'
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
      await factory.prepare(def)
      const session = factory.openSession(def, run.sessionId)
      const ahead = run.scheduledAt > now && run.trigger === 'schedule'
      const result = await session.enqueue(routine.prompt, {
        mode: 'queue',
        id: fireId(routine.id, run.scheduledAt),
        ...(ahead ? { availableAt: run.scheduledAt } : {}),
      })
      store.markEnqueued(run.id, {
        inboxId: result.inboxId,
        firedAt: now,
        ...(result.duplicate === true ? { reason: 'duplicate enqueue' } : {}),
      })
      const after = store.getRun(run.id) as RoutineRun
      emitRun(routine, after, now)
      return after
    } catch (error) {
      return fail(`enqueue failed: ${errorText(error)}`)
    }
  }

  async function processDue(row: Routine, now: number, report: TickReport): Promise<void> {
    const expected = row.nextFireAt as number
    const def = deps.agents.get(row.agentId)
    if (def === undefined || def.archivedAt !== null) {
      if (store.pauseSlot(row.id, expected, 'agent-archived', now)) {
        emit('routine-changed', row, null, { change: 'paused', reason: 'agent-archived' }, now)
      }
      return
    }

    let fireAt: number | null = expected
    let skipReason: string | undefined
    let next: number | null
    if (now - expected <= graceMs) {
      next = schedule.next(row.schedule, expected)
      // more than one slot behind but inside the grace: the extra slots are skipped, not replayed
      if (next !== null && next <= now) next = schedule.next(row.schedule, now)
    } else {
      // downtime: never replay every missed slot
      next = schedule.next(row.schedule, now)
      const latest =
        row.catchUpWindowMs === null
          ? null
          : latestSlot(row.schedule, now - row.catchUpWindowMs, now)
      if (latest === null) {
        fireAt = null
        skipReason = 'missed'
      } else {
        fireAt = latest
      }
    }
    const firing = fireAt !== null
    let pause: PausedReason | undefined
    if (next !== null && row.endAt !== null && next > row.endAt) {
      next = null
      pause = 'ended'
    }
    if (firing && row.maxFires !== null && row.fireCount + 1 >= row.maxFires) {
      next = null
      pause = 'max-fires'
    }
    if (next === null && pause === undefined) {
      pause = row.schedule.kind === 'at' ? 'completed' : 'ended'
    }

    const slot = fireAt ?? expected
    const run = store.claimSlot({
      routineId: row.id,
      expectedNext: expected,
      scheduledAt: slot,
      nextFireAt: next,
      ...(pause === undefined ? {} : { pause }),
      fire: firing,
      status: firing ? 'claimed' : 'skipped',
      ...(skipReason === undefined ? {} : { reason: skipReason }),
      sessionId: routineSessionId(row, slot),
      now,
    })
    if (run === undefined) {
      report.lost++
      return
    }
    if (pause !== undefined) {
      emit('routine-changed', row, null, { change: 'paused', reason: pause }, now)
    }
    if (!firing) {
      report.skipped.push({ routineId: row.id, scheduledAt: slot, reason: skipReason ?? '' })
      emitRun(row, run, now)
      return
    }
    const done = await dispatch(row, run, now, { checkOverlap: true })
    if (done.status === 'skipped') {
      report.skipped.push({ routineId: row.id, scheduledAt: slot, reason: done.reason ?? '' })
    } else {
      report.fired.push(done)
    }
  }

  async function recover(now: number, report: TickReport): Promise<void> {
    for (const run of store.staleClaims(now - recoverAfterMs)) {
      const routine = store.get(run.routineId)
      if (routine === undefined) continue
      // the first attempt may already have enqueued (the id dedupes), so no overlap check here
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
  async function runTick(now: number): Promise<TickReport> {
    const report: TickReport = { fired: [], skipped: [], lost: 0, recovered: 0, swept: 0 }
    await recover(now, report).catch((e) => log.warn(`routines: recovery failed: ${errorText(e)}`))
    for (const row of store.due(now + lookaheadMs, maxPerTick)) {
      try {
        await processDue(row, now, report)
      } catch (error) {
        log.warn(`routines: ${row.id} failed: ${errorText(error)}`)
      }
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
      let runs: RoutineRun[] = []
      if (parsed !== undefined) {
        const run = store.getRunBySlot(parsed.routineId, parsed.scheduledAt)
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
          outcome = { status: 'succeeded' }
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
          outcome = { status: 'failed', reason: `${e.stop}${suffix(e.errorMessage)}` }
        }
        const done = store.finishRun(run.id, outcome, now)
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
        }
      }
    },
  }

  let timer: ReturnType<typeof setInterval> | undefined
  return {
    outcomes,

    tick(now = clock()) {
      // one tick at a time per instance; another instance may tick at the same moment
      ticking ??= runTick(now).finally(() => {
        ticking = undefined
      })
      return ticking
    },

    async runNow(routine) {
      const now = clock()
      const def = deps.agents.get(routine.agentId)
      if (def === undefined) throw notFound('agent', routine.agentId)
      const sessionId = routineSessionId(routine, now)
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
        void this.tick().catch((error) => log.warn(`routines: tick failed: ${errorText(error)}`))
      }, tickMs)
      timer.unref()
    },

    async stop() {
      stopped = true
      if (timer !== undefined) clearInterval(timer)
      timer = undefined
      await ticking?.catch(() => undefined)
    },
  }
}
