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
 * Denial reason of a tool call that would need approval during a pre-compaction flush (spec 06
 * §5.2a): such calls are auto-denied.
 */
export const FLUSH_APPROVAL_DENIED: string = 'Not available during memory flush.'

/**
 * Replaces a file of an earlier turn whose URL could not be downloaded (e.g. an expired link), so
 * later turns still run (`{mediaType}`, `{filename}`; spec 05 §3, spec 10 §5).
 */
export const FILE_UNAVAILABLE: string = '[file unavailable: {mediaType} {filename}]'

/** Default description of the `final_answer` tool (`SendOptions.output`, tool mode, spec 05 §3.3). */
export const FINAL_ANSWER_DESCRIPTION: string =
  'Submit the final answer of this turn. Call it once, when you are done; its input is the answer.'

/**
 * Result of a successful `final_answer` call (`SendOptions.output`, tool mode, spec 05 §3.3).
 */
export const FINAL_ANSWER_RECORDED: string = 'Final answer recorded.'

/**
 * Turn reminder line of a turn with `SendOptions.output` in tool mode (spec 05 §3.3); `{tool}` is
 * the output tool name (default `final_answer`).
 */
export const OUTPUT_INSTRUCTION: string =
  'When you are done, call the `{tool}` tool once with your final answer. Its input must match the tool schema; the turn ends when the call succeeds.'

/**
 * Input delivered (`data-eh.input`, source `plugin:eh.output`) when a turn with
 * `SendOptions.output` ended without a valid final answer (spec 05 §3.3); `{error}` is the
 * validation error, trimmed to 1 000 characters.
 */
export const OUTPUT_RETRY: string =
  'Your final answer is missing or invalid: {error}\nGive the final answer again; it must match the required schema.'

/** Error result of an external wait that timed out without its own `onTimeout` (spec 11 §4.2). */
export const WAIT_TIMED_OUT: string = 'The external wait timed out before a result arrived.'

/** Error result of an external wait cancelled because the user sent new input (spec 11 §4.2). */
export const WAIT_CANCELLED_NEW_INPUT: string =
  'Cancelled: the user sent a new message while this tool was waiting for an external result.'
