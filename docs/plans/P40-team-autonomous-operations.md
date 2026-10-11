# P40 — Team example: autonomous operations (manager, programs, decision center, big-data work)

Status: in progress (phases A, B and D done) · Owner: maintainer (CTO mandate) · Branch: `main` (batched, see release workflow)

## Goal

The team example becomes a team that runs repetitive work on its own and only asks the client for
decisions. A **manager** agent keeps the backlog, assigns work and proposes plans; **workers**
(writer, researcher, auditor, …) pick up their work and finish it without supervision inside the
authority the client granted once; **heavy data** (thousands of chat messages a day) is processed
in chunks with checkpoints, file by file, and merged with code — never by stuffing everything into
one context. The client sees outputs (reports, drafts, findings) and a short list of decisions.

## The client's use case (acceptance scenario)

1. **Manager** checks all work, creates tasks for other agents, reviews results, and proposes
   plans to the client.
2. **Writer** checks the list of videos to produce and drafts a script for each title that has
   none yet.
3. **Researcher** picks open research items and works through them in detail.
4. **Community auditor** reads a community (Telegram groups/channels through an MCP connector —
   the source is pluggable, Telegram is only the first) and audits each day: anything odd, spam or
   link sharing, moderators misbehaving. Thousands of messages per day.
5. The client approves plans once; after that the work runs to completion unattended.

## Decisions (CTO)

- **D1 — One building block: a session.** DM chats, delegated tasks, program runs, heartbeat and
  (later) dreaming are all eharness sessions. Differences are policy (who starts the turn, what it
  may do, where the result goes), kept in one table (`run profiles`), not separate machinery.
- **D2 — Tool approvals live only inline in the session chat** (done in 4c37402). Nothing else
  answers tool approvals.
- **D3 — Authority is granted per *program/plan*, not per tool call.** What the client approved is
  enforced by the permission engine for that run (session rules + budget), never only by prompt
  text (approved == executed).
- **D4 — Program** (standing order): `authority` (tools, connectors, library paths; enforced),
  `trigger` (schedule via routines, or a heartbeat condition; events later), `gates` (actions that
  still need a decision), `escalation` (when to stop and ask), `forbidden` (deny rules), `budget`
  (per run, per day), `report` (DM digest / silent / task). Each run is a task session that follows
  **Execute → Verify → Report**, at most 3 attempts before escalating, with run history.
- **D5 — Decision Center** holds decisions only, three kinds:
  - **Proposal** — a one-off plan or a new program, with its authority and budget. Approve / edit
    then approve / reject. Approved plans run to completion.
  - **Escalation** — a running program/plan hit a gate or an escalation rule. The agent calls
    `escalate`, its session parks on an **external wait** (eharness `resolveWait`), the decision
    resumes the same session.
  - **Amendment** — a running plan needs more authority; approving widens its grant and resumes.
- **D6 — Work queue = the existing task board.** A task can exist before its session (`queued`,
  with an owner agent, a brief, links). The manager (or the client) creates queued tasks; a worker
  program picks the next queued task assigned to its agent. Board columns: Queued · Running ·
  Waiting for you · Review · Done/Failed.
- **D7 — Big data is processed in chunks with a manifest.** Pattern for any large source:
  1. *Ingest* (deterministic, no model): a collector pulls new items since a cursor into the
     library as files `/data/<source>/<channel>/<YYYY-MM-DD>/<HH>.jsonl`.
  2. *Plan*: a manifest `/work/<run>/manifest.json` lists the chunks and their status.
  3. *Pre-filter with code*: a `run_code` tool (sandboxed JS) computes stats, flags candidates
     (links, keywords, new members, bursts, admin actions) so the model reads less.
  4. *Map*: the agent (or parallel subagents, capped) processes one chunk at a time and writes
     structured findings per chunk `/work/<run>/findings/<chunk>.json`, updating the manifest.
     A run that stops (timeout, crash, compaction) resumes from the manifest.
  5. *Reduce*: `run_code` merges findings; the model writes the final report
     `/reports/<program>/<date>.md`; severe findings become escalations.
- **D8 — `run_code`**: sandboxed JavaScript (Bun subprocess, OS sandbox when available) over a
  per-run scratch directory synced from/to library paths the program may touch; no network; time,
  memory and output limits. Python later if the host has it.
- **D9 — Heartbeat = the manager's ambient monitor** (one rolling session `heartbeat:<agentId>`,
  active hours, empty checklist = no model call, silent when nothing is wrong). It runs program
  condition triggers, nudges stuck work, and **proposes programs from patterns it sees** — it never
  creates authority itself.
- **D10 — Daily digest** in the client's DM for information-only results; no notification per item.
- **D11 — Agents act on company systems as virtual users.** Each agent is a bot account of the
  company system with its own role and token; it calls the same API the web uses (OpenAPI →
  `openApiSource`), so business rules, validation and role checks are written once and enforced by
  the company backend (layer 1); program authority in eharness narrows it further (layer 2).
  Start on staging and read-only; write authority opens per program. Delegation "on behalf of a
  person" is out of scope until needed; company events (webhooks) as program triggers come later.
  - **Single source of truth:** the bot's roles and permissions are set only in the company
    system (its user / department pages). eharness stores no copy, so a change applies on the next
    request.
  - **Self-knowledge:** the company API exposes `GET /me` (roles, departments, permissions; shape
    compatible with the OpenID AuthZEN search API) and marks each operation with the permission it
    needs (`x-permission`). The agent's tool source is rebuilt every turn (`refresh: 'turn'`) and
    filtered by `GET /me` (short cache, invalidated by a company "role changed" webhook): the
    model only sees what it may do now. A `my_permissions` tool lets it re-check.
  - **Denials:** a structured 403 `{ code: 'forbidden', requiredPermission, message }` becomes a
    readable tool result; the agent adapts its plan or escalates in the Decision Center ("needs
    `x` to do `y`"); an admin changes the role in the company system and the run resumes.
  - **Effective authority** = company RBAC (layer 1, owned by the company admin) ∩ program
    authority (layer 2, approved by the client in the Decision Center).
  - **Safety:** the bot never gets RBAC admin endpoints (no self-escalation); the long-lived
    secret stays in the server vault and is never visible to the model; every request carries
    `X-Agent-Id` / `X-Agent-Run` so company logs trace back to the agent run.
- **Deferred:** memory consolidation ("dreaming"), skill evolution / auto-heal, voice, chat
  channels (Telegram/Slack as a UI). The Telegram *data source* comes through an MCP connector.

## Library impact

None expected: routines, subagents (background, park), permission rules and session grants,
`maxSessionUsd` / budget ledger, external waits, structured output, todos, library versions and
`untrustedContent` already exist. If a gap appears, it is written under *Requests to other phases*
and decided before code (docs over presets: patterns become guides, not wrapper APIs).

## Phases

| # | Deliverable | Notes |
|---|---|---|
| A | Run profiles + **Programs** (model, CRUD API, runs as task sessions, enforced authority, budget, run history) | reuses routines as triggers |
| B | **Decision Center** (proposals, escalations via external wait, amendments) + manager tools `propose_plan`, `create_task`, `escalate` | web page + bell links |
| C | **Work queue** (queued tasks, assignment, worker pick-up program, Review column) | writer and researcher scenarios |
| D | **Big-data toolkit**: collector interface + cursor, manifest helpers, `run_code`, chunked map/reduce with subagents; guide | auditor scenario on a scripted 5 000-message fixture |
| E | **Heartbeat** + daily digest + program suggestions | |
| F | Telegram source through an MCP connector (setup only) | after A–E work offline |
| G | **Company system integration (agent = virtual user)**: a mock internal company API in the repo (OpenAPI 3.1; roles employee / leader / manager; illustrative modules from one client use case — any departments work — e.g. a *Clipper* module: upload video, submit social link, analytics by views and by uploader; *Video production* module: idea → draft → shoot → edit → YouTube upload) and the team agents connected to it as **bot users** — one service account and token per agent (`kind: bot`, least-privilege role, revocable), tools from `openApiSource` (include/exclude per agent, method risk feeding program authority, token injected by `headers()` from the vault, never visible to the model), read-only first. Shows that business logic is written once (the API) and reused by people and agents. | D11 |

Every phase: offline scripted-model tests (team server tests), e2e in the browser on an isolated
instance, docs (walkthrough + guide), no paid model calls in tests.

## Phase A checklist (run profiles + programs)

- [x] Run profiles table (`domain/run-profiles.ts`): origin of a session id to policy (permission
      source, unattended, memory, result target, task origin, budget scopes). Read by `taskIndex`
      (task origin) and the agent factory (permission gate, ledger scopes).
- [x] Programs: domain (`domain/programs.ts`), `programs` table + migration `0015`, drizzle repo,
      use cases (`app/programs.ts`), REST routes + OpenAPI (`/programs`, pause, resume, run, runs).
- [x] Program runs: task sessions `program:<id>:<runAt>`, task origin `program`, on the board, run
      history = tasks of the program, "run now".
- [x] Schedule trigger through the routine scheduler (a program owns a routine,
      `routines.program_id`).
- [x] Enforced authority: session gate + `dontAsk` engine + deny rules from `forbidden`; budget via
      ledger scopes `program-run:<session>` and `program:<id>:<YYYY-MM-DD>`.
- [x] Run contract (Execute, Verify, Report, 3 attempts) and the structured report stored on the
      task row (`tasks.report`).
- [x] Web: Programs page (list, create/edit dialog with authority, gates, forbidden, budget, trigger,
      report; pause, resume, run now; run history with reports).
- [x] Tests (server `test/programs.test.ts`, web `lib/programs/form.test.ts`); walkthrough section 18.

Decided in phase A:

- Authority paths are library paths as the file tools see them (`/library/reports/**`); a write
  glob is readable too; `Edit(glob)` covers deleting inside it.
- Per-run budget is a ledger scope with `perRunUsd` as its limit, because `budget.maxSessionUsd`
  is an agent option, not a session one. A deleted program leaves its sessions with an empty
  authority.
- A program run is started with `session.send(..., { output })`, not the durable inbox (an inbox
  item cannot carry an output spec). A fire that is claimed but not started is recovered by the
  routine recovery (deterministic session id); a run that dies mid-turn is `interrupted`.
- A failed report, `output-invalid` and `cost-cap` are failed runs and count toward pausing the
  schedule (`maxFailures`); `partial` and `needs_decision` are `done` tasks with that report
  status (phase B turns `needs_decision` into a decision).
- Gates are text in the run prompt for now; tools pinned to ask (third-party connector writes) are
  refused in a run, which is the first kind of gate the engine knows.

## Phase B checklist (Decision Center)

- [x] Domain (`domain/decisions.ts`), `decisions` table + migration `0016`, drizzle repo
      (compare-and-set on `open`), use cases (`app/decisions.ts`).
- [x] Agent tools (`infra/eh/decisions-plugin.ts`, risk `write`, allowed by app rules): `propose_plan`
      (DM chats and heartbeat, not parked), `escalate` (program and routine runs, heartbeat) and
      `request_authority` (program runs), the last two as `externalTool()`s that park the run.
- [x] Resume through `session.resolveWait` (`infra/eh/decision-service.ts`), same session, decision
      as the tool output, program runs keep their report spec; works after a restart.
- [x] Program gate reads the program on every call (`gate.sync`), so an approved amendment reaches
      the parked run; refusal text and run prompt point to `request_authority` / `escalate`.
- [x] A `needs_decision` report becomes an escalation (answer sent as a new message).
- [x] API `/decisions` (list, get, approve with edit, reject), `decision-changed` events, OpenAPI.
- [x] Web: Decisions page (grouped cards, markdown, authority list, budget, Approve, Edit and
      approve, Reject with note, option buttons), rail badge, bell line that only links.
- [x] Tests (`server/test/decisions.test.ts`, web `lib/decisions/model.test.ts`, live store);
      walkthrough section 19.

Decided in phase B:

- `propose_plan` is flat (name, brief, authority, schedule, ... beside `title` and `body`); `agent`
  names the runner (the manager proposes programs for workers). `runOnce` makes the program manual
  and runs it at approval; the client can switch it while editing.
- One decision per wait id (unique index): a redispatched `start` after a crash reuses the row.
- Tools by origin: `dm` and `heartbeat` get `propose_plan`; `program`, `routine` and `heartbeat`
  get `escalate`; `program` gets `request_authority`. Delegated children of the lead get none (their
  parent is parked on them; they ask through the lead).
- An editing client can narrow an amendment (`authority` in the approve body); the program gets the
  union of its authority and what was granted.
- No timeout on a decision. `expired` means the run no longer waited when the client answered.
- The program authority is now read per tool call, so an edit also applies to a run in progress
  (it used to be frozen at session open).
- The task of a run parked on a decision shows `running` (the board does not know about decisions
  yet: phase C adds "Waiting for you" from the open decisions of the session).

## Phase D checklist (big-data toolkit)

- [x] Collector interface and cursor (`domain/collectors.ts`; the cursor is a library file
      `/library/data/<source>/_cursor.json`), ingest into hourly JSONL files, idempotent and
      at-least-once (`infra/bigdata/ingest.ts`).
- [x] Fixture collector: a deterministic 5 000-item community day with planted incidents and a
      `truth()` list (`infra/bigdata/fixture-collector.ts`); registered by `TEAM_DEMO_COLLECTOR=1`
      or `ServerConfig.bigData.collectors`.
- [x] `ingest_source` tool, limited by the program's write authority on the source directory.
- [x] `run_code` (`infra/bigdata/code-sandbox.ts`): Bun subprocess through `localSandbox` with the
      OS sandbox (no network), authority-checked copy in and out, limits, error strings.
- [x] Manifest (`domain/manifest.ts`) and tools `manifest_create|next|mark|status`: findings must
      exist and parse before a chunk is done, compare-and-set marks, 3 attempts, resume.
- [x] The `chunked-audit` skill, seeded into `/skills` (`domain/builtin-skills.ts`).
- [x] The **Data work** connector (`bigdata`, off by default) and its hook; program runs may take
      150 steps (`PROGRAM_RUN_MAX_STEPS`).
- [x] Tests: `server/test/bigdata.test.ts` (fixture, ingest, manifest, sandbox, no-program tools),
      `server/test/bigdata-audit.test.ts` (5 000-message auditor in chunks, the model's view
      measured, kill and restart resumes from the manifest, authority limits, ingest program).
- [x] Docs: walkthrough section 20, guide `docs/guides/chunked-work.md`.

Decided in phase D:

- Paths: D7's `/data`, `/work` and `/reports` are library paths, so `/library/data/...`,
  `/library/work/<run>/...` and `/library/reports/<program>/<date>.md` (the authority globs of phase
  A are library paths as the file tools see them).
- Ingest is a tool of a program run, not a separate scheduler: a program already has authority,
  schedule and run history, and the call returns one summary line. The function is independent of
  the tool, so a timer can call it later.
- The cursor is a library file, not a table: no migration, visible and versioned, and the write
  authority on the source directory covers it.
- `run_code` copies in only what the program may read and back only what it may write; a failed or
  timed-out run saves nothing. Without an OS sandbox it falls back to the same limits with a
  stripped environment and a soft network guard (`requireOsSandbox` refuses instead).
- A chunk is done only when its findings file exists and is valid JSON (so "done" means "saved").
- Program runs get `maxSteps: 150`: a chunked job is many small steps.
- Not built: parallel subagents are described in the skill (cap 3) but the tests drive a single
  worker; Python in `run_code` (D8 says later); an `escalate` call in the auditor test (phase B owns
  and tests the tool; the skill tells the agent to call it once after the report).

## Acceptance criteria

- [ ] The acceptance scenario runs end to end on an isolated instance with scripted models: the
      manager proposes a plan, the client approves once, writer/researcher/auditor programs run
      and produce files, an escalation parks and resumes, the digest arrives.
- [x] Auditor processes a 5 000-message fixture in chunks, survives a kill/restart mid-run
      (resumes from the manifest) and produces one merged report (phase D).
- [ ] Approved authority is enforced: an out-of-scope tool call is refused by the permission
      engine and turns into an amendment, not a silent failure.
- [ ] Team server + web tests, typecheck, lint green; walkthrough updated.

## Open questions

(none yet)

## Requests to other phases

- Library (optional, not blocking): inbox items cannot carry `SendOptions.output`, so a durable,
  restartable run with a typed result cannot ride the inbox. A way to attach a serializable output
  spec (for example a named spec the agent registers) to an enqueued input would let program runs
  be resumed by another instance. Worked around in phase A with a direct `session.send`.
- Phase B (done): the escalation tool parks the run on an external wait.
- Library (documentation gap, not blocking): the child side of the subagent plugin
  (`reconcileSubagentWaits`, run when a session opens) treats the `correlationId` of ANY external
  wait as the id of a child session and tries to settle it (`subagent: reconciling a wait failed`).
  An app that parks on its own external waits in a session that has the subagent plugin must not
  return `correlationId` from `start` (worked around: the decision id rides in `payload`). Worth a
  sentence in spec 11 section 4.2 or spec 20, or a `payload.kind` check in the reconcile.
- Phase C: show "Waiting for you" for tasks whose session has an open decision (`decisions` with
  `sessionId` and `status = 'open'`); `GET /decisions?status=open` plus the `decision-changed` event
  are enough. A worker that picks queued tasks should get `escalate` the same way program runs do
  (`decisions-plugin.ts` decides by `profileOfSession` origin).
- Phase E: `propose_plan` is already offered to origin `heartbeat`; its sessions are not built yet.
  The heartbeat's `escalate` has no program: the decision has `programId: null`.
- Library (optional, not blocking): the OS sandbox of `localSandbox` restricts writes and the
  network but not reads of the host file system, so `run_code` code can read files outside its
  scratch directory (the server database, key files). An `os.denyRead` list (paths the sandboxed
  process may not read, with a safe default for the home directory) would close it. Worked around by
  documenting the limit and by stripping the environment; use a container for hostile code.
