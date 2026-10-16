# P52 — Context across sessions and standing orders

Status: in progress · Owner: agent session · Branch: main

## Goal

The team's agents can see their own other sessions. An owner talks to an agent in a web DM and
expects it to know that context in the Telegram group; a standing order says "as agreed in the
Crew group, message 12345"; a program run's errors and decisions were visible only in report
files. After this phase the agent has read-only session context tools, scoped by who is asking. (The
standing orders and heartbeat part of this phase is written by the other agent below.)

## Part 1 — Session context tools (this section)

### Tools (`infra/eh/session-context-plugin.ts`, every session kind, same tool order)

| Tool | What it does |
|---|---|
| `sessions_search` | No query: browse the recent sessions of the agent (id, kind web/channel/program/routine/task/heartbeat/delegated, title or chat name, last activity, preview). With a query: messages whose text has every word, grouped per session, each with a snippet, +/-N messages (default 2, max 5) and the compaction summary. Filters: `kind`, `chat` (name part or node id), `since`, `until`, `agent`. |
| `session_read` | One session: compaction summary and a window of messages around a message id (`around`), around a chat message number (`platform_message`: "12345" for "pesan 12345"), or the latest N. The answer names ids to re-anchor from (older / newer). Tool parts are shown as `[tool name state -> short result]`, files as references. A chat name works instead of an id. |
| `runs_list` / `run_read` | Runs of the agent from the task index: status (retrying / failed with the error), start and end, report summary and outputs, the decisions and escalations of the run and how they were answered, the session id to open. |

Descriptions tell the model to search before saying it does not know.

### Search backend

SQL over `eh_messages.parts`: a LIKE prefilter (each term JSON-escaped, all terms must match, newest
first, 1500-candidate cap, only the sessions of the agent that pass the privacy gate), then each
candidate is verified in code against its real text parts. FTS5 was not chosen: it needs a shadow
index kept in sync by triggers with the JSON `parts` on every `persistEachStep` upsert, a backfill
migration of the whole history and a hand-written migration (drizzle cannot generate virtual
tables). `SessionContextStore.search` is the single place to replace with FTS5 if a team outgrows it.
Chat message numbers are searched as text: the header of a chat message carries `message <id>` / `#<id>`.

### Privacy gate (`decideAccess`, `domain/session-context.ts`)

| Caller | May read |
|---|---|
| Web app (the owner), or owner/admin requester in a chat | any session/run of the agent, web DMs included; `agent` (another agent) when the agent is the lead or the requester is an owner |
| Member / guest in a chat (or an unresolved chat sender) | only sessions of the same chat/topic (the node and its room) and runs whose report was posted there (`channel_outbox`); otherwise "That chat is private to its participants." |
| Program run / rehearsal | its own program's runs (`program:<id>:`) and the session ids named in the brief and notes |
| Routine / task run | its own lineage and the session ids named in its prompt/brief |
| Heartbeat | any session of its own agent; web chats only when an order references them (`canReadForHeartbeat(agentId, target, refs)`; refs via `AgentFactoryDeps.sessionRefs`) |

All returned text is wrapped in `<untrusted-content>` (`untrustedContent` of the core).

### Wiring for the heartbeat part

- `SESSION_CONTEXT_TOOLS` (domain) must be added to `HEARTBEAT_ALLOWED` by the heartbeat module.
- `AgentFactoryDeps.sessionRefs(agentId)` returns the session ids of the active standing orders'
  references; `main.ts` should pass it.

### Checklist

- [x] domain: tool names, kinds, `decideAccess`, `canReadForHeartbeat`, rendering helpers
- [x] infra: store, plugin, factory wiring, chat allow rules, program base tools
- [x] tests: `test/session-context.test.ts`
- [x] README section

## Open questions

- Routine runs in `dm` session mode live in the DM thread and are read as part of it.
- Runs are listed from the task index; a run that never became a task row is not listed.

## Part 2 — standing orders and heartbeat

Production evidence (agent "Scout", four orders of the owner): a rule (a screenshot of another
broker's platform in the group: report who and when), a watch (a YouTube channel: uploads, rhythm,
anomalies), a one-shot ("today around 12:00 check whether the analysis video is up; if not, a
penalty to the person in charge, record it, report"), and a ledger rule ("when I say I took videos,
record the date and count; not uploaded in 2 days: warn the PIC and report"). The beat could not
verify the video (no web or browser tools in a beat), the one-shot had no exact time (hourly beats),
nothing kept the video list, notes were free text without proof, and orders never expired.

### Order kinds (`domain/standing-orders.ts`)

The tail of the line in `HEARTBEAT.md` gains optional fields; a line without them is a `watch`
(backward compatible, a plain watch keeps the short tail):

`kind:rule|deadline|ledger  due:<ms>  expires:<ms>  done:<ms> outcome:<enc>  refs:<enc,enc>
needs:<enc,enc>  ledger:<enc path>`

| Kind | Meaning | Chat order becomes it when |
|---|---|---|
| `watch` | ongoing | "pantau channel YouTube ..." |
| `rule` | react when X happens | "kalau ada yang posting screenshot platform lain, laporkan ke saya" |
| `deadline` | one exact wake at `due`, then `done` with an outcome | "hari ini jam 12:00 cek video IHSG; kalau belum ada ..." (`due` resolved in the team timezone: ISO, `today 12:00`, `tomorrow 09:00`, `in 2 hours`) |
| `ledger` | keeps a tracker (default `/library/trackers/<slug>.md`) | "kalau saya bilang sudah take video, catat tanggal dan jumlahnya; 2x24 jam belum upload: SP" |

`standing_order` `add` takes `kind`, `due`, `expires`, `refs` (session ids, "General #12345": the beat
opens them with `session_read`), `needs` (`web`, `browser`, `phone/<connection slug>`,
`files:<library glob>`, read hint only) and `ledger`; `list` shows all of it; `done` ends a deadline
with its `outcome`; `remove` is as before. Needs and a ledger are refused for a member's order.
`parseChecklist(text, now)` takes the clock: done and expired orders are not active and do not make
the beat run. The Heartbeat tab groups orders by kind (done and expired collapsed), refs as links,
needs as chips, a ledger link.

### Exact wakes

A live `deadline` order has a one-shot system routine `sys:order:<agent>:<order>` (`at: due`,
`maxFires: 1`, catch-up 12 h), kept in step with the file by `syncOrderWakes` (on add, remove, done,
and at the start of every beat, so a hand edit of the file is picked up within one interval). Its
fire starts a beat with trigger `deadline`: active hours do not hold it back, the prompt is about
that one order (`beatPrompt({ focus })`), and a busy session is retried every 90 s (6 times). The
beat ends the order with `heartbeat_order_done` (outcome); if it cannot find out it escalates and
the order stays (the next hourly beat sees it as "its time has come"; hygiene flags it overdue).

### Tools follow the orders (gate)

`beginBeat` writes a snapshot `grants` into the heartbeat state: the `needs` and ledger paths of live
orders whose giver is an owner or an admin **today** (the identity's current directory role; a gone
or demoted giver grants nothing) plus the session ids the orders name (`sessionRefs`). The gate
(`gateOf`, heartbeat branch) then allows: the tools of the agent that the needs open (`web` = web
connector, `browser` = browser connector, `phone/<slug>` = that connection; reads always, acts only
when the connector mode is not "ask first" or "off"), and `write_file` / `edit_file` only on a
granted ledger path (`delete_file` never). Notes and patterns have their own fixed-path tools.
Sensitive acts named in an order (points, SP, warnings to members, kicking): `SENSITIVE_RULES` in the
beat prompt: record and report to the giver; the penalty/warning text may be posted only when the
order says so and only in the order's own report chat (the existing `channel_send` gate);
kicking or banning is never done, always escalated.

### Factual notes, patterns, weekly review

- `heartbeat_note` requires `confidence` (`seen`|`inferred`) and evidence: `messageIds` of the chat,
  or `evidence` (URL, `/library/...`, `session:<id>#<message id>`); a note without is refused with a
  sentence. The line ends `(decision, seen; ev: ...)`.
- `heartbeat_notes` reads notes and marks `[no longer resolves: ...]` for a library path or session
  that is gone.
- Weekly review (first scheduled beat on a Monday, team timezone): the server asks the owners in the
  Decision Center about orders that never led to a report in 14 days, expired ones, deadlines
  overdue by a day and done ones older than a week (one question per order; nothing is removed).
  The beat condenses last week's notes with `heartbeat_pattern`, which the server accepts only when
  the named days have notes on at least two different days; they go to
  `/library/notes/heartbeat/<slug>/patterns.md`.
- `fired` counts (reports/escalations per order id, from beat items with `order` and notes) feed the
  "never triggered" rule.

### Order hygiene (no model call, every beat)

`orderHygiene` (`domain/order-hygiene.ts`): destination gone, giver gone or no longer owner/admin,
expired, deadline overdue (2 h), and overlap: two live orders sharing at least 2 topic words that
report to different places or come from different givers. Shown in the Heartbeat tab ("Needs a
look") and as Health findings of kind `order-hygiene`; an overlap also becomes one Decision Center
question (once per pair). Overlap is a hint from words, not a proof of contradiction.

### Checklist (part 2)

- [x] kinds, due/expires/done, refs, needs, ledger in the tail; tool `add`/`list`/`done`/`remove`
- [x] exact deadline wake (`sys:order:`), focused deadline beat, `heartbeat_order_done`
- [x] gate: needs tools and ledger writes for owner/admin orders; sessions for `session_read`
- [x] evidence and confidence on notes; unresolved references marked; patterns need two days
- [x] weekly review and hygiene; Health finding; conflict question
- [x] Heartbeat tab by kind
- [x] tests: `test/order-kinds.test.ts`, web `model.test.ts`

### Open questions (part 2)

- The retire and conflict questions are answered in the Decision Center but the answer does not
  remove an order by itself (the owner removes it on the Heartbeat tab).
- `files:<glob>` is a hint only: the beat reads the whole library already; only a ledger is writable.
- A hand edit of `HEARTBEAT.md` that adds a `due` gets its wake at the next beat (up to one interval).
- Role of a chat giver is the directory role today; a platform admin without a directory entry
  counts as the role the gateway resolves for them.
