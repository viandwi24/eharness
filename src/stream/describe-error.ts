/**
 * `describeError`: user-safe error texts for `error` chunks and `eh.notice` messages (internal).
 *
 * @see docs/specs/10-errors-and-stop-reasons.md#3-describeerror
 */
import { isHarnessError } from '../errors.ts'

/** Fallback text when nothing user-safe can be derived. */
export const UNEXPECTED_ERROR_TEXT = 'Unexpected error (see server logs)'

const MAX_DEPTH = 8

function statusOf(error: object): number | undefined {
  for (const key of ['statusCode', 'status'] as const) {
    const value = (error as Record<string, unknown>)[key]
    if (typeof value === 'number' && Number.isInteger(value)) return value
  }
  return undefined
}

function messageOf(error: object): string | undefined {
  const message = (error as { message?: unknown }).message
  return typeof message === 'string' && message.length > 0 ? message : undefined
}

/** The error, its `.cause` chain and AI SDK `RetryError.lastError`, breadth first, no cycles. */
function chain(error: unknown): object[] {
  const out: object[] = []
  const queue: unknown[] = [error]
  const seen = new Set<unknown>()
  while (queue.length > 0 && out.length < MAX_DEPTH) {
    const next = queue.shift()
    if (typeof next !== 'object' || next === null || seen.has(next)) continue
    seen.add(next)
    out.push(next)
    queue.push((next as { cause?: unknown }).cause, (next as { lastError?: unknown }).lastError)
  }
  return out
}

/**
 * Map any error to a user-safe message.
 *
 * - `HarnessError`s carry texts written by eharness: returned as-is.
 * - Walks `.cause` chains (and `RetryError.lastError`); an error with an HTTP status uses the
 *   provider's own message with a prefix: `Provider rejected the request:` (400, 401, 402, 403,
 *   404, 422), `Rate limited:` (429), `Provider unavailable:` (5xx).
 * - Never includes headers, API keys, request bodies or stack traces.
 * - Falls back to {@link UNEXPECTED_ERROR_TEXT}; `log` receives the full error then.
 */
export function describeError(
  error: unknown,
  log?: (message: string, data?: Record<string, unknown>) => void,
): string {
  const errors = chain(error)
  for (const candidate of errors) {
    if (isHarnessError(candidate)) return candidate.message
  }
  for (const candidate of errors) {
    const status = statusOf(candidate)
    if (status === undefined) continue
    const message = messageOf(candidate) ?? `HTTP ${status}`
    if (status === 429) return `Rate limited: ${message}`
    if (status >= 500 && status <= 599) return `Provider unavailable: ${message}`
    if ([400, 401, 402, 403, 404, 422].includes(status)) {
      return `Provider rejected the request: ${message}`
    }
  }
  log?.('eharness: unexpected error', { error })
  return UNEXPECTED_ERROR_TEXT
}
