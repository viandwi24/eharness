/**
 * The outbox worker: claims due items from an {@link OutboxStore}, sends them through the app's
 * `send`, retries with exponential backoff and jitter, dead-letters after `maxAttempts`, and keeps
 * a circuit breaker per target.
 *
 * @see docs/specs/31-channels.md#3-outbox
 */
import { abortableSleep, type RateGovernor, sleepWithSignal } from './governor.ts'
import type { Json, OutboxItem, OutboxRecord, OutboxStore } from './types.ts'

/** Throw from `send` when the platform says "retry after N ms": parks the target, retries later. */
export class RetryAfter extends Error {
  readonly retryAfterMs: number
  /** Governor park key. Default: the item's target; use {@link PARK_ALL} for a whole connection. */
  readonly parkKey?: string
  /** The rate limit was already reported through {@link Outbox.noteRateLimit}: park and retry, but do not count it for the storm again. */
  readonly counted: boolean
  constructor(
    retryAfterMs: number,
    options: { parkKey?: string; message?: string; counted?: boolean } = {},
  ) {
    super(options.message ?? `rate limited, retry in ${Math.ceil(retryAfterMs / 1000)} s`)
    this.name = 'RetryAfter'
    this.retryAfterMs = retryAfterMs
    this.counted = options.counted === true
    if (options.parkKey !== undefined) this.parkKey = options.parkKey
  }
}

/** Throw from `send` when there is nothing to send any more (the target is gone, the message was withdrawn): settles the item `skipped`. */
export class SkipSend extends Error {
  constructor(reason: string) {
    super(reason)
    this.name = 'SkipSend'
  }
}

/** Throw from `send` when retrying cannot help (bad input, blocked user): dead-letters at once. */
export class PermanentSendError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'PermanentSendError'
  }
}

/** Retry delay: `min(maxMs, baseMs * 2^(attempt-1))`, reduced by up to `jitter` (0..1). */
export interface BackoffOptions {
  baseMs?: number
  maxMs?: number
  jitter?: number
}

/** Circuit breaker per target. */
export interface BreakerOptions {
  /** Consecutive retryable failures that open it. Default 5. */
  threshold?: number
  /** Open time before one trial send is allowed (half-open). Default 30 000. A function gets the target (limits that differ per target or change at runtime). */
  cooldownMs?: number | ((target: string) => number)
}

/**
 * Flood-storm detection: `count` rate limits ({@link RetryAfter}) within `windowMs` open the
 * breaker for the longest retry-after seen in the window (at least the breaker cooldown).
 * Generalised from the team app's governor.
 */
export interface FloodStormOptions {
  /** `RetryAfter`s within the window that make a storm. Default 5; `0` disables detection. A function gets the storm key. */
  count?: number | ((key: string) => number)
  /** Window length. Default 600 000 (10 minutes). A function gets the storm key. */
  windowMs?: number | ((key: string) => number)
  /**
   * `target` (default): count and hold per storm key (the park key mapped by `stormKey`).
   * `global`: count across all keys and hold every target.
   */
  scope?: 'target' | 'global'
  /**
   * Maps a park key (the item's target, or the `RetryAfter`'s / {@link Outbox.noteRateLimit}'s
   * `parkKey`) to the storm key: what is counted together and whose breaker opens. Default: the
   * park key itself. A per-chat lane (`connection\nchat`) maps to its connection so that floods in
   * several chats open the connection's breaker.
   */
  stormKey?: (parkKey: string) => string
}

/** What the app's `send` receives besides the record. */
export interface SendContext {
  signal: AbortSignal
  /** 1-based attempt number. */
  attempt: number
}

/** Events for logs and alerts. */
export type OutboxEvent =
  | { type: 'sent'; id: string; target: string }
  | { type: 'retry'; id: string; target: string; at: number; error: string }
  | { type: 'dead'; id: string; target: string; error: string }
  | { type: 'breaker-open'; target: string; until: number; reason?: string }
  | { type: 'breaker-close'; target: string }
  | { type: 'lease-lost'; id: string }
  /** Settled without sending ({@link SkipSend}). */
  | { type: 'skipped'; id: string; target: string; reason: string }
  /** The lease expired mid-send (`expiredLeases: 'hold'`): resolve it with {@link Outbox.release}. */
  | { type: 'held'; id: string; target: string }
  /** The platform asked to wait (audit/alert hook): `parkKey` is the key that was parked; `id` is `''` for {@link Outbox.noteRateLimit}. */
  | {
      type: 'rate-limited'
      id: string
      target: string
      parkKey: string
      retryAfterMs: number
      until: number
    }
  /** A flood storm opened the breaker; `target` is `'*'` for the global scope. */
  | { type: 'storm'; target: string; count: number; until: number }

/** Options of {@link createOutbox}. */
export interface OutboxOptions {
  store: OutboxStore
  /** Deliver one item. Return a JSON result, or throw ({@link RetryAfter}, {@link PermanentSendError}, anything else = retryable). */
  send: (item: OutboxRecord, ctx: SendContext) => Promise<Json | undefined>
  /** Charged before every send: `{ class, key?, cost? }` of the governor. */
  rate?: (item: OutboxRecord) => { class: string; key?: string; cost?: number }
  governor?: RateGovernor
  backoff?: BackoffOptions
  breaker?: BreakerOptions
  /** Flood-storm detection. Default: on (5 per 10 minutes, per key). */
  floodStorm?: FloodStormOptions
  /**
   * What happens to an item whose lease expired (the sender crashed mid-send, so it may or may not
   * have been delivered). `retry` (default): claim and send it again (at-least-once). `hold`: do
   * not resend; it becomes `held` (event `held`, `list({ state: 'held' })`) and the app resolves it
   * with {@link Outbox.release}.
   */
  expiredLeases?: 'retry' | 'hold'
  now?: () => number
  /** Randomness for jitter in [0, 1). Default `Math.random`. */
  random?: () => number
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  /** Lease owner. Default a random id. Two workers must have different owners. */
  owner?: string
  /** Idle wait between polls while started. Default 1 000. */
  pollMs?: number
  /** Lease length. Default 60 000. */
  leaseMs?: number
  /** Items claimed per poll. Default 10. */
  batch?: number
  onEvent?: (event: OutboxEvent) => void
}

/** The worker. */
export interface Outbox {
  /** Idempotent by id; `maxAttempts` default 5, `availableAt` default now. */
  enqueue(
    input: Pick<OutboxItem, 'id' | 'target' | 'payload'> & Partial<OutboxItem>,
  ): Promise<{ created: boolean; record: OutboxRecord }>
  /** Claim and process one batch; resolves with the number of items claimed. */
  tick(): Promise<number>
  /** Start the poll loop (no-op when started). */
  start(): void
  /** Stop polling and wait for in-flight sends. */
  stop(): Promise<void>
  /** Process every item due now (and those that become due while draining) until none is. */
  drain(): Promise<void>
  /** Drain, then return the record of `id`. */
  flush(id: string): Promise<OutboxRecord | undefined>
  /** Breaker state of a target. */
  breaker(target: string): {
    state: 'closed' | 'open' | 'half-open'
    failures: number
    until: number
  }
  /** Close a breaker by hand (and clear its flood counter). */
  resetBreaker(target: string): void
  /**
   * Open a breaker from outside (the app saw a fatal platform error): items of `target` are
   * deferred, without using an attempt, until `untilMs`; then one trial send passes. Only extends.
   */
  openBreaker(target: string, untilMs: number, reason?: string): void
  /**
   * Report a rate limit seen by a call that does not go through this worker (a read, an edit): it
   * counts toward the same flood storm as `RetryAfter`. Does not park the governor.
   */
  noteRateLimit(parkKey: string, retryAfterMs: number): void
  /** Rate limits counted for a storm key within its window (diagnostics). */
  floods(key: string): number
  /** Resolve a `held` item: `retry` sends it again, `drop` settles it `skipped`. Undefined when the item is not `held`. */
  release(id: string, resolution: 'retry' | 'drop'): Promise<OutboxRecord | undefined>
}

interface BreakerState {
  failures: number
  openUntil: number
  trial: boolean
}

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** Create the outbox worker. */
export function createOutbox(options: OutboxOptions): Outbox {
  const { store, governor } = options
  const now = options.now ?? Date.now
  const random = options.random ?? Math.random
  const sleep = options.sleep ?? abortableSleep
  const owner = options.owner ?? `outbox-${Math.random().toString(36).slice(2)}`
  const pollMs = options.pollMs ?? 1000
  const leaseMs = options.leaseMs ?? 60_000
  const batch = options.batch ?? 10
  const baseMs = options.backoff?.baseMs ?? 1000
  const maxMs = options.backoff?.maxMs ?? 60_000
  const jitter = options.backoff?.jitter ?? 0.2
  const threshold = options.breaker?.threshold ?? 5
  const cooldownOf = (target: string): number => {
    const c = options.breaker?.cooldownMs ?? 30_000
    return typeof c === 'function' ? c(target) : c
  }
  const stormCountOf = (key: string): number => {
    const c = options.floodStorm?.count ?? 5
    return typeof c === 'function' ? c(key) : c
  }
  const stormWindowOf = (key: string): number => {
    const w = options.floodStorm?.windowMs ?? 600_000
    return typeof w === 'function' ? w(key) : w
  }
  const stormKeyOf = options.floodStorm?.stormKey ?? ((parkKey: string): string => parkKey)
  const holdPolicy = options.expiredLeases === 'hold'
  const stormGlobal = options.floodStorm?.scope === 'global'
  const floods = new Map<string, Array<{ at: number; ms: number }>>()
  let globalHoldUntil = 0
  const breakers = new Map<string, BreakerState>()
  const inflight = new Set<Promise<unknown>>()
  const controller = new AbortController()
  let loop: Promise<void> | undefined
  let stopper: AbortController | undefined

  const emit = (e: OutboxEvent): void => {
    try {
      options.onEvent?.(e)
    } catch {
      // an event listener never breaks delivery
    }
  }
  const breakerOf = (target: string): BreakerState => {
    let b = breakers.get(target)
    if (b === undefined) {
      b = { failures: 0, openUntil: 0, trial: false }
      breakers.set(target, b)
    }
    return b
  }
  const delayFor = (attempt: number): number => {
    const d = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1))
    return Math.round(d * (1 - jitter * random()))
  }
  const onFailure = (target: string): void => {
    const b = breakerOf(target)
    b.trial = false
    b.failures += 1
    if (b.failures >= threshold) {
      b.openUntil = now() + cooldownOf(target)
      emit({ type: 'breaker-open', target, until: b.openUntil })
    }
  }

  /** Count one rate limit; open the breaker (or the global hold) when they pile up. */
  const countFlood = (parkKey: string, ms: number): void => {
    const t = now()
    const key = stormGlobal ? '*' : stormKeyOf(parkKey)
    const count = stormCountOf(key)
    if (count <= 0) return
    const windowMs = stormWindowOf(key)
    const list = (floods.get(key) ?? []).filter((x) => x.at > t - windowMs)
    list.push({ at: t, ms })
    floods.set(key, list)
    if (list.length < count) return
    floods.set(key, [])
    const hold = Math.max(cooldownOf(key), ...list.map((x) => x.ms))
    const until = t + hold
    if (stormGlobal) globalHoldUntil = Math.max(globalHoldUntil, until)
    else {
      const b = breakerOf(key)
      b.failures = Math.max(b.failures, threshold)
      b.openUntil = Math.max(b.openUntil, until)
      b.trial = false
    }
    emit({ type: 'storm', target: key, count: list.length, until })
    emit({ type: 'breaker-open', target: key, until })
  }

  /** Record one rate limit seen by `send`: audit event, then the storm counter. */
  const noteFlood = (id: string, target: string, parkKey: string, ms: number): void => {
    emit({ type: 'rate-limited', id, target, parkKey, retryAfterMs: ms, until: now() + ms })
    countFlood(parkKey, ms)
  }

  async function deliver(rec: OutboxRecord): Promise<void> {
    const b = breakerOf(rec.target)
    const t = now()
    if (globalHoldUntil > t) {
      await store.defer(rec.id, owner, globalHoldUntil)
      return
    }
    // circuit breaker: open = hold; after the cool-down exactly one trial passes (half-open)
    if (b.failures >= threshold) {
      if (b.openUntil > t) {
        await store.defer(rec.id, owner, b.openUntil)
        return
      }
      if (b.trial) {
        await store.defer(rec.id, owner, t + Math.max(1, Math.min(pollMs, cooldownOf(rec.target))))
        return
      }
      b.trial = true
    }
    // the platform asked this target to wait: give the item back without using an attempt
    const parked = governor?.parkedFor(rec.target) ?? 0
    if (parked > 0) {
      if (b.trial) b.trial = false
      await store.defer(rec.id, owner, t + parked)
      return
    }
    try {
      if (governor !== undefined && options.rate !== undefined) {
        const r = options.rate(rec)
        await governor.acquire(r.class, r.key ?? rec.target, r.cost ?? 1, {
          signal: controller.signal,
        })
      }
      const result = await options.send(rec, { signal: controller.signal, attempt: rec.attempts })
      if (!(await store.succeed(rec.id, owner, result ?? undefined))) {
        emit({ type: 'lease-lost', id: rec.id })
      }
      if (b.failures >= threshold) emit({ type: 'breaker-close', target: rec.target })
      b.failures = 0
      b.trial = false
      emit({ type: 'sent', id: rec.id, target: rec.target })
    } catch (error) {
      const text = errorText(error)
      if (error instanceof SkipSend) {
        b.trial = false
        if (await store.skip(rec.id, owner, text)) {
          emit({ type: 'skipped', id: rec.id, target: rec.target, reason: text })
        } else emit({ type: 'lease-lost', id: rec.id })
        return
      }
      if (error instanceof PermanentSendError) {
        b.trial = false
        const s = await store.fail(rec.id, owner, { error: text, permanent: true })
        emit(
          s === undefined
            ? { type: 'lease-lost', id: rec.id }
            : { type: 'dead', id: rec.id, target: rec.target, error: text },
        )
        return
      }
      let retryAt: number
      if (error instanceof RetryAfter) {
        // the platform spoke: park, do not blame the target
        retryAt = now() + error.retryAfterMs
        const parkKey = error.parkKey ?? rec.target
        governor?.park(parkKey, retryAt, text)
        b.trial = false
        if (!error.counted) noteFlood(rec.id, rec.target, parkKey, error.retryAfterMs)
      } else {
        retryAt = now() + delayFor(rec.attempts)
        onFailure(rec.target)
      }
      const s = await store.fail(rec.id, owner, { retryAt, error: text })
      if (s === undefined) emit({ type: 'lease-lost', id: rec.id })
      else if (s === 'dead') emit({ type: 'dead', id: rec.id, target: rec.target, error: text })
      else emit({ type: 'retry', id: rec.id, target: rec.target, at: retryAt, error: text })
    }
  }

  async function tick(): Promise<number> {
    if (holdPolicy) {
      for (const r of await store.holdExpired(now()))
        emit({ type: 'held', id: r.id, target: r.target })
    }
    const claimed = await store.claim(
      now(),
      owner,
      leaseMs,
      batch,
      holdPolicy ? { reclaimExpired: false } : undefined,
    )
    // one target at a time in claim order, different targets in parallel
    const lanes = new Map<string, OutboxRecord[]>()
    for (const r of claimed) lanes.set(r.target, [...(lanes.get(r.target) ?? []), r])
    const run = Promise.all(
      [...lanes.values()].map(async (lane) => {
        for (const rec of lane) await deliver(rec)
      }),
    )
    inflight.add(run)
    try {
      await run
    } finally {
      inflight.delete(run)
    }
    return claimed.length
  }

  async function drain(): Promise<void> {
    // a deferred item is not due again until its availableAt, so this ends
    while ((await tick()) > 0) {
      // keep going while there is due work
    }
  }

  return {
    enqueue(input) {
      return store.enqueue({
        availableAt: now(),
        attempts: 0,
        maxAttempts: 5,
        ...input,
      })
    },
    tick,
    start() {
      if (loop !== undefined) return
      stopper = new AbortController()
      const signal = stopper.signal
      loop = (async () => {
        while (!signal.aborted) {
          let n = 0
          try {
            n = await tick()
          } catch (e) {
            emit({ type: 'retry', id: '', target: '', at: now(), error: errorText(e) })
          }
          if (n === 0) {
            try {
              await sleepWithSignal(sleep, pollMs, signal)
            } catch {
              // stopped
            }
          }
        }
      })()
    },
    async stop() {
      stopper?.abort()
      const l = loop
      loop = undefined
      await l
      controller.abort()
      await Promise.allSettled([...inflight])
    },
    drain,
    async flush(id) {
      await drain()
      return store.get(id)
    },
    breaker(target) {
      if (globalHoldUntil > now()) {
        return { state: 'open', failures: 0, until: globalHoldUntil }
      }
      const b = breakers.get(target)
      if (b === undefined || b.failures < threshold) {
        return { state: 'closed', failures: b?.failures ?? 0, until: 0 }
      }
      return {
        state: b.openUntil > now() ? 'open' : 'half-open',
        failures: b.failures,
        until: b.openUntil,
      }
    },
    resetBreaker(target) {
      breakers.delete(target)
      floods.delete(target)
      if (target === '*' || stormGlobal) {
        globalHoldUntil = 0
        floods.delete('*')
      }
    },
    openBreaker(target, untilMs, reason) {
      const b = breakerOf(target)
      b.failures = Math.max(b.failures, threshold)
      b.openUntil = Math.max(b.openUntil, untilMs)
      b.trial = false
      emit({
        type: 'breaker-open',
        target,
        until: b.openUntil,
        ...(reason === undefined ? {} : { reason }),
      })
    },
    noteRateLimit(parkKey, retryAfterMs) {
      emit({
        type: 'rate-limited',
        id: '',
        target: stormGlobal ? '*' : stormKeyOf(parkKey),
        parkKey,
        retryAfterMs,
        until: now() + retryAfterMs,
      })
      countFlood(parkKey, retryAfterMs)
    },
    floods(key) {
      const t = now()
      const k = stormGlobal ? '*' : key
      return (floods.get(k) ?? []).filter((x) => x.at > t - stormWindowOf(k)).length
    },
    release(id, resolution) {
      return store.release(id, resolution, now())
    },
  }
}
