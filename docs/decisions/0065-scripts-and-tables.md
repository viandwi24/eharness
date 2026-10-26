# ADR-0065: Scripts and tables in the team app

Status: **Proposed** · Date: 2026-10-26 · Plan: [P59](../plans/P59-scripts-and-tables.md)

## Context

Repetitive work in the team app runs as agent turns: a program run, a heartbeat or a chat turn each
cost a model call, even when the job is deterministic ("when a message with 'halo' arrives in chat
A, post a line to group B"; "every evening, count yesterday's join requests into a file"). The event
triggers that woke an agent on a matching event were removed (they mixed app and chat events and
still paid for a model turn per event). Owners want the agent to write the automation **once** and
have it run without a model, and they want somewhere structured to keep data the agent and those
automations produce and query (lists, counters, ledgers, imported records), beyond library files.

Constraints: the code is written by an agent and may be shaped by prompt injection, so it is
untrusted; the server is Bun (runtime-neutral library underneath), SQLite, one or more instances
over one database; the library takes no new runtime dependency without an ADR (examples may).

## Decision

### Scripts

- **Where:** a team-app feature (`examples/team/server/src/{domain,app,infra}/scripts`), not a
  library module yet. By the rule of two (ADR-0062) the engine and the capability API move into an
  `eharness/scripts` module when the automation product needs the same machinery.
- **Shape:** a script is one TypeScript module whose default export is
  `async (event, ctx) => void`, plus a manifest kept next to it: triggers (channel event with
  filters, schedule, manual), **grants** (the chats it may post to, library globs it may read or
  write, tables it may read or write, HTTP hosts it may call, management APIs it may use) and limits.
- **Engine:** QuickJS compiled to WebAssembly (`quickjs-emscripten`, quickjs-ng sync variant) run
  inside a Bun Worker per run (or a small pool), with a memory limit, an interrupt-handler CPU
  deadline and a wall-time watchdog that terminates the Worker. TypeScript is stripped with the
  Bun transpiler before running; a generated `scripts.d.ts` describes the API so the agent's code
  is type-checked before it is tested. Host functions are exposed as promises (no asyncify).
- **Not used as a boundary:** `node:vm` / Bun `vm`, `vm2`, SES alone, a self-hosted workerd.
  `isolated-vm` does not run on Bun. A Deno subprocess with tight permissions stays the fallback
  for heavy scripts, behind the same executor interface.
- **Capability API only:** a script sees `ctx` and nothing else (no `fetch`, `fs`, `process`, timers
  beyond a bounded `sleep`). Every call goes through a host RPC that checks the script's grants and
  rate limits: `channels.send/reply` (through the gateway outbox, its governor and proactive
  policy), `library.read/write/list`, `tables.*`, `kv` (small state between runs), `http.fetch`
  (allowlisted hosts, private-host checks), `routines.*` and other management APIs as they are
  added, `log`, and `agent.wake(instruction)` as the explicit, paid escape hatch.
- **Lifecycle:** draft → dry run → activation → immutable versions. A dry run executes the real
  code on a recorded event (picked from a channel's Events page) or a synthetic one, with every
  side-effecting call replaced by a recorder ("would send … to …"). Scripts written by an agent are
  **activated only by an owner or admin**, and widening the grants of an active script needs a new
  approval. Old versions stay and can be restored.
- **Running:** channel triggers listen on the gateway's `onEvent` hook; schedules are a routine
  kind dispatched without a model (like reminders and the digest). Pause all holds scripts. Events
  caused by a script do not trigger scripts unless the script allows it (loop guard); per-script
  cooldown and hourly caps; events older than a freshness window are ignored after a restart. Each
  run is claimed once across instances and leaves a trace (event, host calls, logs, duration,
  result, error) with retention.

### Tables

- **Model:** document tables. A table has a name, an optional schema (typed columns, required
  fields, defaults) used for validation and the grid view, and rows stored as JSON with an id,
  version, timestamps and author. Stored in the app's SQLite database (`data_tables`, `data_rows`),
  so backups, restore and several instances work as for every other table; indexes on declared
  columns use SQLite expression indexes over `json_extract`.
- **Queries:** a MongoDB-like filter object (`$eq $ne $gt $gte $lt $lte $in $nin $contains
  $startsWith $exists $and $or $not`), projection, sort, limit and cursor paging, and aggregates
  (`count sum avg min max` with group-by), compiled to parameterised SQL. **No raw SQL** from agents
  or scripts. Updates by filter or id with compare-and-set on the row version; bulk insert/upsert.
- **Size:** per-table and per-workspace row and byte caps (settings); bulk import from CSV/JSON
  library files and export to the library, so the Python `run_code` toolkit and the files-based
  big-data jobs can work on a table too.
- **Access:** the web app (owner) manages everything; agents and scripts use tables through grants
  (read or write per table, owner-only drop); every change lands in the activity feed.

### Surfaces

- Web: a **Scripts** page (list, editor, dry run with event picker, versions, run traces, enable)
  and a **Tables** page (spreadsheet-like grid: sort, filter, edit cells, import/export).
- Agent tools `scripts` and `tables` (owner and admins, decided in code like `events_recent`).
- HTTP routes for both in the OpenAPI document.

## Consequences

+ Deterministic, repetitive work costs no model calls; the agent spends tokens once to write and
  test the script.
+ Untrusted code runs with no ambient authority; a mistake or an injected script can do only what
  its grants allow, and an owner approves those grants.
+ One structured store for agents, scripts and the web, queryable without SQL access.
− A new execution engine and a dependency (`quickjs-emscripten`) in the team server; QuickJS is
  slower than V8 for heavy computation (scripts are expected to be I/O glue).
− Two features with their own pages, limits and retention to operate.
− Document tables in the main database grow the backups; caps and export keep that bounded.

## Alternatives considered

- **Keep agent turns for everything:** simple, but every repetitive event pays a model call.
- **Bring back event triggers that wake an agent:** still a model call per event.
- **`node:vm` / `vm2`:** not a security boundary (vm2 has had several critical escapes in 2026).
- **`isolated-vm`:** strong and fast, but a V8 addon that does not run on Bun.
- **Raw SQLite tables per user table (runtime DDL):** fast queries, but schema migrations, SQL
  injection surface and backup coverage per table; JSON rows with expression indexes are enough.
- **A separate database engine (MongoDB, DuckDB):** a new service or native dependency to run and
  back up, for scale the team app does not need yet.
