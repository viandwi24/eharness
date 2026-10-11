import type { HarnessWarning } from 'eharness'

/** Same default window as the library's default handler (`warnings.dedupeWindowMs`). */
export const DEFAULT_WARNING_DEDUPE_WINDOW_MS = 60_000
const LIMIT = 1_000

/**
 * Warning handler that prints each code + key once per window (the library only dedupes its own
 * default handler). The key is the stored message id for `W_REPAIRED_MESSAGE` (read-time repair
 * never writes back, so every load warns again), else the message text.
 */
export function createDedupedWarningLog(options: {
  dedupeWindowMs?: number
  now?: () => number
  print?: (line: string) => void
}): (w: HarnessWarning) => void {
  const windowMs = options.dedupeWindowMs ?? DEFAULT_WARNING_DEDUPE_WINDOW_MS
  const now = options.now ?? Date.now
  const print = options.print ?? ((line: string) => console.warn(line))
  const seen = new Map<string, { at: number; suppressed: number }>()
  return (w) => {
    const id = w.details?.messageId
    const key = `${w.code}\u0000${typeof id === 'string' ? id : w.message}`
    const at = now()
    const entry = seen.get(key)
    let suppressed = 0
    if (entry !== undefined) seen.delete(key)
    if (entry !== undefined && at - entry.at < windowMs) {
      entry.suppressed++
      seen.set(key, entry)
      return
    }
    if (entry !== undefined) suppressed = entry.suppressed
    seen.set(key, { at, suppressed: 0 })
    if (seen.size > LIMIT) {
      const oldest = seen.keys().next().value
      if (oldest !== undefined) seen.delete(oldest)
    }
    const repeats =
      suppressed > 0 ? ` (${suppressed} similar suppressed since the last report)` : ''
    print(`eharness warning ${w.code}: ${w.message}${repeats}`)
  }
}
