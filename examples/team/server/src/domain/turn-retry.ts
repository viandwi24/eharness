/**
 * Automatic recovery of transient failures for turns nobody watches. Pure: the classification of a
 * failed turn, the retry policy and the texts. The scheduling is `infra/eh/turn-retry-service.ts`.
 *
 * A turn that ends `stop: 'error'` with a provider outage (502/503/overloaded/no capacity), a rate
 * limit (429), a timeout or a network reset is tried again later with backoff, continuing from the
 * stored state of the session (`session.send(undefined)`), never from the start. A user abort, a
 * budget stop, an auth error (401/403), a rejected request (400/402/404/422), a content filter and
 * a context overflow are NOT retried: asking again gives the same answer.
 */

/** Retries of one failed turn, in order: delays before attempt 1, 2, 3, 4. */
export const RETRY_DELAYS_MS = [30_000, 120_000, 600_000, 1_800_000] as const
export const MAX_RETRY_ATTEMPTS = RETRY_DELAYS_MS.length
/** The jitter of a delay: +-20 %, so many failed runs do not hit a recovering provider together. */
export const RETRY_JITTER = 0.2

/** Why a failure is retried: a known transient provider/network failure, or one we cannot name. */
export type RetryKind = 'transient' | 'unknown'
/** An unknown failure (the library says "Unexpected error") gets fewer attempts. */
export const UNKNOWN_MAX_ATTEMPTS = 2

/** The failure of a turn as `TurnResult` reports it. */
export interface TurnFailure {
  stop: string
  error?: { code: string; message: string } | undefined
}

const TRANSIENT_TEXT =
  /unavailable|overloaded|no capacity|capacity|rate limit|too many requests|timed? ?out|timeout|econnreset|econnrefused|enotfound|eai_again|etimedout|socket hang up|fetch failed|network|connection (?:reset|closed|error)|bad gateway|gateway time-?out|temporarily|try again/i
const PERMANENT_TEXT =
  /credit|quota|insufficient|billing|payment required|content[ -]?(?:policy|filter)|safety|invalid api key|context (?:length|window)|too long/i

/** The text of a failure names a temporary cause (the supervisor classifies stored summaries with it). */
export const looksTransient = (message: string): boolean =>
  !PERMANENT_TEXT.test(message) && TRANSIENT_TEXT.test(message)

/**
 * Whether a failed turn is worth trying again, and of which kind; undefined = never retried.
 * `describeError` of the library gives `EH_PROVIDER` the prefixes `Provider unavailable:` (5xx),
 * `Rate limited:` (429) and `Provider rejected the request:` (4xx); a network error without any
 * status has no text of its own and becomes `EH_RUN_FAILED` ("Unexpected error").
 */
export function classifyFailure(f: TurnFailure): RetryKind | undefined {
  if (f.stop !== 'error' || f.error === undefined) return undefined
  const { code, message } = f.error
  if (PERMANENT_TEXT.test(message)) return undefined
  if (code === 'EH_PROVIDER') {
    if (/^Provider rejected the request/i.test(message)) return undefined
    if (/^(Provider unavailable|Rate limited):/i.test(message)) return 'transient'
    return TRANSIENT_TEXT.test(message) ? 'transient' : undefined
  }
  // the lock or storage service was down: not the session's fault
  if (code === 'EH_LOCK_UNAVAILABLE') return 'transient'
  if (code === 'EH_RUN_FAILED') return TRANSIENT_TEXT.test(message) ? 'transient' : 'unknown'
  return undefined
}

export const maxAttemptsOf = (kind: RetryKind): number =>
  kind === 'unknown' ? UNKNOWN_MAX_ATTEMPTS : MAX_RETRY_ATTEMPTS

/** The delay before attempt `attempt` (1-based), with jitter from `random` in [0, 1). */
export function retryDelayMs(attempt: number, random: () => number = Math.random): number {
  const base = RETRY_DELAYS_MS[Math.min(Math.max(attempt, 1), RETRY_DELAYS_MS.length) - 1] as number
  return Math.round(base * (1 + (random() * 2 - 1) * RETRY_JITTER))
}

/** The state of a failed turn that is waiting for its retry (the task and the run show it). */
export interface PendingRetry {
  sessionId: string
  /** The retry that is waiting (1-based). */
  attempt: number
  max: number
  nextAt: number
  errorCode: string
  errorMessage: string
  /** `running`: the retry turn runs right now. */
  running: boolean
}

const clock = (at: number): string => new Date(at).toISOString().slice(11, 16)

/** `Retrying (attempt 2 of 4) at 14:05 UTC: Provider unavailable: …` for the summary of a task. */
export function retryingText(r: Pick<PendingRetry, 'attempt' | 'max' | 'nextAt' | 'errorMessage'>) {
  return `Retrying (attempt ${r.attempt} of ${r.max}) at ${clock(r.nextAt)} UTC. Last error: ${r.errorMessage}`.slice(
    0,
    500,
  )
}

/** The short line of a Health finding or a run reason: "will retry at 14:05 UTC (attempt 2 of 4)". */
export const willRetryText = (r: Pick<PendingRetry, 'attempt' | 'max' | 'nextAt'>): string =>
  `will retry at ${clock(r.nextAt)} UTC (attempt ${r.attempt} of ${r.max})`

/** What the owners read when the last attempt failed. */
export const gaveUpText = (max: number, errorMessage: string): string =>
  `It failed with a temporary error and ${max} automatic retries did not help. Last error: ${errorMessage}`.slice(
    0,
    500,
  )
