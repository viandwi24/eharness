# P57 — Library structure: the library is the source of truth

Status: in progress · Owner: agent session · Branch: main

## Goal

Facts live in the library; agent memory keeps only short rules and an index that points into it.
The library gets a fixed structure, a program's brief and notes become library files that every run
reads fresh, and one owner-approved flow moves existing memory into that structure without losing
a byte.

```
/library/company/                      profile, organization structure, people and roles, SOPs and rules
/library/programs/<program>/brief.md   the program's instructions (read at every run)
/library/programs/<program>/notes.md   agreements and notes of the program
/library/knowledge/                    topic knowledge
/library/reports/                      dated reports
/library/data/                         trackers, ledgers, sheets
/library/archive/memory/<agent>/       memory retired by a reorganization (+ original/)
/memories/agents/<agent>/              rules.md, index.md, HEARTBEAT.md
```

## 1. Program brief from the library (file mode)

- `programs.brief_path` and `programs.notes_path` (additive migration `0041`). null = text mode.
- A run (`infra/eh/program-service.ts`, `app/program-files.ts#resolveProgramText`) reads the current
  files when it starts. Each save is a `library_history` version. The record keeps `brief` and
  `notes` as the **fallback copy** (the text at the time of the move).
- Missing, empty or unreadable file: the run uses the fallback and raises a `system` alarm (one per
  program and day, ref `/programs/<id>`) naming the file.
- **A file never grants authority.** Only text comes from a file. Authority, forbidden, gates, budget
  and deliverables are read from the record; the run prompt says so when a file is used. The path
  can only point under `/library/programs/<program>/` (`checkProgramFilePath`).
- File mode refuses a text edit of `brief` / `notes` (409 `BRIEF_IN_FILE` / `NOTES_IN_FILE`); the
  `program_note` tool edits `notes.md` (a new version) and refreshes the fallback copy.
- Migration: "Move brief and notes to the library", per program (program page) and for all (Programs
  page). Preview first (`POST /program-files/preview`), then `POST /program-files/apply`: files are
  created (never overwritten, a name clash gets a suffix), read back, then the program switches.
  Switching back is `PATCH /programs/{id}` with `briefPath: null, notesPath: null`.
- The program page shows both files with the library viewer/editor (versions, conflict handling).

## 2. Reorganize memory (one time per agent, owner approved)

`app/memory-reorg.ts`, routes under `/memory/reorganize/*`, web: Agent dialog > Memory > "Reorganize
memory".

1. `propose`: the agent's own model (`deps.completion`, plain `generateText`, no tools), one call per
   batch of at most 12 files / 24k characters. Per file one action: `keep-as-rule` (merged into
   `rules.md`), `move` (library path), `merge-into` (another file), `archive` (stale), with a one-line
   reason. A failed call or a skipped file defaults to a safe move into `knowledge/` plus a warning.
   `HEARTBEAT.md`, `rules.md` and `index.md` are never sent or moved.
2. Deterministic checks (`buildReorgPlan`, pure): target inside `/library` only (not the archive, not
   `.eharness`), never overwrite an existing library file or another row (numeric suffix), dated
   reports go to `/library/reports/`, merges follow their target and loops or unknown targets are
   errors, binary files are archived. The plan lists every row's final target, the issues and the
   diff of `rules.md` and `index.md`.
3. The owner edits action and target per row; every edit re-runs the checks (`preview`).
4. `apply`: `backupBefore('memory reorganization')` first, nothing happens when it fails
   (`BACKUP_FAILED`). Then: new library files (create-only, read back), `rules.md` and `index.md`
   (old text copied to `original/` first), and last each original memory file is **moved** (not
   deleted) to `/library/archive/memory/<agent>/original/<path>` (archived files to
   `/library/archive/memory/<agent>/<path>`). A file whose new place failed stays in memory.
5. A restore point (`kind: memory-reorganization`, sections `library` + `memory`, the safety backup)
   is recorded; the existing undo flow (`/backups/restore-points/{id}/undo`) puts everything back.

Originals are kept at least 30 days and are never deleted automatically (no sweeper exists yet).

## 3. Agent instructions and discipline

- The memory plugin protocol (`TEAM_MEMORY_PROTOCOL`): memory holds rules and an index only; read the
  library for facts (company/, knowledge/, data/, programs/). Pinned files are `rules.md` and
  `index.md`.
- `memoryDiscipline` also refuses a memory write that creates a dated file or writes more than 2,500
  characters, and points to `/library/reports/`, `/library/data/`, `/library/knowledge/`.

## Tests

`server/test/library-structure.test.ts`: proposal parsing, guards (outside library, archive, overwrite,
dated reports, merge loops), apply with no loss (every original byte present), backup first and abort
on failure, plan with errors refused before any backup, undo, file mode (read current file, versioned
edit, fallback and alarm, a file cannot grant authority, text edits refused, `program_note` edits the
file). Web: `lib/library/reorg.test.ts`, `lib/programs/files.test.ts`.

## Open items

- The workspace export does not carry `briefPath` / `notesPath`; an imported program is in text mode
  (its library files are in the zip).
- The fallback copy is the text at move time; it is not refreshed from the file.
- The proposal model call is not written to the model-calls log (Logs page).
- No sweeper removes `original/` after 30 days.
