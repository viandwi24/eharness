# P11 — Approval: risk, decisions, pending details

Status: done · Owner: agent · Branch: `feat/long-running`

## Goal

Approval policies by tool risk; every decision observable with its source and actor, so apps can
build inboxes and audit logs across sessions (ADR-0017).

## Specs

- `docs/specs/11-interaction.md` §2, §3, §3.2 (new), §3.3 (new), §4
- `docs/specs/01-agent-and-plugins.md` §1 (`ApprovalConfig.risk`), §5 (hooks)

## Owns

`src/registry/risk.ts`, approval function in `src/registry/wrap.ts`, `respond()` validation, decision
reporting in `src/session/turn.ts`.

## Checklist

- [x] `ToolRisk`, `riskOf` (metadata `risk`, MCP `destructiveHint`; `readOnlyHint` ignored)
- [x] `approval.risk` in the approval combination; `risk` in the `tool.approve` event
- [x] Pending approvals carry `input` and `risk`
- [x] `approval.decided` hook (automatic, `respond()` with `actor`, new-input denials)
- [x] `respond()` validates `actor`
- [x] Tests, specs, guide section, ADR-0017, changeset

## Acceptance criteria

- [x] Destructive tools ask, read tools auto-approve by risk; decisions reported with their source
- [x] lint, typecheck, test green

## Open questions

- Rule-based grants (`remember` scoped to an input pattern) — roadmap.
- Partial `respond()` (answer a subset of pending approvals) — roadmap.
- LLM classifier guard (auto mode) — future plugin on `tool.approve` (stripped transcript, fail to human).
