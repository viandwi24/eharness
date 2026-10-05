/**
 * Provider error classification (internal), shared by overflow detection and `describeError` so
 * both agree on which errors carry an HTTP status and which texts they expose.
 *
 * Recognised shapes, in this order:
 * - AI SDK `RetryError`: unwrapped to `lastError` (with its whole chain), then the other `errors`
 *   (most recent first).
 * - AI SDK `APICallError`: `statusCode`, `message`, `responseBody`.
 * - AI SDK `StreamProviderError`: `statusCode`, `message`, `data`, `code`, `type`.
 * - Anything else (gateway, fetch, custom wrappers): duck-typed `statusCode` / `status`, and
 *   `message`, `responseBody`, `body`, `data`, `error`.
 * `.cause` is followed for every error (see {@link errorChain} for the order).
 *
 * @see docs/specs/06-compaction.md#7-overflow-recovery
 * @see docs/specs/10-errors-and-stop-reasons.md#3-describeerror
 */
import { APICallError, RetryError, StreamProviderError } from 'ai'

const MAX_CHAIN = 8

/**
 * The error and everything it wraps, depth first, cycle-safe, at most 8 errors: an error is
 * followed by the errors it wraps (AI SDK `RetryError`: `lastError` with its whole chain, then
 * the older `errors` newest first; a duck-typed `lastError` likewise), then by its `.cause` chain.
 */
export function errorChain(error: unknown): object[] {
  const out: object[] = []
  const seen = new Set<unknown>()
  const walk = (value: unknown): void => {
    let current = value
    while (typeof current === 'object' && current !== null && out.length < MAX_CHAIN) {
      if (seen.has(current)) return
      seen.add(current)
      out.push(current)
      if (RetryError.isInstance(current)) {
        walk(current.lastError)
        for (const older of [...current.errors].reverse()) walk(older)
      } else {
        walk((current as { lastError?: unknown }).lastError)
      }
      current = (current as { cause?: unknown }).cause
    }
  }
  walk(error)
  return out
}

/** HTTP status of one error (not its chain), if it carries one. */
export function statusOf(error: object): number | undefined {
  if (APICallError.isInstance(error) || StreamProviderError.isInstance(error)) {
    return error.statusCode
  }
  for (const key of ['statusCode', 'status'] as const) {
    const value = (error as Record<string, unknown>)[key]
    if (typeof value === 'number' && Number.isInteger(value)) return value
  }
  return undefined
}

/** Longest provider message `describeError` passes on (characters). */
export const PROVIDER_MESSAGE_MAX = 300

/**
 * A provider message made safe for clients: URLs, query parameters and key-like tokens
 * (`sk-…`, `Bearer …`, runs of 32+ hex/base64 characters) are replaced by `[redacted]`, and the
 * text is capped at {@link PROVIDER_MESSAGE_MAX} characters. The patterns are not public API;
 * only the behaviour "secrets are redacted" is (spec 10 §3).
 */
export function redactProviderMessage(text: string): string {
  const out = text
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi, '[redacted]')
    .replace(/[?&][\w.-]+=[^\s&"'<>]*/g, '[redacted]')
    .replace(/\bBearer\s+[\w.~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/\b(?:sk|pk|rk|key|api[_-]?key)[-_][\w-]{8,}/gi, '[redacted]')
    .replace(/[A-Za-z0-9+/_=-]{32,}/g, '[redacted]')
  return out.length > PROVIDER_MESSAGE_MAX ? `${out.slice(0, PROVIDER_MESSAGE_MAX - 1)}…` : out
}

/** Non-empty `message` of one error, if any. */
export function messageOf(error: object): string | undefined {
  const message = (error as { message?: unknown }).message
  return typeof message === 'string' && message.length > 0 ? message : undefined
}

function pushText(out: string[], value: unknown): void {
  if (typeof value === 'string') out.push(value)
  else if (typeof value === 'number') out.push(String(value))
  else if (value !== undefined && value !== null && typeof value === 'object') {
    try {
      out.push(JSON.stringify(value))
    } catch {}
  }
}

/** Texts one error exposes (message and provider payload) for pattern matching. */
export function textsOf(error: object): string[] {
  const out: string[] = []
  if (APICallError.isInstance(error)) {
    for (const value of [error.message, error.responseBody, error.data]) pushText(out, value)
    return out
  }
  if (StreamProviderError.isInstance(error)) {
    for (const value of [error.message, error.data, error.code, error.type]) pushText(out, value)
    return out
  }
  const e = error as Record<string, unknown>
  for (const value of [e.message, e.responseBody, e.body, e.data, e.error]) pushText(out, value)
  return out
}
