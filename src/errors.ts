/**
 * Error, warning and stop-reason model of eharness.
 *
 * @see docs/specs/10-errors-and-stop-reasons.md
 */

/**
 * Stable machine-readable codes of {@link HarnessError}.
 *
 * @see docs/specs/10-errors-and-stop-reasons.md#1-errors-thrown
 */
export type HarnessErrorCode =
  | 'EH_CONFIG_INVALID'
  | 'EH_DUPLICATE_TOOL'
  | 'EH_DUPLICATE_SKILL'
  | 'EH_DUPLICATE_DATA_PART'
  | 'EH_SERVICE_CONFLICT'
  | 'EH_SERVICE_MISSING'
  | 'EH_PLUGIN_ORDER'
  | 'EH_SESSION_BUSY'
  | 'EH_SESSION_CLOSED'
  | 'EH_INVALID_INPUT'
  | 'EH_PENDING_RESPONSE'
  | 'EH_INVALID_MESSAGE'
  | 'EH_STORAGE'
  | 'EH_COMPACTION_FAILED'
  | 'EH_CONTEXT_OVERFLOW'

/**
 * Codes of `eh.notice` kind messages. Never thrown.
 *
 * @see docs/specs/10-errors-and-stop-reasons.md#1-errors-thrown
 */
export type HarnessNoticeCode = 'EH_TURN_INTERRUPTED' | 'EH_INPUT_BLOCKED' | 'EH_TURN_TIMEOUT'

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
 * Wraps an error thrown by a tool's `execute`.
 *
 * Copies `name` and `message` of the original error (kept in `cause`), so `String(error)` — the
 * text the model sees — is identical to the original, and the UI stream can carry the same text.
 *
 * @see docs/specs/10-errors-and-stop-reasons.md#11-harnesstoolerror
 */
export class HarnessToolError extends Error {
  /** Name of the tool whose execute threw. */
  readonly toolName: string
  /** Id of the failed tool call. */
  readonly toolCallId: string

  constructor(error: unknown, options: { toolName: string; toolCallId: string }) {
    const isError = error instanceof Error
    super(isError ? error.message : String(error), { cause: error })
    this.name = isError ? error.name : 'Error'
    this.toolName = options.toolName
    this.toolCallId = options.toolCallId
  }
}

/**
 * Codes of non-fatal {@link HarnessWarning}s.
 *
 * @see docs/specs/10-errors-and-stop-reasons.md#2-warnings-non-fatal
 */
export type WarningCode =
  | 'W_SHADOWED'
  | 'W_TOOL_SOURCE_FAILED'
  | 'W_MCP_DRIFT'
  | 'W_INVALID_MESSAGE'
  | 'W_INVALID_SKILL'
  | 'W_SKILL_SOURCE_FAILED'
  | 'W_UNKNOWN_DATA_PART'
  | 'W_UNKNOWN_STORED_PART'
  | 'W_WRITE_OUTSIDE_TURN'
  | 'W_COMPACTION_FAILED'
  | 'W_CONTEXT_TRUNCATED'
  | 'W_HOOK_FAILED'
  | 'W_INVALID_TOOL_NAME'
  | 'W_TRANSIENT_OVERRIDE'
  | 'W_DEPRECATED'
  | 'W_SESSION_OPTIONS_IGNORED'
  | 'W_DEFAULT_CONTEXT_WINDOW'
  | 'W_CONTINUE_LIMIT'
  | 'W_LOOP_STUCK'
  | 'W_BUDGET'
  | 'W_MODEL_UNPRICED'
  | 'W_TOOL_OUTPUT_LIMITED'
  | 'W_CACHE_BUST'
  | 'W_OVERFLOW_RETRY'
  | 'W_GRANT_IGNORED'

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

/**
 * Create the warning emitter of one agent (internal).
 *
 * - With `onWarning`, every occurrence is delivered to it.
 * - Without it, the default handler writes to `console.warn`, deduplicated per `code` + `key`
 *   for the lifetime of the emitter (one agent), remembering the 1 000 most recently used keys.
 * - With `strict`, misuse warnings throw `EH_CONFIG_INVALID` instead.
 */
export function createWarningEmitter(options: {
  onWarning?: (warning: HarnessWarning) => void
  strict?: boolean
}): WarningEmitter {
  const seen = new Set<string>()
  return (warning, key) => {
    if (options.strict === true && STRICT_CODES.has(warning.code)) {
      throw new HarnessError('EH_CONFIG_INVALID', `${warning.code}: ${warning.message}`, {
        details: { warning: warning.code, ...warning.details },
      })
    }
    if (options.onWarning !== undefined) {
      options.onWarning(warning)
      return
    }
    const dedupeKey = `${warning.code}\u0000${key ?? ''}`
    if (seen.has(dedupeKey)) {
      // least recently used order: a key seen again moves to the end
      seen.delete(dedupeKey)
      seen.add(dedupeKey)
      return
    }
    seen.add(dedupeKey)
    // bounded (per-turn keys would grow it forever): evict the least recently used key
    if (seen.size > WARNING_DEDUPE_LIMIT) {
      const oldest = seen.values().next().value
      if (oldest !== undefined) seen.delete(oldest)
    }
    console.warn(`[eharness] ${warning.code}: ${warning.message}`)
  }
}
