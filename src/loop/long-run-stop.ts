/**
 * The stop reason of a long-run chunk (spec 33 §3): the one piece of `eharness/limits` that other
 * modules (`eharness/subagent`) must recognise, so it lives in core. A turn that ends with this
 * stop is a checkpoint of a job that continues in a queued turn; it is not a finished turn.
 *
 * @see docs/specs/33-limits.md
 */

/** `plugin:long-run:checkpoint`: the stop of a turn that ended a long-run chunk. */
export const LONG_RUN_CHECKPOINT_STOP = 'plugin:long-run:checkpoint' as const

/** True for the stop reason of a long-run chunk end (the job is not finished). */
export function isLongRunCheckpoint(stop: string | undefined): boolean {
  return stop === LONG_RUN_CHECKPOINT_STOP
}
