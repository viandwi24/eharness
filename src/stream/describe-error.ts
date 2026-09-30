/**
 * `describeError`: user-safe error texts for `error` chunks and `eh.notice` messages (internal).
 *
 * @see docs/specs/10-errors-and-stop-reasons.md#3-describeerror
 */
import { isHarnessError } from '../errors.ts'
import { errorChain, messageOf, statusOf } from '../internal/provider-errors.ts'

/** Fallback text when nothing user-safe can be derived. */
export const UNEXPECTED_ERROR_TEXT = 'Unexpected error (see server logs)'

/**
 * Map any error to a user-safe message.
 *
 * - `HarnessError`s carry texts written by eharness: returned as-is.
 * - Walks `.cause` chains and AI SDK `RetryError.lastError` / `errors` (same classification as
 *   overflow detection); an error with an HTTP status (`APICallError`, `StreamProviderError`, or
 *   a duck-typed `statusCode` / `status`) uses the provider's own message with a prefix: `Provider rejected the request:` (400, 401, 402, 403,
 *   404, 422), `Rate limited:` (429), `Provider unavailable:` (5xx).
 * - Never includes headers, API keys, request bodies or stack traces.
 * - Falls back to {@link UNEXPECTED_ERROR_TEXT}; `log` receives the full error then.
 */
export function describeError(
  error: unknown,
  log?: (message: string, data?: Record<string, unknown>) => void,
): string {
  const errors = errorChain(error)
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
