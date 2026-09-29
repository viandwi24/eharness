# Build board

Goal of this board: ship **eharness 0.1.0** — the skeleton described in `docs/specs/*`.

Status legend: `todo` · `in progress` · `blocked` · `review` · `done`.
Update this table in the same commit that changes a phase's status.

| Phase | File | Status | Depends on | Can run in parallel with |
|---|---|---|---|---|
| P0 | [Bootstrap repo, tooling, CI, release](P0-bootstrap.md) | done | — | — |
| P1 | [Core foundations: errors, ids, messages, plugins, registries](P1-core-foundations.md) | done | P0 | — |
| P2 | [Session, loop, streaming, storage contracts](P2-session-loop-stream.md) | todo | P1 | — |
| P3 | [Context loading and compaction](P3-compaction.md) | todo | P2 | P4, P6 |
| P4 | [Skills](P4-skills.md) | todo | P2 | P3, P6 |
| P5 | [Filesystem plugin](P5-filesystem.md) | todo | P2 (tools), P4 (skills autoload part) | P3, P6 |
| P6 | [Tool sources and MCP](P6-tools-mcp.md) | todo | P2 | P3, P4, P5 |
| P7 | [Interaction: approvals, respond, regenerate/edit, steer, queue, wake](P7-interaction.md) | todo | P2 (P3 for rewind × compaction tests) | P3–P6 |
| P8 | [Examples, README, 0.1.0 release](P8-release-0.1.md) | todo | P3–P7 | — |

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
