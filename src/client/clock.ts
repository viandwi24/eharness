/**
 * The clock of the feeds and stores, injectable so tests run on a fake clock.
 *
 * @see docs/specs/27-client.md#4-activity-feed
 */

/** Time, randomness and timers. */
export interface Clock {
  now(): number
  random(): number
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
  setInterval(fn: () => void, ms: number): unknown
  clearInterval(handle: unknown): void
  /** Resolves after `ms` or when `signal` aborts. Default: built on `setTimeout`. */
  sleep?(ms: number, signal: AbortSignal): Promise<void>
}

/** The real clock. */
export const systemClock: Clock = {
  now: () => Date.now(),
  random: () => Math.random(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
}

/** `sleep` of a clock. */
export function sleepOf(clock: Clock): (ms: number, signal: AbortSignal) => Promise<void> {
  if (clock.sleep !== undefined) return clock.sleep.bind(clock)
  return (ms, signal) =>
    new Promise((resolve) => {
      if (signal.aborted) return resolve()
      const timer = clock.setTimeout(done, ms)
      function done(): void {
        clock.clearTimeout(timer)
        signal.removeEventListener('abort', done)
        resolve()
      }
      signal.addEventListener('abort', done, { once: true })
    })
}
