# Build board

Goal of this board: ship **eharness 0.1.0** — the skeleton described in `docs/specs/*` — and the
releases after it (P9–P12: 0.3.0; P13–P20: 0.4.0; P21–P29: 0.5.0; P30–P31: 0.6.0 and 0.7.0;
P33–P39: 0.8.0, published 2026-10-11; P40–P48 and later fixes: pending, 0.9.0 next, see [roadmap.md](roadmap.md#090-next)).

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
| P20 | [Production-patterns guide, docs, 0.4.0 release notes](P20-production-guide.md) | done | P13–P19 | — |
| P21 | [Tool risk `'external'`, MCP annotations, approval routing](P21-tool-risk-external.md) | done | P20 | P22 (W1) |
| P22 | [Inbox poison items, retries and dead-letter](P22-inbox-dead-letter.md) | done | P20 | P21 (W1) |
| P23 | [Park-and-resume: external waits](P23-park-and-resume.md) | done | P22 (P21 recommended) | P25 (W2) |
| P24 | [Request-scoped client tools and page context](P24-request-client-tools.md) | done | P23 | P26 (W3) |
| P25 | [Cross-session `BudgetLedger` port](P25-budget-ledger.md) | done | P20 | P23 (W2) |
| P26 | [Approval guard plugin (`eharness/guard`)](P26-approval-guard.md) | done | P21 (P25 recommended) | P24 (W3) |
| P27 | [Group-chat plugin (`eharness/group`)](P27-group-chat.md) | done | P20 | P28 (W4) |
| P28 | [OpenAPI → tools plugin (`eharness/openapi`)](P28-openapi-tools.md) | done | P21 | P27 (W4) |
| P29 | [Docs, guides, 0.5.0 release notes](P29-docs-0.5.md) | done | P21–P28 | — (W5) |
| P30 | [Coding agent example (`examples/coder`)](P30-coder-example.md) | done | P29 | — |
| P31 | [Library improvements found by the coding-agent benchmark](P31-library-from-coder.md) | done | P30 | — |
| P32 | [Team-agent example (`examples/team`)](P32-team-example.md) | review | P31 | — |
| P33 | 0.6.0: `wrapPlugin`, approvals combined with tools without `execute` (ADR-0033; no phase file) | done | P31 | — |
| P34 | Library gaps found by the team example, 0.8: peek and child identity, enqueue timers and ids, stream log and resumable streams, partial approvals, resume replay, held wakes, restart recovery, session invariants and fuzz, `model.call` observer, tool-error streak (ADR-0039–0047, 0054–0057; specs 04, 05, 11, 12, 20; no phase file) | done | P32 | — |
| P35 | `eharness/providers`: definitions, profiles, manager, catalogs, secret vault (ADR-0048, 0052; spec 23; no phase file) | done | P34 | P36 |
| P36 | `eharness/connectors`: definitions, connections, setup flows, OAuth, activation, consolidation with providers (ADR-0049–0053; spec 24; no phase file) | done | P35 | — |
| P37 | `eharness/activity`, `eharness/http`, `eharness/client`: activity feed, attention queue, fetch-style routes, browser client (ADR-0058, 0059; specs 25–27; no phase file) | done | P34 | — |
| P38 | 0.8 readiness: security hardening review, upgrade guide, walkthroughs, production checklist (no phase file) | done | P35–P37 | — |
| P39 | 0.8 hardening (internal multi-perspective review): one naming convention and single options objects, trimmed public surface with a committed exports snapshot, bounded waits and timeouts, fail-closed network and permission defaults, shared LLM judge engine, `config.observe`, one error taxonomy, one glob compiler, core and subagent restructuring without import cycles, test preload that fails on `W_INVARIANT_VIOLATION`, doc and example pass (ADR-0060; specs 01, 10, 15, 18; no phase file) | done | P38 | — |
| P40 | [Team example: autonomous operations](P40-team-autonomous-operations.md) — manager agent, programs (standing orders with enforced authority), decision center, work queue, chunked big-data work with `run_code`, heartbeat and daily digest | in progress (phases A–E, H, I, K, M done) | P32, P39 | — |
| P41 | [Team example: channels](P41-team-channels.md) — chat platforms as agent sessions: gateway with wake/observe, channel tools split by risk, Telegram bot (grammY) and user account (mtcute) transports, backfill into the library; L5 built: generic conversation model (nodes, inherited settings, bridgev2-shaped adapters, golden fixtures; L6 internal groups next) | in progress | P40 | — |
| P42 | [Team example: editable persona](P42-team-persona.md) — per-agent persona ("soul") editable from the web and from chat by owners/admins, with proposals, confirmation, versions and revert; immutable system rules; channel overlays | done | P41 | — |
| P43 | [Team example: People directory](P43-team-people.md) — one person, many platform accounts (labels, stable ids), dynamic fields and notes, role and divisions on the person, linking only by the owner or a pairing code, People page, `people_find`/`people`/`people_link` tools | in progress (phases 1–3 done) | P41 | — |
| P44 | [Code sandbox over the virtual file system](P44-code-sandbox.md) — `eharness/code`: Python runs over synced virtual files (incremental, compare-and-set write-back), packages as a cached environment plus an approved extra list, `denyRead` for the local sandbox, "Files & Sandbox" connector | in progress | P39 | P41 |
| P45 | [Team example: artifacts](P45-team-artifacts.md) — generated documents, web pages, images, code and data as artifacts: kind registry (one definition + one viewer per kind), versions, sandboxed HTML viewer on an optional separate content origin, markdown WYSIWYG, private/public sharing changeable by the agent, share links as channel replies | in progress | P43 | P44 |
| P46 | [Platform rings: shared modules for four products](P46-platform-rings.md) — `eharness/scheduler`, `channels` (delivery slice), `identity`, `handoff`, `limits`, `clock`; typed generic flow; deprecations; canary releases; AI SDK 7 alignment; the team app adopts the modules (ADR-0062, 0063; specs 29–34) | done | P39 | P40–P45 |
| P47 | [Products adopt the P46 modules fully](P47-module-adoption.md) — scheduler and outbox follow-ups; the team's people directory, decision center, outbox and rate governor on `identity`, `handoff` and `channels`; the coder on `limits` and `clock` | done | P46 | — |
| P48 | [Browser agent](P48-browser.md) — `eharness/browser`: adapters (Chrome, Lightpanda; Camoufox as a separate package) over an operation-level connection with a CDP client in core, manual and managed modes (Chrome for Testing / Lightpanda runtimes in `eharness/browser/node`), profiles, snapshots with refs, screenshots in the next model step, live view and human takeover; team Browser page (ADR-0064, spec 35) | done | P46 | P47 |
| P49 | [Long-run jobs](P49-long-run.md) — `longRun()` (checkpointed chunks on the durable inbox, cost and time limits, resume after restarts), `stepBudget({ onCap })` hand-over; the team's workers run for hours and chats never see "ran out of steps"; the coder runs unlimited while on track | done | P47 | P48 |
| P50 | [Follow-up hardening](P50-follow-ups.md) — OS sandbox probe and fallback, Allowed run_python, approvals reach owners, tool_search explains what is missing, readable id errors, mention-only turns, program base tools and brief warnings | done | P49 | P49 |
| P51 | [Proactive heartbeat and agent health](P51-proactive-and-health.md) — heartbeat reads channels, keeps notes and speaks only when it should (modes, reportTo, rubric, activity wake); Health page and authority suggestions; health in the digest | done | P50 | P50 |
| P52 | [Context and standing orders v2](P52-context-and-orders.md) — sessions_search / session_read / runs_list / run_read with a privacy gate; order kinds (watch, rule, deadline, ledger), exact deadline wakes, order needs grant tools, evidence-backed notes, weekly patterns, order hygiene | done | P51 | P51 |
| P53 | [Supervisor duty and consistency](P53-supervisor-and-consistency.md) — the heartbeat supervises its own work (retry, escalate, fix its own memory) and the deterministic consistency detectors feed it | in progress | P52 | P52 |
| P54 | [Alarms](P54-alarms.md) — no failure of scheduled or background work stays silent: deterministic alarms (failed, stuck, paused, expired, broken, system), Health "Needs attention", owner push with rate limit | in progress | P53 | P53 |
| P55 | [Consolidation](P55-consolidation.md) — remove what production did not use (work queue form, generic routines, rehearsals and program tests, workspace memory, Briefing page), one Needs attention page, tables kept | in progress | P54 | P54 |
| P56 | [Developer API](P56-developer-api.md) — isolated API agents and keys for third-party developers: `/v1` one-shot runs and conversations (SSE), per-key limits, origins and usage, the Developers page | in progress | P55 | P55 |
| P57 | [Library structure](P57-library-structure.md) — the library is the source of truth: fixed folders (company, programs, knowledge, reports, data), program briefs and notes as library files, one-time memory reorganization (rules + index only), memory discipline guard | in progress | P55 | P55 |
| P59 | [Scripts and tables](P59-scripts-and-tables.md) — team example: TypeScript scripts in a QuickJS sandbox (channel-event, schedule and manual triggers, capability API with grants, dry runs, owner approval, versions, run traces) and document tables (schema, MongoDB-like queries and aggregates, spreadsheet page, import/export), so repetitive work runs without a model call (ADR-0065) | done | P57 | — |
| P60 | [Scripts and tables, mature](P60-scripts-maturity.md) — media model (stickers, voice, albums, file references), copy/forward with captions, copy map, trigger filters, delayed runs and state helpers, moderation and buttons, table upserts and change triggers, safety and recipes | in progress (W1–W5 done) | P59 | — |

**P13–P20 ship together as 0.4.0.** All of them are committed directly on `main` (no phase
branches); each phase adds its own changeset (P13 `patch`, feature phases `minor`), and the next
version PR releases them as one 0.4.0. "Can run in parallel" means the phases do not depend on
each other; on a single branch they are still committed one after another (rebase before every
commit). Source of P14–P20: the 0.4 proposal (internal notes) — items U1–U9 are
mapped in each phase file; results go to the 0.4.0 results notes (P20, internal).

**P21–P29 ship together as 0.5.0.** Same process as 0.4.0: direct commits on `main`, one
changeset per phase (feature phases `minor`), one version PR. Implementers develop the whole
checklist first and run **one** gate at the end of each phase; one consolidated review of P21–P28
runs in P29 before the version PR. Waves (at most two phases at a time, grouped by low file
overlap): **W1** P21 + P22 → **W2** P23 + P25 → **W3** P24 + P26 → **W4** P27 + P28 → **W5** P29.
Hard dependencies: P23 after P22 (inbox `availableAt` timers), P24 after P23 (pending timeouts),
P26 and P28 after P21 (risk traits). ADR numbers are reserved per phase: 0025 (P21), 0026 (P22),
0027 (P23), 0028 (P24), 0029 (P25), 0030 (P26), 0031 (P27, only if needed), 0032 (P28). New specs:
15 (guard, P26), 16 (group, P27), 17 (openapi, P28). Source: the 0.5 prior-art analysis
(internal notes) — items #1–#8 are mapped in each phase file; results go to
the 0.5.0 results notes (P29, internal).

**P39 is the last phase before 0.8.0.** One internal review looked at the codebase from several
perspectives (API design, security, correctness under concurrency and restarts, operations and
documentation) and produced a list of findings; all accepted ones landed as direct commits on
`main` with one changeset per concern (`.changeset/`). Breaking changes are allowed in 0.x
(minor bump) and are listed in the changesets and in `docs/guides/upgrading.md`. 0.8.0 is
published (npm and tag `eharness@0.8.0`). **Next step:** run `bun run release:version` when 0.9.0 is
cut (39 changesets pending, see [roadmap.md](roadmap.md#090-next)), review the generated
`CHANGELOG.md`, merge, and publish through the release workflow (`docs/engineering/release.md`).

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
