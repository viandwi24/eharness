/**
 * `eharness/sqlite`: one SQLite implementation of every storage port `eharness` defines (spec 36).
 * This entry imports no `bun:` or `node:` module; the drivers live on `eharness/sqlite/bun` and
 * `eharness/sqlite/node`.
 */

export { sqliteActivityStore } from './activity.ts'
export {
  type SqliteBudgetOptions,
  setBudgetLimit,
  sqliteBudgetLedger,
  utcMonthStart,
} from './budget.ts'
export type { SqlDriver, SqlParam, SqlRunResult } from './driver.ts'
export { sqliteHandoffStore } from './handoffs.ts'
export { type SqliteInboxOptions, sqliteInbox } from './inbox.ts'
export { type SqliteLockOptions, sqliteLock } from './lock.ts'
export { sqliteMessages, sqliteState } from './messages.ts'
export { sqliteOutboxStore } from './outbox.ts'
export { type SqlitePersonStoreOptions, sqlitePersonStore } from './people.ts'
export {
  type SqliteProfileStoreOptions,
  type SqliteSealedProfileStoreOptions,
  sqliteProfileStore,
  sqliteSealedProfileStore,
} from './profiles.ts'
export { sqliteScheduleStore } from './schedules.ts'
export {
  isSqliteSchemaError,
  migrate,
  SCHEMA_VERSION,
  type SchemaMigration,
  type SchemaOptions,
  SqliteSchemaError,
  schemaSql,
} from './schema.ts'
export {
  createSqliteStorage,
  type SqliteStorage,
  type SqliteStorageOptions,
} from './storage.ts'
export { type SqliteStreamLogOptions, sqliteStreamLog } from './stream-log.ts'
export type { AdapterOptions } from './util.ts'
