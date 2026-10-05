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

/**
 * Step reminder after the progress guard found the turn stuck (spec 05 §3.2); `{what}` describes
 * the repetition.
 */
export const PROGRESS_NUDGE: string =
  'You are not making progress: {what}. Do not repeat it. Try a different approach, or stop and explain what blocks you.'

/** Step reminder of the wrap-up step after the step budget ran out (spec 05 §3.1, `loop.wrapUp`). */
export const MAX_STEPS_WRAP_UP: string =
  'The step limit of this turn is reached and tools are disabled. Summarize what you did, what is left, and how to continue.'

/** Marker inserted into truncated tool outputs; `{n}` is the number of removed characters. */
export const TOOL_OUTPUT_TRUNCATED: string = '…[truncated {n} chars]…'

/**
 * Placeholder of a pruned tool output (spec 06 §5.0): `{tool}` is the tool name, `{n}` the
 * number of characters of the original output.
 */
export const TOOL_OUTPUT_PRUNED: string = '[output of {tool} pruned: {n} chars]'

/**
 * Replaces a file of an earlier turn whose URL could not be downloaded (e.g. an expired link), so
 * later turns still run (`{mediaType}`, `{filename}`; spec 05 §3, spec 10 §5).
 */
export const FILE_UNAVAILABLE: string = '[file unavailable: {mediaType} {filename}]'
