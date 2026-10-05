# Build board

Goal of this board: ship **eharness 0.1.0** — the skeleton described in `docs/specs/*` — and the
releases after it (P9–P12: 0.3.0; P13–P20: 0.4.0).

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
| P14 | [Context pruning, thrash detection, skill versions](P14-prune-thrash-skill-versions.md) | todo | P13 (recommended) | P16, P17, P18 |
| P15 | [Pre-compaction flush](P15-precompaction-flush.md) | todo | P13, P14 (recommended) | P16, P17, P18 |
| P16 | [Cross-process abort](P16-cross-process-abort.md) | done | P13 (recommended) | P14, P15, P17, P18 |
| P17 | [Memory plugin](P17-memory-plugin.md) | done | P13 (recommended), P15 (for `flushOnCompaction`) | P14, P16, P18 |
| P18 | [Structured final output](P18-structured-output.md) | todo | P13 (recommended) | P14–P17 |
| P19 | [Durable inbox port](P19-durable-inbox.md) | in progress | P13, P16 | — |
| P20 | [Production-patterns guide, docs, 0.4.0 handoff](P20-production-guide.md) | todo | P13–P19 | — |

**P13–P20 ship together as 0.4.0.** All of them are committed directly on `main` (no phase
branches); each phase adds its own changeset (P13 `patch`, feature phases `minor`), and the next
version PR releases them as one 0.4.0. "Can run in parallel" means the phases do not depend on
each other; on a single branch they are still committed one after another (rebase before every
commit). Source of P14–P20: the BTeams proposal (maintainer-only, not committed) — items U1–U9 are
mapped in each phase file; results go to `docs/reviews/0.4.0-results.md` (P20).

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
