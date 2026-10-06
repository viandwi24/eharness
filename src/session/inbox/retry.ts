/**
 * Inbox retries (internal): the backoff between failed attempts of an item and the
 * classification of failures (spec 05 §12 rules 11–13).
 *
 * @see docs/specs/05-session-and-storage.md#12-inbox
 * @see docs/decisions/0026-inbox-retries-and-dead-letter.md
 */
import type { InboxBackoffOptions, InboxRetryOptions } from '../../agent/types.ts'

/** Default `inbox.retry.backoff.delayMs`. */
export const DEFAULT_BACKOFF_DELAY_MS = 1_000
/** Default `inbox.retry.backoff.maxDelayMs`. */
export const DEFAULT_BACKOFF_MAX_DELAY_MS = 60_000

/**
 * The wait before the next attempt after `attempts` counted attempts (≥ 1): `fixed` → `delayMs`,
 * `exponential` → `delayMs × 2^(attempts − 1)`, capped at `maxDelayMs`; with `jitter` (default)
 * a uniform draw from `[0, delay]` (full jitter). `random` is injectable for tests.
 */
export function backoffDelay(
  attempts: number,
  options: InboxBackoffOptions | undefined,
  random: () => number = Math.random,
): number {
  const base = options?.delayMs ?? DEFAULT_BACKOFF_DELAY_MS
  const cap = options?.maxDelayMs ?? DEFAULT_BACKOFF_MAX_DELAY_MS
  const n = Math.max(1, Math.floor(attempts))
  // 2^(n-1) overflows to Infinity for huge n; the cap keeps the result finite
  const raw = options?.type === 'fixed' ? base : base * 2 ** (n - 1)
  const delay = Math.min(cap, raw)
  if (options?.jitter === false) return delay
  return Math.floor(Math.min(1, Math.max(0, random())) * delay)
}

/** The `{ code?, message }` view of a failure (`nonRetryable` input, `lastError`). */
export function failureInfo(error: unknown): { code?: string; message: string } {
  const raw = (error as { message?: unknown } | null | undefined)?.message
  const message =
    error instanceof Error ? error.message : typeof raw === 'string' ? raw : String(error)
  const code = (error as { code?: unknown } | null | undefined)?.code
  return typeof code === 'string' ? { code, message } : { message }
}

/** The `lastError` text of a failure (`CODE: message`). */
export function failureText(error: unknown): string {
  const info = failureInfo(error)
  return info.code === undefined ? info.message : `${info.code}: ${info.message}`
}

/** Whether a failure goes dead at once (default: `EH_INVALID_INPUT`). Never throws. */
export function isNonRetryable(retry: InboxRetryOptions, error: unknown): boolean {
  const info = failureInfo(error)
  if (retry.nonRetryable === undefined) return info.code === 'EH_INVALID_INPUT'
  try {
    return retry.nonRetryable(info) === true
  } catch {
    return false
  }
}
