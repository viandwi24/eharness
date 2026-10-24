# Operations

## One instance

`TEAM_DB` points at a SQLite file (WAL, `busy_timeout` 5 s). Run `bun run start`, set `TEAM_TOKEN`
(and `TEAM_HOST=0.0.0.0` plus `TEAM_PUBLIC_URL` when it must be reachable; without a token it only listens on loopback)
and put TLS in front (a reverse proxy; the server speaks plain HTTP). Always stop with SIGTERM or
SIGINT so agents close cleanly; a SIGKILL is survivable (see below) but delays recovery of a turn
that was streaming.

## Several instances

Start more processes with the same `TEAM_DB` and different `PORT`s behind any load balancer.
No sticky sessions are needed: a chat message to a chat that is busy elsewhere is steered through
the inbox, an approval or abort can be sent to any instance, a stream resumes from the stream log,
and every instance runs the routine ticker (each slot fires once).

One SQLite file is a good fit for instances on **one machine** (SQLite locks do not work reliably
over network file systems such as NFS or SMB: never put the file there). For instances on different
machines use a networked database.

## Connectors

`TEAM_PUBLIC_URL` (where browsers reach this server; the OAuth redirect URI is
`<url>/oauth/callback`, default `http://localhost:$PORT`) and `TEAM_WEB_URL` (where the callback sends
the browser back, `<url>/connectors`, default `http://localhost:5173`) are needed for OAuth
connectors. A curated OAuth connector needs an OAuth app: `TEAM_GITHUB_CLIENT_ID` /
`TEAM_GITHUB_CLIENT_SECRET`, or save the credentials from the Connectors page (stored encrypted).
`TEAM_SECRET_KEY` now encrypts connection secrets and tokens too: rotating it works the same way
(`TEAM_SECRET_KEY_PREVIOUS`). The OAuth callback is the only unauthenticated route besides health;
its single-use `state` is the proof. Give the server an egress policy that blocks private networks:
custom connectors fetch user-supplied URLs.

## Moving to a networked database

The app talks to SQLite in three places; the library never sees it.

| What | Where | Swap |
|---|---|---|
| Domain tables (agents, tasks, routines, settings, events, library) | Drizzle in `infra/db/*` | change the Drizzle dialect and regenerate migrations; the repositories keep their ports |
| eharness adapters (`eh_*`): messages, state, **lock**, inbox, budget ledger, stream log | plain SQL in `infra/eh/storage.ts`, `stream-log.ts`, `library-fs.ts` | rewrite against Postgres (the library ships Postgres examples in `examples/postgres-*.ts`); keep the semantics below and run the conformance suites from `eharness/testing` |
| Transactions | `BEGIN IMMEDIATE` for every claim / compare-and-set | `SELECT ... FOR UPDATE SKIP LOCKED`, `UPDATE ... RETURNING`, or advisory locks |

Semantics to keep: the lock is a lease with heartbeat; `setIf` is atomic; an inbox claim is
exclusive and survives a crash (lease expiry); `enqueue` with an id is idempotent; a routine claim
is a compare-and-set on `next_fire_at` with the run row inserted in the same transaction.
What you gain: `LISTEN/NOTIFY` can replace polling for the inbox, the events feed and the stream log
(`notify` / `subscribe` hooks of their ports); poll intervals can then be raised.

## Tuning

| Knob | Default | Notes |
|---|---|---|
| Session lock lease | 30 s | a crashed holder blocks its session until it expires; lower it for faster failover, keep it above a few missed heartbeats (one third of the lease) |
| `recovery.staleMs` | 120 s | a turn whose heartbeat is older is treated as dead and recovered; below your longest single model call you would break live turns |
| Inbox poll (`inbox.pollMs`) | per adapter | how fast a steered or queued message is seen by the holder; lower = more reads |
| Abort poll (`recovery.abortPollMs`) | per adapter | stop pressed on another instance reaches the turn within one poll |
| Stream log (`streams`): flush, batch, retention, poll | 10 min retention | bigger retention lets slow clients resume later, costs rows |
| Events poll | 500 ms | the sidebar / board latency across instances |
| `TEAM_ROUTINE_TICK_MS` | 15 s | routine timing granularity; `0` turns the ticker off on an instance (a web-only node) |

Failover time of a killed instance is roughly `max(lock lease, staleMs)` for a turn that was
streaming; parked delegations and pending approvals do not wait for anything.

## Pause all

One button (the pause icon of the rail, or Settings > General > Workspace activity) holds everything
automatic, for a deploy or to watch without agents acting. It is a single gate stored in the
database (the `workspace-pause` row of `settings`), read on every tick and decision by every
instance, so it survives restarts and deploys. Nothing changes status: Resume restores exactly what
was active, and anything paused one by one stays paused.

- Held: scheduled slots of routines, programs, the heartbeat, the digest and reminders (recorded as
  skipped with reason `paused`, never replayed), queued tasks (they stay queued and start on
  Resume), automatic retries, a lost long-run continuation found by the reconcile pass, early
  heartbeat wakes, and, with `holdChannels`, chat wakes (messages are received and kept as context;
  whether they are answered after Resume is a choice, below).
- Not held: the owner's web chat, "Run now", approvals and decisions answered by the owner,
  backups, alarms, health and disk checks, pruning.
- Running work finishes unless `stopRunning` is set, which aborts the running task sessions like the
  Stop button.
- A one-shot schedule (a reminder or routine that fires once) whose slot falls inside the pause is
  not claimed or recorded while paused: it fires once, late, on the first tick after Resume (the
  window of the last pause is kept so it is not skipped as missed). Recurring schedules skip their
  slots as `paused` and do not replay.
- The export never carries the paused state, so an imported workspace does not arrive paused.

Held chat messages. With `holdChannels` a message that would have woken the agent (mention, reply to
it, command, alias, own topic, a DM from a person it answers) is kept as context and remembered in
its row (`meta.heldWake` of `ch_messages`, no extra table, so it survives a restart between pause
and resume). `answerHeldOnResume` (the checkbox under "Also stop answering chat channels", default
off; shown in Settings > General > Workspace activity while paused) decides what Resume does with
them:

- On: each conversation wakes once, with the held messages younger than 12 hours folded together
  oldest first, and a note that they arrived while the workspace was paused. The same inbound path
  applies as for a live message when the agent answers (rate limits, governor, breaker, people).
  The reason shows on the Activity page as `woke after pause (...)`.
- Off: they stay context and are never answered.
- Either way every held message is settled at Resume (`meta.heldDone`), so a later pause and resume
  never answers an old one twice. A connection this process does not run keeps its held messages
  until it does or they are older than 12 hours.

`GET /workspace/pause` (state and what is held), `POST /workspace/pause` (`note`, `holdChannels`
default true, `answerHeldOnResume` default false and kept when pausing again, `stopRunning` default
false; idempotent), `POST /workspace/resume`.

## Triggers

Triggers listen to the event stream and act ([events-and-triggers.md](events-and-triggers.md)). Operations notes:

- A trigger fires on the instance that observed the event (the one that runs the chat transport, or that
  appended the app event); two instances never fire one event twice, but an event seen by an instance that is down is
  not replayed (events older than 15 minutes, 24 hours for join requests, are ignored on purpose).
- Pause all holds triggers: each skipped firing is logged as `skipped: paused` and is not replayed after Resume.
- Settings > Limits: "Trigger firings per hour" (default 60, 0 = no cap, across all triggers). Settings > Data
  retention: "Trigger firing log" (days, default 30, 0 = keep). The event rows themselves follow the events
  retention (`ch_events` by age, the app feed by age and count).
- Webhooks call public https hosts only. `TEAM_ALLOW_PRIVATE_WEBHOOKS=1` allows plain http and private or local
  hosts for development; it is a security override, not a product setting. The secret of each webhook is sealed with
  `TEAM_SECRET_KEY` (a changed key makes the webhook fail with "the secret could not be opened": set it again).

## Limits and cost

Set `TEAM_BUDGET_USD` (or Settings): one ledger row shared by all instances. Delegations in flight
are capped by the spawn cap. Check `GET /agents/{id}/stats` for cost per chat. Multi-agent runs
use many times the tokens of a chat; start small.

## Backups

SQLite: use `sqlite3 team.db ".backup backup.db"` or `VACUUM INTO 'backup.db'`, which are safe while
instances run. Do not copy `team.db` alone (the `-wal` and `-shm` files hold committed data); if you
copy files, stop all instances first or copy all three. Everything is in that file: agent
definitions, chats, library, memory, routines, ledger. Restore by stopping the instances, replacing
the file and starting them; stale locks expire on their own. Networked database: use its own
backup tooling. Library uploads are rows in the same database, there is no object store.

## Health and logs

`GET /health` needs no token. Library warnings (`onWarning`) and errors go to stdout as JSON-ish
log lines; ship them with your usual collector. After a crash, `reconcile()` at boot repairs parked
waits and task rows; check `GET /approvals` for work that is waiting for a person.

## Channel delivery and the sending breaker

Every send to a chat platform goes through one outbound queue per connection. It pauses sending for
the whole connection (the breaker, default cooldown 5 minutes, then one attempt is let through and
a failure pauses it again; a person can reset it on the Channels page) only for account or
transport problems: a flood storm, `PEER_FLOOD`, a lost session, or failures of several different
messages in a row (network, timeouts, unknown errors). Retries of one message count once.

Request and content errors fail that one message only and never pause the connection: every
`PHOTO_*`, `MEDIA_*`, `FILE_*`, `IMAGE_*`, `WEBPAGE_*` error and any `*_INVALID`, `*_EMPTY`,
`*_TOO_LONG`, `*_TOO_BIG` (for example `PHOTO_EXT_INVALID`, `ENTITY_BOUNDS_INVALID`). The model
sees a readable sentence. On a Telegram user account only jpeg, png and webp go as photos, every
other file type goes as a document, and a refused photo is retried once as a document.

System alarms go to every owner by direct message. A user account never starts a conversation, so
an owner it has no chat with is skipped (nothing is queued that will certainly fail) and the bell
shows once per day: "Alarms cannot reach <name> on <connection>: ask them to send one message to
the account first."

### Messages that arrived while the server was down

A Telegram user account reads updates with in-memory state, so after a restart or a deploy the
update stream knows nothing about what it missed. The start-up gap fill of every chosen chat
(messages newer than the highest id stored, at most 7 days and 20 pages) finds them. Each message
found goes oldest first to the gateway (`catchUp`):

- Setting, per connection, on the connection's Settings page (account only): "Reply to messages
  missed while the server was down" (`replyMissed`, default on) and "only if they are at most N
  minutes old" (`missedWindowMinutes`, default 30, 1 to 720). Stored in the connection config with
  the rest of the binding (`PUT /channels/connections/{id}/binding`).
- A message inside the window, not sent by the account itself, goes through the same inbound path as
  a live one: the chat's wake policy (a chat set to never wake stays silent), allow and deny rules,
  bot senders, the others-mentioned rule, people and identity, pause, and later the same outbound
  rate limits, governor and breaker. A reply to one of the account's own messages is recognized from
  the log. Older messages, other messages, and everything when the setting is off are only stored,
  as before.
- The messages of one chat that would wake the agent are queued together, oldest first, into one
  turn with a note that they arrived while the assistant was offline and when. The Activity page
  shows `woke after restart (...)`.
- Never twice: the cursor (highest id) moves only after the gateway handled the batch, a message is
  marked handled before it is queued, and a message already handled is dropped as a duplicate. A
  crash between marking and queueing loses that one answer rather than repeating it.
- Pause all still applies: a missed message found while paused is held and follows the pause choice.
- Not covered: direct messages (the gap fill reads only the chosen group chats; a DM missed while
  down is not found), and a reconnect of the live connection after a network drop, which mtcute's
  own catch-up covers while the process runs (the gap fill runs once per start).
