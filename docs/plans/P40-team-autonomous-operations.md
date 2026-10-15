# P40 — Team example: autonomous operations (manager, programs, decision center, big-data work)

Status: in progress (phases A, B, C, D, E, H, I, K and M done) · Owner: maintainer (CTO mandate) · Branch: `main` (batched, see release workflow)

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
  *(Phase N: assigning a task starts it by itself with the agent's chat authority; a worker program is
  optional, for standing orders.)*
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
- **Order:** A–E, then H (deliverables), I (stability), J (evals, when the client's examples exist), K (rehearsal). F (Telegram) waits for the messaging/channels design; G (company integration) is documentation only until a client integrates. Role templates are out of scope: roles depend on each client. Everything stays generic: client specifics are configuration, fixtures, skills or illustrative docs, never special-cased code.
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
| H | **Deliverables contract** (system layer): a program lists required deliverables (path pattern, markdown with required sections or JSON with a schema); the server checks them at run end, gives the agent one fix-up turn with the exact errors (the real *Verify* step), then marks the run `partial` and opens a decision. Style and quality guidance stays in editable skills. | after C, E |
| I | **Stability pass**: soak test (many program runs, several agents at once, kill/restart mid-run, injected provider errors 429/500/timeouts), end-to-end browser checks of every client flow | after H. **built** (walkthrough section 26) |
| J | **Evals** (developer tool, a CLI such as `bun run eval <scenario>`, no web page; opt-in, real model, budget-capped, not in CI; generic scenario format: fixture data + program config + deterministic checks + rubric): fixed scenarios scored automatically (auditor recall/precision against the planted incidents, deliverable checks) and by a rubric judge; scores kept per run to compare prompt/skill/model changes. Needs the client's output examples as the answer key. | **built** (framework + 3 illustrative scenarios); real runs await the client's examples and an approved budget |
| K | **Rehearsal (test run)** for clients, generic for any program: run a program on sample data in a safe mode (writes go to a scratch area, external writes such as company API calls or posts are disabled or simulated), show the deliverables, decisions it would raise and cost before activating; save rehearsals as the program's test cases and re-run them after edits. | after H, J. **built** (walkthrough section 25) |
| M | **Chat threads per agent, all equal** (pattern of ChatGPT / Claude Cowork / Devin): "New chat", rename, archive/delete for any thread (`chat:<agentId>:<threadId>`; the existing `dm:<agentId>` becomes the first thread with no special status). System news leaves the chat: the **daily digest becomes a Briefing page** (one entry per day + one bell notification; later deliverable to channels), **urgent heartbeat alerts go to the bell** (later channels), reports of work started from a thread return to that thread, work not started from a chat shows on the board. The lead can read briefings with a tool from any thread. **Following up**: every run is already its own session (open it from the board, a notification or a briefing and use its follow-up box: same session, same context); a briefing or an alert has **"Discuss in chat"**, which creates a new lead thread seeded with that item as context — threads are created on demand, never automatically per event. Continuity across threads comes from memory, not chat history. Generic, example only. | after I, K. **built** (walkthrough section 27) |
| N | **Work queue redesign: assign a task, it starts.** The value evaluation found the queue + Review flow "needs redesign" (a worker program form, manual *Run now*, authority amendments, manual re-run after send-back, clipped Review buttons; chat gave the same result faster). Tasks now start by themselves with the agent's normal chat authority, per-agent concurrency queues the rest, *Hold* keeps one from starting, Review is the creator's choice, send back restarts by itself, worker programs stay for standing orders. | after the value pass. **built** (walkthrough section 21, "Assigned tasks") |
| F | ~~Telegram source~~ — **deferred**: decided together with the messaging/channels design (data source vs outbound tools vs live chat) | later |
| G | **Docs only for now** ([docs/examples/integrate-team-to-your-system.md](../examples/integrate-team-to-your-system.md)); no implementation until a client integrates. Original scope: **Company system integration (agent = virtual user)**: a mock internal company API in the repo (OpenAPI 3.1; roles employee / leader / manager; illustrative modules from one client use case — any departments work — e.g. a *Clipper* module: upload video, submit social link, analytics by views and by uploader; *Video production* module: idea → draft → shoot → edit → YouTube upload) and the team agents connected to it as **bot users** — one service account and token per agent (`kind: bot`, least-privilege role, revocable), tools from `openApiSource` (include/exclude per agent, method risk feeding program authority, token injected by `headers()` from the vault, never visible to the model), read-only first. Shows that business logic is written once (the API) and reused by people and agents. | D11 |

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

## Phase C checklist (work queue)

- [x] Queued tasks: `queued` status, task columns (`brief`, `inputs`, `priority`, `due_at`,
      `created_by`, `accepted_at`, `round`, `history`) and `programs.worker`, migration `0017`.
- [x] Use cases (`app/work-queue.ts`) and API: `POST /tasks`, `PATCH /tasks/{id}`,
      `POST /tasks/{id}/cancel|accept|send-back`; board columns Queued, Running, Waiting for you
      (needs_action or an open decision of the session), Review, Done / Failed.
- [x] Manager tools `create_task`, `list_tasks`, `update_task` (the lead in DM and heartbeat; a
      program run only when its authority names them) and the worker tool `complete_task`
      (`infra/eh/work-queue-plugin.ts`).
- [x] Worker programs: each run claims the next queued tasks of its agent in code (atomic), one
      session per task; empty queue = skipped slot / `idle`.
- [x] Review: Accept, Send back with a note (re-queued, note appended to the brief, next run
      revises in a fresh session), retry of a failed work item.
- [x] Web: five-column board, New task dialog, task detail (brief, inputs, report, outputs, Review
      and queue actions), *Work queue* option of the program form.
- [x] Tests: `server/test/work-queue.test.ts`, web `lib/board`, `lib/tasks/queue`,
      `lib/programs/form`; walkthrough section 21.

Decided in phase C:

- **One session per task, not one per run.** The run claims and starts tasks one by one; each has
  its own chat, report, cost and failure. Session ids stay `program:<id>:<ms>` (the first task has
  the run's id, the next ones a millisecond later), so authority, budget, history and the
  routine's run row needed no change. A task sent back gets a new session; the old ones are listed
  in `history`.
- **Claiming is code, not a tool.** The brief listed a `next_task` tool. With one session per task
  the run already holds exactly one task, and a model that picks its own work can pick twice or
  skip; the atomic `claimNext` runs in the program service instead. A model-level `next_task` would
  need a second way to bind a task to a run session; not built.
- Review applies to **work items only** (tasks made through the queue). Scheduled program runs
  and delegations do not wait for acceptance: they would clutter Review with every run.
- A worker program is always allowed `complete_task`; manager tools need to be named in a program's
  authority (`tools`). `list_tasks` is read-only but follows the same rule.
- Only queued tasks can be edited or cancelled; a running task is stopped from its session.
- Run history of a program leaves out tasks that are queued again (they are not a run until a
  worker takes them).

## Phase E checklist (heartbeat and daily digest)

- [x] Heartbeat per agent (on for the lead by default): rolling session `heartbeat:<agentId>`,
      woken by a `sys:` routine every N minutes inside the active hours (HH:MM, IANA timezone);
      skipped (recorded, no model call) when off, outside hours, checklist empty, a beat runs or
      waits for a decision.
- [x] Run profile `heartbeat`: unattended, one fixed read-only authority; `propose_plan`,
      `escalate` (resumes with its result spec), `list_tasks`.
- [x] `team_status`: deterministic findings (stuck, failed, waiting, old decisions, failing or
      auto-paused programs, failing routines, connectors needing sign-in, budget, program
      suggestions at >= 3 similar requests in 14 days).
- [x] Silent by default: structured result, fingerprint dedupe (24 h; 14 days for suggestions),
      digest buffer, urgent items to the lead DM as one `eh.event`.
- [x] Daily digest built from data (program runs, decisions, Waiting/Review, heartbeat items, cost),
      idempotent per local day, quiet day sends nothing.
- [x] API `/agents/{id}/heartbeat` (+ `/run`), `/digest`; web Heartbeat tab; no migration (settings rows).
- [x] Tests `server/test/heartbeat.test.ts`, `web/src/lib/heartbeat/model.test.ts`; walkthrough section 22.

Decided in phase E: system routines reuse `routines.program_id` with a `sys:` key (not listed, no
events, not in `TickReport`); the urgent/digest message is an `eh.event` in the lead DM; a beat is
recorded by the `turn.end` hook; "similar" is word-overlap clustering (Jaccard 0.5 on crude stems),
deliberately conservative.

## Phase I checklist (stability pass)

- [x] Heartbeat never parks: `escalate` removed from its tools and gate (urgent goes to the lead DM,
      patterns to `propose_plan`); the beat prompt, run profile text, tests and walkthrough 22 follow.
- [x] Team timezone: workspace setting `timezone` (default `TZ` env, else the host timezone; editable
      in Settings). The heartbeat's active hours (`timezone: null` = follow the team, an own value
      overrides) and the digest time default to it; changing it retimes the digest routine.
- [x] Soak test `scripts/soak.ts` (+ `scripts/soak/{brain,server,invariants}.ts`), CI-safe `--quick`
      variant run by `server/test/soak.test.ts` (checker tested on broken rows too).
- [x] Bugs found by the soak, each with a regression test: killed heartbeat beats were never
      recovered (no task row); a killed program run left its routine run `enqueued` forever.
- [x] End-to-end flows `scripts/e2e-flows.ts` through the HTTP API (no browser automation
      dependency in the repository): program run, proposal, escalation, work queue Review and send
      back, heartbeat and digest.
- [x] Docs: walkthrough section 26 (Operations), scripts README.
- Not faked: the server clock is not injectable (`deps.clock` is `Date.now`), so the soak uses the
  shortest real schedule (10 s) and triggers the heartbeat and the digest through the API and a
  script-only control route.

## Phase J checklist (evals)

- [x] CLI `bun run eval <scenario> [--model] [--budget] [--repeat]`, `compare`, `list`
  (`examples/team/evals`); hard budget through the ledger and `maxSessionUsd`; refuses `CI`
  without `--allow-ci`.
- [x] Generic scenario format (fixture files, tasks, deterministic checks, JSON rubric files graded
  by a structured-output judge), reports as markdown + JSON under `evals/results/` (git-ignored).
- [x] Scenarios `community-audit` (recall/precision vs `truth()`), `research-queue`,
  `writer-drafts`; guide [Evals](../guides/evals.md); walkthrough section 23.
- [x] Tests with scripted models only (`evals/test`, `bun run test:evals`).
- Not done on purpose: real runs await the client's example outputs and an approved budget.

## Phase H checklist (deliverables contract)

- [x] Domain `domain/deliverables.ts` (path tokens, markdown headings, JSON Schema through an
      installed validator, `minChars`), `programs.deliverables` and `tasks.deliverables` columns,
      migration `0018`.
- [x] Run end: structured report, then the deterministic check; one fix-up turn in the same
      session with the exact failures; still failing = `partial` report + escalation decision.
- [x] Work items with failing deliverables stay out of Review (and cannot be accepted) until a
      re-check passes (`POST /tasks/{id}/deliverables/check`, or the decision's retry).
- [x] Program editor, proposal edit dialog (Decision Center), `propose_plan`, task view (Pass / Fail
      per file, Check again), run history badge.
- [x] Run contract text and the `chunked-audit` skill mention deliverables.
- [x] Tests `server/test/deliverables.test.ts`, web `form.test.ts` / `board.test.ts`; walkthrough
      section 24.

Decided in phase H: deliverables belong to the program (work items use their worker program's
list; a per-task list was not needed); the JSON Schema subset is whatever zod 4 `fromJSONSchema`
converts, installed into the pure domain (`infra/json-schema.ts`) because the domain imports no
packages; a report that says `failed` or `needs_decision` is not checked; the decision is an
ordinary report-source escalation, so approving it sends the client's note as a new message and
the run is re-checked when that turn ends.

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

## Phase K checklist (rehearsal)

- [x] Run profile `rehearsal` (session `rehearsal:<programId>:<ts>`, unattended, the program's
      authority, no task), migration `0019` (`rehearsals`, `program_tests`).
- [x] Scratch overlay over the library (`infra/eh/overlay-fs.ts`, registry by session id; file
      tools, memory and the big-data plugin; fail-closed read-only view for a rehearsal that is
      not running); the real library is never written.
- [x] External write tools simulated at the permission gate (`SIMULATED: would call <tool> with
      <input>`), recorded; `escalate`, `request_authority` and a `needs_decision` report recorded
      as "would ask"; `create_task`, `update_task`, `complete_task` simulated.
- [x] Sample data: library paths to copy, attached text files, a sample task for worker programs,
      `reads: library | sample`; a separate small budget cap (0.5 USD default, 5 at most).
- [x] Deliverables checked against the overlay (with the fix-up turn); result with report, files,
      simulated actions, would-ask decisions, tools, cost and the chat.
- [x] Test cases (sample + expectations: deliverables pass, tools that must not be called, report
      status), "Run all tests" (one after the other, a result per case), results tied to a program
      fingerprint (stale after an edit that matters), warning (not a block) when activating a
      program whose cases fail.
- [x] API (`/programs/{id}/rehearsals`, `/rehearsals/{id}`, `/programs/{id}/tests`, ...), web
      (program page with Test run, Tests and Test runs; result page), tests
      `server/test/rehearsal.test.ts`, web `lib/rehearsal/model.test.ts`; walkthrough section 25.

Decided in phase K:

- **Simulation is a denial text at the gate**, not a faked tool result. It is the one mechanism
  that covers plugin, MCP and OpenAPI tools alike (AI SDK has no output substitution for an
  approval decision); the model reads the text as the result and the recorded action list is the
  client-facing truth. Calls the real run would refuse stay refused the same way.
- **Reads fall through to the real library** by default (the client's own files, read only);
  `reads: sample` shows only the sample. Web reads (`web_fetch`) and read tools of connectors run
  for real: a rehearsal on the open internet is still a read.
- **Delegation (the Team connector) is simulated** (it is not one of the built-in connectors a
  rehearsal runs for real): the children it would start run in other sessions that the overlay
  cannot cover.
- **The overlay lives in memory** while the rehearsal runs and the produced files are stored in the
  result (text up to 200 KB per file, 2 MB per rehearsal); a restart fails a running rehearsal
  instead of resuming it. One rehearsal per program and three in the workspace at a time.
- **Staleness is a fingerprint, not the program version**: pausing, resuming, the schedule, the
  report mode and the budget bump `version` but do not change what a run does.
- The digest cost line leaves rehearsal spend out; the ledger (workspace scope, `rehearsal:` scope)
  and the logs page still show it, it is real money.
- Not built: rehearsing an unsaved draft from the editor (the editor offers Test run for the saved
  program), binary sample uploads (text files only), a live view of the files while it runs (they
  appear when it ends; simulated actions and would-ask decisions appear as they happen).

## Phase M checklist (chat threads, briefing, bell)

- [x] Threads per agent, all equal: table `chat_threads` (migration 0020), session ids `dm:<agentId>`
      (the migrated first thread) and `chat:<agentId>:<threadId>`; new / rename / archive / restore;
      per-chat routes take `?thread=`; an archived thread is read-only.
- [x] Migration of the single DM: first read and boot create the first thread row for the existing
      `dm:<agentId>` session, no data moves (test replays a pre-0020 database).
- [x] `source` (`web` | `channel`) and `sourceLabel` on a thread, source badge in the list; channels
      themselves are not built (P41).
- [x] Daily digest = Briefing page (`briefings`, one per day) + one bell notification; urgent
      heartbeat findings = bell alerts (`notifications`); nothing is written into a chat. The lead has
      `read_briefings` in any thread.
- [x] Delegation from a thread reports back to that thread (child sessions hang under the thread;
      attention roots, recovery and wake-ups walk every thread).
- [x] Follow-ups: runs keep their own session (follow-up box); "Discuss in chat" on a briefing item,
      an alert or a run opens a NEW lead thread seeded with an `eh.event` (never automatic).
- [x] Web: thread bar, `?t=`, Briefing page, bell with alerts, empty assistant messages hidden.
- [x] Tests `server/test/threads.test.ts`, `heartbeat.test.ts`, web `threads`/`briefings` models,
      stores and live; walkthrough section 27; API types regenerated.

Decided in phase M: the thread session id of the first thread stays `dm:<agentId>` (data never moves);
routines with `sessionMode: 'dm'` fire into the agent's newest live thread (never an archived one; all archived: a new "Routines" thread). The thread list is
ordered by last activity; an unnamed thread is named by its first user message. No hard delete:
archive is the delete (plan P32 §5.1). A briefing's "Discuss in chat" goes to the lead; `agent` may
name another one.

## Fixes of the first real-model pass

A pass with a real model (DeepSeek) running manager, worker and auditor programs found seven problems.
All are fixed in the team example; `src/` is untouched (the per-turn `settings.maxOutputTokens` of
`SendOptions` was enough).

- [x] 1. Files-capability trap: a program run gets the file tools its authority grants (`runFileTools`,
      the `fileGrant` plugin narrows `activeTools`; the connector's deny rule is dropped for a run, the
      gate still limits paths). `request_authority` for a tool the agent can never have returns the reason
      and does not park. The program editor warns for tools the agent cannot have (`POST /programs/check`).
- [x] 2. Budget floor: program turns pass a sized `maxOutputTokens` (`budget.maxOutputTokens`, else half
      the smallest budget, 2 048 to 16 384; no migration, the field lives in the budget JSON); the editor
      has the field and warns when a budget is below one call's reservation for the agent model.
- [x] 3. `propose_plan`: `agent` required (error lists agents), near-identical open proposals of one agent
      are not stored twice (the model gets the existing id).
- [x] 4. Heartbeat and briefing from real data: `team_status` spend lines (ledger and call log), failing
      findings carry the real spend, the digest counts all runs (window by activity, routines included),
      names failed runs, prints counts.
- [x] 5. `list_tasks` shows cost per task, a `program` filter and a total (read risk, lead and heartbeat).
- [x] 6. `column` (waiting / review / ...) on `GET /tasks` and `GET /tasks/{id}`; a parked run is not
      "stuck" for the heartbeat. `status` is unchanged (queue and claim untouched); the web board already
      mapped a parked run to Waiting through the open-decision set, so it needed no change.
- [x] 7. Channel tools in an authority of an agent bound to no channel: warning at save and in the editor,
      the start is refused before its first model call (`PROGRAM_UNRUNNABLE`, no task; a scheduled refusal
      notifies the bell once). Follow-up: `team_status` states the board counts and spend itself (month and
      today both from the call log over the team timezone, the day inside the month); a beat item that
      only restates task counts is dropped.
- Tests: `server/test/p40-fixes.test.ts` (scripted models, including a manager / worker / auditor scenario
  with Files edit off), web `lib/programs/form.test.ts`.
- Not changed: tools named in an authority that the agent has through a connector turned off are only
  warned about (the run starts and the model cannot call them); only the channel case fails early,
  because that is the one that made runs loop.

## Fixes of the browser end-to-end pass

A browser pass (S0 to S11) found defects D1 to D18. The server-side ones are fixed in the team example
(`src/` untouched); the web ones are another change. Details and design choices:
[walkthrough 27b](../guides/walkthrough-server.md). Tests: `server/test/e2e-fixes.test.ts` (scripted
models), plus changed expectations in `routines`, `threads` and `agent-factory` tests.

- [x] D4 a decline note is the user's own words; D6 program authority satisfies "Ask first" (Off wins,
      warned); D7 rehearsal runs reads; D8 proposal outcome reaches the agent; D10 routine auto-pause
      and D11 Review in the bell, send-back hint; D12 no early fires; stale escalation expired;
      D15 budget stop notice; D14 spend from the call log; D18 connector reachability and beats with
      read tools; D3 always allow siblings and scope; D2 inline thinking split; seed roles.
- Decided: a rehearsal read is a connector capability of kind read (an MCP `readOnlyHint` never
  lowers a risk); Usage counts the call log, so it covers what the log keeps (`since`); the digest
  already used the call log; stale = a newer run of the same program exists.
- Not reproduced: D18 "the digest creates no bell item" (the item exists; opening the Briefing page
  clears it) and the parked task after a restart (`running`, column `waiting`, stable across the
  recovery pass). `pendingKind` has no `decision` value; adding one touches every task consumer.
- Web follow-ups that need the new API: show `hint` of send-back, `scope` of Always allow, `calls`
  and `since` of Usage (the "Turns and runs" label counts turns and runs, not calls).

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

## Value pass (after the value evaluation)

Done in `examples/team`, no library change, no migration:

1. Program authority is validated and repaired against the agent's real connections and tools; the
   effective grant is shown in the editor and on decision cards (walkthrough 18, "Value pass").
2. Stand-down answers ("keep waiting") are remembered per program and subject for 7 days and fed to
   later runs; the program page lists them with Forget.
3. Routines: queued input of the session is visible and clearable; the default mode is a task.
4. Approval noise: reads of custom connectors default to Allowed (on test); readable approve-all
   rows; big-data tools only in program runs.
5. The Analyst seed has library write (new workspaces; an existing Analyst gets it by turning Files
   edit on in its settings). 6. Task titles are short labels.

The work queue / Review redesign is phase N below. Existing connections keep their stored Ask
modes for reads.

## Phase N checklist (work queue redesign: assign a task, it starts)

Source: the value evaluation (work queue + Review = "needs redesign").

- [x] **Assigning starts it.** `createTask` (dialog, board, `POST /tasks`, `create_task`) and send back
      call `dispatchQueue`: the owner agent works the task in a chat-like session
      `task:<taskId>:<round>` (run profile `task`: the agent's own tools, permissions and mode;
      `escalate` is available, approvals ask the client on the board). No worker program needed.
- [x] **Concurrency.** `agents.task_concurrency` (1 to 8, default 1, *Tasks at once* in the agent
      settings) and the team-wide spawn cap: extra tasks wait as Queued with a reason (`queue`:
      `slot`, `hold`, `worker`, `starting`) and start when one ends (run promise, 10 s safety pass,
      boot / repair pass). Claiming is atomic (`claimAssigned`).
- [x] **Hold / Start now.** `tasks.hold`; `POST /tasks/{id}/start` starts any queued task at once.
- [x] **Authority = chat authority** plus optional task grants (`tasks.grants`: tools, connectors,
      read and write paths) as pre-approved allow rules for that task; deny rules and pinned asks
      still win. No amendment step for normal work.
- [x] **Review is the creator's choice.** `tasks.review`: default on for client-made tasks, off for
      tasks an agent created (the delegator reads the result with `list_tasks`). Send back re-queues
      and **starts again by itself** with the note (hint says so).
- [x] **Worker programs keep working.** An agent with an active worker program keeps its queue (tasks
      wait as `worker`, held tasks are skipped); standing orders are what they are for.
- [x] **Migration 0029** (additive columns with defaults): queued tasks of agents without an active
      worker program start at the first pass after the upgrade, held ones do not.
- [x] **Web.** New task dialog without the worker warning (review / hold toggles, optional extra
      permissions), *Tasks at once* in the agent editor, board badges (*waiting for a slot*, *on
      hold*, *waits for worker*), the task drawer actions (Start now, Hold, Accept, Send back, Try
      again) in a footer that is always reachable, details capped and scrollable (fixes the clipped
      Review buttons at small heights).
- [x] Tests: `server/test/task-assignment.test.ts`, the work-queue tests adapted (a task for an agent
      without a worker now starts), web `lib/tasks/queue.test.ts` and `lib/board/board.test.ts`. The
      first run of the review pass found six failing server tests (stale expectations, one broken
      migration-rollback harness); they were corrected and the hardening tests below added.
      **Status: written and corrected, not yet run again** (the pass that made these changes ran no
      tests by order; run `bun test --no-env-file` in `examples/team/server` before relying on them).

Decided in phase N:

- **A worker program still owns its agent's queue.** The alternative (assigned tasks always start,
  the worker only takes what is left) would silently run a task outside the narrow authority the
  client gave the worker. *Start now* is the explicit escape hatch.
- **Held tasks are skipped by worker programs too**: hold means "not by anything automatic".
- **Slots count running and parked tasks (per agent).** A task that waits for an approval keeps its
  agent's slot; otherwise a second task could race ahead of a decision the client has not made yet.
  The team-wide spawn cap counts only running tasks (hardening pass).
- **Agent-created tasks default to no Review**: the creator is an agent (or the lead for the
  client), it reads the result with `list_tasks`; it can ask for review with `review: true`.
- Not done: the bell notice "Ready for review" is posted when a task ends in its own turn, not when
  it ends in a turn that continued after an approval (the board still shows Review).

### Hardening pass after the code review (written, not run)

- **Crash strand.** A task claimed `running` whose `task:` session never got a message (the process
  died while the session was prepared) goes back to `queued` by the repair pass
  (`team.reconcile`, drift step): at boot at once, later after the stale-turn grace (2 min). It
  starts again by itself. New port `tasks.requeueUnstarted`.
- **Assigned tasks may post like chat.** `channel_send` of a `task:` session is not under the
  proactive policy when the client created the task or its grants name `channel_send`
  (`taskMayPost`); a task an agent wrote for itself, routines and the heartbeat stay under it.
  Files (`upload`) now follow the proactive policy too (`proactive.check`: allowed here, no quiet
  hours, outside the digest gap; a file cannot be held). `react` stays free: an emoji on a message
  is no text, mention or file.
- **Role check no longer fails open.** A turn woken by a chat message whose sender cannot be
  resolved is a guest (`gateway.unresolvedChatTurn`); a turn with no chat trigger (web, program,
  routine) is unrestricted by design.
- **Remembered decisions.** Only an option the agent flagged (`standDown` list of `escalate`,
  labels from `options`) or, as a fallback, a *whole* label on a short allowlist (keep waiting,
  skip, ignore, later, not now, tunggu, lewati, ...) is remembered, and the fallback only for a
  record id (`T-05`), never for a bare title. "Hold the shipment and refund" is an action and is
  not remembered.
- **Parked tasks.** A task parked on an approval keeps its per-agent slot but no longer counts under
  the team spawn cap; a queued task waiting behind it carries `queueNote` ("waiting: <task> needs
  your approval first"). Web follow-up: show `queueNote` next to the `slot` badge.
- **Send back.** Clears a hold left from a hand start (the revision starts); the hint reflects the
  real state (it says "you put it on hold" only when the owner re-held it); accepting or sending
  back resolves the "Ready for review" bell notice.
- **Usage calendar.** `team_status` month and today are both team-timezone periods
  (month = the larger of the UTC-month ledger and the call-log month, so today never exceeds it);
  the Usage page keeps the ledger (UTC month) for the budget.
- **Persona bookkeeping.** A proposal is marked applied only after the version committed (a
  version conflict leaves it pending); the live-session map holds weak refs and is pruned; the
  superseded-build list shrinks; a session is closed only when idle twice in a row.
- **Small.** Cancelling a done reminder keeps it done; at most 10 active repeating reminders per
  person (`channels.maxRepeatingReminders` / `TEAM_MAX_REPEATING_REMINDERS`, 0 = no limit);
  program views and the authority repair no longer open connector connections (the repair runs after
  boot activation; `GET /programs/{id}` uses what is activated); legacy message migration says once
  how many bodies cannot be opened and gives up after 3 boots (marker `gaveUp`).
- Tests written for the above, not run: `task-assignment.test.ts` (strand, parked slot, send back),
  `channels-l6.test.ts` (unresolved sender, file policy, reminder limits), `p40-value.test.ts`
  (stand-down). Not covered by a test: persona apply-after-commit, legacy attempts counter,
  `taskMayPost` wiring.

## UX follow-ups (written, not run)

Server markers the web reads instead of guessing: `metadata.app.instruction` (task, program, routine, rehearsal
prompts), `metadata.app.autoAllowed` (calls let through without asking), `payload.standDown` (options a program
remembers). Plan cards say schedule and authority in words and no longer point to the Decision Center inside it;
`task.queueNote` shows beside the slot label. Reminders also work from web chats (P41 notes, walkthrough 28g), so the
lead no longer turns "remind me" into a proposal. No library change.

## Channel delegation and recovery fixes (e2e catalog findings 1, 2, 3, 5)

- **Delegation replies reach the chat.** A turn that delegated (background start, then the ack) is a
  continuation without a chat trigger: the gateway remembers the message a turn works for
  (`turnTriggers`) and, per session, the message that asked for a delegation (`delegations`). The ack is
  posted as a reply to it; the wake turn a finished delegation starts posts its reply to the same
  message (outbox idempotency key `wake:<turnId>`, so it is a second reply, not a duplicate).
  The wake turn runs with the original requester's role.
- **Cancel is never a dead end.** Delegations are background by default (`background.default`). If a
  foreground delegation runs anyway, a message of the requester (or an admin) in that chat aborts the
  child (`delegation.abort` dep), the child's stopped report resolves the wait and the message is read
  next. `update_task` with `cancel` also stops a running board task (aborts its session like the web
  Stop; a task waiting on an approval says so).
- **Delegated approvals in the chat.** The `delegatedApprovals` plugin (every agent) hands a child's
  turn ends to the gateway, which posts its approval request with buttons in the conversation that
  asked for the work (rows keep the child's session id, so a press answers the child). A message
  while approvals wait follows the existing decline/context rules, children's requests included.
- **Restart.** A turn cut by a graceful stop ends `aborted`/`interrupted` and now posts one short
  notice; a turn closed by boot recovery (crash) gets the same notice via `turnInterrupted`. Decision:
  notify and ask to resend, never auto-continue (tools may have partly run; ADR-0014).

## Requests to other phases

- Library (optional, not blocking): `createChatSession` of `eharness/client` has `send`, `retryTurn` and
  `continueTurn` but no `regenerate(messageId)` / `edit(messageId, input)`, although the HTTP chat route
  and `useChat` support both. The team web calls `chat.regenerate({ messageId })` and
  `chat.sendMessage({ text, messageId })` on the bound chat and then `session.refetch()` (worked around in
  `AgentChat`); wrappers in the session would give them the same busy/error handling as `send`.
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
- Phase C (done): show "Waiting for you" for tasks whose session has an open decision (`decisions` with
  `sessionId` and `status = 'open'`); `GET /decisions?status=open` plus the `decision-changed` event
  are enough. A worker that picks queued tasks should get `escalate` the same way program runs do
  (`decisions-plugin.ts` decides by `profileOfSession` origin).
- Phase E (done): heartbeat sessions exist; `propose_plan` and `escalate` work from them.
  The heartbeat's `escalate` has no program: the decision has `programId: null`.
- Library (optional, not blocking): the OS sandbox of `localSandbox` restricts writes and the
  network but not reads of the host file system, so `run_code` code can read files outside its
  scratch directory (the server database, key files). An `os.denyRead` list (paths the sandboxed
  process may not read, with a safe default for the home directory) would close it. Worked around by
  documenting the limit and by stripping the environment; use a container for hostile code.

## Production feedback: non-blocking escalations, who answered, program agreements (as built)

- **`escalate` does not park any more.** A program run that called `escalate` waited 53 minutes for
  the Decision Center. `escalate` is now an ordinary tool: it stores the escalation without a wait
  (`waitId` null, same path as a report-made escalation), returns at once, and tells the model to
  finish the job and end the run; the answer continues the finished session as a new message
  (`decision-service` `send`). `escalate_wait` (an `externalTool`, the old behaviour) is for runs that
  can do nothing else. A tool cannot be both plain and external in eharness, so `wait: true` on
  `escalate` only answers with "call `escalate_wait`" (nothing is asked). Both are in
  `PROGRAM_BASE_TOOLS` and `DECISION_TOOLS`. A waitless escalation with the same question open in the
  same session is one decision. `expireIfStale` is unchanged: a newer run of the same program closes
  an older pending report/waitless decision as `expired`.
- **Who answered.** `DecisionAnswer` carries `answeredBy` ("Answered in the web app (Decision
  Center) by the client"; a chat answer passes `{ via: 'chat', name }` through `approveDecision` /
  `rejectDecision` `by`) and `attribution` (tells the model to attribute the decision to exactly that,
  never to the person it addressed). Both are in the `escalate_wait` result and in the follow-up
  message.
- **Program agreements.** `programs.notes` (JSON column, migration 0030) is returned and patched by
  the API (`notes`, max 50 x 1000 chars), edited on the program editor ("Standing agreements") and
  listed on the program page. Every run prompt prints them after the brief; they never grant
  authority or lift a gate. Chat tool `program_note` (list / add / remove, `dm` origin, risk
  `write`, approved by rule) changes only `notes`; the channel role check refuses members by risk.
  `memory_view` joined `PROGRAM_BASE_TOOLS` (read-only memory for runs).

## Proactive heartbeat (chats, report destination, activity wake)

- **Checklist visible**: the heartbeat panel says plainly when `HEARTBEAT.md` is empty ("every beat
  is skipped, the heartbeat does nothing") and offers an inserted suggestion (never auto-seeded);
  the file is edited through `/memory/file` (the app has one trust level: the owner). Agents with a
  heartbeat on are told in their chats to write "be proactive about X" as a line of that file.
- **Chats in a beat**: the read-only channel tools (`channel_describe`, `channel_read`,
  `channel_status`, `list_topics`, `member_lookup`, `chat_history`, `people_find`) join
  `HEARTBEAT_ALLOWED`; `channel_read download` (writes a file) is refused in the gate.
- **Report destination**: config `reportTo` (a node of the agent's own connections, chosen from
  `destinations` in the heartbeat view) and `maxPostsPerDay` (6). The gate allows `channel_send`
  only as action `send` to exactly that node; the post is counted before it is sent (cap per local
  day), a repeat of the same text inside 24 h is refused, and the post still goes through
  `gw.proactive.submit` (allowed flag, mentions, quiet hours, digest). No `reportTo`: no posts.
- **Activity wake**: `wakeOnActivity` (off by default) and `minGapMinutes` (10). The gateway calls
  `onObserved` for a stored, unaddressed message; the service plans one early beat per agent
  (settle 30 s, never sooner than the gap after the previous beat, active hours, real checklist).
  Watched chats = the chats named in the checklist (title, or id), else every allowed group,
  channel and topic of the agent's connections; never DMs and never `reportTo` itself. `team_status`
  lists new messages per watched chat since the last beat; an activity beat with none makes no
  model call and leaves no history line.
- **Urgent findings** go to the bell (global, not tied to a lead). A team with no `lead` now still
  gets its digest: the digest routine is hosted by the first agent with a heartbeat on.
- **Modes and notes**: config `mode` = `off` (findings only), `notes` (reads the chats, keeps notes,
  never posts) or `speak` (may post to `reportTo`, which may be the very chat it watches). Default
  `notes`; a config stored without a mode keeps speaking when it has a `reportTo`. The only write a
  beat has is the `heartbeat_note` tool: one append-only file per day,
  `/library/notes/heartbeat/<slug>/<YYYY-MM-DD>.md` (team timezone), path built server-side. The
  prompt asks it to read today's and yesterday's notes first and carries a short speak rubric
  (`SPEAK_RUBRIC`) only when posting is possible. Result items carry `decision` (note / say /
  escalate) and a one-line `reason`, shown in the beat log; `note` items stay out of the digest,
  `escalate` rings the bell like an urgent item.
