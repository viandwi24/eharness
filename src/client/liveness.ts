/**
 * Pure connection-health logic of the activity feed: staleness, ping cadence, boot-id changes and
 * reconnect backoff. No timers, no I/O: the feed hands it a clock.
 *
 * @see docs/specs/27-client.md#4-activity-feed
 */

/** Health of the stream. */
export type Health = 'connected' | 'stale' | 'reconnecting'

/** Result of noting a boot id. */
export type BootCheck = 'first' | 'same' | 'changed'

/** Options of {@link createLiveness}. */
export interface LivenessOptions {
  /** The server's keep-alive period (ms). */
  keepAliveMs?: number
  /** Extra silence tolerated beyond one keep-alive before the stream counts as stale. */
  graceMs?: number
  /** Ping `/health` at most this often while something is running. */
  pingMs?: number
}

/** Server keep-alive period of the activity stream (ms). */
export const KEEP_ALIVE_MS = 8_000
/** Extra silence tolerated beyond one keep-alive (ms). */
export const GRACE_MS = 5_000
/** Health ping period while busy (ms). */
export const PING_MS = 5_000
/** Default reconnect delays (ms); the last one repeats. */
export const BACKOFF_MS: readonly number[] = [250, 500, 1000, 2000, 4000, 5000]

/** Delay before reconnect attempt `failures` (1-based): exponential steps, capped, up to 50% jitter off. */
export function backoffDelay(
  failures: number,
  steps: readonly number[] = BACKOFF_MS,
  random: () => number = Math.random,
): number {
  const base = steps[Math.min(Math.max(failures, 1) - 1, steps.length - 1)] ?? 1000
  return Math.round(base * (0.5 + random() * 0.5))
}

/** The state machine behind {@link createLiveness}. */
export interface Liveness {
  /** A stream was opened and answered. */
  opened(now: number): void
  /** The stream ended or failed. */
  closed(): void
  /** Any byte arrived on the stream (event or keep-alive comment). */
  byte(now: number): void
  health(now: number): Health
  /** Record a boot id (from `/health` or the stream); says whether it is new, unchanged or a restart. */
  noteBoot(id: string): BootCheck
  /** Time to ping `/health`? Every `pingMs` while busy; always when the stream is stale. */
  shouldPing(now: number, busy: boolean): boolean
  pinged(now: number): void
  readonly boot: string | null
}

/** Create the health tracker of one feed. */
export function createLiveness(options: LivenessOptions = {}): Liveness {
  const staleAfter = (options.keepAliveMs ?? KEEP_ALIVE_MS) + (options.graceMs ?? GRACE_MS)
  const pingMs = options.pingMs ?? PING_MS
  let lastByteAt: number | null = null
  let lastPingAt = Number.NEGATIVE_INFINITY
  let boot: string | null = null
  let up = false

  const health = (now: number): Health => {
    if (!up) return 'reconnecting'
    return lastByteAt !== null && now - lastByteAt > staleAfter ? 'stale' : 'connected'
  }

  return {
    opened(now) {
      up = true
      lastByteAt = now
    },
    closed() {
      up = false
      lastByteAt = null
    },
    byte(now) {
      lastByteAt = now
    },
    health,
    noteBoot(id) {
      if (boot === null) {
        boot = id
        return 'first'
      }
      if (boot === id) return 'same'
      boot = id
      return 'changed'
    },
    shouldPing(now, busy) {
      if (now - lastPingAt < pingMs) return false
      return busy || health(now) === 'stale'
    },
    pinged(now) {
      lastPingAt = now
    },
    get boot() {
      return boot
    },
  }
}
