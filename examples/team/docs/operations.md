# Operations

## One instance

`TEAM_DB` points at a SQLite file (WAL, `busy_timeout` 5 s). Run `bun run start`, set `TEAM_TOKEN`
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
