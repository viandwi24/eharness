import { HarnessError, uuidv7 } from '../index.ts'
import type {
  CreateScheduleInput,
  FireContext,
  Schedule,
  ScheduleSpec,
  ScheduleStore,
  TickReport,
  UpdateSchedulePatch,
} from './types.ts'

/** Injected cron calculator: the first slot strictly after `after` (epoch ms), `undefined` when none. */
export type CronNext = (expr: string, after: number, timezone?: string) => number | undefined

/** Options of {@link createScheduler}. */
export interface SchedulerOptions {
  store: ScheduleStore
  /** The app callback of a fire (usually `session.enqueue(…, { id: fireId, availableAt })`). */
  fire: (ctx: FireContext) => void | Promise<void>
  /** Cron calculator (e.g. built on `croner`). Required to create cron schedules. */
  next?: CronNext
  /** Clock (epoch ms). Default `Date.now`. */
  now?: () => number
  /** Ticker interval of `start()`. Default 15 000. */
  tickMs?: number
  /** Claim lease. Default 30 000; a dead owner's claim is taken over after it. */
  leaseMs?: number
  /** A slot younger than this is on time, older is missed. Default `max(2 × tickMs, 1000)`. */
  graceMs?: number
  /** Rows claimed per tick. Default 50. */
  maxPerTick?: number
  /** This instance's claim owner. Default a UUIDv7. */
  owner?: string
  /** Receives tick and fire failures. Default: ignored. */
  onError?: (error: unknown, context: { scheduleId?: string }) => void
}

/** The scheduler returned by {@link createScheduler}. */
export interface Scheduler {
  /** Start the ticker (idempotent). */
  start(): void
  /** Stop the ticker and await the tick in flight. */
  stop(): Promise<void>
  /** Run one tick now (tests, serverless cron). Ticks of one scheduler never overlap. */
  tick(): Promise<TickReport>
  create(input: CreateScheduleInput): Promise<Schedule>
  update(id: string, patch: UpdateSchedulePatch): Promise<Schedule>
  pause(id: string): Promise<Schedule>
  resume(id: string): Promise<Schedule>
  remove(id: string): Promise<boolean>
  /** Fire now, outside the schedule (`scheduledAt = now`); does not move `nextFireAt`. */
  fireNow(id: string): Promise<FireContext['fireId']>
  /** The store, for reads (`get`, `list`). */
  readonly store: ScheduleStore
}

const MAX_SLOTS = 1000
const MAX_STEPS = 100_000

function invalid(
  reason: string,
  message: string,
  details: Record<string, unknown> = {},
): HarnessError {
  return new HarnessError('EH_INVALID_INPUT', message, { details: { reason, ...details } })
}

/**
 * Create a scheduler over a {@link ScheduleStore}. Every instance runs the same code against the
 * same store; compare-and-set claims make exactly one fire each slot, and deterministic fire ids
 * (`sched:<id>:<scheduledAt>`) make a retried tick idempotent.
 *
 * @example
 * ```ts
 * const scheduler = createScheduler({
 *   store: memoryScheduleStore(),
 *   fire: ({ schedule, scheduledAt, fireId }) =>
 *     session(schedule.sessionId).enqueue(String(schedule.payload), { id: fireId, availableAt: scheduledAt }),
 * })
 * await scheduler.create({ sessionId: 's1', spec: { kind: 'interval', everyMs: 60_000 }, payload: 'ping' })
 * scheduler.start()
 * ```
 * @see docs/specs/29-scheduler.md
 */
export function createScheduler(options: SchedulerOptions): Scheduler {
  const { store, fire } = options
  const now = options.now ?? Date.now
  const tickMs = options.tickMs ?? 15_000
  const leaseMs = options.leaseMs ?? 30_000
  const graceMs = options.graceMs ?? Math.max(2 * tickMs, 1000)
  const maxPerTick = options.maxPerTick ?? 50
  const owner = options.owner ?? uuidv7()
  const report = (error: unknown, scheduleId?: string): void => {
    try {
      options.onError?.(error, scheduleId === undefined ? {} : { scheduleId })
    } catch {
      // an error hook never breaks the loop
    }
  }

  /** First slot strictly after `after`; `undefined` when the spec is exhausted. */
  const following = (spec: ScheduleSpec, after: number): number | undefined => {
    if (spec.kind === 'once') return spec.at > after ? spec.at : undefined
    if (spec.kind === 'interval') return after + spec.everyMs
    if (!options.next) {
      throw invalid(
        'cron-unsupported',
        'A cron schedule needs a `next` calculator in createScheduler options.',
      )
    }
    const at = options.next(spec.expr, after, spec.timezone)
    return at !== undefined && at > after ? at : undefined
  }

  const validate = (spec: ScheduleSpec): void => {
    if (spec.kind === 'interval') {
      if (!Number.isFinite(spec.everyMs) || spec.everyMs < 1) {
        throw invalid('spec-invalid', 'interval.everyMs must be a finite number >= 1.')
      }
    } else if (spec.kind === 'once') {
      if (!Number.isFinite(spec.at))
        throw invalid('spec-invalid', 'once.at must be an epoch ms number.')
    } else if (spec.kind === 'cron') {
      if (typeof spec.expr !== 'string' || spec.expr.trim() === '') {
        throw invalid('spec-invalid', 'cron.expr must be a non-empty string.')
      }
      if (!options.next) {
        throw invalid(
          'cron-unsupported',
          'A cron schedule needs a `next` calculator in createScheduler options.',
        )
      }
    } else {
      throw invalid('spec-invalid', 'Unknown schedule spec kind.')
    }
  }

  /** The initial `nextFireAt` of a spec: `once` keeps its `at` (even in the past), others look ahead. */
  const initial = (spec: ScheduleSpec, from: number): number | null => {
    validate(spec)
    if (spec.kind === 'once') return spec.at
    const at = following(spec, from)
    if (at === undefined) throw invalid('spec-exhausted', 'The cron expression has no future slot.')
    return at
  }

  const need = async (id: string): Promise<Schedule> => {
    const s = await store.get(id)
    if (!s) throw invalid('not-found', `Schedule ${id} not found.`, { id })
    return s
  }

  /** All slots `<= at`, starting at `from`, keeping the latest {@link MAX_SLOTS}; plus the slot after. */
  const slotsUntil = (
    spec: ScheduleSpec,
    from: number,
    at: number,
  ): { slots: number[]; next: number | null } => {
    if (spec.kind === 'once') return { slots: from <= at ? [from] : [], next: null }
    const slots: number[] = []
    let cur: number | undefined = from
    let steps = 0
    if (spec.kind === 'interval' && (at - from) / spec.everyMs > MAX_SLOTS) {
      // arithmetic jump: keep only the latest MAX_SLOTS slots
      const skip = Math.floor((at - from) / spec.everyMs) - MAX_SLOTS
      cur = from + skip * spec.everyMs
    }
    while (cur !== undefined && cur <= at) {
      slots.push(cur)
      if (slots.length > MAX_SLOTS) slots.shift()
      if (++steps > MAX_STEPS) {
        cur = following(spec, at)
        break
      }
      cur = following(spec, cur)
    }
    return { slots, next: cur ?? null }
  }

  const fireIdOf = (id: string, scheduledAt: number): string => `sched:${id}:${scheduledAt}`

  const processRow = async (row: Schedule, t: number, out: TickReport): Promise<void> => {
    const claimed = await store.claim(row.id, row.version, owner, t + leaseMs)
    if (!claimed) return
    out.claimed += 1
    if (row.claimedBy !== undefined) out.recovered += 1
    try {
      const from = claimed.nextFireAt
      if (from === null) {
        await store.complete(claimed.id, owner, { nextFireAt: null })
        return
      }
      const { slots, next } = slotsUntil(claimed.spec, from, t)
      const fresh = slots.filter((s) => t - s <= graceMs)
      const missed = slots.filter((s) => t - s > graceMs)
      const toFire: number[] = []
      const drop = (list: number[], reason: 'catch-up' | 'overlap'): void => {
        for (const s of list) out.skipped.push({ scheduleId: claimed.id, scheduledAt: s, reason })
      }
      const cu = claimed.catchUp
      const keep = cu === 'skip' ? 0 : cu === 'once' ? 1 : Math.max(0, Math.floor(cu.max))
      toFire.push(...missed.slice(missed.length - keep))
      drop(missed.slice(0, missed.length - keep), 'catch-up')
      if (claimed.overlap === 'queue') toFire.push(...fresh)
      else {
        if (fresh.length > 0) toFire.push(fresh[fresh.length - 1] as number)
        drop(fresh.slice(0, -1), 'overlap')
      }
      for (const scheduledAt of toFire) {
        const fireId = fireIdOf(claimed.id, scheduledAt)
        await fire({ schedule: claimed, scheduledAt, fireId })
        out.fired.push({ scheduleId: claimed.id, scheduledAt, fireId })
      }
      const last = toFire[toFire.length - 1]
      await store.complete(claimed.id, owner, {
        nextFireAt: next,
        ...(last !== undefined ? { lastFireAt: last } : {}),
      })
    } catch (error) {
      out.failed += 1
      report(error, row.id)
      try {
        await store.release(row.id, owner)
      } catch (releaseError) {
        report(releaseError, row.id)
      }
    }
  }

  let running: Promise<TickReport> | undefined
  const runTick = async (): Promise<TickReport> => {
    const out: TickReport = { claimed: 0, recovered: 0, fired: [], skipped: [], failed: 0 }
    const t = now()
    const due = await store.due(t, maxPerTick)
    for (const row of due) await processRow(row, t, out)
    return out
  }
  const tick = (): Promise<TickReport> => {
    if (running) return running
    const p = runTick().finally(() => {
      if (running === p) running = undefined
    })
    running = p
    return p
  }

  let timer: ReturnType<typeof setTimeout> | undefined
  let started = false
  const loop = (): void => {
    if (!started) return
    timer = setTimeout(() => {
      tick()
        .catch((error) => report(error))
        .finally(loop)
    }, tickMs)
    ;(timer as { unref?: () => void }).unref?.()
  }

  return {
    store,
    start(): void {
      if (started) return
      started = true
      tick().catch((error) => report(error))
      loop()
    },
    async stop(): Promise<void> {
      started = false
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
      try {
        await running
      } catch {
        // reported by the loop
      }
    },
    tick,
    async create(input: CreateScheduleInput): Promise<Schedule> {
      const id = input.id ?? uuidv7()
      if (await store.get(id)) throw invalid('exists', `Schedule ${id} already exists.`, { id })
      const schedule: Schedule = {
        id,
        sessionId: input.sessionId,
        spec: input.spec,
        payload: input.payload ?? null,
        state: input.state ?? 'active',
        overlap: input.overlap ?? 'skip',
        catchUp: input.catchUp ?? 'skip',
        nextFireAt: initial(input.spec, now()),
        version: 0,
        ...(input.metadata ? { metadata: input.metadata } : {}),
      }
      return store.put(schedule)
    },
    async update(id: string, patch: UpdateSchedulePatch): Promise<Schedule> {
      const cur = await need(id)
      const next: Schedule = { ...cur, ...patch }
      if (patch.spec) next.nextFireAt = initial(patch.spec, now())
      return store.put(next)
    },
    async pause(id: string): Promise<Schedule> {
      const cur = await need(id)
      return store.put({ ...cur, state: 'paused' })
    },
    async resume(id: string): Promise<Schedule> {
      const cur = await need(id)
      // slots that passed while paused are dropped: look ahead from now (a pending `once` keeps its slot)
      const nextFireAt = cur.spec.kind === 'once' ? cur.nextFireAt : initial(cur.spec, now())
      return store.put({ ...cur, state: 'active', nextFireAt })
    },
    remove(id: string): Promise<boolean> {
      return store.delete(id)
    },
    async fireNow(id: string): Promise<string> {
      const schedule = await need(id)
      const scheduledAt = now()
      const fireId = fireIdOf(id, scheduledAt)
      await fire({ schedule, scheduledAt, fireId })
      return fireId
    },
  }
}
