# eharness team

A team of AI agents you chat with, built **only on the public eharness API**. One lead agent and
several role agents (researcher, writer, analyst, ops) share a library of files and a memory. You
talk to any of them, watch what the others are doing on a task board, approve risky actions and answer
questions inline in the chat, and let agents run routines on a schedule.

It is the reference for deployment profile "web + server" ([ADR-0034](../../docs/decisions/0034-deployment-profiles.md)):
the web is only a UI, the server runs everything, survives `SIGKILL`, and can run as several
instances over one database. It is an example: it is never published, and its SQLite adapters live
here, not in the library. Plan and decisions: [P32](../../docs/plans/P32-team-example.md).

**Read the walkthrough:** [Building a multi-user agent server](../../docs/guides/walkthrough-server.md)
follows one request through this code, piece by piece (storage, lock, stream log, inbox, recovery,
background children, approvals, activity feed, `eharness/http`, `eharness/client`), with why each
exists and what breaks without it. The short review list is the
[production checklist](../../docs/guides/production-checklist.md).

```
server/   Hono + @hono/zod-openapi + Drizzle on bun:sqlite (the whole backend)
web/      SvelteKit 3 + Svelte 5 + Tailwind 4 + edmi-ui (UI only; talks to /api)
shared/   generated: openapi.json (and the web's api types), never edited
scripts/  real-process checks: two instances, kill and restart, real-model smoke
docs/     architecture, API, operations
```

## What you get

- **Chat per agent** (AI SDK `useChat`): streaming, reload and resume, stop, steer a running turn,
  attachments, tool approvals in the thread.
- **Lead and role agents**: the lead hands work to role agents (parked, so approvals survive
  restarts) and reads their reports; agents are rows in the database you edit in the app, not code.
- **Board and notifications**: every delegated task on a board, and a bell listing what waits for a
  person. Approvals and questions are answered only inline in the session's chat (the agent's DM
  or the task view); notifications and the board just link there.
- **Library and memory**: shared files agents write and you edit (stale edits lose to agent writes),
  workspace and per-agent memory.
- **Routines**: cron / interval / one-shot prompts, safe with several instances.
- **Connectors** (Claude style): built-in Files, Memory, Planning, Web, Ask the user and Team; GitHub and any remote MCP URL, connected once for the workspace (available to all agents, each agent may override) or for one agent; per agent each capability is Allowed, Ask first or Off. Secrets are encrypted, writes of external connectors always ask, even in Bypass mode. Custom connectors are added like in Claude: **Add custom connector** → name + remote MCP URL → the server probes it (OAuth detected or not) → choose *Sign in now*, *Sign in when needed* or *No sign in*, an optional OAuth client and request headers → each one becomes its own card. Their tool prefix is a slug of the name taken at creation, so renaming never renames tools. The composer's tools menu switches connectors per chat, and **Tool access** (Auto / On demand) decides whether third-party tools are loaded up front or found through `tool_search`.
- **Channels** (Telegram bot): the **Channels** page connects a bot (token from @BotFather), binds it to an agent, lists the chats it was added to with a policy each (wake on mention, always, or observe only; reply or post-by-tool; retention), pairs employees with a `/start` link and shows the outbound queue. Groups, forum topics, channels and DMs; approvals with buttons. See [Telegram bot](#telegram-bot).
- **Cost controls**: a per-workspace USD budget on a shared ledger and a cap on concurrent
  delegations. Multi-agent runs cost many times a chat, see the
  [lead and role agents guide](../../docs/guides/lead-and-role-agents.md).

Screenshots (to be added under `docs/img/`): `chat.png` (chat with the context panel),
`board.png` (tasks board with an approval drawer), `library.png`,
`routines.png`, `agent-editor.png`.

## Quick start

Requirements: [Bun](https://bun.sh) (dev toolchain) and Node 22+ compatible code; one model key.

```bash
bun install                              # at the repo root (workspaces: the library, coder, team server)
bun install --cwd examples/team/web      # the SvelteKit web has its own lockfile

cp examples/team/.env.example examples/team/.env
# edit examples/team/.env: set OPENROUTER_API_KEY (or AI_GATEWAY_API_KEY) and TEAM_TOKEN

cd examples/team
bun run dev        # server on :4000 and web on http://localhost:5173 together; Ctrl+C stops both
```

Or run them separately: `bun run dev:server` and `bun run dev:web` (both read the same `.env`).
Other scripts in `examples/team/package.json`: `test`, `check`, `openapi` (export the spec and
regenerate the web types), `db:generate`, `test:instances`, `test:restart`, `smoke` (real model, costs money).

API docs: http://localhost:4000/docs. In the web, the token comes from `PUBLIC_TEAM_TOKEN` in the
same `.env` (dev) or from the Settings page.

Providers: open Settings > Providers to add profiles (several per provider, for example two OpenRouter
keys with their own headers). Each agent picks a profile and a model; the Settings default model is a
profile and a model too. Keys never leave the server (the API returns `{ set, hint }`) and are stored
encrypted. Environment keys keep working with an empty database as read-only profiles.

No key? Set `TEAM_SCRIPTED_MODEL=/path/to/steps.json` in `.env` to run offline with a scripted model
(a JSON array of steps, see `eharness/testing`).

| Variable | Default | Meaning |
|---|---|---|
| `OPENROUTER_API_KEY` / `AI_GATEWAY_API_KEY` | - | read-only **env profiles** of those providers (more providers and profiles are added in Settings > Providers; `TEAM_PROVIDER`, `TEAM_MODEL` choose the default profile and model) |
| `TEAM_INSTANCE_ID` | `team-<PORT>` | stable id of this server instance. After a crash or restart the instance owns the turns and locks of its previous run: they are recovered at boot (tool calls answered `Interrupted:`, chat shows Continue / Retry, delegated tasks become `interrupted`, the lead gets a report) instead of after the 120 s stale timeout. Must be unique among live instances on one database (set it explicitly when you run several on one port range or behind a proxy). |
| `TEAM_SECRET_KEY` | dev key file | 32 bytes, base64 (`openssl rand -base64 32`): encrypts provider secrets saved from the web (AES-GCM). Unset in dev = a key is generated into `data/secret.key` (git-ignored) with a warning; set it for anything shared. `TEAM_SECRET_KEY_PREVIOUS` (comma separated) keeps old keys that can still open rows after a rotation |
| `TEAM_OFFLINE` | - | `1` = never fetch the public model catalogs (cached in the database, refreshed every 24 h) |
| `TEAM_CLASSIFIER_MODEL` / `TEAM_SEARCH_MODEL` | - | Auto-mode classifier / `web_search` model: `profile:model` or a plain id on the default profile |
| `TEAM_SCRIPTED_MODEL` | - | path to a JSON array of scripted steps: offline runs and tests (wins over the keys) |
| `TEAM_TOKEN` | - | bearer token for every route except `/health`, `/docs`, `/openapi.json`, `/oauth/callback`. **Unset = the API is open**, so the server listens on loopback only and refuses to start with a non-loopback `TEAM_HOST` |
| `TEAM_HOST` | `127.0.0.1` | bind address. A non-loopback value (for example `0.0.0.0`) requires `TEAM_TOKEN` of at least 16 characters that does not start with `dev-` (`openssl rand -base64 32`) |
| `TEAM_ALLOWED_ORIGINS` | - | comma-separated extra browser origins allowed to send POST/PUT/PATCH/DELETE; a request with another `Origin` header gets `403 FORBIDDEN_ORIGIN` (CSRF guard, also protects the token-less loopback setup; the origins of `TEAM_WEB_URL` and `TEAM_PUBLIC_URL` always pass; requests without `Origin`, like curl, are not affected) |
| `TEAM_ALLOWED_HOSTS` | - | comma-separated `Host` header names accepted besides loopback, `TEAM_HOST` and the host of `TEAM_PUBLIC_URL` (DNS rebinding guard: other hosts get `403 FORBIDDEN_HOST`) |
| `TEAM_DEBUG_INVARIANTS` | - | `1` = `debug.invariants` on every agent (explicit in eharness; the server tests set it through `server/bunfig.toml`). A broken session invariant then fails the turn instead of only warning |
| `TEAM_ALLOW_PRIVATE_MCP` | - | `1` = custom connector URLs may point at private/loopback hosts (local MCP servers; dev only) |
| `TEAM_PUBLIC_URL` / `TEAM_WEB_URL` | `http://localhost:$PORT` / `http://localhost:5173` (with `TEAM_WEB_DIR`: the public URL, same origin) | where browsers reach the server (OAuth redirect URI `<url>/oauth/callback`; its host and origin are always allowed) / where the OAuth callback sends the browser back (`<url>/connectors`; its origin is always allowed) and the links in channel messages |
| `TEAM_<CONNECTOR>_CLIENT_ID` / `_CLIENT_SECRET` | - | OAuth app of a curated connector (for example `TEAM_GITHUB_CLIENT_ID`); or save it on the Connectors page (stored encrypted) |
| `OPENROUTER_BASE_URL` | - | base URL of the OpenRouter env profile (proxies) |
| `TEAM_DB` | `./data/team.db` | SQLite file (WAL). Several instances may share it |
| `PORT` | `4000` | HTTP port of the server |
| `TEAM_BUDGET_USD` | unset | monthly USD limit of the workspace ledger (also in Settings) |
| `TEAM_SPAWN_CAP` | `4` | role agents the lead runs at once (also in Settings) |
| `TEAM_ROUTINE_TICK_MS` | `15000` | routine ticker interval (`0` = off) |
| `TEAM_LOG_MAX_ROWS` | `5000` | model call log (Logs page): rows kept |
| `TEAM_LOG_RETENTION_DAYS` | `7` | model call log: days kept |
| `TEAM_EVENTS_RETENTION_HOURS` | `72` | events feed (SSE source, includes one `model-call` row per model call): hours kept, pruned at boot and every 10 min; `0` = by count only |
| `TEAM_EVENTS_MAX_ROWS` | `100000` | events feed: rows kept (the oldest go first). The newest event and the latest message of each agent are always kept. A client resuming from a pruned cursor gets a `resync` signal (SSE `event: resync`, or `resync: true` on `GET /activity`) and refetches its state |
| `TEAM_ROUTINE_RUNS_RETENTION_DAYS` / `TEAM_TASKS_RETENTION_DAYS` / `TEAM_LIBRARY_HISTORY_RETENTION_DAYS` | `30` / `90` / `180` | days kept of finished routine runs, finished tasks (their chat messages stay in the session store) and library history rows (besides the per-path cap); `0` = keep. Pruned at boot and every 10 min together with events |
| `TEAM_CHANNEL_KEY` | dev key file | 32 bytes, base64: encrypts the channel message log at rest (its own key; dev: `data/channel.key`); `TEAM_CHANNEL_KEY_PREVIOUS` for rotation |
| `TEAM_TELEGRAM_API_ROOT` | `https://api.telegram.org` | Bot API root of the Telegram bot (a local Bot API server, or a test fake) |
| `TEAM_WEB_DIR` | - | serve the built web (`web/build`) from the server on one port; the API then lives under `/api` (set by the Docker image) |
| `TZ` | host timezone | team timezone default (active hours, briefing time) |
| `TEAM_DEMO_COLLECTOR` | - | `1` = register the demo community source (5 000 deterministic chat messages) for the big-data tools |
| `PUBLIC_TEAM_TOKEN` | - | web only: token the browser sends (else saved from Settings) |
| `TEAM_API_PROXY` | `http://localhost:4000` | web dev server only: where `/api` goes |

The web reads the token from `PUBLIC_TEAM_TOKEN` (build/dev env) or from the one saved on its Settings page (browser storage). Migrations are generated by
drizzle-kit (`bun run db:generate`) and applied at boot.

## Telegram bot

1. In Telegram open **@BotFather**, send `/newbot`, pick a name and a username ending in `bot`, and
   copy the token it gives you (`123456:ABC...`).
2. Groups: the bot only sees mentions, replies and commands while **privacy mode** is on (the
   default). To let it follow a whole group (answer on every message, or observe), either make it
   a **group admin**, or send `/setprivacy` to @BotFather, choose *Disable* and **remove and re-add**
   the bot to the group. For channels, add the bot as an admin with the right to post.
3. In the web app open **Channels** -> **Connect a Telegram bot** and paste the token (it is stored
   encrypted and never shown again). The page tells you whether privacy mode is on.
4. **Bind** the connection to an agent. Add the bot to a group and write a message; the chat shows
   up under **Chats**. Allow it and choose when the agent wakes.
5. **People**: create a link for a team member and send it; they open it in Telegram and press
   **Start**. Only linked accounts can message the agent directly.

A bot can only receive updates by one method at a time: if a webhook is set the page offers to
remove it. Run one server process per bot. `TEAM_TELEGRAM_API_ROOT` points at a local Bot API
server. Telegram's terms limit what may be done with chat data (platform data and AI): read the
notes in [P41](../../docs/plans/P41-team-channels.md) and ingest only chats you own or manage.

## Docker

One image runs the whole example on one port: the server serves the built web at `/` and the API
under `/api` (OpenAPI docs at `/api/docs`). Build from the **repository root** (the server runs
against the library source in `src/`):

```bash
docker build -f examples/team/Dockerfile -t eharness-team .
```

```bash
docker run -d --name team -p 4000:4000 --env-file examples/team/.env -v team-data:/data eharness-team
```

- Required in `.env`: `TEAM_TOKEN` (16+ characters; the container binds `0.0.0.0`, so the server
  refuses to start without it) and a model key. Recommended: `TEAM_SECRET_KEY`, `TEAM_CHANNEL_KEY`,
  `TZ`.
- Open http://localhost:4000 and paste `TEAM_TOKEN` on the Settings page; the image never inlines
  it into the web bundle (`PUBLIC_TEAM_TOKEN` is ignored).
- All state (SQLite database, library files, dev key files) lives in the `/data` volume. Keep
  `TEAM_DB` unset in `.env` (a relative path would leave the volume).
- Another host port or a domain: set `TEAM_PUBLIC_URL=<origin>/api` and `TEAM_WEB_URL=<origin>`.
- `docker logs team` shows the server log; the container health check calls `/api/health`.

## Scripts and checks

```bash
cd examples/team/server
bun test                      # layering, HTTP, factory, tasks, routines, MCP, adapter conformance
bunx tsc --noEmit -p .        # typecheck
bun run openapi               # regenerate ../shared/openapi.json (commit it)

# from the repo root, real processes over one SQLite file, scripted model (free):
bun examples/team/scripts/two-instances.ts
bun examples/team/scripts/kill-restart.ts
bun examples/team/scripts/smoke-real.ts        # one real turn, costs money
```

The process scripts are hermetic: they start the server with `bun --no-env-file` and drop every
`TEAM_*` variable and `PORT` from the environment, so a developer's `.env` (a `TEAM_TOKEN`, a model, a budget)
cannot change what they test. `bun run dev`, `dev:server` and `start` read `examples/team/.env`
(`bun --env-file=../.env`). Details of the scripts: [scripts/README.md](scripts/README.md).

## Docs

- [docs/architecture.md](docs/architecture.md): layers, request flow, how eharness is wired, what
  survives a restart, known limits
- [docs/api.md](docs/api.md): OpenAPI at `/docs`, auth, errors, the streaming endpoints
- [docs/operations.md](docs/operations.md): several instances, swapping the database, tuning, backups
- [Lead and role agents](../../docs/guides/lead-and-role-agents.md): the pattern this app uses

## Integrating into your own system

To connect these agents to an existing company system (users, roles, permissions, an OpenAPI
backend on Hono or Express) as bot users, without writing the business logic twice, see
[docs/examples/integrate-team-to-your-system.md](../../docs/examples/integrate-team-to-your-system.md).
