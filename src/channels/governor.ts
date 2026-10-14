/**
 * The rate governor: token buckets per call class and key, plus a park state for "the platform
 * said retry after N seconds". Platform-neutral: classes, keys and reasons are the app's own.
 *
 * @see docs/specs/31-channels.md#2-rate-governor
 */
import { HarnessError } from '../index.ts'

/** Refill rule of one call class. */
export interface RateClass {
  /** Bucket size (also the burst). Must be > 0. */
  capacity: number
  /** Tokens added per second. Must be > 0. */
  refillPerSec: number
}

/** Options of {@link createRateGovernor}. */
export interface RateGovernorOptions {
  classes: Record<string, RateClass>
  /** Clock in epoch ms. Default `Date.now`. */
  now?: () => number
  /** Wait `ms`; must reject (or may be raced) when `signal` aborts. Default: `setTimeout`. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
}

/** Options of {@link RateGovernor.acquire}. */
export interface AcquireOptions {
  signal?: AbortSignal
}

/** Diagnostics of {@link RateGovernor.state}. */
export interface RateGovernorState {
  buckets: Array<{ class: string; key: string; tokens: number; capacity: number }>
  parks: Array<{ key: string; until: number; reason: string }>
}

/** The park key that holds every call, whatever its key. */
export const PARK_ALL = '*'

export interface RateGovernor {
  /** Wait until `cost` tokens of `cls` (per `key`) are free and no park holds `key`; then take them. */
  acquire(cls: string, key?: string, cost?: number, options?: AcquireOptions): Promise<void>
  /** Take the tokens now if free and not parked; otherwise return false and take nothing. */
  tryAcquire(cls: string, key?: string, cost?: number): boolean
  /** The platform asked to wait: hold every call for `key` (or {@link PARK_ALL}) until `untilMs`. A park only extends. */
  park(key: string, untilMs: number, reason: string): void
  /** Milliseconds `key` is still parked for (0 = free). */
  parkedFor(key?: string): number
  /** Lift a park. */
  unpark(key: string): void
  /** Buckets and active parks, for diagnostics. */
  state(): RateGovernorState
}

/** Default sleep: `setTimeout`, aborting with the signal's reason. */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) return reject(signal.reason)
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(signal?.reason)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** Race `sleep` against the signal so a custom sleep that ignores it is still abortable. */
export function sleepWithSignal(
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>,
  ms: number,
  signal?: AbortSignal,
): Promise<void> {
  if (signal === undefined) return sleep(ms)
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    sleep(ms, signal).then(
      () => {
        signal.removeEventListener('abort', onAbort)
        resolve()
      },
      (e: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(e)
      },
    )
  })
}

/** Create a {@link RateGovernor}. */
export function createRateGovernor(options: RateGovernorOptions): RateGovernor {
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? abortableSleep
  const buckets = new Map<string, { cls: string; key: string; tokens: number; at: number }>()
  const parks = new Map<string, { until: number; reason: string }>()

  const classOf = (cls: string): RateClass => {
    const c = options.classes[cls]
    if (c === undefined)
      throw new HarnessError('EH_INVALID_INPUT', `unknown rate class "${cls}"`, {
        details: { cls },
      })
    return c
  }

  const parkedFor = (key = ''): number => {
    const t = now()
    let wait = 0
    for (const k of [key, PARK_ALL]) {
      const p = parks.get(k)
      if (p === undefined) continue
      if (p.until <= t) parks.delete(k)
      else wait = Math.max(wait, p.until - t)
    }
    return wait
  }

  const bucket = (
    cls: string,
    key: string,
  ): { tokens: number; c: RateClass; b: { tokens: number } } => {
    const c = classOf(cls)
    const id = `${cls}\n${key}`
    const t = now()
    let b = buckets.get(id)
    if (b === undefined) {
      b = { cls, key, tokens: c.capacity, at: t }
      buckets.set(id, b)
    }
    b.tokens = Math.min(c.capacity, b.tokens + ((t - b.at) / 1000) * c.refillPerSec)
    b.at = t
    return { tokens: b.tokens, c, b }
  }

  /** ms until `cost` tokens fit and no park holds (0 = now). */
  const waitFor = (cls: string, key: string, cost: number): number => {
    const { tokens, c } = bucket(cls, key)
    if (cost > c.capacity) {
      throw new HarnessError(
        'EH_INVALID_INPUT',
        `cost ${cost} exceeds the capacity ${c.capacity} of class "${cls}"`,
        { details: { cls, cost } },
      )
    }
    const refill = tokens >= cost ? 0 : Math.ceil(((cost - tokens) / c.refillPerSec) * 1000)
    return Math.max(parkedFor(key), refill)
  }

  const take = (cls: string, key: string, cost: number): void => {
    bucket(cls, key).b.tokens -= cost
  }

  return {
    async acquire(cls, key = '', cost = 1, opts) {
      const signal = opts?.signal
      for (;;) {
        if (signal?.aborted === true) throw signal.reason
        const wait = waitFor(cls, key, cost)
        if (wait <= 0) return take(cls, key, cost)
        await sleepWithSignal(sleep, wait, signal)
      }
    },
    tryAcquire(cls, key = '', cost = 1) {
      if (waitFor(cls, key, cost) > 0) return false
      take(cls, key, cost)
      return true
    },
    park(key, untilMs, reason) {
      const cur = parks.get(key)
      if (cur === undefined || cur.until < untilMs) parks.set(key, { until: untilMs, reason })
    },
    parkedFor,
    unpark(key) {
      parks.delete(key)
    },
    state() {
      const t = now()
      const out: RateGovernorState = { buckets: [], parks: [] }
      for (const b of buckets.values()) {
        const c = classOf(b.cls)
        const tokens = Math.min(c.capacity, b.tokens + ((t - b.at) / 1000) * c.refillPerSec)
        out.buckets.push({ class: b.cls, key: b.key, tokens, capacity: c.capacity })
      }
      for (const [key, p] of parks) if (p.until > t) out.parks.push({ key, ...p })
      return out
    },
  }
}
