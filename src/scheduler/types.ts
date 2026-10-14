/**
 * Types of `eharness/scheduler`: schedules that fire into sessions, and the store port.
 *
 * @see docs/specs/29-scheduler.md
 */

/** When a schedule fires. */
export type ScheduleSpec =
  | { kind: 'cron'; expr: string; timezone?: string }
  | { kind: 'interval'; everyMs: number }
  | { kind: 'once'; at: number }

/** What happens to slots that are older than the grace window when a tick finds them. */
export type CatchUp = 'skip' | 'once' | { max: number }

/** One schedule row (JSON-serializable). */
export interface Schedule {
  id: string
  /** The session a fire targets (the app's `fire` callback enqueues into it). */
  sessionId: string
  spec: ScheduleSpec
  /** JSON the fire carries to the app callback. */
  payload: unknown
  state: 'active' | 'paused'
  /** `skip`: of several fresh slots only the latest fires. `queue`: every fresh slot fires. */
  overlap: 'skip' | 'queue'
  catchUp: CatchUp
  /** Next slot (epoch ms); `null` when the schedule is exhausted (a fired `once`). */
  nextFireAt: number | null
  lastFireAt?: number
  claimedBy?: string
  claimedUntil?: number
  /** Bumped by the store on every write; the compare-and-set token of `claim`. */
  version: number
  metadata?: Record<string, unknown>
}

/** Query of {@link ScheduleStore.list}. */
export interface ScheduleListQuery {
  sessionId?: string
  state?: Schedule['state']
  limit?: number
  cursor?: string
}

/** A page of schedules. */
export interface ScheduleListResult {
  items: Schedule[]
  nextCursor?: string
}

/**
 * Storage port of the scheduler. All methods are async; `claim`, `complete` and `release` must be
 * atomic compare-and-set operations (spec 29 §2).
 */
export interface ScheduleStore {
  get(id: string): Promise<Schedule | undefined>
  /** Schedules ordered by id. */
  list(query?: ScheduleListQuery): Promise<ScheduleListResult>
  /** Create or replace. The store assigns `version` (previous + 1, `1` on create) and returns the row. */
  put(schedule: Schedule): Promise<Schedule>
  /**
   * Compare-and-set replace (optional; stores without it give last-writer-wins edits). Succeeds
   * only when the row exists and still has `expectedVersion`; then it behaves like `put` (version
   * bumped, row returned). Returns `undefined` on a conflict (row changed or gone), writing
   * nothing. `scheduler.update/pause/resume` use it with a retry loop.
   */
  update?(schedule: Schedule, expectedVersion: number): Promise<Schedule | undefined>
  /** Remove; `true` when a row existed. */
  delete(id: string): Promise<boolean>
  /**
   * Active schedules with `nextFireAt <= now` that are unclaimed or whose claim expired
   * (`claimedUntil <= now`), oldest `nextFireAt` first, at most `limit`.
   */
  due(now: number, limit: number): Promise<Schedule[]>
  /**
   * Compare-and-set: succeeds only when the row still has `version` (as read from `due`, so it was
   * unclaimed or its claim had expired) and is active. Every claim bumps `version`, so a second
   * claimer holding the old version loses. Sets `claimedBy`/`claimedUntil`, bumps `version`, returns the row.
   */
  claim(
    id: string,
    version: number,
    owner: string,
    leaseUntil: number,
  ): Promise<Schedule | undefined>
  /** When `owner` still holds the claim: set `nextFireAt` and `lastFireAt`, clear the claim, bump `version`. */
  complete(
    id: string,
    owner: string,
    advance: { nextFireAt: number | null; lastFireAt?: number },
  ): Promise<Schedule | undefined>
  /** When `owner` still holds the claim: clear it without advancing (the slot is retried). */
  release(id: string, owner: string): Promise<boolean>
}

/**
 * What `fire` may resolve to. `void` / `undefined` (or `{ fired: true }`) means the slot fired;
 * `{ fired: false }` means "slot handled, nothing fired" (for example the app skipped it): the
 * scheduler advances `nextFireAt` but leaves `lastFireAt` unchanged and does not count a fire.
 */
// biome-ignore lint/suspicious/noConfusingVoidType: `void` keeps callbacks that return nothing assignable
export type FireResult = void | { fired?: boolean }

/** Argument of the app's `fire` callback. */
export interface FireContext {
  schedule: Schedule
  /** The slot this fire is for (epoch ms). */
  scheduledAt: number
  /** `sched:<id>:<scheduledAt>`: pass it as `session.enqueue(…, { id })` for idempotence. */
  fireId: string
}

/** Input of `scheduler.create`. */
export interface CreateScheduleInput {
  /** Default: a UUIDv7. */
  id?: string
  sessionId: string
  spec: ScheduleSpec
  payload?: unknown
  /** Default `'active'`. */
  state?: Schedule['state']
  /** Default `'skip'`. */
  overlap?: Schedule['overlap']
  /** Default `'skip'`. */
  catchUp?: CatchUp
  metadata?: Record<string, unknown>
}

/** Patch of `scheduler.update`. A new `spec` recomputes `nextFireAt` from now. */
export type UpdateSchedulePatch = Partial<
  Pick<Schedule, 'sessionId' | 'spec' | 'payload' | 'overlap' | 'catchUp' | 'metadata'>
>

/** One fire a tick performed. */
export interface FireRecord {
  scheduleId: string
  scheduledAt: number
  fireId: string
}

/** What one `tick()` did. */
export interface TickReport {
  /** Rows this instance claimed (another instance may have won the rest). */
  claimed: number
  /** Claims taken over from a dead owner (a subset of `claimed`). */
  recovered: number
  fired: FireRecord[]
  /** Slots dropped by `catchUp` / `overlap`. */
  skipped: Array<{
    scheduleId: string
    scheduledAt: number
    reason: 'catch-up' | 'overlap' | 'declined'
  }>
  /** Rows whose `fire` threw; they were released and are retried. */
  failed: number
}
