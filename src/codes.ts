/**
 * The single source of truth of every machine-readable code: thrown errors, `eh.notice` codes and
 * warnings. Types are derived from the lists, so a code cannot exist in a type and not in the list
 * (a test checks that every code is documented in spec 10).
 *
 * `EH_*` codes name a condition that ends or refuses an operation; `W_*` codes name a non-fatal
 * problem the run survived. A condition may have one of each, with different semantics (see
 * `EH_COMPACTION_FAILED` / `W_COMPACTION_FAILED`, `EH_CONTEXT_THRASH` / `W_CONTEXT_THRASH` in
 * spec 10).
 *
 * @see docs/specs/10-errors-and-stop-reasons.md
 */

/** Codes of {@link HarnessError} and of `TurnResult.error` (internal list). */
export const HARNESS_ERROR_CODES = [
  'EH_CONFIG_INVALID',
  'EH_MCP_TIMEOUT',
  'EH_DUPLICATE_TOOL',
  'EH_DUPLICATE_SKILL',
  'EH_DUPLICATE_DATA_PART',
  'EH_SERVICE_CONFLICT',
  'EH_SERVICE_MISSING',
  'EH_PLUGIN_ORDER',
  'EH_SESSION_BUSY',
  'EH_SESSION_CLOSED',
  'EH_INVALID_INPUT',
  'EH_PENDING_RESPONSE',
  'EH_INVALID_MESSAGE',
  'EH_STORAGE',
  'EH_COMPACTION_FAILED',
  'EH_CONTEXT_OVERFLOW',
  'EH_LOCK_UNAVAILABLE',
  'EH_EVENTS_OVERFLOW',
  'EH_PROVIDER_AUTH',
  'EH_PROVIDER',
  'EH_RUN_FAILED',
] as const

/** Codes of `eh.notice` kind messages that are not errors (internal list). */
export const HARNESS_NOTICE_CODES = [
  'EH_TURN_INTERRUPTED',
  'EH_INPUT_BLOCKED',
  'EH_TURN_TIMEOUT',
  'EH_CONTEXT_THRASH',
  'EH_COST_CAP',
] as const

/** Codes of non-fatal warnings (internal list). */
export const WARNING_CODES = [
  'W_SHADOWED',
  'W_TOOL_SOURCE_FAILED',
  'W_MCP_DRIFT',
  'W_INVALID_MESSAGE',
  'W_INVARIANT_VIOLATION',
  'W_REPAIRED_MESSAGE',
  'W_INVALID_SKILL',
  'W_SKILL_SOURCE_FAILED',
  'W_UNKNOWN_DATA_PART',
  'W_UNKNOWN_STORED_PART',
  'W_WRITE_OUTSIDE_TURN',
  'W_COMPACTION_FAILED',
  'W_COMPACTION_FLUSH_SKIPPED',
  'W_CONTEXT_TRUNCATED',
  'W_HOOK_FAILED',
  'W_HOOK_TIMEOUT',
  'W_INVALID_TOOL_NAME',
  'W_TRANSIENT_OVERRIDE',
  'W_DEPRECATED',
  'W_SESSION_OPTIONS_IGNORED',
  'W_DEFAULT_CONTEXT_WINDOW',
  'W_CONTINUE_LIMIT',
  'W_LOOP_STUCK',
  'W_BUDGET',
  'W_MODEL_UNPRICED',
  'W_BUDGET_LEDGER_FAILED',
  'W_TOOL_OUTPUT_LIMITED',
  'W_TOOL_INPUT_REPAIRED',
  'W_TOOL_MEDIA_OFFLOAD',
  'W_CACHE_BUST',
  'W_OVERFLOW_RETRY',
  'W_CONTEXT_THRASH',
  'W_GRANT_IGNORED',
  'W_ABORT_UNSUPPORTED',
  'W_OUTPUT_INVALID',
  'W_INBOX_FAILED',
  'W_STREAM_LOG_FAILED',
  'W_GUARD_UNAVAILABLE',
  'W_INBOX_DEAD_LETTER',
  'W_PAGE_CONTEXT_LIMITED',
  'W_TOOL_ORDER',
  'W_WEB_NO_RESOLVER',
  'W_PERMISSION_SESSION_RULE_GLOBAL',
] as const

/**
 * Stable machine-readable codes of {@link HarnessError} (and of `TurnResult.error` of a failed turn).
 *
 * @see docs/specs/10-errors-and-stop-reasons.md#1-errors-thrown
 */
export type HarnessErrorCode = (typeof HARNESS_ERROR_CODES)[number]

/**
 * Codes of `eh.notice` kind messages that name a stop reason, not an error. Never thrown.
 *
 * @see docs/specs/10-errors-and-stop-reasons.md#1-errors-thrown
 */
export type HarnessNoticeCode = (typeof HARNESS_NOTICE_CODES)[number]

/**
 * Codes of non-fatal {@link HarnessWarning}s.
 *
 * @see docs/specs/10-errors-and-stop-reasons.md#2-warnings-non-fatal
 */
export type WarningCode = (typeof WARNING_CODES)[number]

/**
 * Every stop reason that is a fixed string, as constants, so UIs and apps stop matching string
 * literals: `result.stop === STOP_REASONS.INTERRUPTED`. `StopReason` also admits
 * `` `plugin:${string}` `` (a `step.end` hook stop), which has no constant. A test keeps this
 * object equal to the list of spec 10 §4.
 *
 * @see docs/specs/10-errors-and-stop-reasons.md#4-stop-reasons
 */
export const STOP_REASONS = {
  COMPLETE: 'complete',
  TOOL_PENDING: 'tool-pending',
  LENGTH: 'length',
  CONTENT_FILTER: 'content-filter',
  ERROR: 'error',
  ABORTED: 'aborted',
  TIMEOUT: 'timeout',
  BLOCKED: 'blocked',
  STUCK: 'stuck',
  CONTEXT_THRASH: 'context-thrash',
  INTERRUPTED: 'interrupted',
  MAX_STEPS: 'max-steps',
  COST_CAP: 'cost-cap',
  OUTPUT_INVALID: 'output-invalid',
} as const

/** A stop reason with a constant in {@link STOP_REASONS} (`StopReason` without the plugin form). */
export type KnownStopReason = (typeof STOP_REASONS)[keyof typeof STOP_REASONS]

/**
 * Every library code an `eh.notice` message can carry (`NoticePayload.code`): the notice codes
 * (`EH_TURN_INTERRUPTED`, `EH_TURN_TIMEOUT`, `EH_CONTEXT_THRASH`, `EH_INPUT_BLOCKED`,
 * `EH_COST_CAP`) and the error codes a failed turn stores as its notice (`EH_RUN_FAILED`,
 * `EH_PROVIDER`, `EH_STORAGE`, ...). Each key equals its value. A test keeps it equal to
 * `HARNESS_NOTICE_CODES` plus `HARNESS_ERROR_CODES`. Apps may also store codes of their own.
 *
 * @see docs/specs/10-errors-and-stop-reasons.md#1-errors-thrown
 */
export const NOTICE_CODES = {
  EH_TURN_INTERRUPTED: 'EH_TURN_INTERRUPTED',
  EH_INPUT_BLOCKED: 'EH_INPUT_BLOCKED',
  EH_TURN_TIMEOUT: 'EH_TURN_TIMEOUT',
  EH_CONTEXT_THRASH: 'EH_CONTEXT_THRASH',
  EH_COST_CAP: 'EH_COST_CAP',
  EH_CONFIG_INVALID: 'EH_CONFIG_INVALID',
  EH_MCP_TIMEOUT: 'EH_MCP_TIMEOUT',
  EH_DUPLICATE_TOOL: 'EH_DUPLICATE_TOOL',
  EH_DUPLICATE_SKILL: 'EH_DUPLICATE_SKILL',
  EH_DUPLICATE_DATA_PART: 'EH_DUPLICATE_DATA_PART',
  EH_SERVICE_CONFLICT: 'EH_SERVICE_CONFLICT',
  EH_SERVICE_MISSING: 'EH_SERVICE_MISSING',
  EH_PLUGIN_ORDER: 'EH_PLUGIN_ORDER',
  EH_SESSION_BUSY: 'EH_SESSION_BUSY',
  EH_SESSION_CLOSED: 'EH_SESSION_CLOSED',
  EH_INVALID_INPUT: 'EH_INVALID_INPUT',
  EH_PENDING_RESPONSE: 'EH_PENDING_RESPONSE',
  EH_INVALID_MESSAGE: 'EH_INVALID_MESSAGE',
  EH_STORAGE: 'EH_STORAGE',
  EH_COMPACTION_FAILED: 'EH_COMPACTION_FAILED',
  EH_CONTEXT_OVERFLOW: 'EH_CONTEXT_OVERFLOW',
  EH_LOCK_UNAVAILABLE: 'EH_LOCK_UNAVAILABLE',
  EH_EVENTS_OVERFLOW: 'EH_EVENTS_OVERFLOW',
  EH_PROVIDER_AUTH: 'EH_PROVIDER_AUTH',
  EH_PROVIDER: 'EH_PROVIDER',
  EH_RUN_FAILED: 'EH_RUN_FAILED',
} as const

/** A library code of an `eh.notice` message: a notice code or an error code (see {@link NOTICE_CODES}). */
export type NoticeCode = (typeof NOTICE_CODES)[keyof typeof NOTICE_CODES]
