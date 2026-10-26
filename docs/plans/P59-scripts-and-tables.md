# P59 — Team example: scripts and tables

Status: in progress · Owner: agent · Branch: `main` (direct commits, one gate per step)

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

- [ ] Agent tool `tables` (owner/admin in code): list, describe, create, alter, drop (owner only),
      insert, update, delete, query, aggregate, import, export; answers as readable lines.
- [ ] Tables page: list, grid with sort/filter/edit cell/add row, schema editor, import/export.
- [ ] Activity feed entries for table changes.

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

- [ ] Migration: `scripts` (id, name, status draft/active/disabled, current version, author kind
      agent/person, approval), `script_versions` (immutable code + manifest + hash), `script_runs`
      (trace: trigger, event id, host calls, logs, duration, result, error) with retention.
- [ ] Capability API v1: `channels.send/reply`, `library.read/write/list`, `tables.*`, `kv`,
      `log`, `agent.wake`; grants modelled on `ProgramAuthority`.
- [ ] Dry run on a recorded event (by event id from a channel's Events page) or a synthetic one;
      returns "would …" lines, logs and the result.
- [ ] Manual run (real side effects) for an active script.

### W5 — Triggers and safety

- [ ] Channel trigger: subscribe on the gateway's `onEvent`; filters (connection, chat incl.
      topics, event type from the adapter's `events`, actor role/id, text substring or bounded
      regex) — port the filter code from the removed triggers (branch
      `backup/events-root-2026-10-25`, `domain/triggers.ts`).
- [ ] Schedule trigger: a routine kind dispatched by `dispatchSystem` (no model).
- [ ] Gates: disabled, loop guard (events a script caused), Pause all, cooldown, hourly cap,
      freshness window; one claim per run across instances; skip reasons logged once a minute.
- [ ] Alarms: a script failing repeatedly raises one alarm and is paused like a routine.

### W6 — Scripts surfaces and approval

- [ ] Agent tool `scripts` (owner/admin in code): list, view, create, update (new draft version),
      dry run, request activation, disable, delete, runs; the agent reads type errors and dry-run
      output as text.
- [ ] Approval: an agent-authored script or a grant widening becomes a Decision Center question
      for an owner/admin; activation only after a yes; the web owner may activate directly.
- [ ] Scripts page: list with status, editor with the API types, event picker for dry runs,
      versions with diff and restore, run traces, enable/disable.
- [ ] Docs `scripts.md` with worked examples (the "halo" forwarder, a nightly table summary into
      a library report, a join-request counter).

### W7 — Optional: table events as triggers

- [ ] `table.row_created/updated/deleted` as a script trigger kind, with the same loop guard.

## Acceptance criteria

- [ ] The "halo" example works end to end with a fake channel: the agent writes it through the
      `scripts` tool, the dry run shows "would send …", the owner approves, a real message in
      chat A posts to group B, the run trace shows the call, and no model call happens per event.
- [ ] A script cannot reach anything outside its grants; an infinite loop, a memory bomb and a
      thrown error each end as a failed run with a readable reason; the server keeps serving.
- [ ] Tables: create with a schema, bulk import 100 000 rows from CSV, query with filters and an
      aggregate under a second on the dev machine, export back to the library; caps refuse with
      a readable message.
- [ ] Pause all holds scripts; several instances never run one event twice.
- [ ] Upgrade test: a database at the previous migration keeps every row and gains the new tables.
- [ ] `bun run lint && bun run typecheck && bun test && bun run build && bun run check:package && bun run check:imports` green
- [ ] No library change, so no changeset unless `src/` changes; team docs updated.

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
