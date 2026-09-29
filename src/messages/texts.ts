/**
 * Fixed model- and UI-visible texts written by the core. Changing one is a minor change.
 *
 * @see docs/specs/10-errors-and-stop-reasons.md#5-fixed-texts
 */

/** Error result of tool calls left without a result when a turn ends. */
export const INTERRUPTED_TURN: string = 'Interrupted: the turn ended before this tool finished.'

/** Error result of tool calls left without a result by a crashed process (crash recovery). */
export const INTERRUPTED_CRASH: string =
  'Interrupted: the process stopped before this tool finished.'

/** Error result the projection and the guard give tool calls that have no recorded result. */
export const INTERRUPTED_UNKNOWN: string =
  'Interrupted: no result was recorded for this tool call; it may or may not have taken effect.'

/** Approval denial reason when the user sent new input instead of answering. */
export const DENIED_NEW_INPUT: string = 'The user sent a new message instead of answering.'

/** Client tool error when the user sent new input instead of answering. */
export const NOT_EXECUTED_NEW_INPUT: string = 'Not executed: the user sent a new message.'

/** Marker inserted into truncated tool outputs; `{n}` is the number of removed characters. */
export const TOOL_OUTPUT_TRUNCATED: string = '…[truncated {n} chars]…'
