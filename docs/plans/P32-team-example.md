# P32 — Team-agent example (`examples/team`)

Status: review (M1-M8 done; real-model smoke passes; awaiting maintainer confirmation) · Owner: — · Branch: `main` (direct commits, see the board) · Depends on: P31

## Goal

A team-agent app built **only** on the public eharness API: a workspace of role agents (one per
job) coordinated by a lead agent. The user chats with any agent, watches what the others are
doing, approves risky actions, and lets agents run routines on a schedule. It is the second
benchmark application for "eharness is flexible" (the first is the terminal coding agent,
[P30](P30-coder-example.md)) and the reference for **deployment profile (c), web + server**
([ADR-0034](../decisions/0034-deployment-profiles.md)): the web is only UI, the server runs
everything, survives restarts and can run as several instances.

Like P30/P31, the example exists to find library gaps. Every gap goes under
[Requests to the library](#requests-to-the-library) and is fixed in the library (a follow-up
phase, P33), not hacked around in the example. The example never imports anything but the public
subpaths and never ships storage in the library (ADR-0008): SQLite adapters live in the example.

It lives in `examples/team` and is never published.

## Specs relied on

The app is a consumer; it changes no spec. It relies on:

- spec 01 (plugins, hooks `turn.start` / `turn.end` / `step.prepare` / `tool.approve`), spec 02 §5–6
  (instructions vs reminders, stable tool order)
- spec 04 (UI message stream, turn buffer, `attach()`, `events()`), spec 05 (session, storage
  adapters, `onRun` §2.1, locking §8, crash recovery §9, cross-process abort §9.1, durable inbox §12,
  parent/child index §13, fork §14)
- spec 06 (compaction), spec 07 (skills), spec 08 (`FileSystem` incl. `readBytes` / `writeBytes`),
  spec 09 (tool sources, `mcpServer`, deferred tools)
- spec 11 (approvals, pending, `respond()`, external waits, `handleChatRequest`, steering, wake)
- spec 12 (cost, budgets, `BudgetLedger`), spec 13 (todos), spec 14 (memory), spec 18 (permissions),
  spec 20 (subagents: park, messaging), spec 21 (ask), spec 22 (web)
- ADR-0034 (profiles), ADR-0035 (nested approvals park the parent), ADR-0038 (agent messaging),
  ADR-0021 / ADR-0024 / ADR-0027 (abort, inbox, external waits)

## Owns

- `examples/team/**` (new): `server/`, `web/`, `shared/`, `docs/`, scripts
- one-line entries in `examples/README` / `docs/guides/README.md`
- this file and its row on the board

Not owned: `src/**`. Library changes go through the requests list.

---

## 1. Research: what eharness has and what the product needs

### 1.1 Product (v1 scope)

- **Layout** (desktop "bots" app style, only the layout is imitated): left sidebar = agents
  (avatar, name, last-activity preview, time, unread dot), search, "+" new agent; centre = chat with
  the selected agent (messages, attachments as file chips, composer with attach and send); right =
  context panel of the selected agent (routines with status and schedule, files/artifacts,
  current tasks, settings). Mobile: list, then chat, panel as a sheet.
- **Agents.** One lead agent (coordinates, delegates, keeps the user informed), seeded role
  agents (Researcher, Writer, Analyst, Ops; distinct tools, §6.1) and user-created custom agents
  (name, avatar/colour, instructions, skills, tools, routines).
- **Memory layers.** Workspace memory (shared), per-agent memory, and a shared **Library** of
  files the agents write (artifacts).
- **Tasks.** A cross-agent board: Needs action / Running / Done, derived from session state.
- **Approvals.** Human in the loop for risky actions, answered from the web on any instance.
- **Routines.** Scheduled runs per agent ("Morning briefing every day at 9:00"), pause, resume,
  run now; multi-instance safe.
- Out of scope for v1: email, CRM, real deploys. Integrations only through optional,
  user-configured MCP servers. Web search/fetch through `eharness/web`. Single user (a local token,
  or none on localhost); multi-user is later (see Open questions).

### 1.2 Feature map (product feature to eharness API)

| Feature | eharness API | Status |
|---|---|---|
| Agent definition (blueprint) with persistent identity | `defineHarnessAgent()` built per definition by an app factory (`buildAgent(def)`); the definition is data in the DB | app code |
| Conversation and task = session | `agent.session(id, { runtime })`; ids chosen by the app (`dm:<agentId>`, `task:<taskId>`, `routine:<routineId>:<fireAt>`) | have |
| Lead delegates to role agents | `subagents({ agents: () => …, approvals: 'park' })` (ADR-0035): a role agent run is a child session, its approvals park the lead's tool call | have |
| Follow-up to a running or finished role agent | `send_message` is **not offered with `park`** (ADR-0038); across processes the mechanism is `childSession.enqueue(text, { mode: 'steer' })` | partly: close R4 in the library (park-mode `send_message` over the durable inbox) |
| Approvals, modes, rules per agent or workspace | `permissionsPlugin()` (spec 18), `approval.decided` hook with `actor`, `respond({ approvals })`; `approvalGuard` optional | have |
| Questions to the user | `askUser()` client tool, answered through `respond()` (spec 21) | have |
| Pending approvals of child sessions in the UI | `pendingSubagentApprovals()`, `session.children()`, `parentInfo()` (spec 05 §13) | have, per parent only (R1) |
| Workspace and agent memory | `memory({ roots })` on a `FileSystem` (spec 14); `flushOnCompaction` | have |
| Library of files | `filesystem({ fs })` with a **DB-backed `FileSystem`** in the example (`readBytes` / `writeBytes`, versions, `ifVersion`) | have; adapter is example code |
| Todos inside a task | `eharness/todos` | have |
| Web search/fetch | `eharness/web` | have |
| Optional integrations | `mcpServer()` from per-agent settings | have |
| Long chats | compaction, prune, `session.compact()`, budgets, `BudgetLedger` (per-agent daily budget) | have |
| Streaming chat endpoint | `handleChatRequest(session, body, { actor })`, `run.toResponse()`; busy gives 409 | have |
| Reload while a turn streams | `session.attach()` replays and follows the **in-process** turn buffer; cross-process resume is out of scope (spec 04 §6) | **gap R2** |
| Stop a turn on another instance | `session.requestAbort()` (inbox or state path) | have |
| Message to a session on another instance | `session.enqueue()` with a durable `InboxAdapter` (queue, steer, wake, collect) | have; adapter is example code |
| Result of a background run wakes the lead | `inject(…, { wake: true })` and the inbox `wake` item | have |
| Live updates in the UI | `session.events()` (in process only), `onRun` (in process, spec 05 §2.1) | partly: example event table (R3) |
| Cross-session task board | no index: `children()` is per parent, there is no "sessions with pending state" query | **gap R1** |
| Routines (scheduler) | none by design (production-patterns: "cron, queues and timers are your infrastructure"); a wake is `inject({ wake })`; the inbox has internal `availableAt` timers that `enqueue()` does not expose | **gap R5** |
| Restart recovery | `recovery`, `activeTurn` heartbeat, `reconcileSubagentWaits()` (`selfAgent`), `expireWaits()` | have |
| Team/agent registry, memory scopes, renderers for eharness data parts | none | candidates R6–R8 |

### 1.3 Findings that shape the design

1. **One agent object per definition, many sessions.** A `HarnessAgent` holds model, plugins and
   storage; sessions hold history. So an "agent" in the product is a **row** (`agents` table:
   blueprint, version) and the server keeps a small per-instance cache `agentId@version →
   HarnessAgent`. Editing a definition bumps the version; open sessions pick it up on their next
   turn because `agent.session(id)` is called per request.
2. **Two kinds of session per agent.** The **DM** session (`dm:<agentId>`, the chat shown in the
   centre) and **task** sessions (delegated work: child sessions of the lead's DM through
   `subagents`, or runs created by routines). The right panel's "current tasks" and the task board
   read the task sessions.
3. **Park, not inline** (ADR-0034/0035): the lead's tool call waits as an external wait while a
   role agent needs a person. The approval is answered with `respond()` on the **child** session
   (`pendingSubagentApprovals(leadSession, openChild)` lists them), from any instance; the lead
   continues by itself when the child ends. Costs: no `send_message` with park, no background
   (`run_in_background`) children in park mode (spec 20 §1). Both are recorded as R4.
4. **The server owns durability.** Nothing in memory is the only copy: pending approvals live in
   the session state, waits in storage, routine fires in a table with a lease, inbox items in the
   inbox table.
5. **SQLite is enough to test multi-instance on one machine.** Two Bun processes on one WAL-mode
   database file give real races (CAS, claims, leases); a Postgres adapter swap is a Drizzle
   dialect change and not part of v1.

---

## 2. Tech stack

Versions checked against the npm registry on 2026-10-10 (pin exact versions in the package
files; re-check at M1 start).

| Package | Version | Use |
|---|---|---|
| `bun` | repo `packageManager` (1.4.2) | runtime and package manager, everywhere; `bun:sqlite` |
| `ai` / `zod` | root ranges (`^7.0.127` / `^4.6.5`) | one copy, as in P30 §2.1 |
| `hono` | 4.13.13 | HTTP server |
| `@hono/zod-openapi` | 1.6.3 (peers `zod ^4`, `hono >=4.10`) | routes and OpenAPI 3.1 generated from zod (`createRoute`, `app.openapi`, `app.doc31`) |
| `@scalar/hono-api-reference` | 0.12.11 (peer `hono ^4.12.5`) | API reference at `/docs` |
| `drizzle-orm` / `drizzle-kit` | 0.45.4 / 0.31.11 | `bun-sqlite` driver, schema in TS, generated SQL migrations |
| `@ai-sdk/svelte` | 5.0.137 (peer `svelte ^5.31`) | `Chat` class in the web (verify the AI SDK v7 line at M5) |
| `@sveltejs/kit` | 3.0.1 (peers `vite ^8.0.12`, `svelte ^5.57.1`) | web app |
| `svelte` | 5.57.2 (runes) | |
| `tailwindcss` | 4.3.3 | styles |
| `@edmi-ui/tokens`, edmi-ui registry components | latest at M5 | UI kit, copied in (shadcn-svelte registry) |
| `croner` (optional) | verify at M7 | cron expression parsing only (no timers); else a 30-line parser for the preset set |

New dependencies live in `examples/team/*/package.json` only (CLAUDE.md rule 10 concerns the
library). Elysia was checked for comparison, see Alternatives considered.

### 2.1 Server framework decision: Hono + `@hono/zod-openapi` + Scalar

- The spec is **the code**: one zod schema validates requests, types handlers and produces the
  OpenAPI 3.1 document; no hand-kept YAML. The same zod 4 as eharness and the tools.
- `defineOpenAPIRoute` / `app.openapiRoutes([...] as const)` keep routes in small modules; small
  `OpenAPIHono` apps are combined with `.route()` per domain, which is the layering we want.
- Web-standard `Request`/`Response`: `handleChatRequest(...).toResponse()` returns a `Response`,
  so the streaming route is one line and the server stays runtime-neutral (Bun here, Node later).
- `hc` RPC client types are available for the web, but the web uses the generated OpenAPI types
  (`openapi-typescript`, §3) so the contract stays language-neutral.
- Scalar mounts at `/docs` from `/openapi.json` (`Scalar({ url })`); confirm the exact option
  names in its README at M1.

### 2.2 Web install (official commands, from the maintainer's research)

```bash
bunx sv create web            # SvelteKit 3, TypeScript, add: tailwindcss
bunx --bun shadcn-svelte@latest init          # style nova, icons phosphor
bunx --bun shadcn-svelte@latest add \
  https://viandwi24.github.io/edmi-ui/r/svelte/theme.json \
  https://viandwi24.github.io/edmi-ui/r/svelte/all.json --overwrite
bunx --bun shadcn-svelte@latest add \
  https://viandwi24.github.io/edmi-ui/r/svelte/ai-all.json --overwrite
bun add @edmi-ui/tokens
```

Per CLAUDE.md rule 9: run these, do not hand-write generated files; read the then-current
`sv create` and shadcn-svelte docs first (flags change). edmi-ui facts: a shadcn-svelte copy-in
registry on Bits UI with shared OKLCH tokens; UI kit (sidebar, data-table, tabs, sheet, patterns
`agent-card`, `kanban-column`, `task-list`) and AI kit (Conversation, Message with
MessageAvatar/MessageHeader, PromptInput / ChatComposer, Reasoning, Tool + ToolStatusBadge
(AI SDK v7 states), Confirmation, Attachments, ModelSelector, Context, Artifact*, AgentAvatar,
Queue / Task / Plan). It is **presentational only**: no `@ai-sdk/svelte` wiring and no renderers
for eharness data parts, so the example writes the mapper (§7.3).

### 2.3 Workspace wiring (as examples/coder)

- Root `package.json` `workspaces`: `[".", "examples/coder", "examples/team/server", "examples/team/web", "examples/team/shared"]`
  (an empty changeset for that commit, as in P30 §2.1).
- Each member is private; `eharness` is **not** a dependency: resolved to `src/` through the
  `paths` of a tsconfig extending `examples/tsconfig.json`. The SvelteKit web must not import
  `eharness` at all (browser bundle); it only uses `ai`'s UI types.
- Root `typecheck` script gains `tsc --noEmit -p examples/team/server`, `-p examples/team/shared`
  and `svelte-check` for the web. `examples/tsconfig.json` `exclude` gains `team`.
- `bun run check:imports` is unchanged: the example imports `eharness/*` subpaths only.

---

## 3. Layout

```
examples/team/
  README.md
  docs/                      # product + API notes: architecture, memory model, run & deploy
  shared/                    # generated, never edited
    openapi.json             # exported by `bun run openapi` from the server
    api.d.ts                 # openapi-typescript output, imported by the web
  server/
    package.json  tsconfig.json  drizzle.config.ts
    drizzle/                 # generated SQL migrations (drizzle-kit generate)
    src/
      main.ts                # boot: config, db, wiring, http, scheduler, recovery
      domain/                # pure: types, rules, no I/O, no eharness imports
        agents.ts tasks.ts routines.ts library.ts memory.ts approvals.ts ids.ts
      app/                   # use cases (functions taking ports): createAgent, startTask,
                             #   answerApproval, runRoutine, boardQuery, …
      infra/
        db/                  # schema.ts (drizzle), client.ts, repositories
        eh/                  # eharness wiring (below)
          agent-factory.ts   # definition -> HarnessAgent (cached per instance)
          storage.ts         # MessageAdapter, StateAdapter, InboxAdapter, BudgetLedger on SQLite
          library-fs.ts      # FileSystem over the library tables
          task-index.ts      # plugin: turn/approval hooks -> task rows + events
          roster.ts          # lead tools: delegate (agent), send_message
        scheduler/           # routine ticker with lease
        mcp/                 # per-agent MCP servers
        auth.ts logger.ts
      http/
        app.ts               # OpenAPIHono root, /openapi.json, /docs, error mapping
        routes/              # agents, chats, tasks, routines, library, memory, settings, events
        schemas/             # zod schemas shared by routes (named with .openapi('Name'))
    test/                    # unit, integration, e2e (§10)
  web/                       # SvelteKit 3 (§8)
  scripts/                   # dev (server + web), two-instance, kill-restart, smoke
```

Layering rules (checked by a small test that greps imports, like `check:imports`):
`domain` imports nothing; `app` imports `domain` and port types; `infra` implements ports and is
the only layer importing `eharness`, `drizzle-orm` and `bun:sqlite`; `http` imports `app`
and `schemas` only; `main.ts` is the only composition root.

---

## 4. Domain model

Ids are UUIDv7 (time-sortable, `src/messages/ids.ts` style; the example uses its own generator in
`domain/ids.ts`, prefixes only in session ids).

| Entity | Fields (essential) | Notes |
|---|---|---|
| `Workspace` | `id`, `name`, `settings` (default mode, default model, budgets) | one row in v1 |
| `AgentDef` | `id`, `workspaceId`, `slug`, `name`, `role` (`lead`/`role`/`custom`), `avatar`, `color`, `instructions`, `model`, `tools[]` (names from a fixed catalog), `skills[]`, `mcp[]`, `permissionMode`, `rules`, `version`, `archivedAt` | blueprint; `version` bumps on edit |
| `Chat` (DM) | `agentId`, `sessionId = dm:<agentId>`, `lastMessageAt`, `lastPreview`, `unread` | one per agent in v1 |
| `Task` | `id`, `agentId`, `sessionId`, `parentSessionId?`, `origin` (`user`/`lead`/`routine`), `title`, `state` (`needs_action`/`running`/`done`/`failed`/`cancelled`), `pendingKind?`, `startedAt`, `endedAt?`, `summary?` | an index **derived** from sessions (R1); the session stays the truth |
| `Approval` view | computed from pending state: `sessionId`, `approvalId`, `toolName`, `input`, `risk`, `agentId` | not a table; cached in `tasks.pendingKind` for the board |
| `Routine` | `id`, `agentId`, `name`, `prompt`, `schedule` (`{ kind: 'cron', expr, tz }` or `{ kind: 'every', ms }`), `enabled`, `nextRunAt`, `leaseOwner?`, `leaseUntil?`, `lastRunAt?`, `lastStatus?` | §6.6 |
| `RoutineRun` | PK (`routineId`, `fireAt`), `taskId`, `startedAt`, `status` | the unique key makes a fire idempotent |
| `LibraryFile` | `path`, `version`, `bytes`/`text`, `mediaType`, `size`, `createdByAgentId?`, `updatedAt` | the shared `FileSystem` |
| `MemoryFile` | stored in the same file table under `/memories/workspace/…` and `/memories/agents/<agentId>/…` | memory is files (ADR-0022) |
| `Event` | `seq` (autoincrement), `type`, `payload`, `createdAt` | feed for the UI (§5.3), trimmed |
| eharness tables | `eh_messages`, `eh_state`, `eh_inbox`, `eh_budget` | owned by the adapters in `infra/eh/storage.ts`; the same conformance suites as the library (`messageAdapterConformance`, `inboxAdapterConformance`, …) run against them in M2 |

Drizzle schema in `infra/db/schema.ts`; migrations by `bunx drizzle-kit generate` and applied at
boot (`migrate()`), never hand-written. SQLite settings: WAL, `busy_timeout`, `BEGIN IMMEDIATE`
for every CAS/claim so two processes serialize correctly.

---

## 5. HTTP API

All JSON unless noted. Bearer token from `TEAM_TOKEN` (absent on localhost = open). Errors:
`{ error: { code, message } }` with eharness codes passed through (`EH_SESSION_BUSY` is 409).
Every route is declared with `createRoute` and named zod schemas, so `/openapi.json` (OpenAPI
3.1) is complete. `GET /docs` serves Scalar; `GET /openapi.json` the document; `bun run openapi`
writes `shared/openapi.json` and the web's `api.d.ts`. Tags per domain: `agents`, `chats`,
`tasks`, `routines`, `library`, `memory`, `settings`, `events`.

### 5.1 Resources

| Resource | Routes |
|---|---|
| agents | `GET/POST /agents`, `GET/PATCH/DELETE /agents/{id}` (delete = archive), `GET /agents/{id}/context` (routines, files, current tasks in one call for the right panel) |
| chats | `GET /agents/{id}/messages?before=&limit=` (stored UI messages), `POST /agents/{id}/chat` (stream), `GET /agents/{id}/chat/stream` (attach), `POST /agents/{id}/chat/abort`, `POST /agents/{id}/chat/compact`, `GET /agents/{id}/chat/status` |
| uploads | `POST /files` (multipart, into the library `/uploads/…`, returns a path and media type); a message references it as a `file` part |
| tasks | `GET /tasks?state=&agentId=`, `GET /tasks/{id}`, `GET /tasks/{id}/messages`, `POST /tasks/{id}/approvals` (answer, §5.2), `POST /tasks/{id}/abort`, `POST /tasks/{id}/messages` (message to a task's agent, §6.2) |
| routines | `GET/POST /agents/{id}/routines`, `PATCH/DELETE /routines/{id}`, `POST /routines/{id}/pause`, `/resume`, `/run` |
| library | `GET /library?prefix=`, `GET /library/file?path=` (bytes with media type), `PUT /library/file`, `DELETE /library/file` (with `ifVersion`) |
| memory | `GET/PUT /memory/workspace/{path}`, `GET/PUT /agents/{id}/memory/{path}` (the same files the agents edit) |
| settings | `GET/PATCH /settings` (workspace), `GET /models` (catalog with prices), `GET /usage` (cost per agent/day) |
| events | `GET /events?after=<seq>` (SSE), see §5.3 |

### 5.2 Streaming and approvals (the chat contract)

Reference behaviour: spec 04, spec 05 §2, spec 11 §4, §7.

- **`POST /agents/{id}/chat`** body = `ChatRequestBody` (AI SDK `useChat` shape). The route builds
  `agents.session('dm:<id>', { runtime: { workspaceId, actor } })` and returns
  `handleChatRequest(session, body, { actor, ifBusy: 'steer' }).toResponse()`. The server rebuilds
  nothing from client history (spec 11 §7, §8). OpenAPI documents the request and the stream as
  `text/event-stream` (UI message stream protocol) with an `x-` note; the chunk shapes are the AI
  SDK's, not ours (ADR-0001).
- **Approvals.** A turn ending `tool-pending` leaves the assistant message with
  `approval-requested` parts. The web answers by posting the assistant message back with
  `approval-responded` parts to the same chat endpoint (`useChat`'s
  `addToolApprovalResponse` + `sendAutomaticallyWhen`), which `handleChatRequest` maps to
  `respond()` and streams into the **same** message. For approvals of **other** sessions (a role
  agent's child session, a routine run) the board uses `POST /tasks/{id}/approvals` with
  `{ approvals: [{ id, approved, note? }], answers? }` which calls
  `agent.session(task.sessionId).respond(...)` on whichever instance receives it, and streams
  nothing: the continuation runs server side and its progress reaches the UI through events.
  `ask_user_question` answers use the same body (`output`).
- **Reload and attach.** `GET .../chat/stream` returns `session.attach()?.toResponse()`
  (replay then follow) or `204` when idle; the web's `resume` calls it. When the turn runs on
  another instance the buffer is not there (spec 04 §6): the route answers
  `409`-free `202 { running: 'elsewhere' }`, and the web falls back to events and refetching the
  message at turn end. Closing the gap is **R2**.
- **Abort.** `POST .../chat/abort` -> `session.requestAbort()`; the response names the target
  (`local` / `remote` / `idle`).
- **Message while a turn runs.** `ifBusy: 'steer'` on the same instance; on another instance the
  route calls `session.enqueue(input, { mode: 'steer' })` first (multi-instance guide pattern) and
  answers `202 { inboxId }`.
- **Wake turns** (a routine result, a child report) are not initiated by a request: the instance
  that runs them records them through `onRun` / the task-index plugin (§6.4).

### 5.3 Events feed

One SSE stream `GET /events?after=<seq>` for the sidebar and the board: `message-added` (preview,
unread), `task-changed`, `approval-needed`, `routine-fired`, `agent-changed`, `file-changed`.
Rows are written to the `events` table by the instance that observes the change (hooks, §6.4),
every instance tails the table (poll every 500 ms; SQLite has no notify) so a client connected to
instance B sees what instance A did. This is app infrastructure in v1 and the request R3 asks for
a library-level cross-instance session event feed.

---

## 6. Behaviour

### 6.1 Agents

- Built by `agent-factory.ts`: model from the definition, plugin list in a **fixed order**
  (prompt-cache prefix, `toolOrder`): `filesystem` (library) → `memory` → `todos` → `web` →
  `permissions` → `ask` → optional `mcpServer`s → for the lead `subagents` and the roster tools →
  `taskIndex`. Static instructions first; volatile things (current date, unread counts, the
  roster of agents) go in turn reminders, never `instructions` (spec 02 §5).
- Seeds (editable, `app/seed.ts`): **Lead** (tools: delegate, `send_message`, todos, memory read,
  library read; instructions: plan, delegate, report back, ask the user when blocked),
  **Researcher** (web search/fetch, library write `/research/…`), **Writer** (library
  read/write, no web), **Analyst** (read library files, a pure `compute` tool or `run_script`
  only if a sandbox driver is configured; off by default), **Ops** (MCP servers the user
  configured; every tool risk `external` asks).
- Custom agents choose from the catalog; the catalog is code, so a definition cannot invent a
  tool. Skills are folders in the library (`/skills/<name>/SKILL.md`, spec 07 `fsSkillSource`),
  workspace-wide or agent-scoped.
- The lead's `subagents({ agents: () => roleAgentsFromDb(), approvals: 'park', parkTimeoutMs })`
  re-reads the roster once per session (the option accepts a function). Role agents install
  `subagentChild({ parent: () => leadAgent })`. Sessions of a role agent reached through the lead
  are `${leadSession}:agent:${toolCallId}` (library default); the DM sessions are unrelated.
- Boot of every instance registers the same plugin set (required for waits, ADR-0035), and the
  lead agent gets `selfAgent` so waits reconcile after a crash.

### 6.2 Delegation and follow-up

- **Delegate:** the model calls `agent({ agent: 'researcher', prompt })` (park). A task row is
  created by the task-index plugin from `data-subagent.run` and the child index; it shows in the
  right panel of both the lead and the role agent and on the board.
- **Message an agent:** the user messages a role agent directly in its DM (own session). Agents
  message each other with the library's `send_message` (ADR-0038). It is not offered in park mode
  today (R4): **R4 is closed in the library during M4**, not worked around in the example — the
  park-mode variant delivers through the durable inbox (`enqueue(…, { mode: 'steer' | 'queue' })`
  on the target's session, any instance) with the same `<agent-message>` framing, throttling and
  the "no agent message is user approval" rule. Only if that library change is blocked does the
  example ship a temporary tool, recorded as a workaround to remove.
- Reports return to the lead as the park result; a role agent reply to a DM-initiated task is
  stored in its own chat and surfaces in the sidebar preview.

### 6.3 Memory and Library

- **Workspace memory** `/memories/workspace` (all agents read; write on for the lead and
  explicit roles), **agent memory** `/memories/agents/<id>` (write for that agent only). Roots come
  from `memory({ roots: (ctx) => … })` using `ctx.runtime.agentId`. `pinned` shows
  `profile.md` of both. `flushOnCompaction: true`. `hiddenPrefixes: ['/memories']` keeps file tools
  off memory.
- **Library**: `/library/**` is the artifact space; `write_file` by an agent emits a `file-changed`
  event (an `onWrite`-style hook on the example's `FileSystem` wrapper) and the file shows in the
  right panel with the creating agent. Uploads land in `/uploads`. Binary files use
  `readBytes`/`writeBytes`; an image or PDF reaches the model through `read_file` media outputs.
  The DB-backed `FileSystem` implements `list`, `stat`, `grep` (SQL `LIKE` + regex filter), `glob`,
  `move`, versions as content hashes, and runs `fileSystemConformance(..., { requireBytes: true })`.
- Users edit files and memory through the same API; edits use `ifVersion`, so a stale edit loses
  to an agent write and the UI shows the conflict.

### 6.4 Tasks and the board

State comes from session facts, never from a parallel store of truth:

- **Needs action** = `state.core.pending` non-empty (approvals, `ask_user_question`) on a task
  session or on a DM session, or a parked wait whose child has pending state.
- **Running** = the session has an `activeTurn` or a background run in progress.
- **Done** = last assistant message stop is not `tool-pending` and no active turn.

The `taskIndex` plugin (hooks `turn.start`, `turn.end`, plus approval events) upserts the `tasks`
row and appends an `events` row on **whichever instance runs the turn**, so the board survives
restarts and is the same for every instance. A reconcile pass at boot (and every minute) re-reads
`session.stats()` / pending of tasks not in a terminal state and fixes drift (a crashed instance
never ran `turn.end`). `GET /tasks?state=needs_action` is a table read. The need for a library
index of "sessions with pending state" is **R1**.

### 6.5 Approvals

- `permissionsPlugin` per agent: a default mode from the definition (`default`, `acceptEdits`,
  `plan`, `dontAsk`, `bypassPermissions` where allowed) with workspace overrides. Library
  write is allowed, shell absent, MCP and `web_fetch` to unknown hosts ask. Rules come from
  settings (`Tool(spec)`).
- `approval.decided` receives `actor` from the request (the single user), and the decision is
  stored on the event feed. "Always allow for this agent" appends a rule to the definition
  (version bump) rather than keeping session memory.
- Routine runs have no human at the time: a routine's mode defaults to `dontAsk` for tools that
  would ask, and tools that need a person leave the run in **Needs action** (parked at
  `tool-pending`), answerable later from the board. Spend limits come from `BudgetLedger`
  (per-agent daily USD) so an unattended routine cannot run away.

### 6.6 Routines (scheduler, multi-instance safe)

eharness ships no scheduler on purpose; the example implements the **app-side** pattern and
records what a library helper should do (R5).

- Every instance runs a ticker (every 15 s). One iteration claims due routines atomically in a
  single statement: `UPDATE routines SET lease_owner=?, lease_until=now+60s WHERE enabled AND
  next_run_at <= now AND (lease_until IS NULL OR lease_until < now) RETURNING …`.
- For each claimed routine the claimer inserts `routine_runs (routine_id, fire_at)`; the primary
  key makes a double fire impossible (idempotent under lease expiry and clock skew). It then
  creates a task session `routine:<routineId>:<fireAt>` (a fresh context per run, plus the agent
  memory) and starts the turn with `session.send(prompt)` (or `enqueue` so a different instance
  that already holds the session applies it), advances `next_run_at` to the next fire and clears
  the lease. Missed fires after downtime run **once** (catch-up policy `latest`, configurable
  `skip`).
- `pause` / `resume` toggle `enabled` (and recompute `next_run_at` on resume); `run now` is a fire
  with `fireAt = now` and the same insert. Cron with timezone through `croner` for parsing only.
- The "silent OK" pattern from production-patterns (a `nothing_to_report` tool and a `step.end`
  stop) keeps quiet routines out of the unread count.
- The run's final assistant text becomes a message in the agent's DM (an `inject('eh.event', …)`
  marked `routine`) so the user sees "Morning briefing" in the sidebar preview.

### 6.7 Settings, cost and limits

Per-agent model (catalog from `eharness` models), daily budget, `maxSteps`/progress guard defaults,
compaction defaults. `GET /usage` aggregates `costUsd` stored per turn (assistant message
`metadata.eharness`). Auth: single token; every route reads it in one middleware; `actor` is
`{ id: 'owner' }`.

---

## 7. Web UI (SvelteKit 3, Svelte 5 runes, Tailwind 4, edmi-ui)

SvelteKit is **only a UI**: `ssr = false` for the app routes, a typed `fetch` client from
`shared/api.d.ts`, no server `load` that talks to storage, one `PUBLIC_API_URL`.

### 7.1 Screens

| Route | Content |
|---|---|
| `/` | three-pane shell (edmi-ui `sidebar` + panes; mobile: list -> chat -> panel sheet) |
| `/a/[agentId]` | chat with the agent, right panel with tabs **Routines**, **Files**, **Tasks**, **Settings** |
| `/tasks` | board: **Needs action** / **Running** / **Done** (`kanban-column`, `task-list` patterns); a card opens a drawer with the task transcript and approval controls |
| `/library` | file browser and viewer (text, markdown, image, PDF), history of the creating agent |
| `/agents/new`, `/a/[id]/settings` | agent editor: name, avatar/colour (`AgentAvatar`), instructions, model (`ModelSelector`), tools, skills, MCP, permission mode and rules |
| `/settings` | workspace memory editor, default mode, budgets, usage |

Left sidebar items show avatar, name, last-activity preview, time and an unread dot (from the
events feed and `lastReadMessageId` kept server side per agent); search filters locally. "+" opens
the agent editor with a template picker.

### 7.2 Chat wiring

`@ai-sdk/svelte` `Chat` with `DefaultChatTransport({ api: '/agents/{id}/chat', prepareSendMessagesRequest })`
(send only the last message and the chat id, as spec 11 §7), `resume: true` against the attach
route, `sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses` (AI SDK
helper, verify the name for the v7 line), `chat.addToolApprovalResponse({ id, approved, reason })`
from the approval card. Initial messages come from `GET /agents/{id}/messages`; after a
continuation (respond) ends the message is refetched (spec 11 §7 resume caveat).

### 7.3 UIMessage parts -> components mapper (example code, `web/src/lib/parts`)

| Part | Component |
|---|---|
| `text` | `Message` / `MessageContent` (markdown) |
| `reasoning` | `Reasoning` with `durationMs` from the chunk metadata (R20 of P31) |
| `tool-*` / `dynamic-tool` | `Tool` + `ToolStatusBadge`; states `input-streaming`, `input-available`, `approval-requested` (-> `Confirmation` approve/reject, wired to `addToolApprovalResponse`), `output-available`, `output-error`, `output-denied` |
| `file` | `Attachments` chips (library links) |
| `data-subagent.run` | a run card: agent avatar, status, report preview, "open task" |
| `data-eh.input` | a "message delivered mid-turn" chip |
| `data-todos.list` | `Plan` / `Task` list |
| kind messages (`eh.compaction`, `eh.event`) | divider rows ("Conversation summarised", "Routine: Morning briefing") |
| `ask_user_question` client tool | question card with options, posts the answer |

Multi-agent attribution uses `MessageHeader` / `MessageAvatar` from the part's agent (the DM
shows its agent; the task drawer shows child agents). Parts are filtered like the model view:
transient parts never render from storage.

---

## 8. Multi-instance and restart

Everything in profile (c) must survive:

| Scenario | Expectation | Mechanism |
|---|---|---|
| Server killed mid-turn | the turn is marked interrupted on next contact; unanswered tool calls get `Interrupted:` results; no re-execution (ADR-0014) | `recovery`, heartbeat |
| Killed while an approval is pending | the approval is still answerable after restart, on either instance | pending state in `eh_state` |
| Killed while a role agent's child awaits approval | the lead stays parked; the child's approval answers; the lead continues when the child ends | ADR-0035, `selfAgent` reconcile |
| Approval answered on instance B, turn lived on A | exactly one winner, continuation runs on B | `StateAdapter.setIf` / lock, consume-once |
| Stop pressed on B, turn on A | A aborts within one poll | `requestAbort` + inbox/state path |
| Message sent to a busy chat on another instance | steered into the running turn, or queued | durable inbox `enqueue` |
| Two instances tick the scheduler | every fire runs exactly once | lease + `routine_runs` PK |
| Instance dies holding a routine lease | another instance takes it after `lease_until` and fires once | lease expiry |
| Reload while a turn streams (same instance) | replay and follow | `attach()` |
| Reload while the turn runs on another instance | UI shows "running" and refreshes at the end (until R2) | events feed |

Scripts (`examples/team/scripts`): `two-instances.ts` starts two servers (ports 4001 / 4002, one
database file) behind a tiny round-robin proxy; `kill-restart.ts` drives scenarios from the table
with `SIGKILL`; both use a **scripted model** so the runs are deterministic.

---

## 9. Testing strategy

Per the project memory ("dev first, test last"): implementers build a whole milestone first and
run **one** gate at its end (`bun run lint && bun run typecheck && bun test`).

1. **Unit** (`domain/`, `app/`): schedule maths (cron, catch-up), board state derivation, rule
   evaluation, id ordering, layering test.
2. **Adapter conformance**: `messageAdapterConformance`, `stateAdapterConformance`,
   `inboxAdapterConformance`, `fileSystemConformance`, budget ledger conformance from
   `eharness/testing` against the SQLite adapters (file database in a temp dir). Failures here are
   library or adapter findings.
3. **Integration with scripted models** (`eharness/testing` mock models): lead delegates to a role
   agent, role agent needs approval, parked wait, approval answered through the HTTP route,
   lead completes; restart in the middle by recreating the agents over the same database;
   routine fires once under two tickers.
4. **HTTP e2e** (`app.request()` of Hono, no network): every route in the OpenAPI document is hit
   at least once; a contract test validates responses against the generated schema; the stream
   endpoint is parsed with the AI SDK stream reader; the spec file is regenerated and diffed
   (fails when `shared/openapi.json` is stale).
5. **Process tests**: the two-instance and kill/restart scripts run in CI as a separate step
   (still scripted models, no network).
6. **Web**: `svelte-check`, plus component tests with `vitest` and `@testing-library/svelte` for
   the parts mapper and the approval card, fed by recorded UI message fixtures (from the server
   tests). No Playwright in v1 (a manual checklist in `docs/`).
7. **Real-model smoke** (`scripts/smoke.ts`, optional, key from the environment, never in CI):
   chat, delegation with one approval, a routine "run now", a file written to the library.

---

## 10. Milestones and checklist

Dev first, one gate at the end of each milestone. Update this file and the board per milestone.

### M1 — Workspace and server skeleton

- [x] Root `workspaces`, tsconfigs, typecheck script, empty changeset
- [x] Re-check the version table; `bun add` the server deps; drizzle config
- [x] `domain/`, `app/`, `infra/db` (schema, migrations by drizzle-kit), `http/app.ts` with
  `/openapi.json`, `/docs` (Scalar), error mapping, token auth
- [x] Agents CRUD with seeds; layering test; OpenAPI export script

### M2 — eharness on SQLite

- [x] `MessageAdapter`, `StateAdapter` (`setIf`), `SessionLock`, `InboxAdapter`, `BudgetLedger`
  on `bun:sqlite`; conformance suites green
- [x] DB-backed library `FileSystem` (bytes, versions, grep, glob, move); conformance green
- [x] `agent-factory` (plugin order, memory roots, permissions), cache by version (M4 hooks left as TODO: `subagents`, MCP, `taskIndex`)

### M3 — Chat endpoints

- [x] SQLite `StreamLogAdapter` (`infra/eh/stream-log.ts`, tables `eh_stream_log` / `eh_stream_chunks`, poll-only, `expire`) wired as `storage.streams`; `streamLogConformance` green
- [x] `POST /agents/{id}/chat` via `handleChatRequest` (last message only, file parts checked, `library:` upload refs resolved), `GET /agents/{id}/chat/stream` (`handleResumeRequest`, 204 when idle), `POST /agents/{id}/chat/abort`, `GET /agents/{id}/messages`, `POST /agents/{id}/compact`, `GET /agents/{id}/stats`, `POST /library/files` (multipart)
- [x] Busy handling and error mapping, documented in OpenAPI: user message while busy = steer here / inbox steer + `202` on another instance / `?ifBusy=reject` and approvals, regenerate, edit = `409 EH_SESSION_BUSY`; `EH_INVALID_INPUT` 400, `EH_SESSION_CLOSED` 409
- [x] Integration tests with scripted models (`server/test/chat.test.ts`): text, tool, approval approve/deny (same message id, consume-once), resume and cursor resume from a second `compose()` on the same DB file, abort from the second instance, 204 idle, steer / 202 / 409, uploads and limits

Routes added in M3 differ from §5.1 in two names: compaction is `POST /agents/{id}/compact` and
the status call is `GET /agents/{id}/stats` (context, usage, active turn, pending approvals);
uploads are `POST /library/files` and return a `library:///uploads/…` url to use as the `url` of a
`file` part (the server turns it into a data URL; clients never name other paths).

### M4 — Lead, role agents, tasks

- [x] `subagents` park config on the lead (roster from the DB, `messageTool` / `outputTool` / `stopTool`, `selfAgent`, spawn cap = `maxConcurrent`, `maxDepth: 1`, `parkTimeoutMs`), role agents as park children (`subagents({ agents: {}, approvals: 'park', parentAgent, selfAgent })`), per-workspace budget ledger scope `workspace:<id>` (`TEAM_BUDGET_USD`); lead / role prompts in `domain/prompts.ts` (D4: a convention, our own words). R4 is closed in the library (ADR-0041): `send_message` resumes a finished role agent across instances, tested here
- [x] `taskIndex` plugin (`infra/eh/task-index.ts`: hooks `turn.start`, `turn.end`, `approval.decided`, `tool.after`), `tasks` and `events` tables (migration `0002_tasks_events_feed`), routes `GET /tasks`, `GET /tasks/{id}`, `GET /approvals`, `POST /approvals/{id}`, `GET /events`, `GET /events/stream` (SSE, polls the table: every instance tails it), `GET /agents/{id}/sessions`, `POST /agents/{id}/read`, `GET /agents` with `lastActivity`
- [x] Boot / periodic repair (`infra/eh/team-service.ts` `reconcile()`: `reconcileSubagentWaits` over the lead DM and the parents of unfinished tasks, then a task drift pass; `selfAgent` also reconciles on session open)
- [x] Integration tests (`server/test/team.test.ts`, scripted models, two `compose()` instances on one database file): delegate with park, approval listed and answered from the second instance (note, deny with reason, question), child continues and the lead resumes by itself, task rows and events, `send_message` resume, restart (instance closed between park and answer), crash gap (child finished without the wait resolved, healed by reconcile), drift repair, SSE across instances

Routes added in M4 differ from §5.1: approvals of any session are `GET /approvals` +
`POST /approvals/{id}` (`id` is the approval id, or the tool call id of an `ask_user_question`;
`sessionId` in the body disambiguates; body `{ approved, reason?, note?, endTurn? }` or
`{ answers }`), not `POST /tasks/{id}/approvals`; the SSE feed is `GET /events/stream` and
`GET /events?after=` is plain JSON; the task status words are `needs_action | running | done |
failed | stopped`. Not done (later): `POST /tasks/{id}/abort`, `POST /tasks/{id}/messages` (use the
lead's `send_message`, or M6 adds them), `GET /agents/{id}/context`.

Notes from building M4:

- The spawn cap is `maxConcurrent` of the lead's plugin: in park mode a slot is held only while a
  child's first turn runs, so it limits a burst of delegations, not the number of live tasks (see
  R20). The workspace ledger counts USD only for priced models: M4 passes no `models` price
  catalog, so `TEAM_BUDGET_USD` limits nothing until the usage screen (M8) wires a catalog.
- Opening a lead session starts a detached `reconcileSubagentWaits` (library behaviour with
  `selfAgent`): listing approvals or reading a DM can therefore resume a parked lead (a model
  call). That is the intended heal, but it makes "read" calls not side-effect free (R18).

### M5 — Web shell and chat

- [ ] Run the official install commands (§2.2); three-pane layout, sidebar with preview/unread/search
- [ ] `Chat` wiring, parts mapper, approval card, attachments, markdown, responsive behaviour
- [ ] Generated API types; component tests for the mapper

### M6 — Context panel, board, library, memory

Server side (done, `server/test/workspace.test.ts`; the web screens are still open):

- [x] Library routes: `GET /library?prefix=` (creator agent, size, media type, `updatedAt`), `GET /library/file` (text inline as JSON, binary or `raw=true` as a download, `inline=true` for images and PDF), `GET /library/versions` (metadata history, table `library_history`), `PUT /library/file` (text by the user, `ifVersion`: a stale edit loses to an agent write, 409 `VERSION_CONFLICT` with `error.details.currentVersion`), `DELETE /library/file`, `POST /library/move`; every change of any file reaches the events feed as `file-changed` (library-fs `onChange` hook, with `area` library / upload / memory)
- [x] Memory routes: `GET /memory?scope=workspace|agent&agentId=`, `GET/PUT/DELETE /memory/file?scope&agentId&path` (the factory's memory roots, same `ifVersion` rules)
- [x] Settings: `GET/PATCH /settings` (default permission mode, budget USD, spawn cap, default model) in the `settings` table, read by the factory on every `agentFor` (the settings revision is part of the cache key; the budget limit is applied to the shared ledger row); `default` as an agent's own mode means "the workspace default"
- [x] Permission modes (Manual = `default`, Auto = `auto`, Bypass = `bypassPermissions`; no acceptEdits/plan): per-session mode in `session_modes` (`GET/PUT /agents/{id}/mode`, `mode-changed` event), read per tool call through `permissionsPlugin({ mode })` with one engine per live session (`infra/eh/permission-plugin.ts`, so Auto block counters are per chat). Resolution (`domain/modes.ts`): the chat's pick, else (children) the delegating chat's effective mode, else the agent's own mode, else the Settings default; an agent's own mode is its ceiling (pinned Manual never runs Auto/Bypass); Auto needs a classifier (`TEAM_CLASSIFIER_MODEL`, default `TEAM_MODEL`; not offered with a scripted model). Agent storage stays compatible: `default` = inherit, legacy `acceptEdits`/`plan`/`dontAsk` display and run as Manual. Routines use the workspace default (no per-routine mode yet).
- [x] Tasks: `POST /tasks/{id}/abort` (`requestAbort`, any instance), `POST /tasks/{id}/messages` (user message into the task session through `enqueue` steer / queue), `GET /agents/{id}/context` (stats, tools, memory file lists, routines, current tasks, latest files)
- [x] Chat route on the new library APIs: `inputFiles.resolve` keeps `library://` upload references in stored messages (no base64), `session.busy()` replaces the copied 120 s check, `session.stats().usage` replaces the 5 000-message sum (usage is now `{ inputTokens, outputTokens, totalTokens, costUsd, turns }`), `run.toHttpResponse()` answers pre-commit failures with a status (a stale approval answer is now a 400, not an error chunk in a 200)
- [ ] Right panel tabs, `/tasks` board with drawer and approvals, library browser, memory editors (web)
- [ ] Agent editor and settings screens (web)

### M7 — Routines

Server side (done, `server/test/routines.test.ts`; the web editor is still open):

- [x] SQLite inbox `enqueueOnce` (table `eh_inbox_keys`, key kept while the item is stored and 24 h after the ack, purged on the next `enqueueOnce`); `availableAt` was already there; `inboxAdapterConformance` runs with `requireDedupe`
- [x] Tables `routines` (spec cron+tz | everyMs | at, prompt, session mode `dm` | `task`, overlap `skip` | `queue`, catch-up window, status `active` | `paused` + reason, `nextFireAt`, `lastFireAt`, failures / `maxFailures`, `maxFires`, `endAt`) and `routine_runs` (unique `(routine_id, scheduled_at)`); migrations `0003` / `0004` are generated by drizzle-kit (the M1 lease-based placeholder tables were dropped, never used)
- [x] Ticker in every instance (`infra/eh/routine-service.ts`, `tickMs` default 15 s, `TEAM_ROUTINE_TICK_MS`): recover stale `claimed` runs, claim due rows with a compare-and-set on `next_fire_at` (+ the run row in the same transaction), next slot by `croner` (IANA tz), `session.enqueue(prompt, { mode: 'queue', id: 'sched:<id>:<slot>', availableAt })`, overlap skip through `agent.peek()` (`busy`, inbox stats, pending), missed slots skipped (one `skipped` run) or the latest fired within `catchUpWindowMs`, sweeper over `inbox.pending()`
- [x] Outcomes: plugin `routineOutcomes` on every agent maps turn ends to `succeeded` / `failed` / `needs_action`; consecutive failures pause the routine; a fire that needs approval is a task of origin `routine` in `GET /approvals` (no auto-approve, the overlap guard skips later fires while it waits)
- [x] Routes: `GET/POST /routines`, `GET/PATCH/DELETE /routines/{id}`, `POST /routines/{id}/pause|resume|run`, `GET /routines/{id}/runs`; events `routine-fired` (every run status change) and `routine-changed`
- [x] Tests: two tickers fire once, direct CAS race on two connections, missed fires skipped / catch-up window, overlap skip and queue, pause / resume recompute, one-shot and `maxFires`, dedupe on retry (recovery), failures auto-pause, approval of an unattended run, DM mode with run now
- [ ] "Silent OK" pattern (`nothing_to_report`) and the run's final text as a marked message in the agent DM for task-mode fires (not done)
- [ ] Routine editor and status in the panel (web)

### M8 — Multi-instance and polish

- [x] `two-instances.ts`, `kill-restart.ts` (table in §8; commit `265f547`, scripts in `examples/team/scripts`, README there), events tailing across instances (checked by `two-instances.ts`: B's `/events/stream` carries A's events)
- [x] Optional MCP per agent, server side: `agents.mcp_servers` (migration `0005_mcp_servers`), `mcpServers: [{ name, transport: { type: 'http' | 'sse', url, headers? }, allow?, deny? }]`, no stdio (a server example must not spawn processes for an editable definition, and another instance would not have them), headers stored server-side and returned as `headerNames` only (an edit without `headers` keeps them), the factory adds `mcpServer({ defer: true, wrapUntrusted: true })` per entry (installed when the definition lists the `mcp` tool), OpenAPI regenerated; `server/test/mcp.test.ts` (validation, redaction, wiring against a local HTTP MCP server: deferred tools, auth header, untrusted frame)
- [x] `examples/team/README.md` and `docs/` (architecture, api, operations); guide [Lead and role agents](../guides/lead-and-role-agents.md) (D4) with its row in the guides README
- [ ] Usage screen and the MCP editor in the agent form (web, other owner)
- [ ] Real-model smoke: `scripts/smoke-real.ts` exists and was not run in this pass (it costs money)
- [x] "Requests to the library" consolidated with the final status of every item (table below the candidates)
- [ ] Finish this file: set the status to done when the web milestones (M5-M8 web items) close

## Acceptance criteria

Status at the end of the server pass (server and docs done; the web items depend on the web owner):

1. Everything in §1.1 works from the browser against one server and against two servers sharing
   one database file. **Server side verified** (HTTP tests, `two-instances.ts`); browser side open
   (web milestones).
2. The server survives `SIGKILL` at any point of the §8 table; pending approvals and parked leads
   are answerable afterwards, and no tool is re-executed. **Met** (`kill-restart.ts`; the honest
   `--wait-stale` variant waits the recovery window).
3. `GET /openapi.json` is valid OpenAPI 3.1, every route is documented with named schemas, `/docs`
   renders it, and `shared/openapi.json` is up to date in CI. **Met locally** (`bun run openapi`
   after every change, including MCP); the CI up-to-date check is not added yet.
4. The example imports `eharness` only through public subpaths; no `src/` deep imports; no
   library change is hidden in the example. **Met** (`layering.test.ts`; gaps went to the library:
   ADR-0039..0043).
5. The adapters pass the library's conformance suites. **Met** (`eh-conformance.test.ts`).
6. `bun run lint`, `typecheck`, `test` pass; the process scripts pass. **Server met** (143 tests);
   the web's checks and a run of both scripts after the last library change are the closing gate.
7. Every workaround is listed under "Requests to the library". **Met** (final table below).

---

## Requests to the library

Expected gaps (candidates), to be confirmed or struck while building; each becomes an item of a
follow-up phase (P33) with spec text and, where it changes a decision, an ADR.

| # | Candidate | Why |
|---|---|---|
| R1 | A **cross-session index**: list sessions by state (`pending`, `running`, parent) through an optional `StateAdapter` / storage query, plus a `SessionSummary` (title, last message time, last stop, pending kinds) | the board and the sidebar need "all sessions with pending approvals" across the workspace; today only `children()` of a known parent exists, so the example keeps a derived `tasks` table |
| R2 | **Cross-instance attach** — decided (D2): a core **port** `StreamLogAdapter` (append-only chunk log per `{ sessionId, turnId }`, cursor = chunk index, optional `subscribe`, short retention) with an in-memory default; `session.attachRemote({ from })` and `handleResumeRequest()` for AI SDK `useChat({ resume: true })`; the example ships a SQLite adapter; ADR + conformance suite | reload on instance B while A streams shows nothing until the turn ends |
| R3 | A **cross-instance session event feed** (`events()` over storage / notify), including turn start/end and pending changes | the example polls its own `events` table fed by hooks |
| R4 | **(closed by ADR-0041, verified in M4)** **Messaging in `park` mode**: `send_message`/names/resume for park children, or an exported `messageSession()` helper (framing, neutralisation, throttling) over `enqueue`; background children in park mode | the lead cannot follow up with a role agent across processes without app code |
| R5 | **Routines on the durable inbox** — decided (D3): no scheduler port; the library adds `enqueue(…, { availableAt, id })` (expose the inbox timer; a caller id makes a fire idempotent) and a guide for the schedule-row + compare-and-set tick pattern (skip overlap and skip missed fires by default, optional catch-up window, pause/resume); the schedule table and cron parsing (`croner`) stay in the example; promote to `eharness/scheduler` only if a second product repeats it | every team/ops product needs routines |
| R6 | A **team/agent registry** helper: definition-as-data, cached agent per version, roster for `subagents` | the factory and cache are generic |
| R7 | **Memory scopes** (workspace / agent / user) as a documented preset of `memory({ roots })` and a path convention | every multi-agent app builds the same roots |
| R8 | **Renderers for eharness parts** (`data-subagent.run`, `data-eh.input`, kind messages, child-session approvals) — decided (D1): built in the example only; nothing goes to edmi-ui or the library until the example has used them well; revisit after P32 | prove usefulness first |
| R9 | A **DB-backed FileSystem helper** (SQL implementation of `list`/`grep`/`glob`/`move`/versions) as documented example, not a dependency | keep as `examples/` unless a second product needs it (ADR-0008) |
| R11 | Built-in **tool kinds for the memory tools** (`memory_view` read, `memory_create`/`str_replace`/`insert`/`delete` write on `path`, `memory_rename` write on `old_path`) in `DEFAULT_TOOL_KINDS` of `eharness/permissions` | without them every memory write is an unknown tool and asks; the example registers the kinds itself |
| R12 | Export the small text helpers `fileSystemConformance` and `memoryFs` share (`splitLines`, `statelessPattern`, `GREP_SCAN_CHARS`) from `eharness/filesystem`, and document that the conformance factory must return an **empty, isolated** adapter per call | the SQLite `FileSystem` re-implemented them; the first run failed on a shared database until the factory returned a fresh one |
| R13 | An `InboxAdapter` without `notify`/`subscribe` is fine but the guide should say what the holder's poll costs and recommend `inbox.pollMs`; a `bun:sqlite` adapter has no cross-process notification (candidate: poll `PRAGMA data_version`) | the SQLite inbox is poll-only |
| R14 (done in library: `run.accepted` / `toHttpResponse()` / `session.busy()`) | **Busy as a status across instances**: `handleChatRequest` answers `409` only for an in-process busy; a turn on another instance (lock conflict) and every other run error (`EH_INVALID_INPUT`, stale approval answer) come back as an `error` chunk in a `200` stream. The example pre-checks `stats().activeTurn` (with the `recovery.staleMs` default of 120 s copied) before calling it. Candidate: a `busy()` helper on the session (activeTurn + staleness) and/or `handleChatRequest` mapping a pre-start failure to its status | the route cannot choose steer vs 409 without reimplementing liveness |
| R15 (done in library: `inputFiles.resolve` and `writeBytes({ mediaType })`) | **File parts that name app-side files**: `inputFiles` only allows `data:` / `https:`, so an upload (library `/uploads`) must be inlined as a data URL into the stored message. Candidate: `inputFiles.resolve(url) -> bytes` hook, or a file-reference part kind that is resolved only when projecting to the model; also `FileSystem.writeBytes(path, bytes, { mediaType })` so a store can keep the declared media type of text files (the SQLite adapter lost `text/csv`) | stored messages bloat with base64; media types are guessed from the extension |
| R16 (done in library: `stats().usage`) | `session.stats()` has no cumulative usage/cost; the example sums `metadata.eharness.usage` over up to 5 000 stored messages for `GET /agents/{id}/stats`. Candidate: `usage` (and `costUsd`) in `stats()` or a `session.usage()` read | a cheap per-chat cost readout for UIs |
| R17 (closed by ADR-0042, verified in M6) | **Runtime and lock for child sessions**: `subagents({ childSession, parentSession })` hands the app's `SessionLock` and `runtime` (`workspaceId`, `agentId`) to children and re-opened parents; the example wires both in `agent-factory.ts` and no longer silences `W_SESSION_OPTIONS_IGNORED` | cross-process locking of child turns and attribution in hooks |
| R18 (closed by ADR-0042, verified in M6) | **Read-only session access**: `agent.peek(id)` (messages, stats, pending, busy, children, parentInfo) has no `session.start` hooks; the approvals list, task detail, DM messages, drift pass and routine overlap checks use it, so reading never resumes a parked lead. Residue (closed, ADR-0043: needs the resolved registry which peek must not run, and is not stored; apps open the session for it): `ContextStats` (window, tokens) is not in `peek().stats()`, so `GET /agents/{id}/stats` and `/context` still open the session | the board and the approvals list read many sessions without waking any |
| R19 (closed by ADR-0042, verified in M6) | **Child identity in the index**: `ChildSessionInfo` / `pendingSubagentApprovals` entries carry `agent`, `name`, `description`; the approvals listing maps `agent` (catalog key = slug) to the definition and keeps the task row only as a fallback | the approvals listing opens a child on the right agent |
| R20 (closed by ADR-0042 in the library; verified for wiring) | **Spawn budget for park**: `subagents({ maxChildren })` is wired through `TeamLimits.maxChildren`; budgets are per workspace through `budget.ledger.scopes: (ctx) => ['workspace:' + ctx.runtime.workspaceId]`. The cap counts the children of a session's whole life and the lead DM never ends, so the example keeps it off by default (`maxConcurrent` = the settings `spawnCap` is the live limit). Candidate: a per-turn or per-day variant | multi-agent runs cost many times a chat (D4) |
| R10 | Run records: one hook or event carrying `{ sessionId, parent, kind, stop, usage, durationMs }` per turn end for every instance | the task index builds it from three hooks |
| R21 (done in library, ADR-0043: optional `FileSystem.versions?` / `readVersion?`, restore = write, `memoryFs` + `requireVersions`; the app adopts it) | **Version history for `FileSystem`**: `GET /library/versions` is metadata only (`library_history`, written in the same transaction as the change); the content of an older version is gone, so there is no restore. Candidate: an optional `FileSystem.history?(path)` / `readVersion?(path, version)` and a conformance case | the library UI wants "who changed this and when" and, later, restore |
| R22 (done in library, ADR-0043: `ctx.turn.source = { kind: 'inbox', id, key?, ids, keys }` and `metadata.eharness.inboxKey`; the app drops the retry loop) | **Caller id on the turn**: a turn started from `enqueue(…, { id })` does not expose the id (`dedupeKey`) to hooks; the app matches a fire to its run row by `metadata.eharness.inboxId`, which is only known after `enqueue` returns, so a very fast turn can end first and the outcome plugin retries for up to 2 s. Candidate: put the caller id in `metadata.eharness` of the user message (and `turn.start`'s input), or return it from `onRun` | routine run outcomes without a race |
| R23 (done in library, ADR-0043: `enqueue(…, { metadata })` stored as trusted `metadata.app`, 16 KiB cap, wins over a client `app` key) | **App metadata on enqueued input**: `enqueue()` drops client metadata (`acceptClientMetadata` is off), so a routine fire cannot mark its user message (the UI wants "Routine: Morning briefing" instead of a plain user bubble). Candidate: `EnqueueOptions.metadata` stored under a namespaced key | provenance of scheduled and webhook inputs |
| R24 (closed as app code, ADR-0043: `pending()` has session ids only and the id carries no agent identity; guide note in multi-instance sweeper) | **Inbox sweeper helper**: sweeping `inbox.pending()` means mapping every session id back to its agent definition (`dm:`, `routine:` prefixes here) and opening it; the guide shows the loop but not that mapping. Candidate: `agent.drainPending({ open })` or a documented convention | instances that went away leave claimable items |


### Final status (end of the server pass)

| R | Status | Reference |
|---|---|---|
| R1 cross-session index | **open**: the example keeps a derived `tasks` table written by hooks; `agent.peek()` and the child identity (R18, R19) make the reads cheap, but "all sessions with pending state" is still an app index | `47f1f9a` |
| R2 cross-instance attach | **closed** | ADR-0039, `84f8bc9` (stream log port, `attachRemote`, `handleResumeRequest`; SQLite adapter in the example) |
| R3 cross-instance event feed | **open**: the `events` table fed by hooks and tailed by every instance works (poll 500 ms); a library feed would remove the hooks | - |
| R4 park-mode messaging | **closed** | ADR-0041, `84f8bc9` |
| R5 routines on the inbox | **closed**: `enqueue({ availableAt, id })` and the guide section "Routines on the inbox"; no scheduler port (D3); promote to `eharness/scheduler` only if a second product repeats it | ADR-0040, `84f8bc9`, `docs/guides/multi-instance.md` |
| R6 team/agent registry helper | **open (kept in the example)**: the factory plus per-version cache was written once here; generalise when a second app needs it | `agent-factory.ts` |
| R7 memory scopes preset | **open (kept in the example)**: `domain/memory.ts` roots; documented in the example docs | - |
| R8 part renderers | **decided D1**: built in the example only; revisit after P32 | - |
| R9 DB-backed `FileSystem` | **kept as example** (ADR-0008): `infra/eh/library-fs.ts`, conformance-checked | `ae6665b` |
| R10 run records event | **open**: the task index still builds it from three hooks; `ctx.turn.source` (R22) removed the worst gap | - |
| R11 memory tool kinds | **closed** | `220d467` |
| R12 filesystem text helpers | **closed** | `220d467` |
| R13 inbox poll cost | **open (documentation)**: the SQLite inbox is poll-only (`inbox.pollMs`); stated in `docs/operations.md`; a `PRAGMA data_version` notify is a candidate | - |
| R14 busy as a status | **closed** | `7b945f5` |
| R15 file references, `writeBytes({ mediaType })` | **closed** | `7b945f5` |
| R16 `stats().usage` | **closed** | `7b945f5` |
| R17 child lock and runtime | **closed** | ADR-0042, `47f1f9a` |
| R18 `agent.peek()` | **closed** (residue closed by decision: context tokens need the resolved registry, so `GET /agents/{id}/stats` opens the session) | ADR-0042, ADR-0043 |
| R19 child identity in the index | **closed** | ADR-0042, `47f1f9a` |
| R20 spawn budget for park | **closed** (`maxChildren`; per-day / per-turn variants are not requested) | ADR-0042, `47f1f9a` |
| R21 `FileSystem` versions | **closed in the library**; the example still stores metadata only (`library_history`) and does not adopt `versions` / `readVersion` yet (restore UI) | ADR-0043 |
| R22 caller id on the turn | **closed in the library** (`ctx.turn.source`); the app's retry loop can be dropped | ADR-0043 |
| R23 enqueue metadata | **closed in the library** (`metadata.app`); the example can label routine messages with it | ADR-0043 |
| R24 inbox sweeper | **closed as app code**: the session-id to agent mapping is application knowledge; guide note added | ADR-0043 |
| R25 tool failures not seen by the progress guard | **closed**: `ERROR:` results count as failures; `progress.toolErrorStreak` nudges then stops `stuck` (found by the real-model smoke) | `23ec4fe` |
| R26 parallel approvals answered one at a time | **closed**: partial resolution of pending approvals; the completing answer runs the continuation (found by the real-model smoke) | ADR-0044, `b5ba722` |
| R27 step budget across park resumes | **open**: every approval resume of a park child is a new turn with a fresh `maxSteps`, so a child's lifetime work is unbounded by steps; candidate: a per-session lifetime step/tool-call cap in `subagents()` or the loop | — |
| R28 cost of unpriced models | **open (example)**: OpenRouter models are unpriced without a catalog (`W_MODEL_UNPRICED`), so the workspace budget counts nothing; wire the OpenRouter model catalog as the coder does | — |

Not library requests, found on the way: no Svelte `resume` option (the app calls
`chat.resumeStream()`), and MCP over stdio is deliberately absent from the server example.

---

## Alternatives considered

- **Elysia 1.4.x** (checked 2026-10-10): Bun-first, typed end to end, OpenAPI plugin from TypeBox.
  Rejected: its schema layer is TypeBox, so we would keep two schema systems next to eharness'
  zod; its peers (`file-type`, `exact-mirror`, `@sinclair/typebox <1`) add weight; web-standard
  `Response` interop with `handleChatRequest` is easier with Hono. Elysia would be fine for a Bun-only
  product.
- **Express/Fastify + a swagger plugin**: more boilerplate, no single source of truth for schemas.
- **SvelteKit endpoints as the backend**: contradicts profile (c) (web is only UI) and ties
  long-running work to the web process.
- **Postgres from day one**: closer to production, but needs a service for every contributor.
  The adapters are written against a small repository layer so the swap is a Drizzle dialect
  change.
- **One session per agent for everything** (no task sessions): simplest, but approvals of
  delegated work would block the DM and the board could not show tasks separately.
- **Inline subagent approvals**: single-process only; rejected by ADR-0034 for this profile.
- **Shipping a team module in the library first**: premature (rule: promote after the example
  proves it, as P31 did).

## Decisions (2026-10-10, after research)

Research covered resumable streams (AI SDK `resumable-stream` and the chatbot template,
assistant-ui, LibreChat, Cloudflare Agents, LangGraph Platform, OpenAI Responses background mode,
Mastra), schedulers (Cloudflare Agents `schedule()`, LangGraph crons, Mastra, Temporal Schedules,
BullMQ, pg-boss, graphile-worker, Inngest) and lead/supervisor patterns (LangGraph supervisor,
OpenAI Agents SDK handoffs and agents-as-tools, CrewAI hierarchical, Claude Code agent teams,
Anthropic's multi-agent research system). Sources are listed below.

- **D1 — Part renderers stay in the example.** edmi-ui is a UI kit; nothing moves there (or into
  the library) until the example proves the components. Revisit after P32.
- **D2 — Resumable streams: a core port with a memory default** (R2). A cursor log (OpenAI
  `sequence_number`, LangGraph `lastEventId`, LibreChat Redis Streams) survives the producer
  instance; pub/sub with producer replay (`resumable-stream`) does not, and has no cursor
  contract, so it is not used in core (chunk order is public API). Shape: `StreamLogAdapter`
  (`append`, `close`, `read(from)`, optional `subscribe`/`expire`), cursor = chunk index per
  `turnId`, local readers keep using the in-memory turn buffer, a batched drainer appends, adapter
  failures are warnings, a reader disconnect never aborts (stop stays `requestAbort`). Committed
  messages remain the truth; the log is short-lived. Lands in M3 with an ADR and a conformance
  suite; the example implements it on SQLite.
- **D3 — Routines on the durable inbox, no scheduler port** (R5). The inbox already has timers,
  claims, leases, retry and dead-letter; a fire is an input. Library change: expose
  `enqueue(…, { availableAt, id })`. The schedule row, the compare-and-set tick and `croner` live in
  the example; defaults follow the research: overlap `skip`, missed fires skipped (optional
  catch-up window, latest fire only), deterministic fire id `sched:<id>:<scheduledAt>`,
  pause-after-N-failures and a max-fires guard against cost runaways. A guide documents the
  pattern; an `eharness/scheduler` module only if a second product repeats it.
- **D4 — The lead is a convention, not a library role.** eharness already has the parts teams
  rely on (named agents, `agent` tool, park approvals, background, `send_message`, roster,
  parent/child index, inbox). LangGraph moved away from its `create_supervisor` wrapper toward
  plain tools. P32 writes a "Lead and role agents" guide; an optional prompt helper
  (`leadInstructions(roster)`) is added only if the example's prompt proves generic. A shared task
  board with claims (as in Claude Code agent teams) is the one element without an eharness
  equivalent: deferred until the example needs it. Budgets matter (multi-agent runs cost many
  times a chat): the example sets a per-workspace budget and a spawn cap.

## Open questions

1. Multi-user later: `actor`, per-user DM sessions (`dm:<userId>:<agentId>`), workspace members,
   per-user memory roots. v1 keeps `actor` in every call so this is additive.
2. Verify at M5 that `@ai-sdk/svelte` 5.x matches the AI SDK v7 UI contract (`resume`,
   `addToolApprovalResponse`, `sendAutomaticallyWhen`); if it lags, the example adds a thin
   adapter and records it as a gap against the AI SDK.
3. Verify at M5 that edmi-ui's registry URLs and `Confirmation` / `Tool` states still match.

## Sources

- docs in this repo: concept, architecture, specs 04, 05, 11, 14, 20, ADR-0034, 0035, 0038,
  guides `multi-instance.md`, `production-patterns.md` (Scheduling and heartbeats), P30, P31
- npm registry (2026-10-10): hono, @hono/zod-openapi, @scalar/hono-api-reference, drizzle-orm,
  drizzle-kit, @ai-sdk/svelte, @sveltejs/kit, svelte, tailwindcss, elysia
  (`https://registry.npmjs.org/<pkg>/latest`)
- https://hono.dev/examples/zod-openapi and
  https://github.com/honojs/middleware/tree/main/packages/zod-openapi (`createRoute`, `app.openapi`,
  `doc31`, `openapiRoutes`, `hc`)
- https://ai-sdk.dev/docs/reference/ai-sdk-ui/use-chat (`Chat`, transport, resume,
  `addToolApprovalResponse`, `sendAutomaticallyWhen`)
- https://viandwi24.github.io/edmi-ui/ (registry, kits) and the maintainer's install notes

Research for D2–D4:
- https://ai-sdk.dev/v7/docs/ai-sdk-ui/chatbot-resume-streams · https://github.com/vercel/resumable-stream
- https://www.assistant-ui.com/docs/guides/resumable-streams · https://www.librechat.ai/docs/features/resumable_streams
- https://developers.cloudflare.com/agents/api-reference/chat-agents/ · https://developers.cloudflare.com/agents/api-reference/schedule-tasks/
- https://developers.openai.com/api/docs/guides/background · https://reference.langchain.com/javascript/langchain-langgraph-sdk/client/RunsClient/joinStream
- https://mastra.ai/docs/harness/durable-agents · https://mastra.ai/docs/workflows/scheduled-workflows.md
- https://docs.temporal.io/evaluate/features/schedules · https://docs.bullmq.io/guide/job-schedulers/repeat-options
- https://worker.graphile.org/docs/cron · https://www.inngest.com/docs/guides/scheduled-functions · https://github.com/Hexagon/croner
- https://github.com/langchain-ai/langgraph-supervisor-py · https://code.claude.com/docs/en/agent-teams
- https://www.anthropic.com/engineering/multi-agent-research-system · https://docs.crewai.com/en/learn/hierarchical-process
