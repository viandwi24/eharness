/**
 * Provider error classification (internal), shared by overflow detection and `describeError` so
 * both agree on which errors carry an HTTP status and which texts they expose.
 *
 * Recognised shapes, in this order:
 * - AI SDK `RetryError`: unwrapped to `lastError`, then the other `errors` (most recent first).
 * - AI SDK `APICallError`: `statusCode`, `message`, `responseBody`.
 * - AI SDK `StreamProviderError`: `statusCode`, `message`, `data`, `code`, `type`.
 * - Anything else (gateway, fetch, custom wrappers): duck-typed `statusCode` / `status`, and
 *   `message`, `responseBody`, `body`, `data`, `error`.
 * `.cause` is followed for every error.
 *
 * @see docs/specs/06-compaction.md#7-overflow-recovery
 * @see docs/specs/10-errors-and-stop-reasons.md#3-describeerror
 */
import { APICallError, RetryError, StreamProviderError } from 'ai'

const MAX_CHAIN = 8

/**
 * The error, its `.cause` chain and the errors wrapped by AI SDK `RetryError` (`lastError` first,
 * then `errors` from most recent), breadth first, cycle-safe, bounded.
 */
export function errorChain(error: unknown): object[] {
  const out: object[] = []
  const queue: unknown[] = [error]
  const seen = new Set<unknown>()
  while (queue.length > 0 && out.length < MAX_CHAIN) {
    const next = queue.shift()
    if (typeof next !== 'object' || next === null || seen.has(next)) continue
    seen.add(next)
    out.push(next)
    queue.push((next as { cause?: unknown }).cause)
    if (RetryError.isInstance(next)) queue.push(next.lastError, ...[...next.errors].reverse())
    else queue.push((next as { lastError?: unknown }).lastError)
  }
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
