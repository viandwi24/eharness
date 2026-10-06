/**
 * `eharness/guard`: the `approvalGuard()` plugin — an LLM judge on the approval chain that can
 * only tighten (deny or escalate to a person), reading a restricted transcript (user messages and
 * tool calls only), with a read-risk fast path, a per-session verdict cache, a consecutive-denial
 * circuit breaker and fail-closed escalation when the judge is unavailable.
 *
 * @see docs/specs/15-guard-plugin.md
 */
export { type ApprovalGuardOptions, approvalGuard, type GuardVerdict } from './plugin.ts'
export { canonicalJson, verdictKey } from './prompt.ts'
export {
  GUARD_ASK,
  GUARD_BREAKER,
  GUARD_DEFAULT_POLICY,
  GUARD_DENIED,
  GUARD_INSTRUCTIONS,
  GUARD_PROMPT,
  GUARD_TRUNCATED,
  GUARD_UNAVAILABLE,
} from './texts.ts'
