# ADR-0068: SQLite adapters ship as a separate package (`@eharness/sqlite`)

Status: **Superseded by [ADR-0071](0071-sqlite-adapters-as-subpaths.md)** · Date: 2026-11-08 · Plan: [P62](../plans/P62-adopter-gaps.md) · Builds on: [ADR-0008](0008-plugins-adapters-dogfooding.md), [ADR-0062](0062-platform-rings-and-rule-of-two.md)

## Context

ADR-0008 keeps the library to memory adapters, and ADR-0062 allows Ring 2 adapters as separate
packages that the core never depends on. In practice no Ring 2 package exists. Every app that wants
durable sessions copies the adapters from `examples/`:

- `examples/team` carries its own stores for messages, state, lock, stream log, activity, schedules
  and profiles.
- A second product, built on 0.9.0 from npm, copied nine of them into its own code,
  about 2,000 lines, and extended several (inbox dedupe window, budget status, lock takeover).

The two copies already differ in behavior. Each fix has to be made twice, and a third app would make
a third copy. The conformance suites in `eharness/testing` make a shared implementation safe to
publish.

## Decision

1. **A workspace package `packages/sqlite`, published as `@eharness/sqlite`.** `eharness` is its peer
   dependency; the core never imports it (ADR-0008 holds). It follows ADR-0062 rule 1, Ring 2.
2. **Driver interface: small and synchronous.** The adapters talk to a `SqlDriver` (`exec`,
   `query`, `run`, `transaction`) instead of one SQLite binding. It is synchronous on purpose:
   `bun:sqlite`, `node:sqlite` and better-sqlite3 are, and both existing copies of these adapters
   rely on it. Every read-modify-write runs in one `transaction(fn)` that takes the write lock up
   front (`BEGIN IMMEDIATE`) with no `await` inside, so two processes on one WAL file serialize and a
   statement sequence is atomic within a process. Drivers for `bun:sqlite` and `node:sqlite` live on
   their own subpaths, so the root entry imports neither runtime. Another synchronous binding is a
   third-party package that implements the same interface. Async drivers (libsql, D1) cannot give
   that atomicity and are out of scope; they need their own port and package.
3. **One adapter per existing port**, each passing its conformance suite: `MessageAdapter`,
   `StateAdapter` (with `setIf`), `SessionLock` (lease), `InboxAdapter`, `StreamLogAdapter`,
   `BudgetLedger`, `ActivityStore`, `ScheduleStore`, `OutboxStore`, `HandoffStore`, `PersonStore`,
   `ProfileStore` and `SealedProfileStore`. `createSqliteStorage(driver)` returns the bundle that
   `createAgent` takes.
4. **Schema is owned by the package.** Versioned migrations run from code (`migrate(driver)`), tables
   carry a configurable prefix (default `eh_`) and a `schema_version` row. An app that manages its
   own migrations (the team example and the second product use Drizzle) takes the same DDL from
   `schemaSql({ prefix })` and runs it itself; the adapters never create tables behind its back
   unless `migrate` is called.
5. **Cross-process wake-up is polling** with a configurable `pollMs`. SQLite has no notification
   channel, and the specs allow polling for every port that has `subscribe`.
6. **Where the two copies differ, the stricter behavior wins** (the longer inbox dedupe window, the
   per-instance activity `seq`), and the choice is stated in the spec (`docs/specs/36-sqlite-adapters.md`).
7. **No Postgres package in this phase.** It uses the same layout and conformance suites once this
   one is stable.

## Consequences

+ An app gets durable storage with one import and no copied code. Bug fixes land once.
+ The team example becomes the first consumer, which proves the package.
+ Third-party drivers and databases have a defined shape to follow.
− A new published package: its own changesets, release flow, npm scope, and a migration contract to
  keep. A schema change needs a migration, not an edit.
− SQLite fits one machine. Multiple replicas on one file over a network share are unsupported and
  the spec says so.
− `node:sqlite` is still marked experimental in Node 22; the Node driver follows its API changes.

## Alternatives considered

- **Keep adapters in `examples/` only** (status quo). Rejected: two products already diverged.
- **Ship adapters inside `eharness` as subpaths.** Rejected: breaks ADR-0008 and ADR-0062 rule 1, and
  ties the core's release to a database binding.
- **Postgres first.** Rejected for this phase: SQLite is what both products run on, and it needs no
  server to test.
- **An async `SqlDriver`** so libsql and D1 fit. Rejected: an `await` between the read and the write
  of one adapter call breaks the atomicity the current adapters get for free.
