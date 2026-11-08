/**
 * `eharness/codes`: the stop reasons and `eh.notice` codes as constants (spec 10 §1.3, ADR-0072).
 *
 * A pure-constants entry with no runtime import, so a UI that talks to the core over HTTP can
 * compare against `STOP_REASONS` and `NOTICE_CODES` without pulling the runtime that `eharness`
 * (the package root) brings. The same objects are exported from the root.
 *
 * @see docs/specs/10-errors-and-stop-reasons.md
 */
export { type KnownStopReason, NOTICE_CODES, type NoticeCode, STOP_REASONS } from '../codes.ts'
