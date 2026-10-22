# P55 — Consolidation: remove what production did not use

Status: in progress · Owner: agent session · Branch: main

## Goal

After eight days with one company, the team example carried more surface than anyone touched. This
phase removes the unused parts, merges the overlapping ones and leaves one place for each job. No
data is dropped: every table stays in the database (the removed features' tables are legacy rows,
nothing reads or writes them), and every migration stays additive.

The old code is kept in the git tag `archive/pre-consolidation-2026-10-22`.

## Production usage evidence (8 days, one company)

| Feature | Use |
|---|---|
| Work queue tasks created by the owner | 0 |
| Routines (not reminders, not program schedules) | 0 |
| Rehearsals and program test cases | 0 |
| Workspace (shared) memory files | 0 |
| Briefings | 7, barely read |
| Manager agent | unused |
| Health findings, consistency findings, alarms | three separate places |
| A standing order and a program note | duplicated (overlap) |

## What was removed or merged, and why

1. **Owner-created work queue tasks.** Removed the "New task" dialog (`NewTaskDialog.svelte`,
   `openNewTask`, the form helpers of `lib/tasks/queue.ts`) and the owner-facing `POST /tasks`
   route with its `TaskCreate` schema. Kept: the Tasks board (runs and hand-overs), start / hold /
   cancel / retry / accept / send back of tasks that exist, and the agent tools `create_task`,
   `list_tasks`, `update_task` (the lead hands work to agents with them) and `complete_task`
   (worker program runs). They are used by the lead and by programs, not only by the queue UI.
   Tests and the soak script now queue through `createTask` (`app/work-queue.ts`); the soak server
   has a `/__soak/task` control route, and `scripts/e2e-flows.ts` scenario 4 has the lead queue the
   task from its chat.
2. **Routines page becomes Reminders.** The page (`/routines`, same path, label "Reminders") lists
   reminders made from chats. Removed: the generic routine rows, the routine dialog, editor, runs and
   queue components, `routineAction`, `routineBadge`. No agent tool ever created a generic routine,
   so no tool changed. Programs keep their schedule (their internal `routines` rows stay); the
   HTTP routes `/routines/*` stay for the engine, programs and the API.
3. **Rehearsals and program tests.** Removed the routes (`/programs/{id}/rehearsals`,
   `/rehearsals/*`, `/programs/{id}/tests*`, `/program-tests/*`), `app/rehearsal.ts`,
   `domain/rehearsal.ts`, `infra/eh/rehearsal-service.ts`, `rehearsal-registry.ts`, `overlay-fs.ts`,
   the repositories and ports, every simulate branch in the channels, decisions, work-queue and
   big-data plugins, the program gate and the permission plugin, the rehearsal ledger scope, the
   program page tabs and dialogs, the Test run buttons and the activation warning. Kept: the
   `rehearsal` run origin in `domain/run-profiles.ts` and usage categories, so old model calls and
   sessions still classify. Tables `rehearsals` and `program_tests` stay (legacy).
4. **Workspace (shared) memory.** The memory tool no longer offers the workspace root and its pinned
   `profile.md` (`connector-catalog.ts`), the Settings > Memory section and the "Workspace memory"
   card of the Memory connector are gone, the lead seed text says "your own memory". Agent memory
   stays. Kept for compatibility: the `/memory?scope=workspace` routes, the export and import of
   existing files, the consistency scan of old files, and the `builtin:memory` connection row.
5. **Briefings folded into the daily digest.** The digest is one bell notification per local day
   (kind `briefing`, key `briefing:<day>`, body = the whole text, `postDigest`). Removed: the Briefing
   page, `/briefings*`, `read_briefings`, the `briefing-added` event, the `BriefingStore`, the
   "discuss a briefing" thread seed (stored seeds of old threads still display). The `briefings` table
   stays (legacy, no longer written). The bell shows the digest text. The notification routes moved
   to `routes/notifications.ts`.
6. **One "Needs attention" page.** `/attention` shows health findings, consistency findings and
   alarms in one list sorted by severity then recency, with one Dismiss button (alarms are
   acknowledged, findings dismissed, the same label). `/health` redirects there. Server links
   (`/health` in alarms, findings, heartbeat items) now say `/attention`. The routes
   `/agent-health/findings*` and `/alarms*` stay unchanged.
7. **Archived agents in pickers.** Every server list excludes archived agents by default; the web
   store no longer adds an archived agent it fetched by id to the picker list (`agents-core.ts`).
   The Manager agent itself is production data and was not archived.

The standing order / program note overlap is a data matter (the consistency detector
`order-duplicates-note` already reports it); no code change.

## Database

No table, column or row was dropped or migrated. Legacy tables: `rehearsals`, `program_tests`,
`briefings`; workspace memory files under `/memories/workspace/**`; the `routines` rows that are not
programs or reminders. `deleteProgram` no longer deletes the legacy rehearsal and test rows of the
program (they stay orphaned).

## Restore from the tag

```bash
git diff archive/pre-consolidation-2026-10-22 -- examples/team   # everything removed here
git checkout archive/pre-consolidation-2026-10-22 -- examples/team/server/src/infra/eh/rehearsal-service.ts   # one file
git worktree add ../eharness-archive archive/pre-consolidation-2026-10-22                                      # the whole old tree
```

The tables are still there, so a restored feature finds its old data.

## Tests

`server/test/threads.test.ts` (digest notification, discuss), `heartbeat.test.ts` (digest),
`work-queue.test.ts` and `task-assignment.test.ts` (queue through `createTask`), `e2e-fixes.test.ts`
(rehearsal case removed), `soak.test.ts`; web `lib/health/model.test.ts` (merged list),
`lib/routines/reminders.test.ts`, `lib/nav/sections.test.ts`, `lib/stores/agents.test.ts` (archived
agent), `lib/notifications-model.test.ts`. Removed: `test/rehearsal.test.ts`, the web
`lib/rehearsal` and `lib/briefings` tests.

## Open questions

- With no owner-facing create route and no Routines page, the worker program flow depends on the lead
  (`create_task`). If production never uses worker programs, they are the next candidate.
- The `/routines/*` HTTP CRUD could go once nothing but programs and reminders uses it.
