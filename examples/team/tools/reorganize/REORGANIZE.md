# Reorganize this workspace

You are an AI coding agent. This folder is an unzipped workspace export of a team-agent app
(`eharness-team`). The owner wants its **library** and **memory** reorganized into a fixed structure
without losing any information. Read this whole file first, then work in this folder only.

When you are done the owner runs `validate.ts`, then `pack.ts`, and uploads the new zip. The app
shows a preview before anything changes. Your job is to make that preview clean.

## 1. What the zip contains

| Path | What it is | May you edit it? |
|---|---|---|
| `manifest.json` | format, counts, sha256 of every file | **No.** `pack.ts` recomputes hashes and counts. |
| `settings.json` | workspace settings (`settings`) and digest | Only `settings.worksRoot` (section 5). Nothing else. |
| `library/**` | every library file as it is | **Yes.** This is where you work. |
| `uploads/**`, `other/**` | uploaded files, other roots | No. Leave them where they are. |
| `memory/**` | workspace memory (legacy, usually empty) | Reduce like agent memory (section 6). |
| `agents/<slug>/agent.json` | model, permission mode, tool `rules`, connector enablement | Only library paths inside `rules`. Never ids, never permission mode, never connectors. |
| `agents/<slug>/persona.md` | identity, voice, operating rules | Only if it names a library path. |
| `agents/<slug>/heartbeat.json` | heartbeat configuration | No. |
| `agents/<slug>/memory/**` | the agent's memory; `HEARTBEAT.md` holds the standing orders | Yes, section 6. |
| `agents/<slug>/programs/<name>.json` + `<name>.brief.md` | a program: authority, deliverables, `briefPath`, `notesPath`, notes | Paths only (section 4). Never `id`, `status`, `budget`, `gates`, `trigger`, `forbidden`. |
| `agents/<slug>/routines/<id>.json` | a routine (prompt, schedule) | Only library paths inside `prompt`. |
| `agents/<slug>/reminders/<id>.json` | an active reminder | No (reading only). |
| `connections/<label>.json` | a connection WITHOUT secrets | No (reading only). |
| `people/<id>.json` | a person of the directory | No, unless a note names a library path. |
| `data/<table>/NNN.json` | rows of a table (`{ format, table, part, rows }`) | Rarely. Only to update a library path inside a row, with care: valid JSON, same keys, same row count. |
| `secrets.enc.json` | encrypted secrets | **Never touch.** Do not open, move, rename or re-save it. |

Never change an `id`, a `slug`, a `label`, a `name` of an agent or program, or a table row key: the
app matches things by them. Never invent or paste a secret, token or password anywhere.

## 2. The target structure

`<company>` is a short lowercase slug for the organization (ask the owner if it is not obvious; use
it in every path). Create only the files you have content for; do not create empty placeholders.

```
/library/<company>/
  profile.md                         who the company is: mission, products, clients, facts
  organization.md                    structure, roles, who reports to whom
  divisions/<division>/
    sop.md                           standard operating procedures of the division
    pic.md                           person in charge, contacts, escalation
    kpi.md                           the division's KPI definitions and targets
  kpi/YYYY/MM.md                     KPI results of a month
  reports/weekly/YYYY-Www.md         weekly reports (ISO week, e.g. 2026-W07)
  reports/monthly/YYYY-MM.md         monthly reports
  attendance/YYYY/MM.md              attendance of a month
  knowledge/<topic>.md               topic knowledge, one file per topic
  works/YYYY/MM/DD.md                daily journal: the day's cache, follow-ups, notes
  archive/                           retired material, kept (section 7)
/library/programs/<program>/brief.md    a program's instructions (this exact place is required)
/library/programs/<program>/notes.md    a program's agreements
/library/notes/heartbeat/               written by the app; leave it alone
/library/archive/memory/<agent>/        written by the app's own reorganization; leave it alone
```

Rules of the structure:

- One topic, one file. Merge duplicates by concatenating under headings, keeping every fact.
- File names are lowercase, dashes, no spaces. Dates are ISO (`2026-02-07`, `2026-W07`).
- Dated material goes into the dated folders (`reports/`, `kpi/`, `attendance/`, `works/`), never
  into `knowledge/`.
- Program files stay under `/library/programs/<program>/`: the app refuses other places.
- Files of the library that do not fit (`library/data/` trackers and ledgers, sheets) may stay
  where they are or move under `/library/<company>/data/`; the validator only warns. If you move
  a tracker, update every reference to it (section 4).

## 3. Every move is recorded

Create or extend `migrations/moves.json` (a JSON array, create the folder if needed):

```json
[
  { "from": "/library/old-name.md", "to": "/library/<company>/profile.md", "note": "renamed" },
  { "from": "/library/reports/", "to": "/library/<company>/reports/", "note": "whole folder" }
]
```

- A file move: `from` and `to` are file paths. A folder move: both end with `/`.
- Record **every** move, rename and merge (a merge: one entry per source file, same `to`).
- After the move, `from` must not exist in this folder, and `to` must.
- A file you split into several: record it as a move of the original into
  `/library/<company>/archive/` and note the new files in `note`.
- Paths are absolute library paths starting with `/library/`, never zip paths.
- Memory files are not recorded here; they are handled by section 6.

## 4. Every reference is updated

After moving, search the whole folder (`grep -rn "/library/" .` and every old name) and fix each
reference to a moved path. Places that hold paths:

1. **Programs** (`agents/<slug>/programs/<name>.json`):
   `authority.read` and `authority.write` globs, `deliverables[].path` (tokens like `{date}` and
   `{slug}` stay), `briefPath`, `notesPath` (file must exist under `/library/programs/<program>/`),
   and library paths mentioned in `notes`. The `<name>.brief.md` next to it must exist.
   A glob still has to cover where the program really reads and writes (do not widen authority:
   narrow or equal only).
2. **Standing orders** (`agents/<slug>/memory/HEARTBEAT.md`). One order per line:

   ```
   - The person's words. <!-- order:<id> by:<who> name:<name> role:<role> report:web:<session> mention:no at:<ms> ledger:<encoded path> refs:<encoded,list> needs:<encoded,list> -->
   ```

   The fields after `order:` are percent-encoded (`/` is `%2F`). Update the paths in `ledger:`,
   `refs:` and `needs:` (`files:<glob>`) and in the sentence itself. Decode, change, encode again.
   Do not change `order:<id>`, `by`, `at`, `report` or any other field, and keep the line on one line.
3. **Memory text** (`rules.md`, `index.md`, other memory files): every `/library/...` mention.
4. **Agent tool rules** (`agents/<slug>/agent.json` `rules.allow|ask|deny`) when a rule names a path.
5. **API agent grants** (`data/api_agents/*.json` rows: `readFolders`, `writeFolder`).
6. **Routines** whose `prompt` names a path.
7. **Persona** and **people notes** that name a path.

## 5. The daily works journal

Agents append the day's cache, follow-ups and working notes to `<worksRoot>/YYYY/MM/DD.md` (team
time zone); heartbeat and program runs add one line with a link to their full report. Format:

```
# Works 2026-02-07

- 09:12 [ana] Asked finance for the invoice list; follow up Monday.
- 18:40 [program weekly] done: Weekly report written. ([report](/library/<company>/reports/weekly/2026-W06.md))
```

If the company keeps the journal inside its folder, set `settings.worksRoot` in `settings.json`
to `/library/<company>/works` (no trailing slash) and move any existing journal files there
(recorded in `moves.json`). Otherwise leave it at `/library/works`. This is the only edit you make
to `settings.json`.

## 6. Memory: rules and an index only

Each agent's memory (`agents/<slug>/memory/`) ends with exactly:

- `rules.md`: short standing rules and preferences the agent must follow every time. Under 8,000
  characters. No facts that belong to a document, no reports, no tables, no secrets.
- `index.md`: one line per library place: `- /library/<company>/profile.md: company facts`. Under
  8,000 characters. Every path must exist.
- `HEARTBEAT.md`: the standing orders, kept (section 4.2), never reordered or deleted.

Every other memory file: move its content into the right library file (section 2), then **remove
the memory file** and record the move in your notes for the owner. Facts go to `knowledge/`,
company facts to `profile.md` or `organization.md`, dated material to the dated folders.
Add each new library file to `index.md`. Memory pointing into the library is the whole idea: memory
says where, the library holds what.

## 7. Never delete information

- Do not drop a sentence because it looks stale or duplicated. If it is clearly obsolete, move the
  whole file to `/library/<company>/archive/<original-name>` and record the move.
- When you merge files, every fact of every source must be present in the target.
- If you cannot tell where something belongs, put it in `/library/<company>/knowledge/<topic>.md`
  and mention it in your final note to the owner.
- Do not rewrite content for style. Move and reference; edit text only to fix paths.

## 8. Finish

1. Re-read `migrations/moves.json`: every `to` exists, every `from` is gone.
2. Run the validator and fix everything it reports as an ERROR until it is clean:

   ```
   bun tools/reorganize/validate.ts <this folder>
   ```

   Warnings (files outside the template, stray memory files) should be explained to the owner or
   fixed. Do not silence a check by editing the validator.
3. Do not run `pack.ts`, do not zip, do not upload: the owner does that.
4. Reply with: the list of moves (count and the main folders), what you merged, what you archived,
   the files you were unsure about, and the validator's last output.
