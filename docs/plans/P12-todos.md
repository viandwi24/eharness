# P12 — Todos plugin

Status: done · Owner: agent · Branch: `feat/long-running`

## Goal

A shipped `eharness/todos` plugin that keeps long tasks on track without breaking branching, the
prompt cache or the progress bounds (ADR-0018).

## Specs

- `docs/specs/13-todos-plugin.md` (new)

## Owns

`src/todos/**`, subpath wiring (`package.json`, `tsdown.config.ts`, `scripts/*`).

## Checklist

- [x] `todo_write` tool (schema, single `in_progress`, compact result)
- [x] `data-todos.list` part, `latestTodos`
- [x] List derived from the wire; carried across compaction; summarizer context
- [x] Volatile reminders (`remindEvery`, after compaction)
- [x] `enforce` via `turn.beforeEnd`, bounded by `maxNudges`, fingerprint and `idleContinues`
- [x] Subpath `eharness/todos`, smoke and import checks
- [x] Tests, spec, ADR-0018, changeset

## Acceptance criteria

- [x] Enforcement continues until done and gives up after a nudge without progress
- [x] The list survives a compaction
- [x] lint, typecheck, test, build, check:package, check:imports green

## Open questions

- Shared task lists across subagents (`listId`, owners, dependencies) — roadmap.
