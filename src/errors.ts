/**
 * Error, warning and stop-reason model of eharness.
 *
 * The code lists live in `src/codes.ts` (one source of truth); the types are re-exported here.
 *
 * @see docs/specs/10-errors-and-stop-reasons.md
 */
import type { HarnessErrorCode, HarnessNoticeCode, WarningCode } from './codes.ts'
import { errorText } from './internal/util.ts'

export type { HarnessErrorCode, HarnessNoticeCode, WarningCode }

/** Options of the {@link HarnessError} constructor. */
export interface HarnessErrorOptions {
  /** Structured, JSON-serializable details (e.g. `{ reason: 'stale' }`). */
  details?: Record<string, unknown>
  /** The underlying error, if any. */
  cause?: unknown
}

/**
 * Error thrown by eharness for programmer and configuration errors and explicit API misuse.
 *
 * Never thrown for model or tool failures during a turn: those end the turn with
 * `stop: 'error'` (spec 05 §2).
 *
 * @example
 * ```ts
 * try { await session.ready() } catch (e) {
 *   if (isHarnessError(e, 'EH_SERVICE_MISSING')) console.error(e.message)
 * }
 * ```
 * @see docs/specs/10-errors-and-stop-reasons.md#1-errors-thrown
 */
export class HarnessError extends Error {
  /** Stable machine-readable error code (`EH_*`). */
  readonly code: HarnessErrorCode
  /** Structured details, e.g. the owners involved in a conflict. */
  readonly details?: Record<string, unknown>

  constructor(code: HarnessErrorCode, message: string, options?: HarnessErrorOptions) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'HarnessError'
    this.code = code
    if (options?.details !== undefined) this.details = options.details
  }
}

/**
 * Type guard for {@link HarnessError}, optionally narrowed to one `code`.
 *
 * Works across package copies (checks `name` and `code`, not only `instanceof`).
 *
 * @see docs/specs/10-errors-and-stop-reasons.md#1-errors-thrown
 */
export function isHarnessError(error: unknown, code?: HarnessErrorCode): error is HarnessError {
  if (!(error instanceof Error) || error.name !== 'HarnessError') return false
  const actual = (error as { code?: unknown }).code
  if (typeof actual !== 'string' || !actual.startsWith('EH_')) return false
  return code === undefined || actual === code
}

/**
 * Named constructors of the errors the runtime raises more than once (internal). One construction
 * point per code keeps messages and `details` identical wherever the condition is reported.
 */

/** `EH_SESSION_CLOSED`: the session handle was closed or evicted. */
export function sessionClosedError(sessionId: string): HarnessError {
  return new HarnessError(
    'EH_SESSION_CLOSED',
    `Session '${sessionId}' was closed or evicted; call agent.session(id) again.`,
    { details: { sessionId } },
  )
}

/** `EH_SESSION_BUSY`: a turn of the session is running (here or in another instance). */
export function sessionBusyError(
  sessionId: string,
  message = `A turn of session '${sessionId}' is running.`,
  cause?: unknown,
): HarnessError {
  return new HarnessError('EH_SESSION_BUSY', message, {
    details: { sessionId },
    ...(cause === undefined ? {} : { cause }),
  })
}

/**
 * `EH_LOCK_UNAVAILABLE`: `SessionLock.acquire` failed for a reason other than contention (the
 * lock service is down, a network error, a timeout). Contention is `EH_SESSION_BUSY` (spec 05 §8).
 */
export function lockUnavailableError(sessionId: string, cause: unknown): HarnessError {
  return new HarnessError(
    'EH_LOCK_UNAVAILABLE',
    `The session lock service failed (this is not contention): ${errorText(cause)}`,
    { details: { sessionId }, cause },
  )
}

/**
 * Classify a rejected `SessionLock.acquire`: a `HarnessError` `EH_SESSION_BUSY` means the lock is
 * held elsewhere (contention); any other rejection is an infrastructure failure.
 */
export function lockFailure(sessionId: string, cause: unknown): HarnessError {
  return isHarnessError(cause, 'EH_SESSION_BUSY')
    ? sessionBusyError(sessionId, 'The session is locked by another instance.', cause)
    : lockUnavailableError(sessionId, cause)
}

/** `EH_STORAGE` for an adapter failure; a `HarnessError` cause passes through unchanged. */
export function storageError(
  kind: 'Message' | 'State',
  what: string,
  cause: unknown,
): HarnessError {
  if (isHarnessError(cause)) return cause
  return new HarnessError('EH_STORAGE', `${kind} storage failed (${what}).`, { cause })
}

/** `EH_INVALID_INPUT` for rejected caller input. */
export function invalidInputError(
  message: string,
  details?: Record<string, unknown>,
  cause?: unknown,
): HarnessError {
  return new HarnessError('EH_INVALID_INPUT', message, {
    ...(details === undefined ? {} : { details }),
    ...(cause === undefined ? {} : { cause }),
  })
}

/** `EH_CONFIG_INVALID` for a misconfiguration or an API misuse. */
export function configError(message: string, details?: Record<string, unknown>): HarnessError {
  return new HarnessError('EH_CONFIG_INVALID', message, details === undefined ? {} : { details })
}

/** Any thrown value as a `HarnessError` (`EH_INVALID_INPUT` for a foreign error). */
export function asInvalidInputError(error: unknown): HarnessError {
  if (isHarnessError(error)) return error
  return invalidInputError(errorText(error), undefined, error)
}

/**
 * Wraps an error thrown by a tool's `execute`.
 *
 * Copies `name` and `message` of the original error (kept in `cause`), so `String(error)` — the
 * text the model sees — is identical to the original, and the UI stream can carry the same text.
 * With `config.toolErrorText`, `String(error)` is the mapped `text` instead (spec 10 §1.1).
 *
 * @see docs/specs/10-errors-and-stop-reasons.md#11-harnesstoolerror
 */
export class HarnessToolError extends Error {
  /** Name of the tool whose execute threw. */
  readonly toolName: string
  /** Id of the failed tool call. */
  readonly toolCallId: string

  /** The mapped text (`config.toolErrorText`), when one was set. */
  readonly text: string | undefined

  constructor(
    error: unknown,
    options: { toolName: string; toolCallId: string; text?: string | undefined },
  ) {
    const isError = error instanceof Error
    super(isError ? error.message : String(error), { cause: error })
    this.name = isError ? error.name : 'Error'
    this.toolName = options.toolName
    this.toolCallId = options.toolCallId
    this.text = options.text
  }

  /** `String(error)`: the mapped text when set, else `<name>: <message>` of the original. */
  override toString(): string {
    return this.text ?? super.toString()
  }
}

/**
 * A non-fatal problem, delivered to `config.onWarning`, as a transient `data-eh.warning` part
 * during a turn, and as a session `data` event otherwise.
 *
 * @see docs/specs/10-errors-and-stop-reasons.md#2-warnings-non-fatal
 */
export interface HarnessWarning {
  /** Stable warning code (`W_*`). */
  code: WarningCode
  /** Human-readable description. */
  message: string
  /** Structured details (owners, names, ids). */
  details?: Record<string, unknown>
}

/** Misuse warnings that `config.strict: true` turns into thrown `EH_CONFIG_INVALID`. */
const STRICT_CODES: ReadonlySet<WarningCode> = new Set<WarningCode>([
  'W_TRANSIENT_OVERRIDE',
  'W_UNKNOWN_DATA_PART',
  'W_WRITE_OUTSIDE_TURN',
])

/** Emits one warning. `key` scopes deduplication of the default handler (e.g. a tool name). */
export type WarningEmitter = (warning: HarnessWarning, key?: string) => void

/** Keys remembered by the default warning handler (least recently used are forgotten). */
const WARNING_DEDUPE_LIMIT = 1_000

/** Default `config.warnings.dedupeWindowMs`: the default handler prints a code + key once per window. */
export const DEFAULT_WARNING_DEDUPE_WINDOW_MS = 60_000

/**
 * Create the warning emitter of one agent (internal).
 *
 * - With `onWarning`, every occurrence is delivered to it.
 * - Without it, the default handler writes to `console.warn`, deduplicated per `code` + `key`
 *   within a time window (`dedupeWindowMs`, default 60 s; the next report counts the suppressed
 *   repeats), remembering the 1 000 most recently used keys.
 * - With `strict`, misuse warnings throw `EH_CONFIG_INVALID` instead.
 */
export function createWarningEmitter(options: {
  onWarning?: (warning: HarnessWarning) => void
  strict?: boolean
  /** Default handler: print a key again after this many ms (default 60 000; 0 = every time). */
  dedupeWindowMs?: number
  /** Clock (tests). Default `Date.now`. */
  now?: () => number
}): WarningEmitter {
  const windowMs = options.dedupeWindowMs ?? DEFAULT_WARNING_DEDUPE_WINDOW_MS
  const now = options.now ?? Date.now
  /** key -> start of the window and the repeats suppressed in it. */
  const seen = new Map<string, { at: number; suppressed: number }>()
  let handlerFailureReported = false
  return (warning, key) => {
    if (options.strict === true && STRICT_CODES.has(warning.code)) {
      throw new HarnessError('EH_CONFIG_INVALID', `${warning.code}: ${warning.message}`, {
        details: { warning: warning.code, ...warning.details },
      })
    }
    if (options.onWarning !== undefined) {
      // a handler bug must never break the runtime (it is called from finalisation paths too)
      try {
        options.onWarning(warning)
      } catch (handlerError) {
        if (!handlerFailureReported) {
          handlerFailureReported = true
          try {
            console.error(
              '[eharness] onWarning handler threw (further failures are silent):',
              handlerError,
            )
          } catch {}
        }
      }
      return
    }
    const dedupeKey = `${warning.code}\u0000${key ?? ''}`
    const at = now()
    const entry = seen.get(dedupeKey)
    let suppressed = 0
    // least recently used order: a key seen again moves to the end
    if (entry !== undefined) seen.delete(dedupeKey)
    if (entry !== undefined && at - entry.at < windowMs) {
      entry.suppressed++
      seen.set(dedupeKey, entry)
      return
    }
    if (entry !== undefined) suppressed = entry.suppressed
    seen.set(dedupeKey, { at, suppressed: 0 })
    // bounded (per-turn keys would grow it forever): evict the least recently used key
    if (seen.size > WARNING_DEDUPE_LIMIT) {
      const oldest = seen.keys().next().value
      if (oldest !== undefined) seen.delete(oldest)
    }
    const repeats =
      suppressed > 0 ? ` (${suppressed} similar suppressed since the last report)` : ''
    console.warn(`[eharness] ${warning.code}: ${warning.message}${repeats}`)
  }
}
