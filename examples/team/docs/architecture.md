# Architecture

How the team app is put together and why. Decisions and the research behind them are in
[P32](../../../docs/plans/P32-team-example.md); the library contracts are in `docs/specs/`.

## Layers

```
web (SvelteKit)  --HTTP/SSE-->  server/src
                                  http/    OpenAPIHono routes + zod schemas (the only API surface)
                                  app/     use cases over ports (createAgent, answerApproval, ...)
                                  domain/  pure types and rules, no I/O
                                  infra/   SQLite + Drizzle, and the eharness wiring (infra/eh)
                                  main.ts  composition root
```

Rules, enforced by `server/test/layering.test.ts`: `domain` imports nothing; `app` imports `domain`
and port types; `http` imports `app` and its schemas only; `infra` implements the ports and is the
only layer importing `eharness`, `drizzle-orm` and `bun:sqlite`; `main.ts` wires them. The server
imports eharness only through public subpaths, never `src/`.

## Request flow (a chat message)

1. `POST /agents/{id}/chat` with the AI SDK `useChat` body. The route resolves the agent
   definition and opens `dm:<agentId>` through the factory (shared lock and runtime
   `{ workspaceId, agentId }`).
2. `handleChatRequest` validates the body (only `text` / `file` parts, server-made ids; the client
   history is never trusted) and starts the turn. If the session is busy here it steers; if a turn
   runs on another instance the message goes through the durable inbox (`202`).
3. The turn streams as a UI message stream. Chunks are also appended to the **stream log** in
   SQLite in batches, so another instance can resume it.
4. Hooks (`taskIndex`, `routineOutcomes`) write `tasks` rows and `events` rows on whichever
   instance runs the turn. Messages are persisted by the storage adapter; they are the truth.
5. Every instance tails `events`, so the sidebar and board of a client connected elsewhere update.

## eharness wiring

**Agents are data.** An agent is a row (`agents`: instructions, model, tool names from a fixed
catalog, MCP servers, permission mode, rules, `version`). `infra/eh/agent-factory.ts` turns a row
into a `HarnessAgent`, cached per `agentId@version@settingsRev`. An edit bumps the version, so the
next turn of a chat gets a fresh agent while running turns finish on the old one. The plugin order
is fixed (prompt-cache prefix): filesystem (library) -> memory -> todos -> web -> permissions ->
ask -> subagents -> task index. MCP servers are the root `mcp` option. Static text goes in
`instructions`; the date and the roster go in a turn reminder.

**Providers and profiles.** `infra/eh/providers.ts` wires the `eharness/providers` manager:
OpenRouter and the AI Gateway as definitions, environment variables as read-only `env` profiles, and
profiles saved from the web in `config_profiles` with the whole settings object AES-GCM encrypted
(`secret-box.ts`, key from `TEAM_SECRET_KEY`). An agent's model is `{ modelProfile, model }`; a plain
model id (old rows) means the default profile. The manager's `catalog()` feeds cost and context window
into the agent. A change appends `providers-changed`; other instances tail the feed and reload.
The public catalogs are cached in `catalog_cache`.

**DM sessions and task sessions.** Each agent has one DM session `dm:<agentId>`. Delegated work
runs in a **child session** (`<leadSession>:agent:<toolCallId>`), so a task has its own history and
its approvals do not block the DM. Routines run in the agent's DM or in their own session
(`routine:<id>:<slot>`), per routine.

**Background delegation (default).** The lead's `subagents` also has `background: { default: true }`
([ADR-0046](../../../docs/decisions/0046-durable-background-subagents-in-park-mode.md)): the `agent`
call starts the role agent through its durable inbox and returns at once, so the lead stays free to
chat and a new user message cancels nothing. The role agent's approvals are answered on its own
session from any instance; when its turn ends, the report wakes the lead as an event. The card in
the chat opens the child session (the `data-subagent.run` marker carries its id) and its status
follows the task row. `run_in_background: false` gives the foreground park below.

**Park delegation.** The lead uses `subagents({ approvals: 'park' })`. When a role agent needs an
approval, the lead's turn ends parked and the child waits in storage. The user answers on the
board (`POST /approvals/{id}`) on any instance; the child continues and, when it ends, the lead
resumes with the report. Nothing lives in process memory, which is why it survives restarts
([ADR-0035](../../../docs/decisions/0035-nested-approvals-park-the-parent.md)). `send_message`
works in park mode over the inbox ([ADR-0041](../../../docs/decisions/0041-park-mode-messaging.md)),
so the lead can follow up with a finished role agent from any instance. Role agents are leaves
(`maxDepth: 1`).

**Read without waking.** Pure reads (approvals list, task detail, DM messages) use `agent.peek()`,
which has no `session.start` hooks and resumes nothing
([ADR-0042](../../../docs/decisions/0042-peek-child-identity-spawn-cap.md)).

**Events feed.** The `events` table (autoincrement `seq`) is written by hooks; `GET /events/stream`
tails it (poll, 500 ms) and replays from a cursor. It is app infrastructure; a library-level feed
is request R3.

**Model call log (Logs page).** The `activityLog` plugin (`infra/eh/activity-log.ts`) is registered on
every agent and persists each `model.call` event
([ADR-0047](../../../docs/decisions/0047-model-call-observer.md)) into `model_calls`: summary columns
for the table plus capped JSON columns (request options and body, response, output, provider
metadata, raw usage; 512 KB each, `truncated` flag). Auto mode classifier calls arrive through
`modelClassifier({ onModelCall })` per session (kind `other`). Retention is a row cap and an age, pruned
cheaply while writing (`TEAM_LOG_MAX_ROWS`, `TEAM_LOG_RETENTION_DAYS`). Each call also appends a
`model-call` event so the page live-updates. A write failure is logged and never breaks a turn.

**Stream log.** `eh_stream_log` / `eh_stream_chunks` implement the `StreamLogAdapter` port
([ADR-0039](../../../docs/decisions/0039-resumable-streams-stream-log.md)): cursor = chunk index,
retention 10 min, readers poll. `GET /agents/{id}/chat/stream?from=` resumes a turn running on
another instance; a reload on the same instance replays the in-memory buffer.

**Routines on the inbox.** There is no scheduler in the library
([ADR-0040](../../../docs/decisions/0040-enqueue-timers-and-ids.md)). Every instance runs a ticker
(15 s) that claims due rows with a compare-and-set on `next_fire_at`, inserts the
`routine_runs (routine_id, scheduled_at)` row in the same transaction, and calls
`session.enqueue(prompt, { id: 'sched:<id>:<slot>', availableAt })`. The unique run row and the
inbox dedupe key make a fire idempotent. Overlap is skipped by default, missed slots are skipped
(or the latest is fired within a catch-up window), and consecutive failures pause the routine.
Unattended runs never auto-approve: a fire that needs approval becomes a task in the inbox.

**Library and memory.** One `library_files` table implements `FileSystem` (list, read, grep, glob,
move, bytes, versions). `/library/**` is the artifact space, `/uploads` holds attachments (kept as
`library://` references in messages, resolved to bytes only when the model request is built),
`/memories/workspace` and `/memories/agents/<id>` are memory roots. Edits carry `ifVersion`, so a
stale user edit loses to an agent write and the UI shows the conflict.

**Cost.** Every agent reserves against one ledger scope `workspace:<id>` (`budget.ledger`); the
limit is a row set from Settings or `TEAM_BUDGET_USD`. The lead's concurrent delegations are
capped (`maxConcurrent` = Settings spawn cap).

**Connectors** (`eharness/connectors`, spec 24). What an agent can use is decided by connectors,
not by a tool checklist. The built-ins (Files, Memory, Planning, Web, Ask the user, Team) are
included; GitHub (remote MCP, OAuth app or a personal access token) and the custom connector (any
remote MCP URL) are connected from the Connectors page. A **connection** is workspace scoped
(connected once, "available to all agents" = `defaultEnabled`, inherited; an agent may override it)
or agent scoped. Per agent and connection the choices live in `agent_connectors`: on / off /
inherit, a mode per capability (Allowed / Ask first / Off, plain words) and per-tool overrides under
"Advanced". `activateConnectors` turns them into plugins, MCP sources, permission rules and a stable
tool order; the connector rules are merged most-restrictive-wins with the agent's own rules, and
write or destructive tools of non-built-in connectors that ask are pinned (they ask even in Bypass
mode, through `toolKinds`). Remote MCP tools are deferred (`tool_search`), prefixed `<label>_<tool>`
and framed as untrusted.

Activation is asynchronous, the agent factory is not: `factory.prepare(def)` activates the
connectors of an agent, the lead and the roster, `agentFor` / `openSession` use the result (every
chat, task and routine entry point awaits `prepare` first).

**One secret system.** The server's AES-GCM box (`TEAM_SECRET_KEY`, previous keys for rotation) is
the library's `SecretVault`. Provider profiles, connections (settings: API keys, header values),
their OAuth credentials (tokens, client) and the OAuth app credentials an admin saves live in the
same `config_profiles` table; connector rows are sealed by `sealedProfileStore` (one blob per row,
bound to its kind and id), flow scratch is sealed with the same vault, and nothing is returned by
the API except `{ set, hint }`. Several instances: a change of a connection or an enablement
appends `connectors-changed` (like `providers-changed`) and the others rebuild their agents; token
refreshes take a lease in `eh_locks` so two instances never refresh one single-use token at once.

**Migration.** Agents from before connectors (`agents.connectors_migrated = 0`) are migrated at boot
(`infra/eh/connectors-migration.ts`): the tool checklist becomes enablement that reproduces it
exactly (`domain/connectors.ts` `enablementFromTools`: library_read/write -> Files read / edit +
delete, memory -> workspace memory (lead writes) + own memory, todos -> Planning, web_* -> Web,
ask_user -> Ask the user, delegate (+ send_message) -> Team) and every MCP server becomes an
agent-scoped custom connection `mcp:<agent>:<name>` (headers sealed, tools still `<name>_<tool>`,
allow / deny lists kept, switched off when the agent never had the `mcp` tool). The legacy columns
stay in place and are never written again.

## Multi-instance guarantees and what survives a restart

Instances share nothing but the database. Coordination uses the library's ports implemented on
SQLite: a lease **lock** per session (30 s, heartbeat), `StateAdapter.setIf`, the durable **inbox**,
the stream log and the ledger.

| Situation | Result |
|---|---|
| Server killed mid-turn | the turn is recovered on next contact: an `EH_TURN_INTERRUPTED` notice, unanswered tool calls get `Interrupted:` results, nothing re-runs ([ADR-0014](../../../docs/decisions/0014-interrupted-tool-calls-answered.md)) |
| Killed with an approval pending, or a parked lead | still answerable after restart, on either instance; the lead continues when the child ends |
| Same approval answered on two instances | exactly one wins (consume-once), the other gets an error |
| Stop pressed on B, turn on A | A aborts within one abort poll |
| Message to a chat busy on another instance | steered into the running turn or queued (inbox) |
| Reload while the turn runs on another instance | resume from the stream log |
| Two tickers, or a ticker that died holding a claim | each routine slot fires exactly once; stale claims are recovered |

`scripts/two-instances.ts` and `scripts/kill-restart.ts` check this with real processes. A killed
streaming turn is only recovered after its heartbeat is older than `recovery.staleMs` (120 s) and
the lock lease (30 s) expired; the scripts shorten both with SQL, `--wait-stale` waits honestly.
A boot and periodic `reconcile()` re-reads waits and task rows that never reached a terminal state.

## Known limits

- One workspace and one user (`actor` is `owner`); a single bearer token.
- SQLite has no cross-process notification: events, the inbox and the stream log are polled
  (sub-second to seconds of latency). A networked database with `LISTEN/NOTIFY` would remove it.
- A turn killed mid-stream waits for the recovery window before the session is usable again.
- The library keeps version metadata, not old content: no restore (request R21).
- `ContextStats` (window, tokens) is not in `peek()`, so `GET /agents/{id}/stats` opens the session.
- Opening a lead session reconciles parked waits, so a list of approvals can resume a parked lead
  (a model call): intended healing, but reads are not strictly free there.
- The spawn cap counts live delegations; there is no per-day or per-turn limit besides the budget.
- `web_search` needs an OpenRouter or AI Gateway profile (it uses the provider's own search); other providers have none.
- MCP: no stdio, no OAuth flow (static headers only), URLs are not checked against private
  networks (SSRF) because the single user is trusted: add an allow list before multi-user use.
