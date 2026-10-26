# Scripts

Scripts are small TypeScript programs that run **without a model** when something happens: a
chat event (a message, a reaction, a member joining), a schedule, a change in a
[table](tables.md), something the app itself does (a task finished, a program changed, an alarm),
or a call from another system to the script's webhook URL. Through `ctx.api` a script can use the
same team API the web app uses, route by route as its grants allow. They do the rule-based work an agent should not be woken for: forward
messages, count things, log to a table, write a daily report to the library. An agent can write
them itself; a person approves before a script runs on its own. Decision:
[ADR-0065](../../../docs/decisions/0065-scripts-and-tables.md), plan:
[P59](../../../docs/plans/P59-scripts-and-tables.md).

- [A first script](#a-first-script)
- [Lifecycle](#lifecycle)
- [The manifest](#the-manifest)
- [The `ctx` API](#the-ctx-api)
- [Events](#events)
- [Gates and safety](#gates-and-safety)
- [Examples](#examples)
- [Agent tools](#agent-tools)
- [API](#api)
- [Storage and operations](#storage-and-operations)

## A first script

"When a message with *halo* arrives in chat Ops, post it to group VIP":

```ts
export default async function (event, ctx) {
  await ctx.channels.send({
    connection: 'c1',
    chat: 'VIP',
    text: `${event.actor?.name ?? 'Someone'} in ${event.chat?.title}: ${event.text}`,
  })
  return { forwarded: true }
}
```

```json
{
  "triggers": [
    { "kind": "channel", "events": ["message.created"], "chats": ["Ops"], "textContains": ["halo"] }
  ],
  "grants": { "send": [{ "connection": "c1", "chat": "VIP" }] }
}
```

`c1` is the connection id (Channels page, the connection's settings). A chat is named by its
title, its platform id (`-100…`) or its internal node id; for a forum topic the trigger matches the
topic or its group.

Rules for the source:

- One default export: `async function (event, ctx)`. What it returns (JSON) is kept in the run trace.
- No `import`/`require`, no timers, no `fetch`: everything outside the script goes through `ctx`.
- TypeScript types are stripped, not checked; a dry run shows runtime errors with their message.
  The Scripts page and `scripts_read` action `types` show the full `scripts.d.ts`.
- `console.log(...)` and `ctx.log(...)` lines go to the trace.

## Lifecycle

1. **Draft.** Create the script (Scripts page, `POST /scripts`, or the agent's `scripts_write`).
   Every change of code or manifest is a new immutable **version**; old versions stay and can be
   restored (a restore is a new version).
2. **Dry run.** Runs the real code on a recorded chat event (picked from the Events page; the event
   log never keeps message text, so you type the text) or on a synthetic event. Calls that change
   something (`channels.*`, `library.write`, `tables.insert/update/delete`, `kv.set/delete`,
   `http.request`, `agent.wake`, `programs.run`) are **recorded, not done** ("would channels.send
   …"); reads are real. The answer also says, per channel trigger, whether the event would start
   the script or why not.
3. **Activation.** The owner activates a version on the Scripts page. A script an agent writes
   **while you (or an admin in a chat channel) ask for it in a chat** runs as soon as the agent calls
   `request_activation`: your request is the approval (Settings > Limits > Scripts, on by default).
   A script an agent writes on its own (a heartbeat, a program) waits for approval: the bell shows
   "Script … waits for your approval" with a link, and the owner approves or rejects on the script's
   page. A later version of an approved, active script that **widens nothing** (same triggers, no new
   grants, no shorter cooldown, no higher hourly cap, same limits) the agent may switch to itself;
   anything wider needs approval again, and the approved version keeps running meanwhile.
4. **Running.** Each run leaves a trace: trigger, version, event (message text removed, only its
   length), the `ctx` calls with their answers, logs, result or error, duration and CPU time.
5. **Off.** Disable by hand, or automatically after **5 failed runs in a row** (an alarm is
   raised; the owner turns it on again after a fix). Deleting removes versions, runs and state.

## The manifest

```json
{
  "triggers": [],
  "grants": {},
  "cooldownSec": 0,
  "maxRunsPerHour": 60,
  "limits": {}
}
```

**Triggers** (at most 10; at most one schedule). A script without triggers runs only by hand.

| Kind | Fields |
|---|---|
| `channel` | `events` (required: `message.created`, `message.edited`, `message.deleted`, `reaction.added`, `reaction.removed`, `member.joined`, `member.left`, `member.updated`, `member.join_requested`, `member.join_request_resolved`, `node.*`, `action`), and optional filters: `connections` (ids), `chats` (title, platform id or node id), `actorRoles` (`owner`, `admin`, `member`, `guest`), `actors` (platform id, name or `@username`), `textContains` (any of the words, ignoring case), `textRegex` (bounded: at most 200 characters, no nested quantifiers) |
| `schedule` | `spec`: `{ "kind": "cron", "expr": "0 9 * * *", "timezone": "Asia/Jakarta" }` (timezone defaults to the team's), `{ "kind": "every", "everyMs": 3600000 }` (at least one minute), or `{ "kind": "at", "at": "2026-12-01T09:00:00Z" }` |
| `table` | `table` and `events` (`row.created`, `row.updated`, `row.deleted`) |
| `app` | `events`: what the app does (`task-changed`, `program-changed`, `routine-fired`, `decision-changed`, `alarm-raised`, `file-changed`, `message-added`, `turn-started`, `pending-changed`, `approval-decided`, `settings-changed`, …); optional `agents` (id or slug) and `match` (`{ "status": "done" }`: payload fields that must equal these values; dots reach nested fields) |
| `webhook` | none. A `POST` to the script's secret URL (`GET /scripts/{script}/webhook`, shown in the editor) runs the active version; the answer is `{ ok, result, runId }` |

All filters of one trigger must match; any trigger starts the script.

**Grants** are default-deny: a call outside them fails with a sentence the trace shows.

| Grant | Allows |
|---|---|
| `send: [{ connection, chat, topic? }]` | `ctx.channels.send` to those chats |
| `reply: true` | `ctx.channels.reply` in the chat of the event that started the run |
| `libraryRead`, `libraryWrite` | library paths by glob (`/library/reports/**`; `*` inside one folder); write implies read |
| `tablesRead`, `tablesWrite` | table names (`*` = any); write implies read |
| `http` | hosts for `ctx.http.*` (`api.example.com`, `*.example.com`); https only, private addresses refused |
| `wake` | agents (slug or name) `ctx.agent.wake` may give an instruction (a paid model turn) |
| `programs` | programs (name or id) `ctx.programs.run` may start |
| `api` | routes of the team API for `ctx.api`: `"GET /tasks/**"`, `"POST /tables/orders/rows"`, `"POST /programs/*/run"` (`*` one path part, `**` any). Never callable whatever the grant: `/scripts/**` (a script cannot approve or rewrite itself), `/auth`, `/providers`, `/connectors`, `/backups`, `/storage`, `/developer`, `/workspace`, `/v1`, `/hooks` |

**Caps.** `cooldownSec` (0 to 7 days): after a run, events are skipped until it passes.
`maxRunsPerHour` (default 60; 0 = no cap). **Limits** override the defaults within bounds:

| Limit | Default | Bounds |
|---|---|---|
| `memoryMb` | 64 | 8–256 |
| `cpuMs` (time running script code) | 5 000 | 100–60 000 |
| `wallMs` (whole run, host calls included) | 30 000 | 1 000–300 000 |
| `maxHostCalls` | 200 | 1–2 000 |
| `maxLogLines` / `maxLogChars` | 200 / 20 000 | 10–2 000 / 1 000–200 000 |
| `maxValueChars` (result, one call's arguments or answer) | 100 000 | 1 000–1 000 000 |

## The `ctx` API

Every method takes one object and returns a promise.

| Method | Does |
|---|---|
| `channels.send({ connection, chat, topic?, text })` | post to a granted chat → `{ messageIds }` |
| `channels.reply({ text })` | reply in the event's chat (`grants.reply`) |
| `library.read({ path })`, `library.list({ prefix })`, `library.write({ path, content })` | library text files |
| `tables.query({ table, filter?, sort?, fields?, limit?, cursor? })`, `tables.get({ table, id })`, `tables.aggregate({ table, filter?, groupBy?, metrics })` | read [tables](tables.md) |
| `tables.insert({ table, rows })`, `tables.update({ table, id?, filter?, set?, unset?, inc?, ifVersion? })`, `tables.delete({ table, id?, filter? })` | change tables; rows record `script:<name>` as author |
| `kv.get({ key })` → `{ value }`, `kv.set({ key, value })`, `kv.delete({ key })`, `kv.keys({ prefix? })` | the script's own JSON state (1 000 keys, 100 000 characters a value) |
| `http.get({ url, headers? })`, `http.request({ url, method, headers?, body? })` | https to granted hosts; 10 s timeout, 1 MB body, redirects not followed |
| `agent.wake({ agent, instruction })` | an instruction in that agent's "Scripts" chat; at most 3 per run |
| `programs.list()`, `programs.run({ program })` | granted programs |
| `api.get({ path, query? })`, `api.request({ method, path, query?, body? })` | the team API (every route of the [API docs](api.md)) as the owner, on granted routes → `{ status, body }`; a dry run records `api.request` instead of doing it |
| `log(...values)` | a trace line |

## Events

A channel event looks like this (the text is in memory only and never stored):

```json
{
  "type": "message.created",
  "connectionId": "c1",
  "eventId": "…",
  "at": 1793000000000,
  "chat": { "nodeId": "…", "nativeId": "-1001", "title": "Ops", "rootNativeId": "-1001", "rootTitle": "Ops" },
  "actor": { "id": "42", "name": "Ana", "username": "ana", "role": "member" },
  "text": "halo everyone",
  "messageId": "1234",
  "replyTo": { "messageId": "1200" }
}
```

`replyTo` is set on replies (the id of the message answered, plus its sender when the platform
says). `emoji` is set on reactions. An app event: `{ "type": "task-changed", "at", "seq", "agentId",
"agentSlug", "sessionId", "payload": { … } }` (the payload is what the event stream shows). A
webhook event: `{ "type": "webhook", "at", "method", "query", "headers" (content type, user agent
and `x-*` headers without tokens or secrets), "body" (JSON when it parses, else text, at most
256 KB) }`. A table event: `{ "type": "row.created", "table", "rowIds", "rows":
[{ id, version, data }] (up to 20; none for deletions), "by" }`. A schedule event: `{ "type":
"schedule", "slot", "firedAt" }`. A run started by hand gets `{ "type": "manual", "at" }` or the
event given.

## Gates and safety

Before an automatic run the engine checks, in order: **Pause all** (scripts hold too), the **loop
guard** (messages the app itself sent through a connection, table changes the script itself made,
and app events caused by its own `ctx.api` calls never start it; a message a person types on a
connected Telegram account from their phone is an ordinary message and does), **freshness**
(events older than 15 minutes, e.g. a catch-up after a restart, are not run), the **cooldown** and
the **hourly cap**. A skipped event is logged as a `skipped` run with
the reason, at most once a minute per script and reason. Runs of one script go one after another
(at most 20 waiting; more are skipped as `busy`); at most 4 runs go at once (Settings > Limits).

Each run executes in a fresh QuickJS (WebAssembly) sandbox inside its own Worker: no access to
the server's modules, files, network, environment or timers; memory, CPU time, wall time and
host calls are capped, and the Worker is terminated when the wall time runs out. An endless loop,
a memory bomb or a thrown error each end as a failed run with a readable reason; the server keeps
serving. Each event is seen by the one instance that received it, so several instances never run
one event twice; schedules fire through the routine claim (one instance per slot).

`TEAM_SCRIPTS_ALLOW_PRIVATE_FETCH=1` (development only) lets `ctx.http` call `http://` and private
addresses.

## Examples

**Count join requests per chat** (`member.join_requested`, a table):

```ts
export default async function (event, ctx) {
  const chat = event.chat?.title ?? 'unknown'
  const day = new Date(event.at).toISOString().slice(0, 10)
  const found = await ctx.tables.query({ table: 'join_counts', filter: { chat, day }, limit: 1 })
  const row = found.rows[0]
  if (row) await ctx.tables.update({ table: 'join_counts', id: row.id, inc: { n: 1 } })
  else await ctx.tables.insert({ table: 'join_counts', rows: [{ chat, day, n: 1 }] })
}
```

Manifest: `{ "triggers": [{ "kind": "channel", "events": ["member.join_requested"] }], "grants": { "tablesWrite": ["join_counts"] } }`.

**Nightly summary into the library** (schedule, aggregate, library):

```ts
export default async function (event, ctx) {
  const { groups } = await ctx.tables.aggregate({
    table: 'join_counts',
    groupBy: ['chat'],
    metrics: { total: { op: 'sum', field: 'n' } },
  })
  const day = new Date().toISOString().slice(0, 10)
  const lines = groups.map((g) => `- ${g.chat}: ${g.total}`)
  await ctx.library.write({ path: `/library/reports/joins-${day}.md`, content: `# Join requests\n\n${lines.join('\n')}\n` })
  return { chats: groups.length }
}
```

Manifest: `{ "triggers": [{ "kind": "schedule", "spec": { "kind": "cron", "expr": "0 23 * * *" } }], "grants": { "tablesRead": ["join_counts"], "libraryWrite": ["/library/reports/**"] } }`.

**Tell a chat when work is done** (app event, match):

```json
{ "triggers": [{ "kind": "app", "events": ["task-changed"], "match": { "status": "done" } }],
  "grants": { "send": [{ "connection": "c1", "chat": "Ops" }] } }
```

```ts
export default async function (event, ctx) {
  await ctx.channels.send({ connection: 'c1', chat: 'Ops', text: `Done: ${event.payload.title}` })
}
```

**Save webhook calls as rows** (webhook, `ctx.api`):

```ts
export default async function (event, ctx) {
  const r = await ctx.api.request({ method: 'POST', path: '/tables/orders/rows', body: { rows: [{ id: event.body.id, total: event.body.total }] } })
  return { status: r.status }
}
```

Manifest: `{ "triggers": [{ "kind": "webhook" }], "grants": { "api": ["POST /tables/orders/rows"] } }`
(`ctx.tables.insert` with `tablesWrite` does the same; `ctx.api` reaches everything else too).

**Escalate to an agent only when needed** (rule first, model second):

```ts
export default async function (event, ctx) {
  if (!/refund|chargeback/i.test(event.text ?? '')) return { skipped: true }
  await ctx.agent.wake({ agent: 'lead', instruction: `A refund question in ${event.chat?.title}: look at it.` })
}
```

## Agent tools

`scripts_read` (read: `list`, `view`, `versions`, `types`, `runs`, `run`) and `scripts_write`
(write: `create`, `update`, `dry_run`, `request_activation`, `run_now`, `disable`, `delete` with
`confirm: true`). Like the table tools they are for the web owner, an owner or admin in a chat,
and unattended runs; a member or guest is refused with a sentence. The agent can never approve its
own script.

## API

| Route | Does |
|---|---|
| `GET/POST /scripts` | list, create (draft, version 1) |
| `GET/PATCH/DELETE /scripts/{script}` | the script with its latest version and what activating it would widen; update (code or manifest = a new version); delete |
| `GET /scripts/{script}/versions`, `GET /scripts/{script}/versions/{n}` | versions (newest first), one with its source |
| `POST /scripts/{script}/activate`, `/approve`, `/reject`, `/disable`, `/enable` | lifecycle |
| `POST /scripts/{script}/dry-run` | `{ version?, eventId?, text?, event? }` → the run and the trigger matches |
| `POST /scripts/{script}/run` | a real run of the active version (`{ event? }`) |
| `GET /scripts/{script}/runs`, `GET /scripts/{script}/runs/{id}` | traces (`limit`, `before`, `dryRun`) |
| `GET /scripts/{script}/kv` | the script's state |
| `GET /scripts/{script}/webhook` | the secret webhook URL and whether it is live |
| `POST /hooks/scripts/{id}/{token}` | the webhook itself (no bearer token; the path token is the secret) |
| `GET /scripts-types` | the `scripts.d.ts`, the method list and the manifest JSON Schema |

Changes go to the feed as `scripts-changed` events (the web refreshes on them).

## Storage and operations

Tables `scripts`, `script_versions`, `script_runs` and `script_kv` live in the main database and
travel in the database snapshot (not in the workspace zip). Run traces are kept 30 days and at
most 500 per script by default (Settings > Data retention; pruned with the other retention jobs,
also by Settings > Storage "Apply retention now"). Settings > Limits sets how many scripts run at
once (default 4). A schedule is a system routine `sys:script:<id>` that follows the script (there
while it is active, gone when it is off or deleted); it is not listed among the agent's routines.
