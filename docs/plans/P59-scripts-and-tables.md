# P59 — Team example: scripts and tables

Status: done · Owner: agent · Branch: `main` (direct commits, one gate per step)

## Goal

Owners and agents can automate repetitive work **without a model call per event** and keep
structured data. After this phase the team app has **scripts** (TypeScript run in a QuickJS
sandbox, triggered by channel events, schedules or by hand, with a capability API, dry runs,
owner approval, versions and run traces) and **tables** (document tables with an optional schema,
MongoDB-like queries and aggregates, a spreadsheet-like page, import and export). An agent asked
"when a message with 'halo' arrives in chat A, post it to group B" writes the script, dry-runs it
on a real event and asks the owner to activate it; from then on each match costs nothing.

Decision record: [ADR-0065](../decisions/0065-scripts-and-tables.md).

## Specs

- No library spec: both features live in `examples/team`. Docs: `examples/team/docs/scripts.md`,
  `examples/team/docs/tables.md` (new), `examples/team/docs/api.md`.
- Reused contracts: the channels gateway (`onEvent`, `resolveTarget`, `post`, outbox, governor),
  routines (`dispatchSystem`), program authority (`ProgramAuthority`, `program-gate`), `libraryFs`,
  the activity feed, Pause all, the alarm path.

## Owns

- `examples/team/server/src/{domain,app,infra}/scripts/**`, `.../{domain,app,infra}/tables/**`
- `examples/team/server/src/http/routes/{scripts,tables}.ts`, `.../http/schemas/{scripts,tables}.ts`
- New drizzle migrations (additive only) and `domain/backup-coverage.ts` entries for the new tables
- `examples/team/web/src/routes/{scripts,tables}/**`, `examples/team/web/src/lib/{scripts,tables}/**`
- `examples/team/docs/{scripts,tables}.md`

## Scope

- In: the script engine and executor, capability API, triggers (channel event, schedule, manual),
  dry run, approval and versions, run traces, limits; tables with schema, queries, aggregates,
  import/export; agent tools; web pages; HTTP routes; docs.
- Out (later): a library module `eharness/scripts` (rule of two, ADR-0062); scripts calling
  npm packages; HTTP webhooks into scripts; table change events as script triggers (listed as
  W7, optional); raw SQL; cross-workspace sharing.

## Steps

Each step ends with the gate below and its own commit; the web pieces land with the server piece
they show.

### W1 — Tables core

- [x] Migration `0047_data_tables`: `data_tables` (id, name unique, schema JSON, running row and
      byte counters, created/updated, author) and `data_rows` (table id, row id UUIDv7, data JSON,
      version, created/updated, author); backup coverage entries (`snapshot`).
- [x] Schema: typed columns (`string number boolean date json`), required, default, indexed,
      strict; validation on write with readable errors.
- [x] Query compiler: filter operators of ADR-0065 plus `$has` (a list contains a value),
      projection, sort, limit, cursor (row id in creation order, offset with a sort); aggregates
      with group-by; parameterised SQL with checked literal field paths; shared expression indexes
      `data_rows_x_<column>` for declared columns (the query plan uses them).
- [x] Writes: insert (all-or-nothing, 1000 per request), update/delete by id or filter (10 000 per
      request) with row-version compare-and-set; caps per table and for all tables
      (`tableMaxRows`, `tablesMaxMb`, Settings > Limits, `TEAM_TABLE_MAX_ROWS`, `TEAM_TABLES_MAX_MB`).
- [x] Import from CSV/JSON/NDJSON library files (with `upsertKey`), export to the library (CSV
      cells guarded against formulas; an export imports back).
- [x] HTTP routes and tests (`test/tables-domain.test.ts`: every operator on SQLite, injection
      attempts, counters, compare-and-set, CSV; `test/tables.test.ts`: API end to end, caps,
      import/export, upgrade from migration 0046). Docs: `examples/team/docs/tables.md`.
- Measured: 100 000 CSV rows import in about 0.3 s; a filtered, sorted query about 15 ms; a
  grouped aggregate about 35 ms; an export about 0.2 s.

### W2 — Tables surfaces

- [x] Agent tools `tables_read` / `tables_write` (`infra/tables/plugin.ts`; the web owner, an
      owner or admin in a chat, unattended runs): list, describe, query, aggregate; create, alter,
      insert, update, delete, import, export, drop (needs `confirm: true`); answers as readable lines.
- [x] Tables page: list, grid with sort/filter/edit cell/add row, schema editor, import/export.
- [x] Activity feed entries for table changes (`tables-changed`).

### W3 — Script engine

- [x] Dependency `quickjs-emscripten-core` + `@jitl/quickjs-ng-wasmfile-release-sync` (0.32.0) in
      `examples/team/server`.
- [x] Executor (`infra/scripts/executor.ts`, `worker.ts`): a fresh Bun Worker per run, QuickJS
      memory limit, CPU deadline through the interrupt handler that counts only time spent in
      script code (waiting on host calls does not count), wall-time watchdog that terminates the
      Worker; host-call count, value size, log line and character caps. A run starts in ~15 ms.
- [x] Host calls: promises across the Worker boundary (JSON text only), a frozen `ctx` built from
      the method names the caller allows (`ctx.log`, `ctx.sleep` built in), errors of a host
      method become the script's errors; dry runs record the methods marked as side effects and
      answer `{ dryRun: true }`.
- [x] TypeScript: stripped with the Bun transpiler (syntax errors with line and column), imports
      refused, a default export required; `scriptTypes()` generates the `scripts.d.ts` text from
      the host method docs. **Not yet:** type-checking a script against it before a dry run (needs
      the TypeScript compiler at runtime; see open questions).
- [x] Tests (`test/scripts-executor.test.ts`): ctx calls and traces, sync and async exports,
      parallel calls, host errors, dry runs, refused sources, endless loops (also after an await),
      memory bomb, waiting forever, call and size caps, no host globals (`fetch`, `process`,
      `require`, `Bun`, timers, `Function('return this')`), frozen `ctx`, prototype pollution not
      reaching the server, eight runs at once.

### W4 — Scripts: storage, API, dry run, manual runs

- [x] Migration `0048_scripts`: `scripts` (id, name, status draft/active/disabled, latest and
      active version, author kind agent/person, approval), `script_versions` (immutable code +
      manifest + hash), `script_runs` (trace: trigger, event without text, host calls, logs,
      duration, result, error; kept 30 days, 500 per script), `script_kv` (state between runs).
- [x] Capability API v1 (`infra/scripts/host.ts`): `channels.send/reply`, `library.read/list/write`,
      `tables.*`, `kv.*`, `http.get/request` (https, granted hosts, private addresses refused),
      `agent.wake`, `programs.list/run`, `log`; default-deny grants in the manifest
      (`domain/script-manifest.ts`).
- [x] Dry run on a recorded event (by event id, with the message text typed in) or a synthetic one;
      returns "would …" calls, logs, the result and per channel trigger "match" or why not.
- [x] Manual run (real side effects) for an active script; use cases in `app/scripts.ts`, routes
      `/scripts/**`, docs `examples/team/docs/scripts.md`.

### W5 — Triggers and safety

- [x] Channel trigger (`infra/scripts/engine.ts`): the gateway's `onEvent`; filters (connection,
      chat incl. topics, event type, actor role/id, text substring or bounded regex).
- [x] Schedule trigger: the system routine `sys:script:<id>` dispatched by `dispatchSystem` (no
      model), kept in step with the script (`syncSchedule`).
- [x] Gates: Pause all, loop guard (the agent's own events, the script's own table writes),
      freshness window (15 min), cooldown, hourly cap; one queue per script, 4 runs at once; each
      event reaches only the instance that saw it; skip reasons logged once a minute.
- [x] Alarms: 5 failed runs in a row switch the script off and raise one alarm.

### W6 — Scripts surfaces and approval

- [x] Agent tools `scripts_read` / `scripts_write` (`infra/scripts/plugin.ts`, same rule as the
      table tools): list, view, versions, types, runs, run; create, update (new version), dry run,
      request activation, run now, disable, delete (confirm); answers as text.
- [x] Approval: an agent-authored version, or one that widens grants, triggers, caps or limits of
      the approved one, waits for the owner: a bell notification links to the script, the owner
      approves or rejects **on the Scripts page** (not a Decision Center question: the approval
      needs the code and grants in view, and the agent must never answer it from a chat). The web
      owner activates directly; a non-widening new version the agent may switch to itself.
- [x] Scripts page: list with status, editor with the API types, event picker for dry runs,
      versions with diff and restore, run traces, enable/disable.
- [x] Docs `scripts.md` with worked examples (the "halo" forwarder, a nightly table summary into
      a library report, a join-request counter).

### W7 — Optional: table events as triggers

- [x] `row.created/updated/deleted` as a script trigger kind (`{ kind: "table", table, events }`),
      with the loop guard (the script's own writes do not start it).

### W8 — More inputs, the team API, editor (added after the first review)

- [x] App-event trigger (`{ kind: "app", events, agents?, match? }`): every record appended to the
      event feed on this instance (tasks, programs, routines, decisions, alarms, files, turns,
      approvals, settings…); app events caused by the script's own `ctx.api` calls are skipped.
- [x] Webhook trigger (`{ kind: "webhook" }`): `POST /hooks/scripts/{id}/{token}`, an HMAC token
      (`TEAM_SECRET_KEY` / vault key), open route, body at most 256 KB, credentials headers dropped.
- [x] `ctx.api.get` / `ctx.api.request`: the team HTTP API in-process as the owner (a per-process
      internal key), on routes granted in `grants.api` (`METHOD /path` globs); `/scripts`, auth,
      providers, connectors, backups, storage, developer, workspace, `/v1` and `/hooks` never.
- [x] Web: Monaco editor (TypeScript with the server's `scripts.d.ts`: autocomplete, hover, type
      errors; JSON with the manifest JSON Schema), recipes for new scripts, a Simple (forms) / JSON
      manifest editor, an always-visible test panel with a plain verdict, save → test → turn on
      steps, Monaco diffs of versions.

## Acceptance criteria

- [x] The "halo" example works end to end with a fake channel: the agent writes it through the
      `scripts` tool, the dry run shows "would send …", the owner approves, a real message in
      chat A posts to group B, the run trace shows the call, and no model call happens per event.
- [x] A script cannot reach anything outside its grants; an infinite loop, a memory bomb and a
      thrown error each end as a failed run with a readable reason; the server keeps serving.
- [x] (Measured on the dev machine: import of 100 000 CSV rows 0.6 s, filtered sorted query 5 ms,
      grouped aggregate 76 ms.) Tables: create with a schema, bulk import 100 000 rows from CSV, query with filters and an
      aggregate under a second on the dev machine, export back to the library; caps refuse with
      a readable message.
- [x] Pause all holds scripts; several instances never run one event twice (each event reaches only
      the instance that received it; schedules go through the routine claim).
- [x] Upgrade test: a database at the previous migration keeps every row and gains the new tables.
- [x] `bun run lint && bun run typecheck && bun test && bun run build && bun run check:package && bun run check:imports` green
- [x] No library change, so no changeset unless `src/` changes; team docs updated.

## Open questions

- Tables in the main database (chosen) or a separate SQLite file for user data, if backups grow
  too large? Revisit after W1 with real sizes.
- Tables travel in the database snapshot only (`snapshot` class); a workspace-zip section for
  tables is a later step. Meanwhile a table moves through export/import.
- Should `http.fetch` be off until an owner turns it on per script (conservative default: yes)?
- One Worker per run (chosen for isolation) or a warm pool per script? Measured in W3: a run
  starts in about 15 ms, so one Worker per run stays.
- Type-checking scripts against `scripts.d.ts` needs the TypeScript compiler at runtime (a large
  dependency in the server image). Options: ship `typescript` and check before every dry run;
  check only in the web editor (the browser loads the compiler); or rely on dry runs, which already
  report runtime errors with their message. Default until decided: dry runs only.
- May an admin (not only an owner) approve an agent-authored script? Default: owner or admin, as
  for other Decision Center questions.

## Requests to other phases

(empty)
