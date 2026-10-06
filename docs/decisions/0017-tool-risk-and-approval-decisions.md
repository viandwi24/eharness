# ADR-0017: Tool risk in AI SDK metadata; approval decisions are observable

Status: **Accepted** · Date: 2026-09-30 · Amended by: [ADR-0025](0025-external-risk-and-mcp-annotations.md)
(`'external'` risk, tighten-only `openWorldHint`, `idempotent` trait)

## Context

Apps with many tools (a company task manager with dozens of actions) want approval rules by risk,
not per tool name, and approvals from outside the chat (an inbox for managers) with an audit trail
of who decided. Research (2026-09-30): Codex and Claude Code classify actions (risk levels, allow /
ask / deny rules), MCP has `readOnlyHint` / `destructiveHint`, but none of the libraries reports
*who* approved; hosts build that themselves. eharness already has a server-owned pending state and
`respond()` (ADR-0012).

## Decision

- Risk lives in AI SDK's own `tool({ metadata: { risk } })` (`'read' | 'write' | 'destructive'`);
  no new tool type. MCP `destructiveHint` maps to `'destructive'`; `readOnlyHint` is ignored because
  annotations are untrusted and must never lower a risk.
- `approval.risk` maps risks to statuses and joins the most-restrictive combination (after the
  policy, before hooks and grants).
- Pending approvals carry `input` and `risk` (additive, `state.core.pending` and `TurnResult`).
- A new observational hook `approval.decided` reports automatic decisions with their source and
  `respond()` answers with an application-supplied `actor`. The actor is not persisted by the core.

## Consequences

+ Policies scale with the number of tools; inboxes and audit logs need no core storage.
+ Model-visible behaviour is unchanged.
− A tool without metadata is `unknown`; apps must tag tools to benefit.
− Rule-based grants (e.g. "always allow `git *`") and partial `respond()` are still open (roadmap).

## Alternatives considered

- A separate `risk` field on our own tool wrapper (rejected: ADR-0001, build on AI SDK primitives).
- Store decisions in `metadata.eharness` (rejected: audit needs are app-specific and may include
  personal data).
- Trust MCP `readOnlyHint` (rejected: a hostile server could label a destructive tool read-only).
