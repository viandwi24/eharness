/**
 * Log-safe error serialisation (internal): the default logger prints errors as
 * `{ name, message, code, statusCode, cause }` and never as raw objects, because provider errors
 * carry request bodies, response headers and URLs with keys.
 *
 * @see docs/specs/01-agent-and-plugins.md#4-harnesscontext-sessionturnstep-context
 */

/** A serialised error. */
export interface SafeError {
  name: string
  message: string
  code?: string | number
  statusCode?: number
  cause?: SafeError
}

const MAX_DEPTH = 5

/** Cut the query string and fragment of every URL in `text` (they hold keys and tokens). */
function stripUrlQueries(text: string): string {
  return text.replace(/(https?:\/\/[^\s?#"'<>]+)[?#][^\s"'<>]*/g, '$1?…')
}

/** `error` as {@link SafeError}: name, message, code, status code and the cause chain only. */
export function serializeError(error: unknown, depth = 0): SafeError {
  if (typeof error !== 'object' || error === null) {
    return { name: 'Error', message: stripUrlQueries(String(error)) }
  }
  const e = error as {
    name?: unknown
    message?: unknown
    code?: unknown
    statusCode?: unknown
    status?: unknown
    cause?: unknown
  }
  const out: SafeError = {
    name: typeof e.name === 'string' ? e.name : 'Error',
    message: stripUrlQueries(typeof e.message === 'string' ? e.message : String(error)),
  }
  if (typeof e.code === 'string' || typeof e.code === 'number') out.code = e.code
  const status = typeof e.statusCode === 'number' ? e.statusCode : e.status
  if (typeof status === 'number') out.statusCode = status
  if (e.cause !== undefined && depth < MAX_DEPTH) out.cause = serializeError(e.cause, depth + 1)
  return out
}

function isErrorLike(value: unknown): boolean {
  return (
    value instanceof Error ||
    (typeof value === 'object' &&
      value !== null &&
      typeof (value as { message?: unknown }).message === 'string' &&
      typeof (value as { name?: unknown }).name === 'string')
  )
}

/** `data` with every error value (top level, or inside an array) replaced by its {@link SafeError}. */
export function safeLogData(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(data)) {
    out[key] = isErrorLike(value)
      ? serializeError(value)
      : Array.isArray(value)
        ? value.map((v) => (isErrorLike(v) ? serializeError(v) : v))
        : value
  }
  return out
}
