# ADR-0060: Shared LLM judge engine

Status: **Accepted** · Date: 2026-10-11 · Amends: [ADR-0030](0030-llm-approval-guard-plugin.md) · Related: [ADR-0055](0055-approval-answer-wins-and-schema-valid-denials.md)

## Context

Two features ran a second model over tool calls with separate code: `approvalGuard()` (spec 15,
`eharness/guard`, a `tool.approve` hook that can only tighten) and `modelClassifier()` (spec 18 §12,
the auto-mode classifier of the permissions engine, which may allow). Both made one `generateText`
call with a structured verdict over the restricted transcript, but each had its own prompt renderer,
truncation rule and error handling; only the guard had a verdict cache and a breaker. Users could not
tell the two apart, and a fix to one (fail closed on a truncated input, P5-8 / K-09) had to be made
twice.

## Decision

- **One engine in core**: `createJudge({ model, role, instructions, policy?, environment?, … })`
  (`src/judge/`, exported from `src/index.ts`; subpaths import it through the core entry, ADR-0008).
  It owns the `generateText` + `Output.object` call, the restricted-transcript renderer, the framed
  prompt (`<policy>`, `<environment>`, `<transcript>`, `<action>`, frame tags neutralised), the
  truncation rule (a call longer than the window is never judged: `ask`), the verdict cache (key:
  tool + canonical input hash + rule set, with TTL and a bound), the consecutive-denial breaker,
  retries, timeout, output cap, `observeModel` hook and `JudgeUnavailableError` for "no usable
  verdict".
- **Two roles, one base.** `tighten` never returns `approve` (an allow is `no-objection`; the rest of
  the approval chain decides); `decide` may `approve`. The guard plugin is `createJudge({ role:
  'tighten' })` plus plugin-state storage and the approval-chain glue; `modelClassifier()` is
  `createJudge({ role: 'decide' })` plus the `AutoClassifier` mapping. The two instruction sets
  (`GUARD_INSTRUCTIONS`, `AUTO_CLASSIFIER_INSTRUCTIONS`) stay separate texts: they ask different
  questions.
- **Role defaults differ where the risk differs.** `tighten`: cache on (1 h), breaker 3. `decide`:
  cache off (a cached allow would outlive a boundary the user states later) and breaker off (the
  permissions engine's auto pause, spec 18 §12, is its breaker; it also counts totals and resumes).
- **Combined** they compose by the existing rules: the permissions engine decides first, the guard
  can still deny or escalate what the engine approved (most restrictive wins); two judge calls per
  risky call. The engine never lets either role loosen the other.
- Factories keep their names and subpaths for now; the engine is Draft (`@experimental`).

## Consequences

- One place to fix judge behaviour; the guard gains a 1024-token output cap and temperature 0; the
  classifier gains the JSON transcript rendering and an opt-in cache.
- `eharness/guard` no longer exports `canonicalJson`/`verdictKey` helpers or `GUARD_PROMPT` /
  `GUARD_TRUNCATED` (they were internal to the plugin's own prompt; the prompt layout is internal
  and may change in any release).
- Two model calls when both are configured (one since the 2026-10-11 amendment below, with the same model); documented in the guide.

## Amendment 2026-10-11: one call when both roles are active

Two judge calls per risky call were the cost of combining the roles. Claude Code's auto mode
uses one classifier per action, so, when the guard (`tighten`) and the classifier (`decide`) are
both active in a session on the same model instance (or gateway string) and with equal view limits,
the decide judge asks both questions in one structured call
(`{ auto, autoReason, guard, guardReason }`) and the guard consumes its half without calling its
model. Coordination is a small core mechanism, `judgeCoordinator(scope)` (one per session, keyed on
`ctx.signal`, so no cross-session leakage), because the subpaths may only meet through `src/index.ts`:
the guard registers a `JudgeParticipant`; the classifier stores the guard's answer per `toolCallId`.
Semantics are unchanged: the engine uses only the auto half, the guard hook maps its half exactly as
before (cache, breaker, `W_GUARD_UNAVAILABLE`, call records), most restrictive wins. Different models or
limits, an opt-out (`guard({ combineWithAutoMode: false })`), a guard listed before `permissions()`,
a cache hit or recorded answer, a paused or off auto mode: two calls or the guard alone, as before.
`combineWithAutoMode` defaults to `true` (the same model for both is the opt-in; outcomes are
identical). Consequence: the combined prompt is longer and the call is observed by the classifier's
`onModelCall`, not the session's `model.call` hook.
