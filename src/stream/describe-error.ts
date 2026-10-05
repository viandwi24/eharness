/**
 * `describeError`: user-safe error texts for `error` chunks and `eh.notice` messages (internal).
 *
 * @see docs/specs/10-errors-and-stop-reasons.md#3-describeerror
 */
import { APICallError, StreamProviderError } from 'ai'
import { isHarnessError } from '../errors.ts'
import {
  errorChain,
  messageOf,
  redactProviderMessage,
  statusOf,
} from '../internal/provider-errors.ts'

/** Fallback text when nothing user-safe can be derived. */
export const UNEXPECTED_ERROR_TEXT = 'Unexpected error (see server logs)'

/**
 * Map any error to a user-safe message.
 *
 * - `HarnessError`s carry texts written by eharness: returned as-is.
 * - Walks `.cause` chains and AI SDK `RetryError.lastError` / `errors` (same classification as
 *   overflow detection); an error with an HTTP status gets a prefix: `Provider rejected the
 *   request:` (400, 401, 402, 403, 404, 422), `Rate limited:` (429), `Provider unavailable:`
 *   (5xx), followed by the provider's own message for `APICallError` / `StreamProviderError`
 *   (URLs, query strings and key-like tokens redacted, capped at 300 characters) and by
 *   `HTTP <status>` for any other (duck-typed) error.
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
    // only AI SDK provider errors carry a provider message worth showing; it is redacted and
    // capped. Any other error with a status (fetch, gateways, custom wrappers) is described
    // generically: its message may hold URLs with keys, connection strings, …
    const trusted = APICallError.isInstance(candidate) || StreamProviderError.isInstance(candidate)
    const raw = trusted ? messageOf(candidate) : undefined
    const message = raw === undefined ? `HTTP ${status}` : redactProviderMessage(raw)
    if (status === 429) return `Rate limited: ${message}`
    if (status >= 500 && status <= 599) return `Provider unavailable: ${message}`
    if ([400, 401, 402, 403, 404, 422].includes(status)) {
      return `Provider rejected the request: ${message}`
    }
  }
  log?.('eharness: unexpected error', { error })
  return UNEXPECTED_ERROR_TEXT
}
