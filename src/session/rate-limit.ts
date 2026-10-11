/**
 * A rate-limited warning sink (internal): the same problem logged at most once per interval, so a
 * storage outage on a polling path shows up in the logs without flooding them.
 *
 * @see docs/specs/10-errors-and-stop-reasons.md#2-warnings-non-fatal
 */

/** Default interval between two logs of one key (ms). */
export const WARN_INTERVAL_MS = 30_000

/** Logs `message` unless `key` was logged less than `intervalMs` ago. */
export type RateLimitedWarn = (key: string, message: string, data?: Record<string, unknown>) => void

/** Create a {@link RateLimitedWarn} over `warn`. `now` is injectable for tests. */
export function createRateLimitedWarn(
  warn: (message: string, data?: Record<string, unknown>) => void,
  options: { intervalMs?: number; now?: () => number } = {},
): RateLimitedWarn {
  const intervalMs = options.intervalMs ?? WARN_INTERVAL_MS
  const now = options.now ?? Date.now
  const last = new Map<string, number>()
  return (key, message, data) => {
    const at = now()
    const previous = last.get(key)
    if (previous !== undefined && at - previous < intervalMs) return
    last.set(key, at)
    if (last.size > 100) {
      const oldest = last.keys().next().value
      if (oldest !== undefined) last.delete(oldest)
    }
    warn(message, data)
  }
}
