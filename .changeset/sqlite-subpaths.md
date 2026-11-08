---
"eharness": minor
---

Add the SQLite adapters for every storage port as three subpaths of `eharness`: `eharness/sqlite` (adapters, `createSqliteStorage`, `migrate`, `schemaSql`, the `SqlDriver` types; runtime-neutral), `eharness/sqlite/bun` (driver for a `bun:sqlite` handle) and `eharness/sqlite/node` (driver for a `node:sqlite` handle, Node >= 22.5). The drivers take a handle and import no runtime module, so there is no extra npm dependency (ADR-0071).
