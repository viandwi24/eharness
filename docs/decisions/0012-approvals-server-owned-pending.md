# ADR-0012: Tool approvals via AI SDK `toolApproval` with server-owned pending state

Status: **Accepted** · Date: 2026-09-29

## Context

Human-in-the-loop approval is table stakes for agents that edit files or call external systems.
AI SDK v7 supports it natively (`toolApproval`, `tool-approval-request` / `-response`,
`experimental_toolApprovalSecret`); tool-level `needsApproval` is deprecated. The `useChat`
protocol sends the whole message list back with the answers, so a naive server trusts
client-supplied approval state, can execute a tool twice on a replayed request, and can start a
fresh UI message for the continuation (AI SDK then fails with `No tool invocation found`).

## Decision

- One `GenericToolApprovalFunction` per step combines the static policy, `tool.approve` hooks and
  session grants; most restrictive wins; hooks fail closed.
- A turn that needs answers stops with `tool-pending`; the pending set is stored in
  `state.core.pending` (authoritative) and mirrored in message metadata (for UIs).
- `respond()` validates answers against the pending set (all-or-nothing, not stale), **consumes**
  it atomically before any tool runs, patches the stored parts, and continues the **same**
  assistant message via `originalMessages`.
- New input while pending denies the open requests by default (`onNewInput: 'deny'`).

## Consequences

+ Replays and stale answers never execute tools; clients cannot forge approvals.
+ Works with stock `useChat` (`lastAssistantMessageIsCompleteWithApprovalResponses`).
− Requires a persistent `StateAdapter` for approvals to survive restarts.
− Exactly-once across instances needs a `SessionLock` or a `StateAdapter` with `setIf` (spec 05 §8).
− AI SDK re-validates approved calls on continuation, so `tool.before` must be idempotent and
  approval hooks deterministic (spec 11 §3).
− No partial answers in v0.

## Alternatives considered

- Trust the client's message list (rejected: forgeable, replayable).
- Our own approval protocol (rejected: ADR-0001).
