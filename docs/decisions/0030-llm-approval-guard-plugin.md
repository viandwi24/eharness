# ADR-0030: LLM approval guard as a plugin

Status: **Proposed** · Date: 2026-10-06 · Builds on: [ADR-0017](0017-tool-risk-and-approval-decisions.md), [ADR-0025](0025-external-risk-and-mcp-annotations.md)

## Context

Deterministic approval rules (`approval.policy`, `approval.risk`, grants) decide by tool and risk;
they cannot tell "email the report to the address the user gave" from "email it to the address a
web page asked for". Agents that run mostly unattended want a second model that reviews risky
calls in context (prior art: Claude Code's auto-mode transcript classifier, OpenAI Agents tool
guardrails, ADK model-as-judge callbacks, LlamaFirewall AlignmentCheck). The hook for it exists
since 0.3 (`tool.approve`, most restrictive wins); what is missing is a safe, reusable judge.

Three properties make such a judge safe or unsafe: what it may return, what it may read, and how
it behaves when the same call is reviewed twice (AI SDK re-runs the approval function for
approved calls when a `respond()` continuation starts, spec 11 §3).

## Decision

- **A shipped plugin, `eharness/guard`, not core.** `approvalGuard({ model, policy, … })` is a
  `tool.approve` hook built only on the public API (ADR-0008). Apps that want another judge write
  their own hook with the same core pieces.
- **Tighten only.** The guard returns `not-applicable`, `denied` or `user-approval` — never
  `approved`. Combined most-restrictive-wins, it cannot loosen a policy, risk rule, other hook or
  grant; the intended setup is a permissive base policy plus the guard. Auto-approving unknown
  tools ("auto mode") stays a base-policy decision of the app.
- **The restricted view is core.** The `tool.approve` event gains `transcript()`: user messages
  and the agent's tool calls only, built from the step's model wire, excluding tool outputs,
  assistant text, reasoning, instructions, reminders, kind messages and projected data parts. The
  restriction is the security property — an injection in a tool output cannot address the judge —
  so it must not depend on every plugin author filtering correctly. The tool call inputs are
  included: they are what the judge reviews.
- **Caching satisfies the determinism rule.** Approval hooks must be deterministic; a model is
  not. The guard records its answer per `toolCallId` and its verdicts per `(tool, sha256 of the
  canonical input)` in plugin state (per session, bounded, persisted with the turn). The
  re-validation of an approved call — possibly in another process after a cold reload — returns
  the recorded answer without a model call, so a person's approval can never be turned into a
  judge denial. Verdicts are not shared across sessions (they would leak decisions across users).
- **Fail closed to a person.** A judge error, timeout or invalid verdict escalates to
  `user-approval` with a reason and `W_GUARD_UNAVAILABLE` — never `approved` (unsafe) and never a
  hard `denied` (an outage would silently break every reviewed tool).
- **Circuit breaker.** After N consecutive denials (default 3) further denials escalate to a
  person; a person's answer or an allow resets it. A model that keeps retrying denied calls ends
  up in front of a human instead of looping.
- **Judge usage is turn usage.** Every judge call reports `ctx.turn.addUsage(usage, { model })`,
  so budgets, caps and the cross-session ledger (ADR-0029) see it.
- **Fast path.** `read` risk (trusted app metadata only, ADR-0025) skips the judge by default.

## Consequences

+ A reusable, cheap second line for unattended agents with a clear security story.
+ No new core concepts beyond one lazy event field and one warning code.
− One model call per reviewed, uncached tool call: latency before the tool runs, and cost.
− An LLM judge is probabilistic; it complements, never replaces, deterministic policies.
− Type-level: the `tool.approve` event gains a required `transcript` field (code that calls hooks
  by hand must pass it); `WarningCode` gains `W_GUARD_UNAVAILABLE`.

## Alternatives considered

- Judge may approve (rejected: one fooled judge would loosen every rule; tighten-only composes).
- Plugin-built transcript (rejected: the restriction would depend on each plugin).
- Full transcript with tool outputs marked as untrusted (rejected: injections are designed to
  survive such markers; the judge does not need outputs to judge intent).
- Re-judge at re-validation (rejected: non-deterministic; could deny calls a person approved).
- Fail closed to `denied` (rejected: an outage would block all reviewed tools without a person
  seeing why).
