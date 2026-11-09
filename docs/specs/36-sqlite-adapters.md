# Spec 36 — SQLite adapters (`eharness/sqlite`)

Status: **Implemented in `src/sqlite` (subpaths `eharness/sqlite`, `eharness/sqlite/bun`,
`eharness/sqlite/node`; unreleased, ships in the next minor)**. Decision: [ADR-0071](../decisions/0071-sqlite-adapters-as-subpaths.md)
(supersedes ADR-0068). Plan:
[P62](../plans/P62-adopter-gaps.md) workstream A. Builds on spec 05 (storage ports), 12 §4.1
(budget ledger), 25 (activity), 29 (scheduler), 30 (identity), 31 (channels), 32 (handoff), 23
(providers).

One SQLite implementation of every storage port that `eharness` defines, so an app does not copy
adapters from `examples/`. This spec fixes the shape. Names marked *(contract)* may not change
without a spec change; everything else is the implementer's choice, recorded here in the same
commit that makes it.

## 1. Entries

| Entry | Contents | Runtime imports |
|---|---|---|
| `eharness/sqlite` | `createSqliteStorage`, the adapters, `migrate`, `schemaSql`, `SqlDriver` type | none (no `bun:` or `node:` module) |
| `eharness/sqlite/bun` | `bunSqlite(db, options?)` driver | none |
| `eharness/sqlite/node` | `nodeSqlite(db, options?)` driver | none |

No entry imports a `bun:` or `node:` module, not even for types: the drivers take the handle the app
opened (`new Database(path)` / `new DatabaseSync(path)`) and describe it with a small structural
type. The subpaths belong to the `eharness` package and add no dependency (`ai` is already a peer). The
`eharness/sqlite` entry loads on Node ≥ 22.5 and Bun without either binding; `scripts/check-sqlite-entry.ts`
proves it on the built output (no sqlite entry, directly or through a chunk, imports `bun:` or `node:`).
`scripts/check-imports.ts` lets `src/sqlite` import the subpaths whose ports it implements (activity,
channels, handoff, identity, providers, scheduler).

```ts
import { Database } from 'bun:sqlite' // or: import { DatabaseSync } from 'node:sqlite'
import { createSqliteStorage, migrate } from 'eharness/sqlite'
import { bunSqlite } from 'eharness/sqlite/bun' // or: nodeSqlite from 'eharness/sqlite/node'

const driver = bunSqlite(new Database('app.db'), { owned: true }) // WAL, foreign_keys, busy_timeout
migrate(driver) // creates what is missing, records the schema version
const storage = createSqliteStorage(driver)
// createAgent({ messages: storage.messages, state: storage.state, lock: storage.lock,
//   inbox: storage.inbox, streams: storage.streams })
// also: storage.budget, .activity, .schedules, .outbox, .handoffs, .people, .profiles
```

SQLite fits one machine: several processes on one local file are supported, a file on a network
share is not. `prefix` (default `eh_`) names every table; `schemaSql({ prefix })` returns the DDL
for apps that run their own migrations; pass `vault` to `createSqliteStorage` for a
`SealedProfileStore`; `inbox.subscribe` and `streams.subscribe` poll every `pollMs` (default 250).

## 2. Driver *(contract)*

```ts
interface SqlDriver {
  /** Run statements without parameters (DDL, pragmas). */
  exec(sql: string): void
  /** Rows of a query. */
  query<T = Record<string, unknown>>(sql: string, params?: readonly SqlParam[]): T[]
  /** A statement that changes rows. */
  run(sql: string, params?: readonly SqlParam[]): { changes: number; lastInsertRowid: number | bigint }
  /** One write transaction that takes the write lock up front (`BEGIN IMMEDIATE`). `fn` is synchronous. */
  transaction<T>(fn: () => T): T
}
type SqlParam = string | number | bigint | boolean | null | Uint8Array
```

- **Synchronous, on purpose.** An adapter call is `async` toward eharness, but inside it every
  read-modify-write is one `transaction(fn)` with no `await`. Two processes on one WAL file
  serialize on the write lock (`busy_timeout`); within a process the sequence is atomic.
- A driver never opens a database. With `{ owned: true }` (the app opened the handle for this
  package) it sets `journal_mode = WAL`, `foreign_keys = ON` and `busy_timeout`
  (`busyTimeoutMs`, default 5 000 ms). Without it the handle keeps the app's pragmas except
  `busy_timeout`, which is raised to at least 1 000 ms with a warning (`onWarn`, default
  `console.warn`).
- Booleans bind as 0 / 1 and `undefined` as `null`. A `transaction` function that returns a
  promise is a programmer error: the transaction is rolled back and `TypeError` thrown.
- Nested `transaction` calls join the outer one.
- Not supported: async drivers (libsql, D1). See the ADR.

## 3. Storage bundle *(contract)*

```ts
createSqliteStorage(driver: SqlDriver, options?: {
  prefix?: string          // table prefix, default 'eh_' (letters, digits, underscore only)
  lease?: { ms?: number; owner?: string }   // SessionLock lease (§5), default 30 000 ms
  inbox?: { dedupeWindowMs?: number }       // default 86 400 000 (24 h)
  pollMs?: number          // cross-process wake-up polling, default 250
  now?: () => number       // clock in epoch ms for tests, default Date.now
  vault?: SecretVault      // seals `profiles` at rest (SealedProfileStore), default none
}): SqliteStorage
```

`SqliteStorage` has the fields `createAgent` takes (`messages`, `state`, `lock`, `inbox`,
`streams`) and the other stores as their own fields:

| Field | Port | Spec |
|---|---|---|
| `messages` | `MessageAdapter` | 05 §4 |
| `state` | `StateAdapter` with `setIf` | 05 §7 |
| `lock` | `SessionLock` (lease) | 05 §8 |
| `inbox` | `InboxAdapter` | 05 §12 |
| `streams` | `StreamLogAdapter` | 04 §6.2 |
| `budget` | `BudgetLedger` | 12 §4.1 |
| `activity` | `ActivityStore` | 25 |
| `schedules` | `ScheduleStore` | 29 |
| `outbox` | `OutboxStore` | 31 |
| `handoffs` | `HandoffStore` | 32 |
| `people` | `PersonStore` | 30 |
| `profiles` | `ProfileStore`, or `SealedProfileStore` when `vault` is set | 23 |

Each adapter is also exported as a function (`sqliteMessages`, `sqliteState`, `sqliteLock`,
`sqliteInbox`, `sqliteStreamLog`, `sqliteBudgetLedger`, `sqliteActivityStore`,
`sqliteScheduleStore`, `sqliteOutboxStore`, `sqliteHandoffStore`, `sqlitePersonStore`,
`sqliteProfileStore`, `sqliteSealedProfileStore`; each `(driver, options?)`) for an app that wants
one store only. `setBudgetLimit(driver, scope, limitUsd | null)` sets a scope's limit from the
current period on. The bundle never creates tables: call `migrate` first.

## 4. Schema

- `migrate(driver, { prefix })` creates what is missing and records the version in
  `<prefix>schema_version`. It is idempotent and takes the write lock; a database written by a newer
  version of the package makes it throw `SqliteSchemaError` with `code: 'EH_SQLITE_SCHEMA_NEWER'`
  (a class of this package, because `HarnessErrorCode` is a closed list of the core), never
  downgrade. `schema_version` holds one row per applied version.
- `schemaSql({ prefix })` returns the same DDL as an ordered array of `{ version, sql }` for apps
  that run their own migrations. Adapters never create tables unless `migrate` is called.
- Tables (all prefixed): `messages`, `state`, `locks`, `inbox`, `inbox_keys`, `stream_log`,
  `stream_chunks`, `budget_scope`, `budget_reservation`, `budget_record`, `activity`,
  `activity_meta`, `schedules`, `outbox`, `handoffs`, `people`, `person_accounts`, `person_codes`,
  `person_events`, `profiles`, `schema_version`. Schedules, outbox records and handoff requests are
  stored as one JSON document plus the columns their queries need.
- Index rules: messages by `(session_id, id)`, inbox by `(session_id, available_at)` and
  `(session_id, id)`, stream chunks by `(session_id, turn_id, seq)`, activity by `seq`. Any new
  table carries the prefix.
- Each migration is additive. A column or table is never dropped inside one major version.

## 5. Behavior that is fixed

- **Lock.** A row per session with `owner` and `until`. `acquire` takes it when none is live,
  renews every third of the lease, and rejects `EH_SESSION_BUSY` otherwise (spec 05 §8). The row's
  owner is `<instance>:<uuid>`; `<instance>` is `lease.owner` (default a random id). When `acquire`
  receives an `owner` in its options (P62 workstream E), it is the instance, and a lease held under
  that instance by a holder this lock object does not know is taken over at once.
- **Inbox.** Head-of-line claims per session, retry with backoff, dead letters, `enqueueOnce`
  de-duplication for `dedupeWindowMs` after the ack (the key has no expiry while the item is
  stored). `subscribe(sessionId, fn)` polls every `pollMs` and calls `fn` when a new item becomes
  claimable; `notify(sessionId)` calls the local subscribers at once.
- **Stream log.** Chunks keyed by `(session, turn, seq)`; retention (default 10 minutes, option
  `retentionMs`) is enforced on read and by `expire(key, ttl)`; `subscribe` polls every `pollMs`.
- **Activity.** `seq` is assigned in the write transaction, so it is unique across processes on one
  file.
- **Budget ledger.** Per scope and period; the period is a UTC calendar month unless the app passes
  `period: (now) => periodStart`. Unpriced usage is not counted (spec 12). A new period's row
  inherits the limit of the scope's latest row.
- **People.** Person events go to a table of their own (`person_events`, no link to the person
  row), so they outlive `delete`. A linked account of one platform user id is unique.
- **Profiles.** `subscribe` fires at once after a local put or delete and, for another process on
  the same file, by polling `PRAGMA data_version` every `pollMs`.
- **Where the two origins differ the stricter behavior applies** (the longer inbox de-duplication
  window of the second adopter's adapter, the cross-process `seq` of the team adapter).

## 6. Limits

- One machine. Several processes on one local file are supported; a file on a network share is
  not.
- Polling, not notification: a wake-up can take up to `pollMs`.
- `node:sqlite` is experimental in Node 22; the Node driver follows its API and says so in its
  README.
- No encryption at rest. `SealedProfileStore` seals values with the vault the app passes.

## 7. Conformance

Every adapter passes its suite from `eharness/testing`: `messageAdapterConformance`,
`stateAdapterConformance`, `lockConformance`, `inboxAdapterConformance`, `streamLogConformance`,
`budgetLedgerConformance`, `activityStoreConformance`, `scheduleStoreConformance`,
`outboxStoreConformance`, `handoffStoreConformance`, `personStoreConformance`,
`profileStoreConformance`, plus `multiInstanceConformance` with two drivers on one file. The suites
run against `bun:sqlite` under `bun test` and against `node:sqlite` with
`node --test src/sqlite/conformance.node.ts` from the repo root (Node ≥ 22.5; `bun run test:node-sqlite`). A new case lands in `eharness/testing` first (lock `owner`
takeover, principal round-trip), then here; until then `src/sqlite/sqlite.test.ts` covers
the owner takeover, the dedupe window, polled wake-ups, the sealed profiles and schema rules.

## 8. Not in scope

- A Postgres package (same layout, later; it needs a third-party npm dependency, so it is a separate package, ADR-0071).
- Query helpers for app tables, an ORM, or migrations of app data.
- Moving existing app data: an app that already has these tables keeps them and uses
  `schemaSql` to compare.
