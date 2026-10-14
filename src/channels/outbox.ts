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
  constructor(retryAfterMs: number, options: { parkKey?: string; message?: string } = {}) {
    super(options.message ?? `rate limited, retry in ${Math.ceil(retryAfterMs / 1000)} s`)
    this.name = 'RetryAfter'
    this.retryAfterMs = retryAfterMs
    if (options.parkKey !== undefined) this.parkKey = options.parkKey
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
  /** Open time before one trial send is allowed (half-open). Default 30 000. */
  cooldownMs?: number
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
  | { type: 'breaker-open'; target: string; until: number }
  | { type: 'breaker-close'; target: string }
  | { type: 'lease-lost'; id: string }

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
  /** Close a breaker by hand. */
  resetBreaker(target: string): void
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
  const cooldownMs = options.breaker?.cooldownMs ?? 30_000
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
      b.openUntil = now() + cooldownMs
      emit({ type: 'breaker-open', target, until: b.openUntil })
    }
  }

  async function deliver(rec: OutboxRecord): Promise<void> {
    const b = breakerOf(rec.target)
    const t = now()
    // circuit breaker: open = hold; after the cool-down exactly one trial passes (half-open)
    if (b.failures >= threshold) {
      if (b.openUntil > t) {
        await store.defer(rec.id, owner, b.openUntil)
        return
      }
      if (b.trial) {
        await store.defer(rec.id, owner, t + Math.max(1, Math.min(pollMs, cooldownMs)))
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
        governor?.park(error.parkKey ?? rec.target, retryAt, text)
        b.trial = false
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
    const claimed = await store.claim(now(), owner, leaseMs, batch)
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
    },
  }
}
