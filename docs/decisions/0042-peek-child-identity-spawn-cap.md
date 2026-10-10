# ADR-0042: Read-only `peek`, child identity in the index, spawn cap

Status: **Accepted** · Date: 2026-10-10 · Builds on: [ADR-0037](0037-fork-and-child-index.md), [ADR-0035](0035-nested-approvals-park-the-parent.md), [ADR-0041](0041-park-mode-messaging.md)

## Context

The team example (P32 R17–R20) showed four gaps: child sessions opened by `subagents()` had no
`lock` or `runtime` of the app; reading a session (stats, messages) opened it and ran
`session.start` hooks, which can resume a parked lead; the child index held ids only; and nothing
capped how many children a session starts.

## Decision

- `agent.peek(id)` returns a `SessionPeek` that reads the stored state and messages only (no hooks,
  recovery, reconcile, lock or write). It is a separate small object, not a flag on `session()`,
  so that no code path of an opened session can run by accident. The plugin's own reads use it.
- `ParentInfo` and `ChildSessionInfo` gain optional `agent`, `name`, `description` (the child's
  identity, set by the opener). Optional fields keep stored entries compatible.
- `subagents({ childSession, parentSession })` return session options merged under the plugin's own
  (`parent`, the directory runtime key always win); `subagentChild({ parentSession })` likewise.
- `subagents({ maxChildren })` caps children **per parent session, lifetime**: per turn would not
  bound a long-lived lead, and a per-process counter would reset on restart; park counts the
  stored child index. Workspace budgets stay in the ledger scopes (spec 12 §4.1), fed by the
  runtime passed through `childSession`; no new budget API.

## Consequences

Minor change, additive. Spec 05 §2.2 and §13, spec 20 §2.3–2.4.
