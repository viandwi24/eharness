# Build board

Goal of this board: ship **eharness 0.1.0** — the skeleton described in `docs/specs/*` — and the
releases after it (P9–P12: 0.3.0; P13–P20: 0.4.0; P21–P29: 0.5.0).

Status legend: `todo` · `in progress` · `blocked` · `review` · `done`.
Update this table in the same commit that changes a phase's status.

| Phase | File | Status | Depends on | Can run in parallel with |
|---|---|---|---|---|
| P0 | [Bootstrap repo, tooling, CI, release](P0-bootstrap.md) | done | — | — |
| P1 | [Core foundations: errors, ids, messages, plugins, registries](P1-core-foundations.md) | done | P0 | — |
| P2 | [Session, loop, streaming, storage contracts](P2-session-loop-stream.md) | done | P1 | — |
| P3 | [Context loading and compaction](P3-compaction.md) | done | P2 | P4, P6 |
| P4 | [Skills](P4-skills.md) | done | P2 | P3, P6 |
| P5 | [Filesystem plugin](P5-filesystem.md) | done | P2 (tools), P4 (skills autoload part) | P3, P6 |
| P6 | [Tool sources and MCP](P6-tools-mcp.md) | done | P2 | P3, P4, P5 |
| P7 | [Interaction: approvals, respond, regenerate/edit, steer, queue, wake](P7-interaction.md) | done | P2 (P3 for rewind × compaction tests) | P3–P6 |
| P8 | [Examples, README, 0.1.0 release](P8-release-0.1.md) | done | P3–P7 | — |
| P9 | [Progress-bounded loop](P9-progress-loop.md) | done | P8 | — |
| P10 | [Model catalog, cost and budgets](P10-models-cost.md) | done | P9 | P11 |
| P11 | [Approval: risk, decisions, pending details](P11-approval.md) | done | P9 | P10 |
| P12 | [Todos plugin](P12-todos.md) | done | P9 | — |
| P13 | [Hardening (audit fixes)](P13-hardening.md) | done | P12 | — |
| P14 | [Context pruning, thrash detection, skill versions](P14-prune-thrash-skill-versions.md) | done | P13 (recommended) | P16, P17, P18 |
| P15 | [Pre-compaction flush](P15-precompaction-flush.md) | done | P13, P14 (recommended) | P16, P17, P18 |
| P16 | [Cross-process abort](P16-cross-process-abort.md) | done | P13 (recommended) | P14, P15, P17, P18 |
| P17 | [Memory plugin](P17-memory-plugin.md) | done | P13 (recommended), P15 (for `flushOnCompaction`) | P14, P16, P18 |
| P18 | [Structured final output](P18-structured-output.md) | done | P13 (recommended) | P14–P17 |
| P19 | [Durable inbox port](P19-durable-inbox.md) | done | P13, P16 | — |
| P20 | [Production-patterns guide, docs, 0.4.0 handoff](P20-production-guide.md) | done | P13–P19 | — |
| P21 | [Tool risk `'external'`, MCP annotations, approval routing](P21-tool-risk-external.md) | done | P20 | P22 (W1) |
| P22 | [Inbox poison items, retries and dead-letter](P22-inbox-dead-letter.md) | todo | P20 | P21 (W1) |
| P23 | [Park-and-resume: external waits](P23-park-and-resume.md) | todo | P22 (P21 recommended) | P25 (W2) |
| P24 | [Request-scoped client tools and page context](P24-request-client-tools.md) | todo | P23 | P26 (W3) |
| P25 | [Cross-session `BudgetLedger` port](P25-budget-ledger.md) | done | P20 | P23 (W2) |
| P26 | [Approval guard plugin (`eharness/guard`)](P26-approval-guard.md) | in progress | P21 (P25 recommended) | P24 (W3) |
| P27 | [Group-chat plugin (`eharness/group`)](P27-group-chat.md) | todo | P20 | P28 (W4) |
| P28 | [OpenAPI → tools plugin (`eharness/openapi`)](P28-openapi-tools.md) | todo | P21 | P27 (W4) |
| P29 | [Docs, guides, 0.5.0 handoff](P29-docs-handoff-0.5.md) | todo | P21–P28 | — (W5) |

**P13–P20 ship together as 0.4.0.** All of them are committed directly on `main` (no phase
branches); each phase adds its own changeset (P13 `patch`, feature phases `minor`), and the next
version PR releases them as one 0.4.0. "Can run in parallel" means the phases do not depend on
each other; on a single branch they are still committed one after another (rebase before every
commit). Source of P14–P20: the 0.4 proposal (maintainer-only, not committed) — items U1–U9 are
mapped in each phase file; results go to the 0.4.0 results notes (kept outside the repository) (P20).

**P21–P29 ship together as 0.5.0.** Same process as 0.4.0: direct commits on `main`, one
changeset per phase (feature phases `minor`), one version PR. Implementers develop the whole
checklist first and run **one** gate at the end of each phase; one consolidated review of P21–P28
runs in P29 before the version PR. Waves (at most two phases at a time, grouped by low file
overlap): **W1** P21 + P22 → **W2** P23 + P25 → **W3** P24 + P26 → **W4** P27 + P28 → **W5** P29.
Hard dependencies: P23 after P22 (inbox `availableAt` timers), P24 after P23 (pending timeouts),
P26 and P28 after P21 (risk traits). ADR numbers are reserved per phase: 0025 (P21), 0026 (P22),
0027 (P23), 0028 (P24), 0029 (P25), 0030 (P26), 0031 (P27, only if needed), 0032 (P28). New specs:
15 (guard, P26), 16 (group, P27), 17 (openapi, P28). Source: the 0.5 prior-art analysis
(maintainer-only, not committed) — items #1–#8 are mapped in each phase file; results go to
the 0.5.0 results notes (kept outside the repository) (P29).

After 0.1.0: [roadmap.md](roadmap.md).

## How agents work on this board

- One agent per phase. P0 → P1 → P2 are strictly sequential (they create the shared core).
  From P3 on, phases may run in parallel on separate branches (`phase/P3-compaction`, …).
- A phase owns the folders listed in its file. Touching another phase's folder → write the request
  under "Requests to other phases" in the other phase file instead of editing its code.
- Shared files (`src/index.ts`, `src/testing/index.ts`, `package.json`, `tsdown.config.ts`,
  `scripts/smoke.mjs`, `docs/specs/*`) may be edited by any phase, in small, separate commits,
  rebased often.
- Ownership moves forward: after P1 is done, `src/registry/**` belongs to P2 (except the dynamic
  tool-source parts, P6). Each phase file lists its folders.
- Definition of done for every phase: checklist complete, acceptance criteria met, `lint`,
  `typecheck`, `test`, `build`, `check:package`, `check:imports` green, specs updated, changeset
  added, board updated.

## Kick-off prompts

Coordinator (first session, P0):

```
Read CLAUDE.md, docs/README.md, docs/plans/README.md and docs/plans/P0-bootstrap.md.
Execute P0 exactly. Before every setup command, read that tool's official docs for the current
command. Stop after P0's acceptance criteria and report what the maintainer must do by hand.
```

Phase agent (P1 and later):

```
You own phase Pn of eharness. Read CLAUDE.md, docs/plans/README.md and docs/plans/Pn-*.md, then
the specs it links. Implement the checklist in order with tests. Do not edit folders owned by other
phases. When done, update the phase file, the board and add a changeset.
```

Review agent (before merging a phase):

```
Review branch phase/Pn against docs/specs and docs/plans/Pn-*.md. Do not write code. List every
deviation from a spec, missing test from the phase checklist, public API without TSDoc, and
changeset/semver mistakes, each with file:line. Put the list in the PR description.
```
