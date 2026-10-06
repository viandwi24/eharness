---
"eharness": minor
---

New subpath `eharness/guard`: `approvalGuard({ model, policy?, … })` — an LLM judge on the
approval chain (spec 15, ADR-0030).

- **Tighten only:** returns `denied` (with a reason the model reads) or `user-approval`, never
  `approved`; with most-restrictive-wins it cannot loosen a policy, risk rule, hook or grant.
- **Restricted view:** the judge sees the policy, user messages, the agent's earlier tool calls and
  the call under review — never tool outputs, assistant text, reasoning or instructions.
- Read-risk fast path (`skipRisks`, `skipTools`, `onlyTools`), per-session verdict cache in plugin
  state (keyed by tool + SHA-256 of the canonical input; the answer per tool call id is recorded,
  so `respond()` re-validation never calls the judge), a consecutive-denial circuit breaker that
  escalates to a person, fail closed to `user-approval` when the judge errors or times out, and
  judge usage charged to the turn (budgets and the budget ledger see it).
- The per-call record is reused only when tool name and verdict key match (a reused tool call id
  with another call is judged again); the verdict key covers the policy text and judge model id;
  a cached `allow` ignores later conversation context (use `cache.ttlMs`).
- Exported texts `GUARD_*` and helpers `canonicalJson`, `verdictKey`.

Core:

- The `tool.approve` event gains `transcript()` (spec 11 §3.4): a lazy, restricted view of the
  conversation (user messages and tool calls only) for judges; new type `GuardTranscriptEntry`.
- New warning `W_GUARD_UNAVAILABLE`.
- **Type-level:** `WarningCode` gains a member; the `tool.approve` event gains a required
  `transcript` field (code that calls hooks by hand must pass it).

- Plugin / app kind projections are tagged `providerOptions.eharness.core` on the model wire so the
  restricted transcript excludes them (not only string projections); the JSDoc and specs 11/15 state
  the remaining limits (app-projected text, such as group history blocks, appears as user text).
