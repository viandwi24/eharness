# eharness team

A team of AI agents you chat with, built **only on the public eharness API**. One lead agent and
several role agents (researcher, writer, analyst, ops) share a library of files and a memory. You
talk to any of them, watch what the others are doing on a task board, approve risky actions from
one inbox, and let agents run routines on a schedule.

It is the reference for deployment profile "web + server" ([ADR-0034](../../docs/decisions/0034-deployment-profiles.md)):
the web is only a UI, the server runs everything, survives `SIGKILL`, and can run as several
instances over one database. It is an example: it is never published, and its SQLite adapters live
here, not in the library. Plan and decisions: [P32](../../docs/plans/P32-team-example.md).

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
- **Board and approvals inbox**: every delegated task, and everything waiting for a person, across
  all sessions.
- **Library and memory**: shared files agents write and you edit (stale edits lose to agent writes),
  workspace and per-agent memory.
- **Routines**: cron / interval / one-shot prompts, safe with several instances.
- **Connectors** (Claude style): built-in Files, Memory, Planning, Web, Ask the user and Team; GitHub and any remote MCP URL, connected once for the workspace (available to all agents, each agent may override) or for one agent; per agent each capability is Allowed, Ask first or Off. Secrets are encrypted, writes of external connectors always ask, even in Bypass mode. Custom connectors are added like in Claude: **Add custom connector** → name + remote MCP URL → the server probes it (OAuth detected or not) → choose *Sign in now*, *Sign in when needed* or *No sign in*, an optional OAuth client and request headers → each one becomes its own card. Their tool prefix is a slug of the name taken at creation, so renaming never renames tools. The composer's tools menu switches connectors per chat, and **Tool access** (Auto / On demand) decides whether third-party tools are loaded up front or found through `tool_search`.
- **Cost controls**: a per-workspace USD budget on a shared ledger and a cap on concurrent
  delegations. Multi-agent runs cost many times a chat, see the
  [lead and role agents guide](../../docs/guides/lead-and-role-agents.md).

Screenshots (to be added under `docs/img/`): `chat.png` (chat with the context panel),
`board.png` (tasks board with an approval drawer), `approvals.png` (inbox), `library.png`,
`routines.png`, `agent-editor.png`.

## Quick start

Requirements: [Bun](https://bun.sh) (dev toolchain) and Node 22+ compatible code; one model key.

```bash
bun install                              # at the repo root (workspaces)

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
| `TEAM_SECRET_KEY` | dev key file | 32 bytes, base64 (`openssl rand -base64 32`): encrypts provider secrets saved from the web (AES-GCM). Unset in dev = a key is generated into `data/secret.key` (git-ignored) with a warning; set it for anything shared. `TEAM_SECRET_KEY_PREVIOUS` (comma separated) keeps old keys that can still open rows after a rotation |
| `TEAM_OFFLINE` | - | `1` = never fetch the public model catalogs (cached in the database, refreshed every 24 h) |
| `TEAM_CLASSIFIER_MODEL` / `TEAM_SEARCH_MODEL` | - | Auto-mode classifier / `web_search` model: `profile:model` or a plain id on the default profile |
| `TEAM_SCRIPTED_MODEL` | - | path to a JSON array of scripted steps: offline runs and tests (wins over the keys) |
| `TEAM_TOKEN` | - | bearer token for every route except `/health`, `/docs`, `/openapi.json`. **Unset = the API is open**: localhost only |
| `TEAM_DB` | `./data/team.db` | SQLite file (WAL). Several instances may share it |
| `PORT` | `4000` | HTTP port of the server |
| `TEAM_BUDGET_USD` | unset | monthly USD limit of the workspace ledger (also in Settings) |
| `TEAM_SPAWN_CAP` | `4` | role agents the lead runs at once (also in Settings) |
| `TEAM_ROUTINE_TICK_MS` | `15000` | routine ticker interval (`0` = off) |
| `TEAM_LOG_MAX_ROWS` | `5000` | model call log (Logs page): rows kept |
| `TEAM_LOG_RETENTION_DAYS` | `7` | model call log: days kept |
| `TEAM_EVENTS_RETENTION_HOURS` | `72` | events feed (SSE source, includes one `model-call` row per model call): hours kept, pruned at boot and every 10 min; `0` = by count only |
| `TEAM_EVENTS_MAX_ROWS` | `100000` | events feed: rows kept (the oldest go first). The newest event and the latest message of each agent are always kept. A client resuming from a pruned cursor gets a `resync` signal (SSE `event: resync`, or `resync: true` on `GET /events`) and refetches its state |
| `PUBLIC_TEAM_TOKEN` | - | web only: token the browser sends (else saved from Settings) |
| `TEAM_API_PROXY` | `http://localhost:4000` | web dev server only: where `/api` goes |

The web reads the token from `PUBLIC_TEAM_TOKEN` (build/dev env) or from the one saved on its Settings page (browser storage). Migrations are generated by
drizzle-kit (`bun run db:generate`) and applied at boot.

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

Details of the scripts: [scripts/README.md](scripts/README.md).

## Docs

- [docs/architecture.md](docs/architecture.md): layers, request flow, how eharness is wired, what
  survives a restart, known limits
- [docs/api.md](docs/api.md): OpenAPI at `/docs`, auth, errors, the streaming endpoints
- [docs/operations.md](docs/operations.md): several instances, swapping the database, tuning, backups
- [Lead and role agents](../../docs/guides/lead-and-role-agents.md): the pattern this app uses
