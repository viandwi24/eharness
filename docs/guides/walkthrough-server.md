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
   `forbidden` list added to the **deny rules** (spec 18: deny wins in every mode).
2. `dontAsk` alone is not a closed world: reads, `agent` and `safe` tools are approved by their
   kind, so a run could read any library file. The gate adds the closed-world check with the
   library's `matchRule` (allow polarity): a call is approved only when an allow rule of the
   authority matches it. The plugin's `tool.approve` hook runs the gate first, then the engine's
   own verdict; most restrictive wins, like the core's chain (spec 11 section 3).
3. A refusal is a **denial with a reason the model reads** ("Outside the authority of program ...
   Do not retry; report what you could not do with status `needs_decision`"), never an
   approval request: a background run has nobody to ask. A forbidden call says "Forbidden by
   program ... matches the rule ...". The connectors' own *ask* rules are dropped for a run (the
   client granted these tools to the program); tools **pinned to ask** (writes of third-party
   connectors) stay pinned and are refused: they are gates. A deleted program leaves a session
   that can be read but not act (empty authority).

The authority is read when the session is opened: a run in progress keeps the authority it started
with, the next run uses the edited one.

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

*Without the gate:* a program run in `dontAsk` could read everything and an MCP tool outside the
authority would only be "not allowed by mode", with the generic reason; the agent could not tell
that it should report instead of retrying. *Without `dontAsk`:* the first out-of-authority write of
a 3 a.m. run parks on an approval nobody answers.

## What to change when you copy it

| In the example | In your harness |
|---|---|
| SQLite adapters | Postgres / your database (same contracts, run the conformance suites) |
| One owner principal, `canAnswer: () => true` | your user model; `roots` and `canAnswer` per principal |
| Agents as rows | agents as code, or your own definition table |
| Connectors catalog (built-ins, MCP, OAuth) | only the plugins you need |
| Polling for inbox, stream log, feed | `notify` / `subscribe` if your store has a channel (Postgres `LISTEN`) |
| `instanceId` from the port | host name, pod name or a lease row; it must be unique among live instances |
