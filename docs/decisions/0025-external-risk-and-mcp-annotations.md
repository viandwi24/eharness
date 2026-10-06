# ADR-0025: External risk and tighten-only MCP annotation mapping

Status: **Proposed** · Date: 2026-10-06 · Amends: [ADR-0017](0017-tool-risk-and-approval-decisions.md)

## Context

ADR-0017 put tool risk into AI SDK's `tool({ metadata: { risk } })` with three classes
(`read`, `write`, `destructive`) and mapped only MCP's `destructiveHint`. Applications also need
to route calls that have an effect **outside** the system (send an email, post to a third party,
pay) — usually "ask a person", even when the call is not destructive. MCP already has a hint for
that (`openWorldHint`), plus `readOnlyHint` and `idempotentHint`. `@ai-sdk/mcp` copies only the
hints the server sent into `tool.metadata.annotations` (no defaults). The MCP spec defaults
(`destructiveHint` and `openWorldHint` true when absent) exist, and all hints are untrusted unless
the server is trusted. Later phases (inbox retries, park/resume timeouts) need to know whether a
tool may run twice.

## Decision

- `ToolRisk` gains `'external'`. Traits are read by one exported function, `toolTraits(metadata)`
  → `{ risk?, idempotent?, hints? }`; the core uses it everywhere (approval, pending, flush).
- **App metadata wins.** A valid `metadata.risk` is trusted and may be lower than the hints.
  `mcpServer({ risk })` (constant or per-tool function) writes `metadata.risk`: trusted app input.
- **Hints only tighten.** Without an app risk: `destructiveHint: true` → `'destructive'`, else
  `openWorldHint: true` → `'external'`. `readOnlyHint` never derives or lowers a risk.
- **One risk per tool**, derived precedence `destructive` > `external`. A policy that needs both
  facts reads the raw `hints` on the `tool.approve` event.
- **`idempotent` is app-only** (`metadata.idempotent`); `idempotentHint` is reported in `hints`
  and never used by the core, because it would loosen retry behaviour.
- **No MCP spec defaults** are applied: only hints the server sent count. A tool without hints
  stays `unknown`; the guide recommends `approval.risk: { unknown: 'user-approval' }` for
  untrusted servers.
- Events carry the traits: `tool.approve` gains `idempotent?` / `hints?`; `ApprovalDecision` and
  `PendingState.approvals[]` gain `idempotent?`. Routing stays app-injected
  (`approval.policy` / `approval.risk` / `tool.approve`, most restrictive wins).

## Consequences

+ `approval.risk: { external: 'user-approval' }` routes email/payment/post tools from MCP servers
  without per-tool configuration; trusted servers can be classified with `mcpServer({ risk })`.
+ Behaviour of tools without the new hints or metadata is unchanged.
− Type-level change: exhaustive `switch`es and `Record<ToolRisk, …>` objects must add `external`.
− A server that omits `openWorldHint` is not `external` (no defaults); apps must treat
  `unknown` carefully.

## Alternatives considered

- Apply MCP spec defaults (rejected for 0.5.0: every MCP tool without annotations would become
  `'destructive'`, a large behaviour change in a minor).
- Several risks per tool / a risk set (rejected: `approval.risk` would need a combination rule;
  `hints` give policies the detail).
- Use `idempotentHint` for retries (rejected: untrusted and loosening).
- A `trustHints` server option that lets `readOnlyHint` yield `read` (deferred: `mcpServer({ risk })`
  covers trusted servers explicitly).
