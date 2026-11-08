# Storage adapters: what runs on `eharness/sqlite` and what stays here

Since P62 the library ships SQLite adapters ([spec 36](../../../docs/specs/36-sqlite-adapters.md),
[ADR-0071](../../../docs/decisions/0071-sqlite-adapters-as-subpaths.md)). The team server keeps its
own Drizzle tables and real data, so each port was compared column by column: the DDL the Drizzle
migrations create (`server/src/infra/db/schema.ts`) against `schemaSql()` of `eharness/sqlite`.
The decision is per port. No data was migrated and no table was rebuilt.

| Port | Team table | Decision | Reason |
|---|---|---|---|
| `MessageAdapter` | `eh_messages` | package adapter, wrapped | Same columns and primary key. The wrapper stamps the instruction mark (`infra/eh/instruction-marks.ts`) into the metadata before `save`: app behaviour the package does not have. |
| `StateAdapter` | `eh_state` | package adapter | Identical columns. |
| `SessionLock` | `eh_locks` | package adapter, wrapped | Identical columns. The team's `takeOver: true` becomes the package's `acquire({ owner })`: the wrapper passes its own owner, so a caller that sets no `recovery.instanceId` keeps the old behaviour. |
| `InboxAdapter` | `eh_inbox`, `eh_inbox_keys` | package adapter, wrapped | Same columns (order differs). The wrapper drops `notify` and `subscribe`: the team's inbox never had them and the holder of a session polls (`inbox.pollMs`). Indexes differ (team: `eh_inbox_session`, `eh_inbox_keys_expiry`; package: `..._session_available`, `..._session_id`); an index is never read by the adapter, so the existing ones are kept. |
| `BudgetLedger` | `eh_budget_scope`, `eh_budget_reservation`, `eh_budget_record` | package adapter | Identical columns, indexes and UTC-month period. |
| `StreamLogAdapter` | `eh_stream_log`, `eh_stream_chunks` | **kept** (`infra/eh/stream-log.ts`) | The chunk cursor column is `idx` in the team table and `seq` in the package. Renaming it with a Drizzle migration rebuilds the table, and an in-flight stream would break. The head table is identical. |
| `ActivityStore` | `events` (+ `settings`) | **kept** (`infra/db/activity-store.ts`) | Not an `eh_activity` table: `events` is shared with the Events page, retention and the `events-pruned-through` mark in `settings`. |
| `ScheduleStore` | `routines`, `routine_runs` | **kept** (`infra/eh/schedule-store.ts`) | Routines are columns (name, prompt, overlap, run history), not one JSON document plus index columns. |
| `ProfileStore` / `SealedProfileStore` | `config_profiles` | **kept** (`infra/eh/profile-store.ts`, sealed by `sealedProfileStore` with the team vault) | Same columns, but another table name (the package takes a prefix, not a table name) and rows written before sealing hold a legacy `v1:` blob that the team vault reads. |
| `PersonStore` | `people`, `people_accounts`, `people_events`, `people_link_codes` | **kept** (`infra/channels/people*.ts`) | Table names do not carry the prefix; `people_events` has a text `id` where the package has an integer `seq`; link codes are keyed by `id` with a `code_hash` column, the package keys by `hash`. |
| `OutboxStore` | `channel_outbox` | **kept** | Column-per-field with channel delivery columns, not one JSON document. |
| `HandoffStore` | `decisions` | **kept** (`infra/eh/decisions-handoff-store.ts`) | A view over the team's `decisions` table. |

## How it was checked

- The five tables were dumped from a fresh database made by the example's own migrations and
  compared with `schemaSql()`; they match except for index names (above).
- A scratch run wrote messages, state (`setIf` hit and miss), a de-duplicated inbox item, a claim,
  an ack and a budget reservation through the previous adapters and through the new ones on the
  same database, and again on a copy of the file: results were equal (only generated reservation
  ids differ), and each side read the rows of the other. The scratch files lived in a temp
  directory; the real `data/` folder was not opened.
- The server's own tests pass unchanged (`eh-conformance`, `restart-recovery`, `storage`,
  `ux-followups`, `e2e-fixes`). `eh-conformance` runs the library suites against the wrapped
  adapters on the real schema.

`storage.ts` keeps its old exports (`sqliteMessages(sqlite)`, `sqliteLock(sqlite, { leaseMs, owner,
takeOver })`, `setBudgetLimit(sqlite, ...)`) so no call site or test changed.
