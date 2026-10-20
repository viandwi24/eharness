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
- **Connectors** (Claude style): built-in Files, Memory, Planning, Web, Ask the user and Team; GitHub and any remote MCP URL, connected once for the workspace (available to all agents, each agent may override) or for one agent; per agent each capability is Allowed, Ask first or Off. Secrets are encrypted, writes of external connectors always ask, even in Bypass mode. Custom connectors are added like in Claude: **Add custom connector** → name + remote MCP URL → the server probes it (OAuth detected or not) → choose *Sign in now*, *Sign in when needed* or *No sign in*, an optional OAuth client and request headers → each one becomes its own card. Their tool prefix is a slug of the name taken at creation, so renaming never renames tools. The composer's tools menu switches connectors per chat, and **Tool access** (Auto / On demand) decides whether third-party tools are loaded up front or found through `tool_search`. A chat pins the tool definitions a remote MCP server first showed it (a server must not silently rewrite what a tool does), so after a server upgrade the changed tools stay off in long-lived chats: the chat's **Tools** panel marks them *Changed on the server*, Health lists a finding, and the owner accepts the new definitions with **Accept & reload** (one chat), **Reload tools** (every chat of an agent) or **Accept new definitions in all chats** on the connection. Reloading clears the library's MCP pins (`mcp:<name>:pins`) from the stored session states; see `docs/specs/09-tools-and-mcp.md`.
- **Channels** (Telegram bot): the **Channels** page lists your connected channels as cards; open one for its own pages (overview, chats, people, inbox, activity, reminders, delivery, settings): connect a bot (token from @BotFather), bind it to an agent, see the chats it was added to with a policy each (wake on mention, always, or observe only; reply or post-by-tool; retention), the people who wrote (link them to a team member, or ignore them; strangers get silence), the conversations with their logs, an activity feed and the outbound queue, all as searchable, sortable, paged tables. Groups, forum topics, channels and DMs; approvals with buttons. See [Telegram bot](#telegram-bot).
- **Persona**: who an agent is is editable and versioned, from the agent dialog's **Persona** tab or by asking the agent in a chat: identity, voice and preferences, admin-only operating rules, per-chat overlays (Channels page) and notes on how people like to be addressed. Owners and admins confirm a change (a button in the chat); members can only propose it; every version has its author, source and diff and can be reverted. A persona never weakens the rules: roles and approvals stay code. See [the walkthrough](../../docs/guides/walkthrough-server.md#28f-the-persona-of-an-agent-editable-versioned-never-above-the-rules-p42).
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
| `BASIC_AUTH_PASSWORD` | - | password login for the web (see [Login](#login)). Set: every route except `/health` and `/auth/*` needs the session cookie or the bearer `TEAM_TOKEN`; `/docs`, `/openapi.json` and `/oauth/callback` are protected too. Unset = no login, nothing changes. On a non-loopback bind it may replace `TEAM_TOKEN` (12+ characters) |
| `TEAM_TRUST_PROXY` | - | `1` = believe `X-Forwarded-For` / `X-Forwarded-Proto` (login throttle per real client, `Secure` cookie behind a TLS proxy) |
| `TEAM_HOST` | `127.0.0.1` | bind address. A non-loopback value (for example `0.0.0.0`) requires `TEAM_TOKEN` of at least 16 characters that does not start with `dev-` (`openssl rand -base64 32`) |
| `TEAM_ALLOWED_ORIGINS` | - | comma-separated extra browser origins allowed to send POST/PUT/PATCH/DELETE; a request with another `Origin` header gets `403 FORBIDDEN_ORIGIN` (CSRF guard, also protects the token-less loopback setup; the origins of `TEAM_WEB_URL` and `TEAM_PUBLIC_URL` always pass; requests without `Origin`, like curl, are not affected) |
| `TEAM_ALLOWED_HOSTS` | - | comma-separated `Host` header names accepted besides loopback, `TEAM_HOST` and the host of `TEAM_PUBLIC_URL` (DNS rebinding guard: other hosts get `403 FORBIDDEN_HOST`) |
| `TEAM_DEBUG_INVARIANTS` | - | `1` = `debug.invariants` on every agent (explicit in eharness; the server tests set it through `server/bunfig.toml`). A broken session invariant then fails the turn instead of only warning |
| `TEAM_ALLOW_PRIVATE_MCP` | - | `1` = custom connector URLs may point at private/loopback hosts (local MCP servers; dev only) |
| `TEAM_PUBLIC_URL` / `TEAM_WEB_URL` | `http://localhost:$PORT` / `http://localhost:5173` (with `TEAM_WEB_DIR`: the public URL without a trailing `/api`, same origin) | where browsers reach the server (OAuth redirect URI `<url>/oauth/callback`; its host and origin are always allowed) / where the OAuth callback sends the browser back (`<url>/connectors`; its origin is always allowed) and the links in channel messages |
| `TEAM_<CONNECTOR>_CLIENT_ID` / `_CLIENT_SECRET` | - | OAuth app of a curated connector (for example `TEAM_GITHUB_CLIENT_ID`); or save it on the Connectors page (stored encrypted) |
| `OPENROUTER_BASE_URL` | - | base URL of the OpenRouter env profile (proxies) |
| `TEAM_DB` | `./data/team.db` | SQLite file (WAL). Several instances may share it |
| `PORT` | `4000` | HTTP port of the server |
| `TEAM_BUDGET_USD` | unset | monthly USD limit of the workspace ledger (also in Settings) |
| `TEAM_SPAWN_CAP` | `4` | role agents the lead runs at once (also in Settings) |
| `TEAM_CONTEXT_CAP` | unset | deprecated optional global ceiling on every agent's context window (logged once when set). By default the window is the model's own; each agent can set a smaller limit and a summarize-at percent (50-95, default 80) in its settings |
| `TEAM_LONG_RUN_MAX_COST_USD` | `10` | a background worker job stops at this estimated cost (0 = no limit); workers run as long jobs in chunks of 80 steps with no fixed step cap, and resume after a restart |
| `TEAM_LONG_RUN_MAX_HOURS` | `24` | a worker job stops this long after it started (0 = no limit) |
| `TEAM_ARTIFACT_URL` | - (root-relative `/art/*` on the host that shows the page) | public base URL of a separate artifact content origin, e.g. `https://artifacts.example.com` (sandboxed HTML runs there; recommended in production) |
| `TEAM_ARTIFACT_PORT` | - | also serve only the artifact content routes (`/art/*`) on this port, for a separate content origin; signed content URLs then point at it (or at `TEAM_ARTIFACT_URL`) |
| `TEAM_CODE_DRIVER` | `local` when the interpreter is found, else `off` | where agents run Python (`run_python` of the **Files & Sandbox** connector): `off` or `local` (a scratch directory under an OS sandbox: no network, the data directory and your home are unreadable); for a separate machine use the **Remote sandbox** connector (below) |
| `TEAM_CODE_PYTHON` | `python3` | interpreter of `local` (the Docker image sets `/opt/eh-python/bin/python`) |
| `TEAM_CODE_INSTALL` | `off` | `off`, `allowlist` or `any`: agents may add packages with `install_packages` (asks first; wheels only) |
| `TEAM_CODE_ALLOW` | - | comma list of package names (optional `==version`) for `allowlist` |
| `TEAM_CODE_ENV_ROOT` | `<data dir>/python-envs` | where package environments are kept (rebuilt when missing) |
| `TEAM_CODE_REQUIREMENTS` | - | a requirements file: `local` builds its base environment from it (default: the interpreter as it is) |
| `TEAM_BROWSER_DRIVER` | `local` when the root is writable, else `off` | where agents get a browser (the **Browser** connector and the `/browser` page): `off` (profiles connect to an existing browser, such as a hosted service or a container) or `local` (this server downloads Chrome or Lightpanda and runs it for a **managed** profile) |
| `TEAM_BROWSER_ROOT` | `<data dir>/browser` | downloaded engines (`chrome/<version>/`, `lightpanda/<version>/`) and the logins of managed profiles (`profiles/<id>/`); safe to delete: profiles stay, logins are lost |
| `TEAM_BROWSER_XVFB` | - | `1` = headed Chrome on a Linux server without a display (needs `xvfb-run`) |
| `TEAM_BROWSER_MAX` | `4` | browsers open at once; the Browser page shows each running profile's memory and CPU and the server's free memory |
| `TEAM_ROUTINE_TICK_MS` | `15000` | routine ticker interval (`0` = off) |
| `TEAM_LOG_MAX_ROWS` | `5000` | model call log (Logs page): rows kept |
| `TEAM_LOG_RETENTION_DAYS` | `7` | model call log: days kept |
| `TEAM_EVENTS_RETENTION_HOURS` | `72` | events feed (SSE source, includes one `model-call` row per model call): hours kept, pruned at boot and every 10 min; `0` = by count only |
| `TEAM_EVENTS_MAX_ROWS` | `100000` | events feed: rows kept (the oldest go first). The newest event and the latest message of each agent are always kept. A client resuming from a pruned cursor gets a `resync` signal (SSE `event: resync`, or `resync: true` on `GET /activity`) and refetches its state |
| `TEAM_ROUTINE_RUNS_RETENTION_DAYS` / `TEAM_TASKS_RETENTION_DAYS` / `TEAM_LIBRARY_HISTORY_RETENTION_DAYS` | `30` / `90` / `180` | days kept of finished routine runs, finished tasks (their chat messages stay in the session store) and library history rows (besides the per-path cap); `0` = keep. Pruned at boot and every 10 min together with events |
| `TEAM_MEDIA_RETENTION_DAYS` | `3` | screenshots of MCP tools (`/.eharness/tool-media/`, stored as library files, the chat keeps only a small reference) and of the browser (`/.browser/shots/`): days kept; older files are deleted (the chat then shows "screenshot expired"); `0` = keep. Same schedule as the other retention. A new database gives the freed pages back to the disk (`auto_vacuum=INCREMENTAL`); an existing one only reuses them, so the file stops growing but does not shrink until you set `TEAM_DB_COMPACT=1` for one boot (see below) |
| `TEAM_DB_COMPACT` | off | `1` = convert an existing database to `auto_vacuum=INCREMENTAL` once at boot (a full `VACUUM`: needs free disk of about the database size, blocks writers while it runs, skipped when already converted). Set it, restart once, then unset it |
| `TEAM_CHANNEL_KEY` | dev key file | 32 bytes, base64: encrypts the channel message log at rest (its own key; dev: `data/channel.key`); `TEAM_CHANNEL_KEY_PREVIOUS` for rotation |
| `TEAM_TELEGRAM_API_ROOT` | `https://api.telegram.org` | Bot API root of the Telegram bot (a local Bot API server, or a test fake) |
| `TEAM_TELEGRAM_API_ID` / `TEAM_TELEGRAM_API_HASH` | - | api_id / api_hash of the Telegram account (MTProto) channel, from my.telegram.org/apps; or enter them once in the web connect flow |
| `TEAM_WEB_DIR` | - | serve the built web (`web/build`) from the server on one port; the API then lives under `/api` (set by the Docker image) |
| `TZ` | host timezone | default of the team timezone (Settings): the one clock of the app, what agents read as now (`datetime` tool), routines, reminders, chat times, the digest and active hours |
| `TEAM_SEED_AGENTS` | - | a new workspace starts empty; `1` = add the example agents (Lead, Researcher, Writer, Analyst, Ops) when the database is first created |
| `TEAM_DEMO_COLLECTOR` | - | `1` = register the demo community source (5 000 deterministic chat messages) for the big-data tools |
| `PUBLIC_TEAM_TOKEN` | - | web only: token the browser sends (else saved from Settings) |
| `TEAM_API_PROXY` | `http://localhost:4000` | web dev server only: where `/api` goes |

The web reads the token from `PUBLIC_TEAM_TOKEN` (build/dev env) or from the one saved on its Settings page (browser storage). Migrations are generated by
drizzle-kit (`bun run db:generate`) and applied at boot.

## Login

Set `BASIC_AUTH_PASSWORD` in `.env` and the web shows a sign-in page; leave it unset and there is no
login (the existing `TEAM_TOKEN` behaviour). After a correct password the server sets an `HttpOnly`,
`SameSite=Lax` cookie `team_session` (a signed token, 30 days; `Secure` on https or when
`TEAM_PUBLIC_URL` is https). Scripts and API clients keep using `Authorization: Bearer <TEAM_TOKEN>`.

- Use a long password and HTTPS outside localhost. Five wrong passwords lock a client out for 30 s,
  doubling with every further failure (in memory, per client address).
- Changing the password (or `TEAM_SECRET_KEY`) invalidates every session. Log out clears the cookie
  in that browser only (the token is stateless).
- With `TEAM_WEB_DIR` the web files stay public (they hold no data); every `/api` route is protected.
- Dev: sign in on http://localhost:5173; the vite proxy forwards the cookie to the server. Cookies
  ignore ports, so the OAuth callback on `localhost:4000` also sees it. Docker: one origin, so the
  cookie just works behind your HTTPS proxy.

## Telegram bot

1. In Telegram open **@BotFather**, send `/newbot`, pick a name and a username ending in `bot`, and
   copy the token it gives you (`123456:ABC...`).
2. Groups: the bot only sees mentions, replies and commands while **privacy mode** is on (the
   default). To let it follow a whole group (answer on every message, or observe), either make it
   a **group admin**, or send `/setprivacy` to @BotFather, choose *Disable* and **remove and re-add**
   the bot to the group. For channels, add the bot as an admin with the right to post.
3. In the web app open **Channels** -> **Connect a channel** -> **Telegram bot** and paste the token (it is stored
   encrypted and never shown again). The page tells you whether privacy mode is on.
4. **Bind** the connection to an agent. Add the bot to a group and write a message; the chat shows
   up on the channel's **Chats** page. Open it, allow it and choose when the agent wakes.
5. **People**: anybody who writes to the bot in a direct message shows up in the people table (filter
   *Not linked*: name, id, how often; never what they wrote) and gets no answer. Open the person and press
   **Link** to link them to a team member, or **Ignore**; **Link by Telegram user ID** (under the table)
   links somebody who has not written yet. Only linked accounts can message the agent directly. "Reply to unknown people"
   (Settings, off by default) makes the bot answer strangers with one neutral line.
6. **Inbox** lists every conversation (groups, topics, direct messages) with counters; open one for its
   channel log. **Activity** shows what happened to each message and reply. Every list is a table you can
   search, filter, sort and page; the address keeps the search and page.

A bot can only receive updates by one method at a time: if a webhook is set the page offers to
remove it. Run one server process per bot. `TEAM_TELEGRAM_API_ROOT` points at a local Bot API
server. Telegram's terms limit what may be done with chat data (platform data and AI): read the
notes in [P41](../../docs/plans/P41-team-channels.md) and ingest only chats you own or manage.

## People, roles, reminders and recaps (internal groups)

For a company group (for example a forum supergroup with a topic per division):

1. Add the bot to the group as an **administrator** (so it receives every message and topic), allow the chat on the channel's
   **Chats** page (topics inherit it), and keep "Full log" on.
2. The channel's **People** page: **Read the chat admins** imports the creator and administrators as
   *suggestions* ("suggested: admin in TEAMKU"); press **Confirm as ...** to make one a role. Give everybody a role
   (`owner`, `admin`, `member`, `guest`) and divisions (the topics a member may read). Link yourself to the
   team member `owner` so you are the owner. Somebody who is not in the directory is a `guest` (change the
   default on the channel's Settings page). Roles never come from chat text.
3. What each role may do: owner and admin approve in a chat, set reminders for others, schedule and use write
   tools; a member reads and recaps the chats of their divisions and sets their own reminders; a guest only gets
   answers. Every message the agent sees carries a header with the sender's role, topic and time.
4. **Reminders**: ask in the chat ("remind the group tomorrow at 9:00", "remind @Budi at 15:00"). The confirmation
   states the absolute time and topic in the team timezone (Settings). They post as written, without a model call,
   and appear on the channel's **Reminders** page where you can cancel them.
5. **Recaps**: "note today's chat" reads the allowed topics of the day in chunks and saves a note under
   `/library/recaps` with its source range; it says when the log starts after the window.
6. **Proactive posts** (routines, heartbeat): off until you allow them per chat or topic (a chat's page, Proactive posts:
   quiet hours, digest, mention limit).
7. An approval request nobody answers expires after 24 hours (channel Settings); a new message from the person who asked
   declines it with their message as the note.
8. **Trusted internal group**: on a chat's page, *Trusted internal group* makes people who are not in
   the directory *members* in that chat (inherited by its topics) instead of guests. Admin and owner stay explicit
   (People page). You get one bell notification per new unknown person and per unconfirmed platform-admin
   suggestion, linking to the People page. *Reply style* (brief, normal, detailed) sets the default reply length of
   the chat; the agent's own persona wins over the default.
9. **Who the agent is in a chat**: the persona and instructions of the agent own voice and tone. The channel layer
   adds a short per-turn *medium* reminder (where it is, default reply length) and a few non-overridable rules:
   it never explains internals (directory, tool names) to chat users, never invents product or platform names (its
   name is the agent's name; set `TEAM_NAME` to add the team's name) and takes roles only from the message header.
10. **Memory in chats**: greetings and small talk do not read memory, and a write that records a role, admin
    status, permission or capability is refused with a readable reason (those facts come live from
    `channel_status`, `member_lookup` and the header). To clean notes an older version wrote, run the one-off
    script (it only lists unless you ask it to remove, and backs up what it removes):

    ```bash
    cd examples/team/server
    bun ../scripts/clean-memory.ts                                   # list flagged files (dry run)
    bun ../scripts/clean-memory.ts --prefix /memories/agents/<agent id>
    bun ../scripts/clean-memory.ts --remove /memories/agents/<id>/telegram-capabilities.md
    bun ../scripts/clean-memory.ts --remove-all                      # every flagged file
    ```

    `--db` defaults to `TEAM_DB` or `./data/team.db`. Read the listed lines first: a flagged file can hold other
    useful notes too. A backup JSON is written next to the database before anything is removed.
11. **Reminders on the Routines page**: reminders made from chats show on **Routines** with a
    "Reminder · <chat>/<topic>" badge (active ones, and the recent finished or cancelled ones); cancel works there
    too. The `reminder` tool takes `message` (what is posted when it fires, written as the reminder itself, for
    example "Waktunya pulang"), `request` (what the person asked; context only) and `verbatim` (the person quoted
    the words); a message that just restates the request ("ingatkan ...", "remind me ...") is refused with a
    correction. The heartbeat and the digest stay off this page (they have their own pages).

## Telegram account (MTProto)

For groups and channels a bot cannot join (history backfill, admin log). Get an `api_id` and
`api_hash` at <https://my.telegram.org/apps> ([how](https://core.telegram.org/api/obtaining_api_id)),
set `TEAM_TELEGRAM_API_ID` / `TEAM_TELEGRAM_API_HASH` (or enter them in the web flow), then
**Channels** -> **Connect a channel** -> **Telegram account (MTProto)** and sign in by code or QR.
Use a **dedicated account** with two-step verification on: Telegram may limit or ban accounts driven
by API clients, especially for spam or flooding (this app sends slowly and keeps daily caps, but the
risk is yours). Read the [API terms](https://core.telegram.org/api/terms); this is not legal advice.
Run one server process per session. This transport has no automated tests; see the manual checklist
in [P41](../../docs/plans/P41-team-channels.md).

## Session context (what the agent knows of its other chats)

Every agent has four read-only tools to recover what was said or decided elsewhere before it says
"I don't know": `sessions_search` (recent sessions, or a text search over messages, grouped per
session with a snippet, the messages around each hit and the compaction summary), `session_read` (one
session: summary plus a window around a message id, a chat message number such as "pesan 12345", or
the latest N; scroll by re-anchoring), `runs_list` and `run_read` (program, routine and task runs:
status with error and retry state, report, decisions and how they were answered). Search is plain
SQL (a LIKE prefilter over the stored message parts, newest first, verified against the real text),
no FTS5 table to keep in sync. Everything returned is framed as untrusted content.

Who may read what is decided in code from the requester of the turn: the owner in the web app and an
owner or admin in a chat read every session of the agent; a member or guest reads only the
conversation they are in (and runs reported to it), never a web DM or another chat ("That chat is
private to its participants."); a program run reads its own earlier runs and the sessions its brief
names; the heartbeat reads its agent's sessions, web chats only when a standing order names them.
Only the lead, or an owner asking, can pass `agent` to read another agent's sessions.
Details: `docs/plans/P52-context-and-orders.md`.

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

- Required in `.env`: `TEAM_TOKEN` (16+ characters) or `BASIC_AUTH_PASSWORD` (12+ characters; the
  container binds `0.0.0.0`, so the server refuses to start without one) and a model key. Recommended: `TEAM_SECRET_KEY`, `TEAM_CHANNEL_KEY`,
  `TZ`.
- Open http://localhost:4000 and paste `TEAM_TOKEN` on the Settings page; the image never inlines
  it into the web bundle (`PUBLIC_TEAM_TOKEN` is ignored).
- All state (SQLite database, library files, dev key files) lives in the `/data` volume. Keep
  `TEAM_DB` unset in `.env` (a relative path would leave the volume).
- Another host port or a domain: set `TEAM_PUBLIC_URL=<origin>/api` (the web URL follows: `<origin>`; set
  `TEAM_WEB_URL` only when the web lives elsewhere). Links the agents send (artifacts, shares,
  channel replies) use it.
- `docker logs team` shows the server log; the container health check calls `/api/health`.

## Browser

The **Browser** page (admin) and the **Browser** connector give agents a real browser
([guide](../../docs/guides/browser-agents.md), [spec 35](../../docs/specs/35-browser.md),
[P48](../../docs/plans/P48-browser.md)). A **profile** is a named browser with its own logins.

- `TEAM_BROWSER_DRIVER`: `local` (default when the root is writable) lets this server download and run
  Chrome or Lightpanda for a **managed** profile; `off` leaves only **manual** profiles (a CDP URL of
  your own Chrome, a container, or a hosted service such as Browserbase, Kernel or Steel).
- `TEAM_BROWSER_ROOT` (default `<data dir>/browser`) holds the downloaded engines and each managed
  profile's logins; deleting it loses logins, not profiles. `TEAM_BROWSER_XVFB=1` runs headed Chrome on a
  Linux server without a display. `TEAM_BROWSER_MAX` (default 4) browsers at once; the page shows each
  running profile's memory and CPU and the server's free memory.
- **Docker.** Chrome needs system libraries; the image installs them when built with
  `TEAM_BROWSER_LIBS=1` (the default). Build with `--build-arg TEAM_BROWSER_LIBS=0` for a smaller image
  (manual profiles and Lightpanda still work). `--no-sandbox` is added only inside a container.

Create a profile and give it to an agent:

1. **Browser** page, **New profile**: a name, an adapter (Chrome or Lightpanda), then a mode. Choose
   **Run it on this server** and press **Download** then **Start**, or **Connect to an existing browser**,
   fill in the CDP URL (a secret) and press **Test connection**. Add **allowed domains** for a profile
   that holds a login.
2. Open the profile's live view, press **Take control**, log in once (2FA included), press **Give back**.
3. **Connectors**, **Browser**: connect it for one agent and choose the profile (give each agent its own).
   Acting is **Ask first** by default; an admin can mark the profile **trusted** so acting does not ask.

While an agent works you can watch the page live. **Take control** pauses the agent's acting tools
(`BUSY:`); **Give back** returns control. When the agent meets a login, CAPTCHA or 2FA it calls
`browser_request_human`: the turn waits, a takeover card appears in the decision center with **Open
browser**, and **Give back** resumes it. The library solves no CAPTCHAs.

## Code sandbox (Python)

The **Files & Sandbox** connector adds `run_python`: the agent writes a script and its data into the
library (`/library/work/analyze.py`), runs it, and the files the script creates or changes
(`report.md`, `chart.png`) are saved back into the library, where `read_file` and the Library page
show them. The sandbox is a disposable cache synchronised around every run
([spec 28](../../docs/specs/28-code-plugin.md), [P44](../../docs/plans/P44-code-sandbox.md)); the
database is the source of truth, so **no volume is needed** for code. Capability "Run Python" is
Allowed by default ("Ask first" makes it ask). Settings shows the driver, the Python version and whether it runs isolated.

- `TEAM_CODE_DRIVER=local` (default when `python3` is on the PATH): a scratch directory per session
  under the OS sandbox (macOS Seatbelt, Linux bubblewrap): no network, writes only in the scratch
  directory, the server's data directory (database, key files) and `$HOME` unreadable, 120 s CPU,
  1 GiB memory (Linux), 128 processes and 64 MiB per file. Without an OS sandbox on the host it runs unisolated, and Settings says so. The server probes the
  sandbox once at boot (a trivial command through it): bubblewrap installed in a container that forbids
  user namespaces counts as "no sandbox" (code still runs, not isolated, with a boot warning and the reason
  in Settings). In Docker, give the container `--security-opt seccomp=unconfined --security-opt apparmor=unconfined`
  (or use the Remote sandbox) to get isolation.
  Use it for development and trusted agents. Packages: the interpreter as it is, or a base
  environment built from `TEAM_CODE_REQUIREMENTS` (for example `examples/team/python/requirements.txt`),
  plus `TEAM_CODE_INSTALL` for packages agents ask for.
- The team image installs Python and a pinned virtual environment (`/opt/eh-python`, from
  `python/requirements.txt`): code runs with `local` inside the container. An optional pip cache
  volume only speeds up `TEAM_CODE_INSTALL`; nothing depends on it.
- The JavaScript `run_code` of the Data work connector (programs) is unchanged.

### Remote sandbox

The **Remote sandbox** connector runs `run_python` on a separate sandbox server
([`examples/sandbox-server`](../sandbox-server/README.md)) instead of this machine: the container is
the isolation boundary, packages live in its image, and the app only holds a URL and a token.

```bash
# from the repository root
docker build -f examples/sandbox-server/Dockerfile -t eharness-sandbox-server .
docker run -d --name sandbox -p 4100:4100 -e SANDBOX_TOKEN=change-me-please \
  --read-only --tmpfs /tmp:size=1g,mode=1777 --memory 4g --cpus 2 --pids-limit 512 \
  eharness-sandbox-server
```

Then open **Connectors**, choose **Remote sandbox**, enter the URL (`http://localhost:4100`, or the
service name in compose) and the token (stored encrypted); the connection test shows the Python
version and the isolation. Switch it on for an agent (it is off by default; its capability "Run
Python remotely" asks first). An agent that has it on gets `run_python` from the remote: the
Files & Sandbox "Run Python" of that agent is not registered as well, so there is always one tool.
Keep **Files & Sandbox** on for the files themselves. Settings shows `Remote sandbox: <host> ·
Python x · <isolation>`. `examples/sandbox-server/docker-compose.example.yml` runs the team example
next to a sandbox on an `internal` network (no internet egress for scripts). The team image
contains the sandbox client (`examples/sandbox-server/src`), nothing else of it.

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
