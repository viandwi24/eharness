# P40 — Team example: autonomous operations (manager, programs, decision center, big-data work)

Status: todo · Owner: maintainer (CTO mandate) · Branch: `main` (batched, see release workflow)

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

Every phase: offline scripted-model tests (team server tests), e2e in the browser on an isolated
instance, docs (walkthrough + guide), no paid model calls in tests.

## Acceptance criteria

- [ ] The acceptance scenario runs end to end on an isolated instance with scripted models: the
      manager proposes a plan, the client approves once, writer/researcher/auditor programs run
      and produce files, an escalation parks and resumes, the digest arrives.
- [ ] Auditor processes a 5 000-message fixture in chunks, survives a kill/restart mid-run
      (resumes from the manifest) and produces one merged report.
- [ ] Approved authority is enforced: an out-of-scope tool call is refused by the permission
      engine and turns into an amendment, not a silent failure.
- [ ] Team server + web tests, typecheck, lint green; walkthrough updated.

## Open questions

(none yet)

## Requests to other phases

(empty)
