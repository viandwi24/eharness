/**
 * `eharness/guard`: the `guard()` plugin — an LLM judge on the approval chain that can
 * only tighten (deny or escalate to a person), reading a restricted transcript (user messages and
 * tool calls only), with a read-risk fast path, a per-session verdict cache, a consecutive-denial
 * circuit breaker and fail-closed escalation when the judge is unavailable.
 *
 * **Draft:** every symbol of this subpath is experimental and may change in a minor release
 * (docs/engineering/api-stability.md).
 *
 * @see docs/specs/15-guard-plugin.md
 */
export { type GuardOptions, type GuardVerdict, guard } from './plugin.ts'
export {
  GUARD_ASK,
  GUARD_BREAKER,
  GUARD_DENIED,
  GUARD_UNAVAILABLE,
} from './texts.ts'
