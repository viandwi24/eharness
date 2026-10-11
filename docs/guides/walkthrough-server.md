# Building a multi-user agent server: a walkthrough of `examples/team`

[`examples/team`](../../examples/team) is the reference for a **web + server** harness
([ADR-0034](../decisions/0034-deployment-profiles.md)): many users, agents that outlive requests,
several instances over one database, a server that can be `SIGKILL`ed at any time. It is built
only on the public API. This guide reads it in the order you would add the pieces yourself.

For every piece you get four things: **what it does**, **where it is wired**, **why it is needed**
and **what breaks without it**. The failures listed are real ones, found while building the example
(commit messages and [ADRs 0039-0059](../decisions) have the details). Nothing here is a preset: a
real harness always needs you to understand each piece and change it. Copy the wiring, then edit it.

Prefer a single process with a terminal UI? Read the [CLI walkthrough](walkthrough-cli.md). Looking
for a short list to review before shipping? See the [production checklist](production-checklist.md).

## The request, end to end

```
browser ── POST /sessions/dm:lead/chat ──► Hono app ──► eharness/http (authorize, validate)
                                                          │
                          factory.openSession(def, id) ◄──┘   one HarnessAgent per definition version
                                      │
        lock (SQLite lease) ─► turn runs ─► messages/state saved at step boundaries (SQLite)
                                      │              │
                stream log (chunks) ◄─┘              └─► activity() plugin ─► events table
                      │                                                         │
browser ◄── SSE chat stream (or resume from any instance)       SSE /activity ─┘ ─► activity feed in the web
```

| Piece | Server file |
|---|---|
| Composition root (the only place that wires everything) | [`main.ts`](../../examples/team/server/src/main.ts) |
| Agent definition to `HarnessAgent` | [`infra/eh/agent-factory.ts`](../../examples/team/server/src/infra/eh/agent-factory.ts) |
| SQLite adapters: messages, state, lock, inbox, ledger | [`infra/eh/storage.ts`](../../examples/team/server/src/infra/eh/storage.ts) |
| Stream log adapter | [`infra/eh/stream-log.ts`](../../examples/team/server/src/infra/eh/stream-log.ts) |
| Activity store adapter | [`infra/db/activity-store.ts`](../../examples/team/server/src/infra/db/activity-store.ts) |
| Boot recovery and reconcile | [`infra/eh/team-service.ts`](../../examples/team/server/src/infra/eh/team-service.ts) |
| HTTP surface | [`infra/eh/harness-http.ts`](../../examples/team/server/src/infra/eh/harness-http.ts) |

The tables are created by drizzle migrations ([`infra/db/schema.ts`](../../examples/team/server/src/infra/db/schema.ts)),
never by the adapters. The team app also has CRUD, routines, connectors and a settings UI; those are
product, not harness, and are not covered here.

## 1. The agent definition, and where the model comes from

**What.** An agent is a database row (`AgentDef`); the factory turns it into a `HarnessAgent` with
`defineHarnessAgent`. One agent object serves every session of a definition version; the cache key
is `agentId@version@settingsRev@modelsRev@activation`
(`agentFor` in [`agent-factory.ts`](../../examples/team/server/src/infra/eh/agent-factory.ts)).

```ts
const agent = defineHarnessAgent({
  id: def.slug,
  model: deps.models.resolve(...selectionOf(def, settings)),
  settings: { maxOutputTokens: outputCapOf(modelInfoOf(def, settings).maxOutputTokens) },
  instructions: [TEAM_PREAMBLE, ...(def.role === 'lead' ? [LEAD_PLAYBOOK] : [ROLE_AGENT_NOTE]),
                 def.instructions, ...out.instructions, reminder],
  plugins, storage, budget: { ledger: ... }, recovery: { instanceId }, compaction: ..., toolOutput: ...,
})
```

Why it is shaped like this:

- **One agent per version, many sessions.** Sessions are cheap handles; agents hold plugins, MCP
  clients and caches. Editing an agent bumps its version, the next `agentFor` builds a new agent and
  open turns finish on the old one (retired agents are closed at shutdown).
- **Static instructions first, volatile text in the reminder.** The date and the team roster live in
  `reminder` with `refresh: 'turn'`, never in `instructions` (spec 02 §5). *Without it:* the prompt
  cache is invalidated every turn and cost multiplies.
- **A stable plugin and tool order** for every session of an agent (`toolOrder`, spec 02 §6;
  header of `agent-factory.ts`). *Without it:* same prompt-cache loss.
- **Models through `eharness/providers`.** [`provider.ts`](../../examples/team/server/src/infra/eh/provider.ts)
  turns a provider manager into the factory's `resolve(modelId, profileId)`; keys never leave the
  manager, secrets are sealed with a vault ([`secret-vault.ts`](../../examples/team/server/src/infra/eh/secret-vault.ts)),
  catalogs are cached in the database. `TEAM_SCRIPTED_MODEL` swaps in `scriptedModel` for tests and
  offline demos. See [providers and profiles](providers-and-profiles.md).
- **An explicit `maxOutputTokens`.** *Without it:* OpenRouter-style gateways reserve and credit-check
  the model's maximum output on every call, and calls fail on small balances
  (see `outputCapOf` in `agent-factory.ts`).

Take from it: build agents from data, key the cache by everything that changes the build, keep the
prompt prefix identical across sessions.

## 2. Storage: messages and state

**What.** `MessageAdapter` + `StateAdapter` on `bun:sqlite`
(`sqliteMessages` and `sqliteState` in [`storage.ts`](../../examples/team/server/src/infra/eh/storage.ts)). Contract:
[writing a storage adapter](writing-a-storage-adapter.md), spec 05, the `eharness/testing`
conformance suites (the example's tests run them).

```ts
const upsert = sqlite.prepare(
  `INSERT INTO eh_messages (session_id, id, role, parts, metadata, created_at) VALUES (...)
   ON CONFLICT (session_id, id) DO UPDATE ...`)
```

Why:

- **Upsert by message id.** `persistEachStep` saves the same assistant message after every step;
  an adapter that appends duplicates the reply. Message ids are UUIDv7 so a range scan on the
  primary key is also the creation order (CLAUDE.md "easy to get wrong").
- **`setIf` is one conditional statement** (compare and set on `rev`). It is how two instances
  change session state (pending approvals, active turn) without overwriting each other. Every
  read-modify-write runs in `BEGIN IMMEDIATE` so two processes on one WAL file serialize
  (header of `storage.ts`).
- **Nothing is persisted before the commit point of a turn** (spec 05 §3). The core owns that
  rule: a request that fails before it (busy, invalid, aborted) leaves storage untouched. Do not
  add your own early writes (an audit row or a "user message received" write before `send()`
  returns) or a rejected request leaves a ghost behind.

*Without a real adapter:* the default memory adapters lose every conversation and every pending
approval on restart ([getting started](getting-started.md#8-defaults-worth-knowing)).

## 3. The shared lock

**What.** `SessionLock` (spec 05 §8): at most one turn per session across all processes. The SQLite
version is a row with a lease that the holder renews every third of the lease
(`sqliteLock` in [`storage.ts`](../../examples/team/server/src/infra/eh/storage.ts)). It is passed with
`agent.session(id, { lock })` (`openSession` in [`agent-factory.ts`](../../examples/team/server/src/infra/eh/agent-factory.ts)).

```ts
const lock = sqliteLock(sqlite, {
  ...(deps.instanceId ? { owner: deps.instanceId, takeOver: true } : {}),
})
```

*Without it:* two instances (or one instance after a deploy overlap) run two turns on one session
and interleave messages. The lease means a crashed holder frees the session by itself.

`takeOver` is part of the restart story, see section 6.

## 4. The stream log

**What.** `StreamLogAdapter` (spec 04 §6.2, [ADR-0039](../decisions/0039-resumable-streams-stream-log.md)):
the chunks of a turn, appended by the instance that runs it and read by any instance that serves a
resumed stream ([`stream-log.ts`](../../examples/team/server/src/infra/eh/stream-log.ts)). It is
picked up automatically from `storage.streams` (`createStorage` in `agent-factory.ts`).

Why:

- **A reload can land on another instance.** The turn buffer is in the memory of the instance that
  runs the turn. *Without a stream log:* a client that reloads mid-turn sees nothing until the turn
  ends, because messages are stored only at step boundaries.
- **Append is idempotent by length, a gap is rejected.** The drainer retries batches; a retried
  batch must not duplicate chunks.
- **Retention (`expires_at`) bounds the table.** An expired log reads as `missing`; the client falls
  back to stored messages.
- **Continuations are replayed in full** ([ADR-0045](../decisions/0045-resume-replay-of-continuations.md)):
  a `respond()` continuation streams into an existing assistant message, so the log replays the
  whole continuation; *otherwise* AI SDK's `resumeStream()` throws `No tool invocation found for
  tool call ID` and the chat stays in error.

SQLite has no pub/sub, so readers poll (`streams.pollMs`, tuned in `AgentFactoryDeps.tuning`).

## 5. The inbox

**What.** `InboxAdapter` (spec 05 §12): the durable queue behind `enqueue`, steering, wakes and
timers, with claims, leases, retries and dead letters
(`sqliteInbox` in [`storage.ts`](../../examples/team/server/src/infra/eh/storage.ts), [multi-instance](multi-instance.md#the-inbox)).

Why:

- **Steering and queueing survive a restart and cross instances.** The chat route steers by default
  (`ifBusy: 'steer'`, section 14); a message that arrives while another instance runs the turn goes
  into the inbox, and whoever holds the session drains it. *Without an inbox:* the message is
  rejected or lost.
- **Routines and background reports are inbox items.** A routine tick calls
  `session.enqueue(prompt, { mode: 'queue', id: 'sched:<routine>:<at>', availableAt })`
  ([`routine-service.ts`](../../examples/team/server/src/infra/eh/routine-service.ts); [ADR-0040](../decisions/0040-enqueue-timers-and-ids.md)).
  The caller id makes a tick that crashed between "advance the schedule" and "enqueue" safe to
  redo. *Without the id:* a routine fires twice after a crash.
- **`claim` is one `BEGIN IMMEDIATE` transaction** so two claimers never take the same item.
- **No notify channel in SQLite**, so the holder polls (`inbox.pollMs`). Poison items go to a
  dead-letter state instead of looping forever ([poison items](multi-instance.md#poison-items)).

## 6. Recovery: surviving `SIGKILL`

This is the part most harnesses discover late. Three pieces work together.

**6a. A stable `recovery.instanceId`.**

```ts
// main.ts
instanceId: process.env.TEAM_INSTANCE_ID ?? `team-${listenPort}`,
// agent-factory.ts
recovery: { instanceId: deps.instanceId, abortPollMs: ... }
```

A running turn stores an `activeTurn` with an owner and a heartbeat. A process that restarts with
the **same** id owns what its previous run left, so the turn is recovered at the next operation.
*Without a stable id:* the owner is random per process, the restarted process sees a "live foreign"
turn until `recovery.staleMs` (120 s) passes, and "continue" answers `EH_SESSION_BUSY` for about two
minutes ([ADR-0056](../decisions/0056-restart-recovery-and-background-reconcile.md)). The id must be
unique among live instances of one database: the example derives it from the port.

**6b. Lock takeover with the same owner prefix.** The SQLite lock is created with
`owner: instanceId, takeOver: true` (`sqliteLock`): a lease whose owner starts with this
instance's id, and that this process does not hold, belongs to a dead previous run and is deleted at
once. *Without it:* the turn was recoverable but the lock lease (30 s) still said busy.

**6c. `session.recover()` at boot.** Recovery normally happens at the next user message. A server
does not want an interrupted chat to look stuck until someone types, so
[`recoverOrphans`](../../examples/team/server/src/infra/eh/team-service.ts) (in `team-service.ts`)
walks every session that can hold a turn, checks `peek(id).stats().activeTurn` and calls
`openSession(def, id).recover()`. It answers dangling tool calls with `Interrupted:` results
([ADR-0014](../decisions/0014-interrupted-tool-calls-answered.md)), closes open text parts, stores an
`eh.notice` and clears `activeTurn`.

```ts
// main.ts: boot repair, then every 60 s (any instance may run it)
const ready = connectorsReady.then(quiet, quiet)
const timer = setInterval(() => void quiet(), everyMs)
```

*Without the interrupted answer:* the provider rejects the next request because a tool call has no
result, or the model repeats a non-idempotent action it does not know it already started.
`reconcile()` is guarded to one pass at a time per instance (`repairing ??=`), because the periodic
timer and boot can overlap.

## 7. Background children and `reconcile`

**What.** The lead delegates with `subagent({ approvals: 'park', background: { default: true } })`
and role agents run as child sessions, on any instance
(the Team connector plugin in [`agent-factory.ts`](../../examples/team/server/src/infra/eh/agent-factory.ts);
[subagents](subagents.md), [ADR-0046](../decisions/0046-durable-background-subagents-in-park-mode.md)).
Every other agent gets the *child side* of the same plugin (`parentAgent`, `selfAgent`), so reports
of resumed turns find their way back. All instances must build the same plugin set.

Why park + background:

- **Park** means a child waiting for a person does not hold a process: the parent's wait is stored
  and resolved from any instance. *With `inline` approvals* the child's approval callback lives in the process, so a restart loses
  the waiting child.
- **Background** means the lead stays free to chat. *Without it* every new message to the lead
  hits `approval.onNewInput: 'deny'` and cancels the open delegations while the children keep
  running (the failure that motivated ADR-0046).
- **Limits:** `maxConcurrent` (spawn cap), `maxDepth: 1`, `childMaxTurns`, `parkTimeoutMs`,
  `backgroundTimeoutMs`. Multi-agent runs cost many times a chat.

**Reconcile** repairs what a crash leaves between "child finished" and "parent told".
`team.reconcile()` ([`team-service.ts`](../../examples/team/server/src/infra/eh/team-service.ts))
runs, in order: `recoverOrphans`, `reconcileSubagentWaits`, `reconcileBackgroundChildren`, a drift pass
for the app's own task rows, and a stranded-report pass.

*Without `reconcileBackgroundChildren`:* the report is sent by the child's `turn.end` hook, which a hard
crash never runs. A child that never started, or one waiting forever for a person, never tells the
parent, and the lead waits forever (ADR-0056). Held wakes are durable
([ADR-0054](../decisions/0054-held-wakes-while-pending.md)): *before that*, a report injected while
the lead waited for an approval, or before a restart, was stored but never woke the lead, and
nothing failed loudly.

## 8. Permissions and approvals

**What.** [`sessionPermissions`](../../examples/team/server/src/infra/eh/permission-plugin.ts) builds
one `createPermissionEngine` per live session and reads the mode on every tool call (`mode(ctx)`),
so switching mode never rebuilds an agent. Modes (Manual, Auto, Bypass), inheritance by child
sessions and per-agent ceilings are the app's policy in
[`domain/modes.ts`](../../examples/team/server/src/domain/modes.ts); rules come from connectors.
Guide: [permissions](permissions.md#three-deployment-profiles), [approvals](approvals-and-interaction.md).

What the core guarantees that you must not undermine:

- **Pending state is server-owned and consumed atomically.** A turn that needs a person stops with
  `tool-pending`; `respond()` validates the answers against the stored pending set and consumes it
  *before* any tool runs ([ADR-0012](../decisions/0012-approvals-server-owned-pending.md)). *Without
  it:* a replayed or double-clicked answer runs the tool twice, and a client can forge approvals.
- **A continuation streams into the same UI message** (`originalMessages`). *Otherwise* AI SDK
  fails with `No tool invocation found`.
- **Partial answers are recorded** ([ADR-0044](../decisions/0044-partial-resolution-of-pending-approvals.md)).
  One step can raise several approvals; a UI that answers them one at a time got `EH_INVALID_INPUT`
  on every answer and the turn stayed `tool-pending` forever (found in a real-model run).
- **A person's approval wins on re-validation** ([ADR-0055](../decisions/0055-approval-answer-wins-and-schema-valid-denials.md)):
  an approved call was re-run through the Auto classifier, a provider credit error counted as a
  block, the stored message failed validation and vanished on the next load.
- **Auto mode counters are per session** (a pause in one chat must not pause another), which is why
  the example keeps a registry of engines by session id. The classifier has its own model and
  token cap.
- **Pinned asks:** write and destructive tools of non-built-in connectors ask even in Bypass
  (`toolKinds`, `createEngine` in `agent-factory.ts`).

Answers do not go through the assistant message. The web posts them to `/attention/{id}/answer`
(section 14), which is idempotent.

## 9. Ask

`ask_user_question` is the `ask` built-in of the connectors catalog (`eharness/connectors` wires
`ask()` in `src/connectors/builtin.ts`; the team lists it in
[`connector-catalog.ts`](../../examples/team/server/src/infra/eh/connector-catalog.ts)).
In a server it is a *client tool*: the turn stops `tool-pending` with the question in the pending
state, and the answer arrives later as a tool output. The app adds one thing: a `question` answer
kind. [`parseAnswer`](../../examples/team/server/src/infra/eh/harness-http.ts) (in `harness-http.ts`)
turns `{ kind: 'question', answers }` into a tool output with `answerOutput`, and
[`team-service.ts`](../../examples/team/server/src/infra/eh/team-service.ts) reads the
questions back with `pendingQuestions` for the chat's pending dock. Guide: [ask](ask.md).
*Without a non-interactive setting* an autonomous run (a routine, a background child nobody
watches) parks on a question nobody sees; use `ask({ interactive: false })` or switch the
built-in off for those agents (see the guide).

## 10. Todos

`todos()` is the `planning` built-in ([`connector-catalog.ts`](../../examples/team/server/src/infra/eh/connector-catalog.ts)): a `todo_write` tool whose list is
stored as a data part of the message and rendered by the web ([todos](todos.md)). It is optional for
a harness, but it is the cheapest way to make long turns *visible*, and it costs nothing at the
transport level because the list is a persistent data part, not a side table. The CLI uses it too
(see the [CLI walkthrough](walkthrough-cli.md#6-todos)).

## 11. Compaction and tool output

```ts
compaction: { summarizeAt: 0.8, prune: {} },
toolOutput: { maxChars: 30_000, strategy: 'evict' },
```

- **Compaction** summarizes older turns when the context reaches 80 % of the window. It needs the
  window, so the factory sets `contextWindow` from the catalog (`agent-factory.ts`) and falls
  back to 200 000 only for unlisted models. *Without a known window:* compaction cannot trigger and
  a long chat ends in a provider "too long" error ([compaction](compaction.md)).
- **`prune: {}`** drops old tool outputs first, which is cheaper than a summary call.
- **`toolOutput` with `evict`** stores an oversized result in the virtual file system and gives the
  model a pointer, so one `cat` of a large file cannot fill the context.
- Compaction is a normal `UIMessage` of kind `eh.compaction`; the chat renders a divider and a
  "compacting" status from the transient `data-eh.status` part
  ([`create-agent-chat.svelte.ts`](../../examples/team/web/src/lib/chat/create-agent-chat.svelte.ts)).

## 12. Cost and limits

The workspace budget is a row in a shared ledger
(`sqliteBudgetLedger` in [`storage.ts`](../../examples/team/server/src/infra/eh/storage.ts)),
attached with `budget: { ledger: { adapter, scopes } }`. Reservations are all-or-nothing in one
transaction, per calendar month. *Without a shared ledger:* each instance has its own budget and the
real spend is N times the limit. Per-turn caps: `loop.maxSteps` (40 lead, 25 role),
`maxOutputTokens`, spawn cap. See [models and cost](models-and-cost.md#budgets-across-sessions).

**Bounded waits.** Nothing a turn awaits may hang it, so `build()` in `agent-factory.ts` sets the
limits explicitly (they equal the library defaults; a production app tunes them to its providers):
`hooks.timeoutMs` (30 s, an awaited hook that stalls is a `W_HOOK_TIMEOUT`),
`settings.timeout` with `firstChunkMs` / `chunkMs` of 120 s (a model stream that goes silent fails
the step), `toolSources` with `timeoutMs` 30 s and `retryAfterMs` 5 s (a down MCP server costs one
timeout, then backs off instead of failing every turn), and `timeoutMs: 15_000` on every remote MCP
source (`EH_MCP_TIMEOUT`). The Auto classifier gets `maxCallChars`, so an action longer than the
judge reads in full asks a person instead of being judged on a cut-off input. The app uses
permissions Auto mode only, not the approval guard, so there is no second judge to share a model
with ([LLM judge](llm-judge.md#combining-both)); if you add `guard()`, give it the classifier's
model instance and the same limits so one call answers both.

**Observability.** `config.observe` is wired to [`observe.ts`](../../examples/team/server/src/infra/eh/observe.ts):
a cheap synchronous adapter that logs a span only when it is slow or failed (model calls and tool
runs have their own, longer threshold), logs every `hook.timeout` / `tool-source.backoff` counter
and keeps failure counts in memory (`server.metrics()`). `warnings.dedupeWindowMs` prints a repeated
warning once a minute with a repeat count. See [observability](observability.md) for an
OpenTelemetry bridge in place of the Map.

## 13. The activity feed

**What.** `eharness/activity` ([ADR-0058](../decisions/0058-activity-feed-and-attention-queue.md),
spec 25): an `activity()` plugin that writes session events to an `ActivityStore`
(`turn-started`, `message-saved`, `pending-changed`, `approval-decided`, `child-reported`, ...; the team turns the library's `message-saved` off with `messages: false` and writes its own `message-added` events), and
SSE helpers that tail it. The team's store is the `events` table
([`activity-store.ts`](../../examples/team/server/src/infra/db/activity-store.ts)); the app appends
its own types (`providers-changed`, `task-changed`) to the same log through
[`event-appender.ts`](../../examples/team/server/src/infra/eh/event-appender.ts).

```ts
activity({ store: deps.activityStore, agentOf: (slug) => ..., types: SESSION_EVENT_TYPES, messages: false })
```

Why a feed, not polling: a web app needs to know "an agent finished", "something needs me", "a
routine started a turn" without refetching everything. Why it is shaped this way:

- **Events are hints, sessions are truth.** `pending-changed` carries a *snapshot* (`waiting`), not
  a diff, because a hook on instance B does not know the previous state. A consumer that misses
  events refetches.
- **Retention is a prefix prune.** `prune()` removes the oldest rows, never the newest, and keeps a
  monotonic `prunedThrough`; `keepLatestOf: [{ type: 'message-added', by: 'agentId' }]` keeps the
  last message of every agent for the sidebar preview (`pruneEvents` in `main.ts`). A client with a cursor
  below `prunedThrough` gets one `resync` event and refetches. *Without a retention policy* the
  table grows without bound; *with a naive one* clients silently miss events.
- **The store must be atomic across processes.** `seq` is `AUTOINCREMENT` so it is never reused;
  `append` is a transaction. The library's `activityStoreConformance` runs against this adapter.
- **A boot id on the stream.** The first frame carries `bootId`; a client that sees a new one knows
  the server restarted and refetches (section 15).
- **The keep-alive is 8 s by default** (`keepAliveMs`). `Bun.serve` closes a socket after 10 s
  without bytes, so a longer keep-alive would drop a quiet feed and force a full resync every 10 s
  (see section 16).

## 14. `eharness/http`

**What.** [`harness-http.ts`](../../examples/team/server/src/infra/eh/harness-http.ts) is the whole
HTTP use of the library: `createHarnessHttp` returns a `fetch` handler (chat with resume,
steering and interrupt; session reads; attention list and answers; the activity feed) that
[`http/app.ts`](../../examples/team/server/src/http/app.ts) mounts on Hono with
`app.route('/', harnessRoutes(...))`. Guide: [HTTP server](http-server.md), spec 26.

The hooks, in the order a request meets them:

1. **`authorize`** runs first, before the body is read or a session is opened, and returns a
   principal object or a denial. It fails closed: any other result (`undefined`, a string) is a
   `401 EH_HTTP_UNAUTHORIZED`. *Without it* there is no access control; the option is required
   (`openAccess` exists for local development and is unsafe).
2. **`maxBodyBytes`** is enforced by the module on the stream. Chat attachments are base64 data
   URLs, so the limit is 16 MB (`body-limit.ts`).
3. **`chat.authorizeKind`** applies product rules after the request is classified: a task
   session is refused (its messages go through the task route), an archived agent is read-only.
4. **`chat.validate`** checks the attachments (`library:` references against the upload
   store) after the library sanitised the body. The library keeps only the last user message, only
   `text` and `file` parts, no client `metadata`, accepts only `data:` URLs in file parts unless
   `chat.allowFileUrls` says otherwise (the team allows its own `library:` references, never
   client-chosen http URLs, which would be SSRF), and never reads `actor`, `runtime`, `model` or
   `maxSteps` from the body. *Do not undo that.* Trusting client messages is how a user forges an
   assistant message or approval.
   **Attachments in practice** (checked with a real vision model): PNG, PDF and CSV reach the
   model as bytes (`inputFiles.resolve` turns the stored `library:` reference into data at
   projection time) and a reload shows the same file parts; the web fetches the bytes with the
   token for the thumbnail (`<img>` cannot send the bearer header). Limits: 10 MB and the media
   type allowlist, with a readable `400`.
   **The model can name and pass on an attachment.** `inputFiles.describe` adds a short note after
   each uploaded file of a user message (`[Attachment photo.png (image/png) at path
   "/uploads/…"…]`, projection only, never stored), and the lead's `subagent({ files: { resolve } })`
   gives the `agent` tool a `files` argument: the path becomes a file part of the role agent's
   first message (`resolveDelegatedFile` checks that it is an existing upload, at most 10 MB and an
   allowed type, and answers with a readable `ERROR:` otherwise; no child starts). An employee's
   photo or PDF therefore reaches the specialist the lead delegates to, from the web today and from
   any later channel that stores the upload the same way. A resumed child (`send_message`) takes
   text only. **Queued tasks** (`create_task`) carry `inputs`: library
   paths, which an upload is (`/uploads/…`). The worker run (`program-service.ts`, `inputFiles`)
   attaches each image or PDF upload among them as a file part of the run's first message (same
   rules: under /uploads, allowed type, at most 10 MB; a failing input stays a path in the prompt).
   Text-like inputs stay paths the worker reads with the library tools.
   **A model that cannot read the file is caught early.** When the catalog knows the model's input
   modalities (`modelsDevCatalog` / `openRouterCatalog` fill `inputModalities`), an image or PDF
   sent to a model without that input is refused before anything is stored with `EH_INVALID_INPUT`
   (`reason: 'unsupported-modality'`) and a message that names the model and the fix (pick a model
   with image input). Input nobody waits on (a channel message through `enqueue` + `collect`, a steer)
   is accepted instead: the text is kept and the model sees a note in place of the file. The same
   note replaces such a file in the history of a session after a model switch (storage keeps the
   file), so one image never breaks the following turns. An unknown model is never blocked: the
   provider's own error is the notice.
   **A failed provider call** leaves an empty assistant message next to the `eh.notice` on purpose
   (spec 05 §3: the stream already announced its id); a UI should skip assistant messages without a
   visible part.
5. **`session` and `peek`** map a session id to the agent that runs it.
   `peek` is a pure read with no `session.start` hooks, and must go through the agent that runs the
   session so `busy()` can tell a turn of this process from another instance's. *If reads open real
   sessions:* every page load fires start hooks and can resume work.
6. **`ifBusy: ['reject', 'steer']`, default `steer`**: a message sent while a turn runs joins it.
   The idempotency key (`Idempotency-Key` or the user message id) makes a retried send a `409
   EH_HTTP_DUPLICATE_REQUEST` instead of a second turn.
7. **`attention`**: `roots` says which sessions an answer may touch (the lead's DM and its
   children), `canAnswer` is the one-owner policy (`() => true`, explicit), `decorate` adds the
   app's view data (agent name, task title), `parseAnswer` adds the `question` kind, and
   `onSettled` wakes the lead after its own approval or question continuation ended
   (`result.stop === 'complete'`). *Without `onSettled`* reports that arrived meanwhile with no held
   wake (stored before a restart) wait until the next user message.
   Answers are idempotent: statuses `resumed | recorded | already-answered | not-found` are results,
   not errors, so a double click is quiet instead of a 404.
8. **`onError` / `onFailure`**: `onError` maps the app's `DomainError` to a status; 5xx answers carry
   generic text and the real error goes to `onFailure`.

**Turn errors have a code.** `TurnResult.error.code` is always set. The app maps what matters:
`EH_PROVIDER_AUTH` answers 502 with the fix ("set the API key in Settings > Providers") and a
failed routine run or task carries the same hint (`routine-service.ts`, `task-index.ts`);
`EH_LOCK_UNAVAILABLE` is a 503 "storage unavailable" and a routine run it fails does not count
toward pausing the routine (the lock service was down, not the routine); everything else keeps the
server's text. `authorize` returns an object principal (`OWNER`), never a bare boolean, and
`chat.allowFileUrls` accepts only the app's `library:` references.

## 15. `eharness/client` in the Svelte web

The web is only a UI ([`examples/team/web`](../../examples/team/web)). It uses three pieces of
`eharness/client` ([web client](web-client.md), spec 27):

**The client.** [`api/index.ts`](../../examples/team/web/src/lib/api/index.ts) creates one
`createHarnessClient({ baseUrl, headers })`; the token is read per request.

**The chat session.** [`create-agent-chat.svelte.ts`](../../examples/team/web/src/lib/chat/create-agent-chat.svelte.ts)
wraps `@ai-sdk/svelte`'s `Chat` with `createChatSession`: history paging, re-attaching to a running
turn after reload (`follow()`), steering, and recovery (`interruptedTurn`, `continueTurn`,
`retryTurn`). *Without it* each app rewrites a reload handler, a stalled-stream watchdog and a
"the server restarted" path. Note the comment: approvals and questions are answered through
`/attention`, so there is no `sendAutomaticallyWhen`.

**The activity feed.** [`stores/live.svelte.ts`](../../examples/team/web/src/lib/stores/live.svelte.ts)
starts one `createActivityFeed` per tab. `onResync` refetches everything; `isBusy` pings `/health`
while something runs so a killed server is noticed at once; `check()` runs on `focus`, `online` and
`visibilitychange` because a sleeping tab may have missed a restart. The status
(`live | polling | unauthorized | ...`) drives a "Reconnecting" bar; `unauthorized` is terminal (the
server answered 401/403, retrying cannot help) and says to set the token. In the chat,
`ChatSessionState.stopping` disables the stop button and shows "Stopping…" until the server confirms
the stop, and the stored `metadata.eharness.error.code` of the last turn turns `EH_PROVIDER_AUTH`
into the "set your API key" hint ([`chat/errors.ts`](../../examples/team/web/src/lib/chat/errors.ts)).

**The attention list.** [`stores/live-core.ts`](../../examples/team/web/src/lib/stores/live-core.ts)
uses `createAttentionList` with the app's own `list` source (an enriched `/approvals`), the app's
extra event (`task-changed`) and the app's `question` answer kind. It gives optimistic answers, a
generation guard against stale refetches and a debounce. The app answers only inline in the
session's chat (DM or task view); the notification bell and the tasks board only link to the
session that holds the pending item. The task session view uses `followSessionStream` ([`SessionView.svelte`](../../examples/team/web/src/lib/components/app/SessionView.svelte);
merge logic in [`tasks/follow.ts`](../../examples/team/web/src/lib/tasks/follow.ts)) to merge the
live stream of a child with stored messages.

*Without the client module:* about 2 600 lines of SSE parsing, liveness checks, chat bridging and
optimistic lists, each with edge cases the library already handles.

## 16. `Bun.serve` and `idleTimeout: 0`

```ts
// main.ts: Bun closes a connection after 10 s without bytes by default
const http = Bun.serve({ port, idleTimeout: 0, fetch: server.app.fetch })
```

A chat stream is silent while a long tool runs. *With Bun's default:* the stream is cut at 10 s,
the client sees a failed turn although the server finished it, and the user reloads into a resumed
stream. The activity stream keeps itself alive (8 s); chat streams do not, so raise the idle timeout
of **every hop** (Bun, load balancer, reverse proxy) above your longest silent tool call. On Node the
adapter must stream, forward `res.on('close')` as an abort and not buffer `text/event-stream`
([HTTP server](http-server.md#mounting)).

Also in `main.ts`: `SIGINT`/`SIGTERM` call `http.stop()` then `server.close()` (closes agents,
timers, MCP clients). Graceful close is a courtesy; sections 6 and 7 are what make a hard kill safe.

## 17. Verify it like the example does

[`examples/team/scripts`](../../examples/team/scripts) run real processes: `two-instances.ts` (two
servers on one database, kill one while a delegated task waits for approval, answer on the other)
and `kill-restart.ts` (SIGKILL a turn mid-stream, restart, and check the recovery; it ages the heartbeat and lease with SQL to stay fast, `--wait-stale` really waits). A conformance suite proves an
adapter; only a kill proves your recovery wiring. See [testing](testing.md). The server's own
tests run with `debug: { invariants: true }` (`TEAM_DEBUG_INVARIANTS=1`, set by
`server/bunfig.toml`'s preload): the core never infers it from `NODE_ENV`, so a test setup that
relied on it must say so.

## 18. Programs: standing orders with enforced authority

**What.** A *program* ([`domain/programs.ts`](../../examples/team/server/src/domain/programs.ts))
is what a client tells an agent once: a brief, the **authority** it may use (tools or permission
rules, connectors, library paths to read and write), `forbidden` rules, `gates` (what still needs a
person), a budget (per run, per day), a trigger (manual or a schedule) and where the result goes.
Every run is a task session `program:<programId>:<runAt>` owned by the program's agent, indexed by
the same `taskIndex` plugin as every other task (origin `program`), so it shows on the board.
The session is the only building block: DM chats, delegated tasks, routine runs and program runs
differ in policy only, and that policy is one table, the
[run profiles](../../examples/team/server/src/domain/run-profiles.ts) (permission source, whether it
is unattended, where the result goes, which budget scopes it spends from), read from the id of the
session.

**Authority is enforced by the engine, not by the prompt.** The run prompt tells the agent its
authority, but the permission plugin does the refusing:

1. [`sessionPermissions`](../../examples/team/server/src/infra/eh/permission-plugin.ts) asks the
   factory for a *gate* of the session id (`gateOf` in `agent-factory.ts`). A program session gets
   an engine in **`dontAsk`** with the allow rules derived from the authority (`programRules`:
   `Read(glob)`, `Edit(glob)`, tool names, every tool of a granted connector) and the program's
   `forbidden` list added to the **deny rules** (spec 18: deny wins in every mode). A glob ending
   in `/**` also grants the directory itself (a gitignore-style `dir/**` does not match `dir`), so
   `list_files`, `glob` and `grep` on a granted directory work.
2. `dontAsk` alone is not a closed world: reads, `agent` and `safe` tools are approved by their
   kind, so a run could read any library file. The gate adds the closed-world check with the
   library's `matchRule` (allow polarity): a call is approved only when an allow rule of the
   authority matches it. The plugin's `tool.approve` hook runs the gate first, then the engine's
   own verdict; most restrictive wins, like the core's chain (spec 11 section 3).
3. A refusal is a **denial with a reason the model reads** ("Outside the authority of program ...
   Do not retry; call `request_authority`, or finish inside your authority", section 19), never an
   approval request: a background run has nobody to ask. A forbidden call says "Forbidden by
   program ... matches the rule ...". The connectors' own *ask* rules are dropped for a run (the
   client granted these tools to the program); tools **pinned to ask** (writes of third-party
   connectors) stay pinned and are refused: they are gates. A deleted program leaves a session
   that can be read but not act (empty authority).

The authority is read from the program on every tool call (`gate.sync` adds rules the program
gained since the session opened to the live engine, `refuse` reads it fresh), not frozen when the
session opens: an edit applies to a run in progress from its next call, and an amendment approved
in the Decision Center (section 19) reaches the run that asked, also after a restart.

**Budget** goes through the ledger of section 12: the session's `budget.ledger.scopes` adds
`program-run:<sessionId>` (limit `perRunUsd`) and `program:<programId>:<YYYY-MM-DD>` (limit
`perDayUsd`). The core reserves on every step, and a refused reservation ends the run with
`cost-cap` before the next model call; the task shows it as failed with the reason. (A per-run
`maxSessionUsd` is an option of the agent, not of a session; the ledger scope is the per-session
mechanism.)

**The run** starts with a turn whose text is the brief, the authority, the gates, the escalation
and the **Execute, Verify, Report** rule (retry once with an adjusted approach, at most 3 attempts,
then report the failure with a diagnosis; never fail silently). The turn carries
`SendOptions.output`, so the run ends with a typed report
`{ status: done | partial | failed | needs_decision, summary, outputs: string[], notes? }`.
The `taskIndex` plugin reads `TurnResult.output` on `turn.end` and stores it on the task row
(`summary` = the report summary; a `failed` report, `output-invalid` or `cost-cap` make the task
`failed`). Why not the durable inbox the routines use: an inbox item cannot carry `output` (the
spec is not serializable), so
[`program-service.ts`](../../examples/team/server/src/infra/eh/program-service.ts) calls
`session.send`. The cost: a process that dies mid-run leaves an `interrupted` task (crash recovery
and the drift pass handle it) instead of another instance resuming it.

**Schedule trigger = a routine.** A program with a schedule owns one `routines` row
(`routines.program_id`, hidden from the Routines page). The routine service keeps its claim,
overlap, missed-slot, recovery and failure rules; the only change is `dispatch`: for a program's
routine it calls the program runner instead of `session.enqueue`, and `routineSessionId` is
`program:<id>:<slot>`. The outcome of a run (including a `failed` report) reaches the routine
run through the same `routineOutcomes` plugin, so repeated failures pause the schedule. Pausing the
program pauses the routine. **Run now** starts a run directly (one at a time per program, `409
PROGRAM_BUSY`); the run history of a program is its tasks.

**What a run gets that its agent does not have (real-model pass).** Three traps showed up the
first time a real model ran programs, each with a team-level fix and none in the library:

- *File tools.* The Files connector of an agent can have Edit switched off for chats. A program that
  grants write paths would then never get `write_file`, and `request_authority` cannot help (the
  tool does not exist, so it is not an authority question). The files plugin now always defines the
  read and write tools (`connector-catalog.ts`; an agent with no Files connection gets a bare
  `filesystem` plugin with them), and the [`fileGrant`](../../examples/team/server/src/infra/eh/file-grant-plugin.ts)
  plugin narrows `activeTools` per step: every session sees what its connector offers, a program
  run also the tools its authority grants (`runFileTools`: write paths give write and read tools,
  read paths the read tools, naming a tool gives that tool; never `delete_file`). The connector's
  own deny rule is dropped for a run, the closed-world gate decides, and it still limits each call
  to the granted paths. *Without it:* a manager grants `/library/reports/**` and the worker answers
  "I have no write tool" forever.
- *The budget floor.* Every model call reserves its worst case (context plus the output cap at the
  model price) against the run and the day scopes before it runs (section 12). With the agent-wide
  32k output cap that is about $0.04 on a cheap model, so a $0.02 per-run budget failed with $0
  spent. A program run now passes `settings.maxOutputTokens` per turn
  (`factory.programTurn`, for the first turn and for the continuation after a decision):
  `budget.maxOutputTokens` when the program sets it, else a cap sized so one call reserves about half
  of the smallest budget (2 048 to 16 384, never above the model limit; `programMaxOutputTokens`).
  The editor warns when a budget is still below one call (`POST /programs/check`, `budgetWarnings`).
  The `cost-cap` failure text says that the stop is a reservation, not spend.
- *Tools that cannot exist.* A program whose authority lists `channel_send` or `channel_manage` while
  its agent is bound to no channel connection used to loop "running": the tool never exists. The
  same check that warns in the editor (`toolWarnings`, over `factory.toolAvailability`) now makes the
  run fail before its first model call (`409 PROGRAM_UNRUNNABLE`, a failed task with the reason; a
  worker run claims nothing), and `request_authority` for a tool the run can never have returns the
  reason to the model instead of parking (a `superRefine` on the tool input, so the run is not parked
  and no decision is opened).

*Without the gate:* a program run in `dontAsk` could read everything and an MCP tool outside the
authority would only be "not allowed by mode", with the generic reason; the agent could not tell
that it should report instead of retrying. *Without `dontAsk`:* the first out-of-authority write of
a 3 a.m. run parks on an approval nobody answers.

## 19. Decision Center: proposals, escalations and amendments

**What.** Some things only the client can settle. They live in one table, `decisions`
([`domain/decisions.ts`](../../examples/team/server/src/domain/decisions.ts),
[`app/decisions.ts`](../../examples/team/server/src/app/decisions.ts)), three kinds:

| Kind | Who creates it | Parks the session | Approving does |
|---|---|---|---|
| `proposal` | `propose_plan` (DM chats, heartbeat) | no | creates the program with exactly the proposed authority (the client may edit it first); a one-off (`runOnce`) is created with a manual trigger and run once |
| `escalation` | `escalate` (program and routine runs; never the heartbeat) | yes | resumes the same session with `{ decision, note }` as the tool output (`decision` is `approved`, `rejected` or the option picked) |
| `amendment` | `request_authority` (program runs) | yes | adds the authority to the program, then resumes the run like an escalation |

Tool approvals are **not** decisions: they stay inline in the chat of their session (P40 D2).

**The park is eharness' external wait** (spec 11 section 4.2), nothing app-specific.
[`escalate` and `request_authority`](../../examples/team/server/src/infra/eh/decisions-plugin.ts)
are `externalTool()`s: tools without `execute`. At step end the turn stops `tool-pending` and the
pending state (with the wait id `w_<toolCallId>`) is committed to the session's stored state, so
the park holds no process. Only then does the tool's `start` run (inside the turn): it stores the
decision row with `wait_id` (idempotent by wait id: a redispatch after a crash finds the row).
Deciding goes through [`decision-service.ts`](../../examples/team/server/src/infra/eh/decision-service.ts):
`factory.openSession(agent, sessionId).resolveWait(waitId, { output: { decision, note } })`. That
works in any instance and after a restart (the state is in storage), retries `EH_SESSION_BUSY` for a
moment (the turn that parked is still ending), and continues the **same** assistant message: the
parked tool part becomes `output-available` with the decision. A program run continues with its
report spec passed again (`output` is not carried over a `tool-pending` stop, spec 05 section 3.3),
so the resumed run still ends with a typed report on the same task, and with the program step limit
(`maxSteps`: a new turn would otherwise get the agent default and cut a long run short). When the
resumed run ends its deliverables are checked, with the same fix-up turn as a run that never
parked (`programs.verifyResumed`). `resolveWait` answering
`not-pending` (the run was stopped, deleted) makes the decision `expired`, `409 DECISION_EXPIRED`.
Don't return a `correlationId` from `start`: the child side of the subagent plugin reads the
correlation id of *any* external wait as a child session id when a session opens.

**Deciding is a compare-and-set** on `status = 'open'` (the first answer wins, `409
DECISION_CLOSED`), then the effect; a failed effect opens the decision again, so nothing is half
decided. An approved proposal records the program it created (`programId`) and the run it started
(`outcome.runSessionId`).

**Amendments reach the running session.** The gate of section 18 reads the program on every call,
so widening the program is enough: the resumed run (this process or a restarted one) can use the new
authority on its next tool call. The refusal text and the run prompt tell the agent to call
`request_authority` (name what and why) instead of failing.

**A report that says `needs_decision`** and was not preceded by an escalation becomes an escalation
automatically (the `decisions` plugin's `turn.end` hook; one open decision per session). It has no
wait: the answer is sent to the finished session as a new message (`session.send`) and the run
continues from there.

**API and UI.** `GET /decisions` (filters: status, kind, agentId), `GET /decisions/{id}`, `POST
/decisions/{id}/approve` (`note`, `choice`, `edit` for a proposal, a narrower `authority` for an
amendment) and `/reject` (`note`); every change is a `decision-changed` event (with the open
count). The web has a Decisions page (cards grouped by kind: the asking agent, the source chat or
run, the plan as markdown, the authority it grants as a list, budget, Approve, Edit and approve,
Reject with a note, option buttons), a badge on the rail, and a general line per open decision in
the notification bell that only links to the page.

*Without the park:* a run that needs a decision would have to fail or guess, and the client's
answer would start a new run with none of the context. *Without deciding in storage:* the answer
could only reach a run in the process that asked.

## 20. Big data: chunked work

**What.** A program that audits thousands of messages a day cannot read them: the context would
fill after a few hundred. The team example gives the agent a small toolkit and a pattern (the
generic version is [chunked work](chunked-work.md)); the pieces are in
[`infra/bigdata`](../../examples/team/server/src/infra/bigdata) and the pure parts in
[`domain/collectors.ts`](../../examples/team/server/src/domain/collectors.ts) and
[`domain/manifest.ts`](../../examples/team/server/src/domain/manifest.ts).

1. **Ingest, no model.** A `Collector { id, poll(cursor) -> { items, cursor } }` is the only thing a
   source implements (a Telegram or Slack MCP source later; today a seeded fixture of a 5 000-message
   community day). `ingestSource` pulls pages and appends them to the library as
   `/library/data/<source>/<channel>/<YYYY-MM-DD>/<HH>.jsonl`, then moves the cursor, which is a
   library file (`_cursor.json`, versioned like any file). It is at-least-once and idempotent: files
   are stored before the cursor moves, and an item whose id is already in the file is not added again,
   so a crash between the two repeats a page without duplicates. *Where it runs:* as the tool
   `ingest_source`, in a program run whose authority names it and the write path of the source. The
   alternative, a scheduled non-model job, would need its own scheduler, its own authority and its
   own run history; a program already has all three, the call costs a few tokens (the result is one
   summary line) and the same function can be wired to a timer later.
2. **`run_code`.** Sandboxed JavaScript for everything that touches many items. The run gets a
   private scratch directory that holds only the library paths the model listed in `reads` **and the
   program may read** (checked with the same `matchRule` the engine uses, so `forbidden` and
   amendments apply); the code reads and writes them through small globals (`readJsonl`,
   `readJsonlDir`, `writeJson`, `chunkBySize`, `print`, ...). After a successful run, the files it
   created or changed go back to the library **only where the program may write**; the rest are
   reported as "NOT saved". A failed or timed-out run saves nothing. The result is stdout (capped at
   12 KB, the run is stopped past it) plus a list of what was saved.
   [`code-sandbox.ts`](../../examples/team/server/src/infra/bigdata/code-sandbox.ts) runs Bun through
   `eharness/shell`'s `localSandbox({ os: { enabled: true, network: false } })`: Seatbelt on macOS,
   bubblewrap on Linux. Without the platform tool it falls back to the same limits, a stripped
   environment and a soft network guard (or refuses, with `requireOsSandbox`). Limits: 30 s (at most
   120), CPU time (`ulimit -t`), file size (`ulimit -f`), 600 files and 32 MB in, 400 files and 16 MB
   out, capped output. Memory is not limited, and the library's OS sandbox restricts writes and the
   network, not reads of the host: for hostile code use a container.
3. **Manifest.** `/library/work/<run>/manifest.json` lists the chunks and their status. Tools:
   `manifest_create` (from a list or a directory of chunk files), `manifest_next`, `manifest_mark`,
   `manifest_status`. A chunk can be marked `done` only when its findings file exists and is valid
   JSON, so "done" always means "saved". Marks are compare-and-set on the file version, so parallel
   subagents can mark at once. `failed` counts an attempt (3 at most). A run that stops resumes:
   the next run calls `manifest_status`, sees the same manifest (the run id is per job and day) and
   carries on with the chunks that are not done.
4. **The skill.** [`chunked-audit`](../../examples/team/server/src/domain/builtin-skills.ts) is a
   library skill (`/skills/chunked-audit/SKILL.md`, seeded once, editable) that teaches the order:
   resume first, pre-filter with code, one small chunk at a time, findings per chunk, reduce with
   code, one report, escalate what is severe (`escalate`, section 19). An agent gets it through its
   `skills` list.

**Wiring.** The tools are the **Data work** connector (id `bigdata`, off for everyone until an agent
or program switches it on; `connectors: ['bigdata']` in a program's authority grants all its
tools). It is activated through a hook like the Team connector, so the plugin sees the program of
the session on every call. A session that is not a program run has no authority and the tools say
so. A program run may now take up to 150 steps (`PROGRAM_RUN_MAX_STEPS`): a chunked job is many
small steps, a chat turn's 25 are not enough.

**Test it.** [`bigdata-audit.test.ts`](../../examples/team/server/test/bigdata-audit.test.ts) runs the
auditor on the 5 000-message fixture with a scripted model that plays the auditor: it finds every
planted incident (spam bursts, a join raid, a moderator deleting and bullying one member, a role
given to a brand-new account), and the test measures what the model was shown (the biggest tool
result is under 16 KB, the model saw under 10% of the messages). A second test kills the run after
six chunks, restarts the server on the same database and checks the next run reads only the
remaining chunks. `bigdata.test.ts` covers the fixture, ingest, manifest and the sandbox.

*Without the manifest:* a run that stops starts over, and pays for the same chunks again.
*Without `run_code`:* the model is the filter, and thousands of lines cost more than the answer is
worth. *Without the authority check on `reads`:* a read-only program's code could copy any library
file into its reports.

## 21. Work queue: tasks that wait for a worker

**What.** The board can hold work that has not started. A **queued task** is a row of the task
board with an owner agent, a brief (markdown), inputs (library paths), a priority, an optional due
date and who wrote it (`client` or an agent id), but no session yet. A **worker program** takes
queued tasks, works each in a session of its own and moves it to **Review**, where the client
accepts it or sends it back with a note. Board columns: Queued, Running, Waiting for you, Review,
Done / Failed. This is how the writer drafts a script per video and the researcher works through
research items without anyone starting each one.

**Where.** [`domain/work-queue.ts`](../../examples/team/server/src/domain/work-queue.ts) (validation,
feedback text, the run prompt of a task), [`domain/tasks.ts`](../../examples/team/server/src/domain/tasks.ts)
(`queued` status, `boardColumn`, `inReview`), [`app/work-queue.ts`](../../examples/team/server/src/app/work-queue.ts)
(use cases), [`infra/db/tasks-repo.ts`](../../examples/team/server/src/infra/db/tasks-repo.ts)
(atomic claim), [`infra/eh/work-queue-plugin.ts`](../../examples/team/server/src/infra/eh/work-queue-plugin.ts)
(tools) and [`infra/eh/program-service.ts`](../../examples/team/server/src/infra/eh/program-service.ts)
(the worker run). Migration `0017` adds the task columns and `programs.worker`.

1. **A task before its session.** `tasks.session_id` is unique and required, so a queued task holds
   the placeholder `queued:<id>`; claiming replaces it with the real session id. Tasks that did
   not come through the queue have `createdBy = null` and never wait in Review.
2. **Making them.** The client uses the *New task* dialog (`POST /tasks`). A manager agent uses
   `create_task`, `list_tasks` and `update_task` (re-prioritise, reassign, rewrite, cancel, only
   while queued). The lead has them in its DM chat and the heartbeat; a program run is offered a
   manager tool only when its authority names it (the permission engine of a run is closed-world
   anyway). `LEAD_PLAYBOOK` tells the lead to read the board before it queues anything.
3. **The worker program.** `worker: { maxTasks }` on a program (the *Work queue* box of the program
   form). Each run claims the next queued task of its agent (priority, nearest due date, oldest) in
   **code**, not by asking the model, and runs it; then the next, up to `maxTasks`. A run with
   nothing queued does nothing (a scheduled slot is skipped with "no queued tasks"; *Run now*
   answers `idle: true`). The program is the standing instruction ("write the script of the task you
   are given"); the task is the work. Schedules are ordinary program triggers.
4. **One session per task.** The first task of a run has the session of the run
   (`program:<id>:<runAt>`), the next ones the same shape a millisecond later, so authority, budget
   (per task, plus the program's day scope), run history and the routine's run row work unchanged.
   Each task keeps its own chat, report and cost on the board. The alternative (one session for
   the whole run, working the tasks in turn) makes one chat and one report cover several items,
   fills the context with unrelated work, and cannot tell which task a failure belongs to.
5. **Atomic claim.** `claimNext` selects and updates in one `BEGIN IMMEDIATE` transaction guarded by
   `state = 'queued'`, so two runs (two programs, two instances) never take the same task. The
   next task is claimed only when the previous one ended, so a run that stops holds nothing back.
6. **Finishing.** The worker calls `complete_task({ summary, outputs })`: every output must exist
   in the library (the tool answers with the missing paths otherwise), then gives its final report.
   A `done` or `partial` report on a work item the client has not accepted is **Review**.
   *Accept* sets `acceptedAt`. *Send back* (`POST /tasks/{id}/send-back`, a note is required)
   queues it again: the note is appended to the brief under "Feedback from the client (round N)",
   and the next run revises it in a fresh session (the earlier ones stay in `history`). The same
   call retries a work item that failed or was stopped.
7. **Waiting for you.** A task is in that column when an approval or question waits, or when an
   open decision names its session (a run parked on `escalate` still shows `running`). The web
   joins the task list with the open decisions it already holds.

**Test it.** [`work-queue.test.ts`](../../examples/team/server/test/work-queue.test.ts): the writer
drafts a script per queued title, each task goes to Review, a note sends one back and the next run
revises it; the manager queues tasks from its DM; the researcher takes research items one run at a
time; an escalation shows as Waiting for you; two worker runs at once and two database handles
never take the same task; a scheduled worker skips an empty queue.

*Without the claim transaction:* two workers can start the same task twice and pay for it twice.
*Without Review:* "done" is the agent's word, and the client finds out when the video is wrong.

## 22. Heartbeat and daily digest

The ambient layer (P40 phase E): an agent that keeps an eye on the team without talking, and one
short message a day. Code: [`domain/heartbeat.ts`](../../examples/team/server/src/domain/heartbeat.ts)
(pure rules), [`app/heartbeat.ts`](../../examples/team/server/src/app/heartbeat.ts) (use cases),
[`infra/eh/heartbeat-service.ts`](../../examples/team/server/src/infra/eh/heartbeat-service.ts) and
[`heartbeat-plugin.ts`](../../examples/team/server/src/infra/eh/heartbeat-plugin.ts).

**One session, one profile.** A beat is a turn of the rolling session `heartbeat:<agentId>` (the run
profile row that already existed). Compaction keeps it small. It is unattended and read-only: the
permission gate has one fixed authority (base tools, `team_status`, `propose_plan`,
`list_tasks`, `Read(/library/**)`); anything else is refused with a reason the model reads. It does
not feed memory and it is not a task on the board.

**Woken by a routine.** Each enabled heartbeat owns a routine row whose `program_id` is
`sys:heartbeat:<agentId>` (the digest: `sys:digest`, a cron at the digest time). They are not listed
as routines and emit no routine events; the routine service hands their fire to the heartbeat
runner. So claiming, recovery of a claimed-but-unstarted fire and "a second instance cannot fire the
same slot" come for free, and the beat id is the slot, so a recovered fire is the same beat. Config,
beat history, fingerprints and the digest buffer are JSON rows in the existing `settings` table
(`heartbeat:<agentId>:config|state`, `digest:config|state`): no migration.

**Cheap by construction.** Before any model call a beat can be skipped, and the skip is recorded
(identical skips collapse into one history row): the agent's heartbeat is off, outside the active
hours (HH:MM window in an IANA timezone, may wrap midnight), the checklist
`/memories/agents/<id>/HEARTBEAT.md` is empty (only headings, comments, bare list markers), the
previous beat still runs. The heartbeat never parks (it has no `escalate`): urgent things go to the
lead's DM at once, a pattern becomes a proposal through `propose_plan`. Default: on for the lead
only, every 30 minutes, 08:00-20:00 in the **team timezone** (a workspace setting, `Settings`;
default the `TZ` variable or the host timezone; a heartbeat may set its own, `null` follows the team).

**The server observes, the model judges.** `team_status` returns what `observe()` computes
deterministically: stuck, failed and long-waiting tasks, open decisions older than a day, programs
that fail or paused themselves, failing routines, connectors that need sign-in, the budget (80 % /
95 %), and program suggestions. A finding carries a fingerprint; ones already reported inside the
window (24 h, 14 days for suggestions) are not listed again, so a persisting problem returns once a
day. A suggestion needs at least three similar requests in 14 days (word-overlap clusters over the
client's DM messages and the tasks the client made), and none if a program or open proposal already
covers it. Only then may the model call `propose_plan`; nothing is created without the client.

**Silent by default.** The beat ends with a structured result
`{ status: 'ok' | 'attention', items: [{ kind, title, detail, links, urgent, fingerprint }] }`
(`SendOptions.output`). It is recorded by the `turn.end` hook, not by awaiting the run. `ok`:
nothing is shown. New items go to the digest buffer; urgent ones go to the notification bell at once,
one alert each (`postAlerts`, section 27). Nothing is written into a chat: system news leaves the
conversation (phase M).

**The digest** (`runDigest`) is built from data, once a day at a configurable time (default 18:00 in
the team timezone, or the digest's own): program runs since the last digest (`report: 'digest'` programs with
summary and outputs, `task` programs as a count, `silent` none), open decisions, tasks waiting for
you or in Review, the heartbeat items of the day, and the cost from the model call log (with the
heartbeat's share). Idempotent per local day; a quiet day adds nothing. The digest is stored as a
briefing (a page, one per day) with one bell notification (section 27).

**Web.** Agent dialog, Heartbeat tab: on/off, interval, active hours, timezone, the checklist editor
(the memory file), "Run a beat now", the recent beats (ok, attention, skipped, failed with their
items), and for the lead the digest settings.

**Test it.** [`heartbeat.test.ts`](../../examples/team/server/test/heartbeat.test.ts): empty checklist
and outside hours make no model call; ok shows nothing; attention fills the buffer and urgent reaches
the DM once; the same findings are deduplicated; overlap and a parked beat skip; the gate refuses
writes; three similar requests, not two; the digest contents and its idempotence; the routine fires,
a claimed fire is recovered once, a beat the server died in is closed.

**Real numbers (real-model pass).** A beat once reported a budget as burnt while the ledger showed
$0: it had read "the budget of this run was used up" (a reservation that did not fit) as spend. Now
`team_status` ends with the spend from the ledger (this month against the limit) and the call log
(today), says what a budget stop means, and a failing-run finding carries what the run actually
spent. The beat prompt says to quote only those numbers. A run parked on a decision is `running`
in the task index but is no longer "stuck": the heartbeat reports it as waiting for you, and
`GET /tasks` / `GET /tasks/{id}` carry `column` (`waiting` while parked, `review`, ...) next to
`status`, which is untouched, so the queue and claim logic do not change. The digest counts every run
that was active in its window (also one that started before it, and routine runs), prints
`19 runs: 15 done, 3 failed, 1 still running`, names the failed ones whatever their program reports,
and leaves the rest as a count. The lead reads per-run and per-task cost with `list_tasks` (each row
shows what its session spent, `program` filters by id or name, the total is the last line).
`propose_plan` needs `agent` (a readable error lists the agents) and is not stored twice: an open
proposal for the same agent with a similar title or brief is returned to the model instead.

*Without the checklist rule:* a heartbeat on every agent pays a model call every half hour to say
nothing. *Without fingerprints:* the same stuck task is reported every beat.

## 23. Evals (developer tool)

`examples/team/evals` is a CLI that runs a fixed scenario against a real model and scores it
(`bun run eval community-audit --model <id> --budget 0.5`): deterministic checks (for example the
recall and precision of the planted incidents against the fixture's `truth()`) plus rubric files
graded by a judge model, a hard USD cap, a report per run and `bun run eval compare`. It is
separate from the server and the web app, refuses to run in CI, and its tests use scripted models
only. See [Evals](evals.md). The shipped scenarios are illustrative; real runs wait for the
client's own examples and an approved budget.

## 24. Deliverables: files a run must leave

*Verify* in the run contract used to be the model's own promise. A program can now list the files
a run must leave, and the **server** checks them (P40 phase H). Structure is enforced; style and
quality stay in skills the client can edit.

```ts
// domain/deliverables.ts
{ path: '/library/reports/{slug}/{date}.md', kind: 'markdown',
  requiredSections: ['Summary', 'Findings'], minChars: 200 }
{ path: '/library/data/{slug}-{date}.json', kind: 'json', schema: { type: 'object', required: ['findings'] } }
```

- **Where**: `programs.deliverables` (a list; empty = none), edited in the program editor and in
  Edit and approve of a proposal (`propose_plan` takes `deliverables` too). Work-queue items use
  the deliverables of their worker program; `{slug}` is then the task title.
- **Tokens** (resolved per run): `{date}` UTC day of the run, `{slug}` program name (task title for
  a work item), `{runId}` the run's millisecond timestamp, `{program}` the program id. The run
  prompt lists the resolved paths, so the agent writes exactly there.
- **The check** (`evaluateDeliverables`, pure; the library is read through an injected function):
  the file exists, is not binary unless `any`, has at least `minChars`, has every required
  markdown heading (any level, case-insensitive, code fences ignored), parses as JSON and matches
  the schema. JSON Schema is validated with zod 4's `z.fromJSONSchema`, installed into the domain by
  `infra/json-schema.ts`; keywords zod does not know are ignored, and a `required` key without a
  `properties` entry is handled (zod would skip it). A schema zod cannot convert is refused when the
  program is saved.
- **The flow** (`infra/eh/program-service.ts` `runChecked`, `app/deliverables.ts`): the turn ends
  with its structured report; if the report says `done` or `partial` the files are checked. All
  pass: the report stands and the task stores the checks. Otherwise ONE fix-up turn in the same
  session with the exact failures ("Verify: ... `/library/..` the file does not exist"), then a
  re-check. Still failing: the report becomes `partial` with the failures in its summary, the task
  keeps the per-file result, and an escalation is opened in the Decision Center. A report of
  `failed` or `needs_decision` is not checked (it already asks for attention).
- **Work queue**: a work item with failing deliverables is not in Review (it shows in Waiting for
  you while its decision is open, else in Done with the failure) and `accept` is refused until the
  files pass. Approving the decision lets the agent try again; when that turn ends the files are
  checked again. `POST /tasks/{id}/deliverables/check` checks again without a turn (after the client
  repaired a file by hand); a pass puts the item in Review.
- **Web**: the program editor has a Deliverables section (path, kind, headings or schema, minimum
  length); the task view lists each file as Pass or Fail with its problems and a "Check again"
  button; the run history shows a deliverables badge; proposal cards list the files.
- **Storage**: `programs.deliverables` and `tasks.deliverables` (migration `0018`).

Tests (`test/deliverables.test.ts`, scripted models): passing files; a missing file fixed by the
fix-up turn (the turn names the file); sections missing twice gives partial and an open decision
after exactly one fix-up; a JSON file that does not match its schema; tokens resolve; a failing
work item stays out of Review, cannot be accepted and enters Review after a re-check; approving the
decision re-checks when the run ends; the editing API and proposals.

*Without the server check:* "I verified it" is the same model grading its own work. *Without the
single fix-up:* an agent can loop on a file forever; one turn with exact errors fixes the usual
cases and the rest goes to a person.

## 25. Rehearsal: a test run before a program is activated

A client who is about to activate a program wants to see what it does first, without it touching
anything real. A **rehearsal** (P40 phase K) runs the program as saved on sample data in a safe
mode; it works for any program, nothing in it is specific to a client.

```
POST /programs/{id}/rehearsals { sample: { copy, files, task, reads }, budgetUsd }   -> 201, runs
GET  /rehearsals/{id}              result (report, deliverable checks, files, simulated, would ask, cost)
GET  /rehearsals/{id}/messages     the chat of the run, read only
```

- **A session of its own**: `rehearsal:<programId>:<ts>` (a run profile, `domain/run-profiles.ts`:
  unattended, the program's authority, no task). It is never a task, so it is not in the run
  history, the board, the Review column or the heartbeat, and a worker program does not claim a
  queued task. The digest leaves its spend out of its cost line (`RehearsalStore.spentBetween`).
- **Files go to an overlay**: `infra/eh/overlay-fs.ts` is a `FileSystem` over a scratch
  `inMemoryFs` and the real library. Writes, deletes and moves land in the scratch; reads see the
  scratch first and then the library (the real one is only read, never written, and sends no file
  events); `ifVersion` is checked against what the overlay shows. The overlay reaches the
  agent three ways, all keyed by session id through `infra/eh/rehearsal-registry.ts`: the file tools
  and the memory plugin take `fs` as a function of the session (`sessionFileSystem`), and the
  big-data plugin is wrapped with `wrapPlugin` so its tools use the overlay in a rehearsal
  session. **Fail closed**: a rehearsal session id that is not running (the server restarted, the
  rehearsal ended) gets a read-only view, never the writable library.
- **External writes are simulated**: the program gate (`gateOf` in `agent-factory.ts`) has an
  extra step for a rehearsal. After the authority and the engine approved a call, a tool of a
  connector that is not built in (MCP, OpenAPI, third party; the built-ins are `files`, `memory`,
  `planning`, `web`, `ask`, `bigdata`) whose risk is not `read` (unknown counts as a write) is
  refused with `SIMULATED: would call <tool> with <input>. This is a rehearsal: ...`, recorded, and
  the agent carries on. Calls the real run would refuse (outside the authority, a pinned ask) are
  refused the same way as in a real run, so the rehearsal does not promise more than the real run
  does. (A denial text rather than a faked tool output is the one AI SDK mechanism that covers every
  tool kind; the model reads it as the result.)
- **Decisions are recorded, not raised**: in a rehearsal `escalate` and `request_authority` are
  plain tools (`decisions-plugin.ts`) that record a "would ask" entry and tell the agent to assume
  the safest answer; a report of `needs_decision` is recorded the same way. Nothing reaches the
  Decision Center and the run never parks. `create_task` and `update_task` are simulated,
  `complete_task` checks the outputs in the overlay and is simulated (a worker program is rehearsed
  on a **sample task**, a draft that is never queued).
- **Budget**: its own ledger scope `rehearsal:<session>` with a small cap (default 0.5 USD, at most
  5; `cost-cap` fails the rehearsal). The program's own scopes (per run, per day) are not touched.
- **Sample data** (`domain/rehearsal.ts` `RehearsalSample`): library paths to copy into the
  overlay (files or `/dir/`), text files the client attached or pasted, the sample task for a
  worker program, and `reads`: `library` (the default: the run can read the rest of the real
  library, it still cannot change it) or `sample` (the run sees only the sample).
- **Deliverables** are checked against the overlay files with the same function and the same one
  fix-up turn as a real run (`rehearsal-service.ts`); a failure is shown, no decision or partial
  task is made.
- **Result**: `report`, `deliverables`, `files` (produced files, with their text up to caps),
  `deleted` (library files it deleted in the overlay), `simulated`, `wouldAsk`, `toolsCalled`, cost
  and the chat. A row per rehearsal (`rehearsals`, the whole result as JSON; the last 50 per
  program are kept). A rehearsal that was running when the server stopped is marked failed at boot.

**Test cases** turn a good rehearsal into a regression test: a case is a sample plus expectations
(`deliverablesPass`, `mustNotCall` tools, an expected `reportStatus`), stored in `program_tests`
with its last result. `POST /programs/{id}/tests/run` re-runs the cases one after the other (each a
rehearsal linked to its case) and stores pass, fail (with the reasons) or error. A result is tied to
a **fingerprint** of what makes a program behave (agent, name, brief, authority, gates,
escalation, forbidden, worker, deliverables): an edit that matters makes it *stale*, pausing, the
schedule and the budget do not. `GET /programs/{id}/tests` returns the cases and a summary; the
web warns before activating a program with failing cases ("Activate anyway": a warning, not a
block).

**Web**: the Programs list has a Tests and test run action and the editor a Test run button; both
open the program page (`/programs/{id}`, `PageHeader` and `PageBody`) with the Test run dialog and
the Tests and Test runs tabs; a run lands on its result page
(`/programs/{id}/rehearsals/{rid}`), which polls while it runs and offers Save as test case and Run
again.

Tests (`test/rehearsal.test.ts`, scripted models, an in-process fake MCP server): the overlay
unit (conditional writes, deletes, moves, read-only fallback); a rehearsal writes only into the
overlay and the real library is unchanged; sample files and `reads: sample`; a write tool of an
external connector is simulated and recorded while the same call in a real run is made; would-ask
decisions with an empty Decision Center; deliverables against overlay files including the fix-up;
a worker program on a sample task; the budget cap; no run history, no digest line, cleanup with the
program; a saved case passes, then fails after an edit that breaks it, is stale in between and
survives a pause.

*Without the overlay:* "try it" writes into the client's library. *Without simulating at the gate:*
a rehearsal posts to the real company system. *Without the fingerprint:* pausing a program makes a
failing test look stale and the warning disappears.

## 26. Operations: soak test, end-to-end flows, what the invariants mean

Two scripts in [`examples/team/scripts`](../../examples/team/scripts) check the server the way it
is run, with real processes, a scripted model and no paid calls. They are written for the
stability pass of P40 (phase I); run them before a release and after a change to runs, routines,
decisions or recovery.

```bash
bun examples/team/scripts/soak.ts                  # 90 s soak: load, faults, SIGKILL, restart
bun examples/team/scripts/soak.ts --quick          # the 30 s variant (also run by `bun test`, server/test/soak.test.ts)
bun examples/team/scripts/soak.ts --seconds 120 --seed 7 --fault-rate 0.3   # harsher, reproducible-ish
bun examples/team/scripts/e2e-flows.ts --port 4700 # the five client flows through the HTTP API
```

**The soak** (`soak.ts`, helpers in `scripts/soak/`). Two server processes (A and B) on free
ports share one SQLite file. Five programs run at once: three scheduled (the shortest schedule the
product allows, 10 s, with the routine ticker at 500 ms), one manual, one worker with a queue of
tasks the script keeps adding. The script also fires the heartbeat, asks the digest to run (a
script-only control route, `/__soak/digest`: its own slot is a day apart), answers every decision
(approve with a choice, or reject), accepts work in Review and sends some back. The model is a
scripted "brain" (`soak/brain.ts`) that decides each step from what the call looks like, so any
number of agents can share it; from a seeded random generator it injects `429`, `500`, a thrown
connection error, a timeout, a stream error and slow streams. Along the way A is `SIGKILL`ed and
restarted with the same instance id, then B (only ever by PID). When the load stops, the programs
are paused, every decision is answered and the queue is run dry; then both processes are stopped
cleanly and `soak/invariants.ts` reads the database. Time is not faked: the clock of the server
is not injectable, so schedules are real (short) and the heartbeat and digest are triggered
through the API. Exit code 1 and a list of violations if any invariant fails; `KEEP_DIR=1` keeps
the database and the logs.

| Invariant | What a violation means |
|---|---|
| `no-stuck-task` | A task is still `running`, `queued` or waiting after recovery and the drain, or a session still has an active turn: a killed turn was not repaired. |
| `queue-lost`, `queue-twice` | A task the client queued has no row, or ran twice (round and history disagree with the number of sends back, one session for two tasks). |
| `run-has-task` | A routine run is not final (`claimed`, `enqueued`), a scheduled run has no task row, or a succeeded run's task is not `done`. |
| `decisions` | A decision is still open at the end, a decided one has no `decided_at`, or a session still waits (`pending`) with no decision to answer. |
| `budget` | The workspace ledger differs from the sum of the logged model calls (cost is recorded once per step, also for a step that failed after streaming), or a reservation stayed open past its expiry (a killed process legitimately holds one until it expires). |
| `digest-once` | Two briefings share a day (the `briefings` day index forbids it; this is the second line of defence), or a `daily-digest` message was written into a chat (the digest is a page since phase M). |
| `heartbeat` | A beat is still `running`, ends before it starts, repeats an id, or an `ok` beat has items. |
| `orphans` | A run session has no task row or names a deleted program, a task has a missing parent session, or an undelivered inbox item is left on a run or heartbeat session. |

**Bugs it found** (each has a regression test):

- A heartbeat beat killed mid-turn kept its active turn and a `running` record for good: the boot
  repair recovered chats and task sessions only, and the rolling session `heartbeat:<agentId>` has
  no task row. It is recovered now and its record closes as failed ("interrupted"). Test:
  `restart-recovery.test.ts`, "a beat the dead process left running is closed with its turn".
- A scheduled program run killed mid-turn left its routine run `enqueued` forever (the repair
  closed the turn, nothing told the routine). It ends as `failed` now, without counting toward
  pausing the schedule. Test: "the routine run of a killed program run ends too".

**The end-to-end flows** (`e2e-flows.ts`). One server process on a port you choose (4700 by
default) with `TEAM_SCRIPTED_MODEL`, and the requests the web makes, one flow after the other so
the single scripted model is consumed in a known order: create a program, Run now and see the
report on the board; a proposal in the lead's chat, Approve, the program exists; an escalation
parks a run, Decide, the same run resumes; a queued task goes to Review, Send back with a note,
the revision comes back; the heartbeat finds something and the digest (set to the next minute in
the team timezone, so this flow takes about a minute) carries it. There is no browser
automation dependency in the repository, so this is the API the pages call, not their DOM.

## 27. Chat threads, the Briefing page and the bell (phase M)

**Threads.** An agent has any number of chat threads, all equal (no pinned "main" chat). A thread
is one eharness session plus a row in `chat_threads` (`domain/threads.ts`, `app/threads.ts`):
title (null until the first message names it), `source` (`web`, later `channel`) and
`sourceLabel` (for example a group name) so channel conversations can share the same list with a
badge, an optional `seed` (what "Discuss in chat" was opened about), archive flag, last activity and
preview (kept current by wrapping the event appender, `infra/eh/thread-activity.ts`). Session ids:
`dm:<agentId>` for the thread that existed before threads, `chat:<agentId>:<threadId>` for every
other. A delegation from a thread has the child session `<thread session>:agent:<call>`, so the
report returns to the thread that started it and attention roots, recovery and wake-ups walk
every thread (`team-service.ts`). One helper, `parseChatSession`, replaces the old `dm:` regexes.

**Migration without moving data.** The first read of an agent with no thread row (and the boot
pass `ensureAllFirstThreads`) creates one row for its existing `dm:<agentId>` session: history,
modes and connector switches stay under the old id. `migration 0020` only creates the tables.
`test/threads.test.ts` replays this on a database from before the phase.

**API.** `GET/POST /agents/{id}/threads`, `PATCH /agents/{id}/threads/{threadId}` (rename),
`POST .../archive|restore`, `POST /threads/discuss`. Per-chat routes (`/agents/{id}/stats`,
`compact`, `context`, `sessions`, `mode`, `chat/tools`) take `?thread=<id>`; without it they use the
thread with the newest activity. The chat itself is the library's `/sessions/{sessionId}/chat`: a
`chat:` id without a thread row is a 404, an archived thread answers 409 `THREAD_ARCHIVED`.
Threads are created only on demand.

**Routines in `dm` mode.** A routine with `sessionMode: 'dm'` fires into the agent's newest live
(non-archived) thread, resolved when the slot is claimed and stored on the run (`dmSession` in
`main.ts`). An agent with no thread rows yet uses `dm:<agentId>`; an agent whose threads are all
archived gets a new thread titled "Routines". It never writes into an archived thread.

**Briefing page and bell.** `runDigest` stores a `briefings` row (markdown body plus items) and one
`briefing` notification; `finishBeat` adds one `alert` notification per urgent finding
(`app/briefings.ts`, tables `briefings`, `notifications`, both idempotent by key). `GET /briefings`,
`GET /notifications`, `POST /notifications/{id}/dismiss`, `POST /notifications/dismiss-all`. The
lead reads briefings from any thread with the read-only tool `read_briefings`
(`heartbeat-plugin.ts`, allowed without approval like the other app tools).

**Following up.** A program or task run is already its own session: open it from the board, a
notification or a briefing and use its follow-up box (`POST /tasks/{id}/messages`, same session and
context). "Discuss in chat" on a briefing (or one of its items), an alert or a run
(`discussInChat`) creates a NEW thread on the lead, seeded with that context as one `eh.event`
message (no model call). Continuity across threads comes from memory, not chat history.

**Web.** A thread bar above the chat (switcher with archived section, New chat, rename, archive),
`?t=` in the URL (thread id or session id), a Briefing page in the rail, alerts with "Discuss in
chat" and Dismiss in the bell, empty assistant messages hidden.

**Test it.** `server/test/threads.test.ts` (CRUD, migration, delegation back to its thread,
briefing, alerts, `read_briefings`, discuss seeding), `heartbeat.test.ts`, and the web unit tests
`lib/threads/model.test.ts`, `lib/briefings/model.test.ts`, `lib/stores/threads.test.ts`,
`lib/stores/live.test.ts`.

## 28. Channels: chat platforms as sessions of an agent (P41 phase L1)

**What.** An agent can live in a chat platform the way an employee does. The *gateway*
([`infra/channels`](../../examples/team/server/src/infra/channels)) sits between platform
*adapters* and the agent sessions and never names a platform; a Telegram bot, a Slack app or the
in-memory `mock-adapter.ts` all implement the same `ChannelAdapter` (normalized inbound events,
`send`/`edit`/`delete`/`react`/`typing`, optional history, members and a native action catalog,
`capabilities` with the text limit). The contract is `types.ts`; the rules that need no I/O (scope
resolution, the wake test, splitting text, the loop guard) are `policy.ts`.

**One event, in order.** `gateway.handle(event)`: drop the agent's own messages and bots (unless
`allowBots`, then the loop guard: 20 events in 300 s puts the conversation in a 600 s cooldown);
the allowlist (`groupPolicy: allowlist` by default, per group and per topic overrides of `agentId`,
`wake`, `delivery`, `retentionDays`); a DM only from a mapped employee (a one-time `/start <token>`
link, `pairing.issue`, only the token's hash is stored); then **wake** or **observe**. A message
wakes the agent when it mentions it, replies to it, matches an alias, is in the agent's own topic,
or the scope says `wake: 'always'`; a message that mentions somebody else and not the agent is only
observed; `wake: 'never'` is an audit chat. Every kept message goes to the **channel log**
(`channel_messages`, body sealed with its own key; unique per platform message id, which is the
dedupe), then a wake is `session.enqueue(input, { mode: 'collect', id: 'ev:<message id>' })`:
a burst of messages becomes one turn, and the inbox's caller id makes a redelivery a no-op.
An observed message is just the log row marked `pending`.

**Sessions.** `channel:<connection>:<conversation id>`, one per group, per forum topic and per DM
peer (the adapter composes the conversation id). Each is registered as a `chat_threads` row with
`source: 'channel'` and a label, so it shows in the agent's thread list. Turns are prefixed with
the sender (`[Ana Putri @ana] ...`), inbound files are stored like web uploads (same allowlist and
size limit) and reach the model as file parts. At the next wake the messages observed since the
last one (at most 50) arrive as a **turn reminder** (an instruction with `refresh: 'turn'`: never
in the system prompt, so the prompt cache holds) and are cleared after the run.

**Replies.** `final_text` (default): at `turn.end` the final assistant text (after the last tool
call) is posted back, quoting the message that woke the agent, in the same topic, split at the
adapter's `maxTextLength` on newlines. `message_tool`: only `channel_send` posts. The exact text
`NO_REPLY` is swallowed only in `wake: 'always'` scopes. The agent gets a 👀 reaction on an
addressed group message and a typing indicator while it works.

**Outbound queue** ([`outbound.ts`](../../examples/team/server/src/infra/channels/outbound.ts)).
Everything that talks to a platform (replies, `channel_send`, reactions, pairing replies) is one
operation in a queue per conversation: in order, at least `chatMinIntervalMs` apart (1 s), at most
20 a minute to a group, 25 a second over a connection (all in the connection's config). A
`rate_limit` error parks the connection for the time the platform asked and retries (never a
tight loop); a `fatal` error, or five failures in a row, opens a **circuit breaker** that refuses
sends until its cooldown ends and raises one bell notification.

**Tools.** `channel_describe` and `channel_read` (history from the log or the platform, members,
download an attachment into the library) are read-only; `channel_send` (`external`: send, reply,
upload, react, also to a mapped member's DM) and `channel_manage` (`destructive`: edit, delete,
pin) keep one static risk each, so permissions, program authority and rehearsals work unchanged.
A target must be a conversation the gateway knows or a configured group or channel; the tools
return readable errors. The native actions of an adapter become **deferred tools** found with
`tool_search`, each with its own risk. *Without the split by risk:* one `channel(action)` tool would
be `destructive` for everybody, or `read` for nobody.

**Test it.** `server/test/channels.test.ts` with a scripted model and the mock adapter: the pure
policy, the sealed log and its retention, pairing, U3 (mention wakes with the observed context and
replies quoting the trigger in its topic; unmapped DM ignored; two agents in one group; the loop
guard), U1 (an audit chat never wakes), U2 (a program posts three updates through the queue at the
configured rate and reads them back), rate-limit parking, the breaker and the bell, dedupe of a
redelivered event and a restart that keeps the log, pairing and session; the hardening tests:
a simulated crash between turn end and delivery (one send after the restart), a `sending` row
checked against the platform, a blind platform, retried chunks keep their order, approvals
(buttons, deny, refusal, admin, web link, web wins, question), the rebinding and read actions.
`bun scripts/channels-demo.ts` runs a small demo on the mock adapter.

**Hardening (reliable delivery, approvals, rebinding).** Four rules turn the sketch above into
something you can run for U1-U3.

- *Outbox* ([`delivery-store.ts`](../../examples/team/server/src/infra/channels/delivery-store.ts),
  table `channel_outbox`). Nothing is sent before it is a row (body sealed like the log): `reply`
  rows are written at `turn.end` (one per chunk, with the trigger, the target and the chunk index;
  a trigger that already has reply rows queues nothing), `post` rows by `channel_send`, `approval`
  rows by the approval announcement. A row is claimed with a compare-and-set (`pending` ->
  `sending`) so it is posted by one sender at most, and its id travels to the adapter as
  `OutboundMessage.key` (an adapter whose platform can dedupe uses it). Success marks the row
  `sent` with the platform message id. A reply or approval row whose send fails is retried
  (backoff 5 s doubling to 5 min, ten attempts, then a bell notification); an `invalid` error is
  final. On boot (`register`) retries are due at once and rows a crash left in `sending` are
  checked against the platform history: found = marked sent, absent = sent, and a platform that
  cannot list history never gets the row again (marked failed, bell rings: a duplicate is worse
  than a visible gap). `post` rows (tool calls) are never retried by the outbox and never resent
  after a crash: the model was told, ADR-0014 says an interrupted tool call is not re-executed.
  Chunk `n+1` waits for chunk `n`. Posts with files bypass the outbox (the bytes are not stored).
- *Approvals in chat.* A turn that a channel message started and that stops at a tool approval or
  an `ask_user_question` posts a short request into the conversation (quoting the trigger). With
  the `buttons` capability an approval carries Approve / Deny buttons (inbound `action` events,
  `approve` / `deny`, data = the approval row id); without it, and for every question, the request
  links to the thread in the web app. **Who may answer from the chat:** the team member the
  trigger's sender is linked to (pairing), or a member listed in the connection's `admins`
  (default `['owner']`, the example's single principal). Everybody else, including unmapped
  accounts, gets a readable refusal and nothing changes. The answer goes through the same
  `answerAttention` as the web. **First answer wins:** the chat claims the approval row with a
  compare-and-set before answering; an answer from anywhere else shows up as a `pending-changed`
  event in the activity feed, which the gateway reads (a wrapper around the activity store,
  [`attention.ts`](../../examples/team/server/src/infra/channels/attention.ts)) and turns into an
  edit of the request ("Answered in the web app"); a late button press gets "already answered".
  A turn the web app starts in a channel thread announces nothing in the chat. The reply of the
  continuation is delivered through the outbox like any other (the parked trigger is kept in
  `channel_approvals`).
- *Rebinding.* The agent of a conversation is the binding's agent at every wake (group or topic
  `agentId`, else the connection's). When it changed, the conversation moves to the next
  generation: a new session `channel:<connection>:<conversation>#2` and a new thread of the new
  agent. The old agent's thread stays as history; its pending approvals still work.
- *Native read actions.* `gateway.readActionTools(agentId)` lists the tool names of the
  read-risk native actions of the agent's connections, derived from the adapters' catalogs, and
  the permission engine of a session allows them. Write, external and destructive actions keep
  asking.

The web app shows a source badge for a channel conversation in the thread list and in the
switcher; it can be read and continued there (what is written there is not posted to the chat).

## 28b. Telegram bot and the Channels page (P41 phase L3)

**What.** The first real adapter: a Telegram bot over the Bot API with grammY
([`infra/telegram`](../../examples/team/server/src/infra/telegram)). It implements the
`ChannelAdapter` of section 28, so the gateway, outbox, approvals and tools are unchanged.

**Setup in four steps** (the owner enters the token in the web app, never in a file):

1. In Telegram, @BotFather `/newbot`; copy the token. For groups, either make the bot a group admin
   or turn privacy mode off (`/setprivacy`, then re-add the bot), otherwise it only sees mentions,
   replies and commands.
2. Channels page, **Connect a Telegram bot**: the connector flow takes the token and runs
   `getMe`; the connection shows `@username` and what privacy mode means for this bot.
3. Bind the connection to an agent. Polling starts; the bot shows as *Running*.
4. Write in a group where the bot is (or add it): the chat appears under **Chats**. Allow it and
   choose when the agent wakes (mention, every message, observe only), how it replies and how
   long messages are kept. For employees, **People** issues a `/start` deep link per team
   member; only linked accounts reach the agent by DM, and only they (or an admin) answer
   approvals pressed in a chat.

**Transport.**

- *Inbound.* `run(bot)` (concurrent) with `sequentialize` by chat, `allowed_updates` listed
  explicitly, a long poll of 30 s. `normalize.ts` turns an update into an `InboundEvent`: mention
  by entity, reply to the bot, `/command@botname`, forum topic as its own conversation, edits,
  channel posts, reactions, callback queries (answered at once, then handed to the gateway as
  `action` events), and `my_chat_member` / chat updates into the known chats table.
- *Outbound.* Through the gateway's outbox and queue. Telegram's `retry_after` becomes a
  `ChannelError('rate_limit', ..., ms)` that the queue parks; auto-retry only absorbs waits up to
  5 s. HTML only, with a strict escaper and a Markdown subset; a parse failure is resent plain.
- *Errors and secrets.* 401 means a revoked token: `markNeedsAuth`, a bell, the poller stops. The
  token sits in every request URL, so every message that leaves the adapter is scrubbed.
- *Tests* run the real grammY and runner under Bun against a fake Bot API on a local port
  ([`test/support/fake-telegram.ts`](../../examples/team/server/test/support/fake-telegram.ts)):
  polling order, signals, topics, callbacks, the 20 MB cap, 429 `retry_after`, 401, privacy
  guidance, HTML escaping and splitting, and the whole flow through the HTTP API
  (`test/telegram-channels.test.ts`). No real network.

**Admin API.** `GET /channels/connections`, `PUT|DELETE .../{id}/binding`, `GET .../chats`,
`PATCH|DELETE .../chats/{chatId}/policy[?topic=]`, `GET .../links`, `POST .../pairing`,
`DELETE .../links/{peerId}`, `POST .../webhook/delete`, `.../restart`, `.../breaker/reset`
(zod-openapi schemas, generated web types). The web page is `/channels`.

## What to change when you copy it

| In the example | In your harness |
|---|---|
| SQLite adapters | Postgres / your database (same contracts, run the conformance suites) |
| One owner principal, `canAnswer: () => true` | your user model; `roots` and `canAnswer` per principal |
| Agents as rows | agents as code, or your own definition table |
| Connectors catalog (built-ins, MCP, OAuth) | only the plugins you need |
| Polling for inbox, stream log, feed | `notify` / `subscribe` if your store has a channel (Postgres `LISTEN`) |
| `instanceId` from the port | host name, pod name or a lease row; it must be unique among live instances |
