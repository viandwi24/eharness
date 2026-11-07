---
"@eharness/sqlite": minor
---

New package `@eharness/sqlite`: one SQLite implementation of every storage port, so an app no longer copies adapters from `examples/`. `createSqliteStorage(driver)` returns the bundle `createAgent` takes (`messages`, `state` with `setIf`, `lock` (lease), `inbox`, `streams`) plus `budget`, `activity`, `schedules`, `outbox`, `handoffs`, `people` and `profiles` (sealed with a vault when you pass one); each adapter is also exported on its own. The drivers are synchronous (`SqlDriver`) and live on `@eharness/sqlite/bun` (`bun:sqlite`) and `@eharness/sqlite/node` (`node:sqlite`, Node 22.5+); the root entry imports neither. The package owns a prefixed, versioned schema (`migrate`, `schemaSql`). Several processes on one WAL file are supported; wake-ups are polled (`pollMs`). `eharness` is a peer dependency.
