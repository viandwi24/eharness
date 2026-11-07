# Spec 36 — SQLite adapters (`@eharness/sqlite`)

Status: **Draft (planned, 0.10)**. Package: `packages/sqlite` (published as `@eharness/sqlite`, never a
dependency of `eharness`). Decision: [ADR-0068](../decisions/0068-sqlite-adapter-package.md). Plan:
[P62](../plans/P62-adopter-gaps.md) workstream A. Builds on spec 05 (storage ports), 12 §4.1
(budget ledger), 25 (activity), 29 (scheduler), 30 (identity), 31 (channels), 32 (handoff), 23
(providers).

One SQLite implementation of every storage port that `eharness` defines, so an app does not copy
adapters from `examples/`. This spec fixes the shape. Names marked *(contract)* may not change
without a spec change; everything else is the implementer's choice, recorded here in the same
commit that makes it.

## 1. Packages and entries

| Entry | Contents | Runtime imports |
|---|---|---|
| `@eharness/sqlite` | `createSqliteStorage`, the adapters, `migrate`, `schemaSql`, `SqlDriver` type | none (no `bun:` or `node:` module) |
| `@eharness/sqlite/bun` | `bunSqlite(db)` driver | `bun:sqlite` types only |
| `@eharness/sqlite/node` | `nodeSqlite(db)` driver | `node:sqlite` types only |

`eharness` is a peer dependency (same range as the release it was built against). The root entry
must load on Node ≥ 22 and Bun without either binding installed; a script in `scripts/` checks it.

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
- The drivers set `journal_mode = WAL`, `busy_timeout` (default 5 000 ms) and `foreign_keys = ON`
  when they are given a database they opened; a handle the app opened keeps the app's pragmas
  except `busy_timeout`, which is raised to at least 1 000 ms with a warning.
- Nested `transaction` calls join the outer one.
- Not supported: async drivers (libsql, D1). See the ADR.

## 3. Storage bundle *(contract)*

```ts
createSqliteStorage(driver: SqlDriver, options?: {
  prefix?: string          // table prefix, default 'eh_' (letters, digits, underscore only)
  lease?: { ms?: number; owner?: string }   // SessionLock lease (§5), default 30 000 ms
  inbox?: { dedupeWindowMs?: number }       // default 86 400 000 (24 h)
  pollMs?: number          // cross-process wake-up polling, default 250
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
| `profiles` | `ProfileStore`, `SealedProfileStore` | 23 |

Each adapter is also exported as a function (`sqliteMessages(driver, options)`, …) for an app that
wants one store only.

## 4. Schema

- `migrate(driver, { prefix })` creates what is missing and records the version in
  `<prefix>schema_version`. It is idempotent and takes the write lock; a database written by a newer
  version of the package makes it throw (`EH_SQLITE_SCHEMA_NEWER`), never downgrade.
- `schemaSql({ prefix })` returns the same DDL as an ordered array of `{ version, sql }` for apps
  that run their own migrations. Adapters never create tables unless `migrate` is called.
- Index rules: sessions by `(session_id, id)`, inbox by `(session_id, available_at)`, stream log
  and activity by `seq`. Any new table carries the prefix.
- Each migration is additive. A column or table is never dropped inside one major version.

## 5. Behavior that is fixed

- **Lock.** A row per session with `owner` and `until`. `acquire` takes it when none is live,
  renews every third of the lease, and rejects `EH_SESSION_BUSY` otherwise (spec 05 §8). When
  `acquire` receives an `owner` (P62 workstream E), a lease held under the same instance owner that
  this process does not hold is taken over at once.
- **Inbox.** Head-of-line claims per session, retry with backoff, dead letters, `enqueueOnce`
  de-duplication for `dedupeWindowMs`. Subscribers are woken by polling every `pollMs`.
- **Stream log.** Chunks keyed by `(key, seq)`, retention enforced on read and by `expire(key, ttl)`.
- **Activity.** `seq` is assigned in the write transaction, so it is unique across processes on one
  file.
- **Budget ledger.** Per scope and period; the period is a UTC calendar month unless the app passes
  `period`. Unpriced usage is not counted (spec 12).
- **People.** Person events go to the activity store or the table the app names; they outlive
  `delete`.
- **Where the two origins differ the stricter behavior applies** (the longer inbox de-duplication
  window of the Keith adapter, the cross-process `seq` of the team adapter).

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
run against `bun:sqlite` under Bun and `node:sqlite` under Node 22 in CI. A new case lands in
`eharness/testing` first (lock `owner` takeover, principal round-trip), then here.

## 8. Not in scope

- A Postgres package (same layout, later).
- Query helpers for app tables, an ORM, or migrations of app data.
- Moving existing app data: an app that already has these tables keeps them and uses
  `schemaSql` to compare.
