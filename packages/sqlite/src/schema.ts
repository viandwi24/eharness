/**
 * Versioned schema (spec 36 §4). Each migration is additive: a column or table is never dropped
 * inside one major version.
 */
import type { SqlDriver } from './driver.ts'
import { DEFAULT_PREFIX, tables } from './util.ts'

/** One migration: the version it brings the schema to and its DDL. */
export interface SchemaMigration {
  version: number
  sql: string
}

/** Options of {@link migrate} and {@link schemaSql}. */
export interface SchemaOptions {
  /** Table prefix (letters, digits and underscores). Default `eh_`. */
  prefix?: string
}

/** Rejected by {@link migrate} when the database was written by a newer version of the package. */
export class SqliteSchemaError extends Error {
  readonly code = 'EH_SQLITE_SCHEMA_NEWER'
  readonly found: number
  readonly supported: number
  constructor(found: number, supported: number) {
    super(
      `@eharness/sqlite: the database is at schema version ${found}, this package supports up to ${supported}. Upgrade @eharness/sqlite.`,
    )
    this.name = 'SqliteSchemaError'
    this.found = found
    this.supported = supported
  }
}

/** Type guard for {@link SqliteSchemaError}. */
export function isSqliteSchemaError(error: unknown): error is SqliteSchemaError {
  return error instanceof Error && (error as { code?: unknown }).code === 'EH_SQLITE_SCHEMA_NEWER'
}

const v1 = (prefix: string): string => {
  const t = tables(prefix)
  return `
CREATE TABLE IF NOT EXISTS ${t.messages} (
  session_id TEXT NOT NULL,
  id TEXT NOT NULL,
  role TEXT NOT NULL,
  parts TEXT NOT NULL,
  metadata TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, id)
);
CREATE TABLE IF NOT EXISTS ${t.state} (
  session_id TEXT NOT NULL PRIMARY KEY,
  state TEXT NOT NULL,
  rev INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS ${t.locks} (
  session_id TEXT NOT NULL PRIMARY KEY,
  owner TEXT NOT NULL,
  until INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS ${t.inbox} (
  id TEXT NOT NULL PRIMARY KEY,
  session_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  item TEXT NOT NULL,
  available_at INTEGER,
  claimed_by TEXT,
  claimed_until INTEGER,
  delayed_until INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  dead_at INTEGER,
  dead_reason TEXT
);
CREATE INDEX IF NOT EXISTS ${t.inbox}_session_available ON ${t.inbox} (session_id, available_at);
CREATE INDEX IF NOT EXISTS ${t.inbox}_session_id ON ${t.inbox} (session_id, id);
CREATE TABLE IF NOT EXISTS ${t.inboxKeys} (
  session_id TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  item_id TEXT NOT NULL,
  expires_at INTEGER,
  PRIMARY KEY (session_id, dedupe_key)
);
CREATE INDEX IF NOT EXISTS ${t.inboxKeys}_item ON ${t.inboxKeys} (item_id);
CREATE TABLE IF NOT EXISTS ${t.streamLog} (
  session_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  status TEXT NOT NULL,
  length INTEGER NOT NULL,
  ttl_ms INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, turn_id)
);
CREATE INDEX IF NOT EXISTS ${t.streamLog}_expires ON ${t.streamLog} (expires_at);
CREATE TABLE IF NOT EXISTS ${t.streamChunks} (
  session_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  chunk TEXT NOT NULL,
  PRIMARY KEY (session_id, turn_id, seq)
);
CREATE TABLE IF NOT EXISTS ${t.budgetScope} (
  scope TEXT NOT NULL,
  period_start INTEGER NOT NULL,
  limit_usd TEXT,
  spent_usd TEXT NOT NULL DEFAULT '0',
  PRIMARY KEY (scope, period_start)
);
CREATE TABLE IF NOT EXISTS ${t.budgetReservation} (
  id TEXT NOT NULL PRIMARY KEY,
  key TEXT NOT NULL,
  scopes TEXT NOT NULL,
  period_start INTEGER NOT NULL,
  amount_usd TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'open'
);
CREATE INDEX IF NOT EXISTS ${t.budgetReservation}_key ON ${t.budgetReservation} (key);
CREATE TABLE IF NOT EXISTS ${t.budgetRecord} (
  key TEXT NOT NULL PRIMARY KEY,
  recorded_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS ${t.activity} (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  agent_id TEXT,
  session_id TEXT,
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ${t.activity}_session ON ${t.activity} (session_id, seq);
CREATE INDEX IF NOT EXISTS ${t.activity}_created ON ${t.activity} (created_at);
CREATE TABLE IF NOT EXISTS ${t.activityMeta} (
  key TEXT NOT NULL PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ${t.schedules} (
  id TEXT NOT NULL PRIMARY KEY,
  session_id TEXT NOT NULL,
  state TEXT NOT NULL,
  next_fire_at INTEGER,
  claimed_until INTEGER,
  version INTEGER NOT NULL,
  doc TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ${t.schedules}_due ON ${t.schedules} (state, next_fire_at);
CREATE INDEX IF NOT EXISTS ${t.schedules}_session ON ${t.schedules} (session_id, id);
CREATE TABLE IF NOT EXISTS ${t.outbox} (
  id TEXT NOT NULL PRIMARY KEY,
  state TEXT NOT NULL,
  available_at INTEGER NOT NULL,
  lease_until INTEGER,
  updated_at INTEGER NOT NULL,
  doc TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ${t.outbox}_state ON ${t.outbox} (state, available_at, id);
CREATE TABLE IF NOT EXISTS ${t.handoffs} (
  id TEXT NOT NULL PRIMARY KEY,
  session_id TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  audience TEXT,
  doc TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ${t.handoffs}_status ON ${t.handoffs} (status, created_at, id);
CREATE INDEX IF NOT EXISTS ${t.handoffs}_session ON ${t.handoffs} (session_id, created_at, id);
CREATE TABLE IF NOT EXISTS ${t.people} (
  id TEXT NOT NULL PRIMARY KEY,
  display_name TEXT NOT NULL,
  nickname TEXT,
  status TEXT NOT NULL,
  role TEXT,
  divisions TEXT NOT NULL,
  fields TEXT NOT NULL,
  notes TEXT NOT NULL,
  member_id TEXT,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ${t.people}_updated ON ${t.people} (updated_at);
CREATE TABLE IF NOT EXISTS ${t.personAccounts} (
  id TEXT NOT NULL PRIMARY KEY,
  person_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  native_id TEXT NOT NULL,
  label TEXT,
  status TEXT NOT NULL,
  linked_via TEXT NOT NULL,
  linked_by TEXT,
  linked_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS ${t.personAccounts}_linked
  ON ${t.personAccounts} (platform, native_id) WHERE status = 'linked';
CREATE INDEX IF NOT EXISTS ${t.personAccounts}_person ON ${t.personAccounts} (person_id, linked_at);
CREATE TABLE IF NOT EXISTS ${t.personCodes} (
  hash TEXT NOT NULL PRIMARY KEY,
  person_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  used_at INTEGER
);
CREATE INDEX IF NOT EXISTS ${t.personCodes}_person ON ${t.personCodes} (person_id);
CREATE TABLE IF NOT EXISTS ${t.personEvents} (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  actor TEXT,
  detail TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ${t.personEvents}_person ON ${t.personEvents} (person_id, at);
CREATE TABLE IF NOT EXISTS ${t.profiles} (
  kind TEXT NOT NULL,
  id TEXT NOT NULL,
  definition_id TEXT NOT NULL,
  label TEXT NOT NULL,
  settings TEXT NOT NULL,
  models TEXT,
  extra TEXT,
  enabled INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (kind, id)
);
`
}

/** The package's schema version: the highest `version` of {@link schemaSql}. */
export const SCHEMA_VERSION = 1

/** The migrations as ordered `{ version, sql }`, for apps that run their own migrations. */
export function schemaSql(options: SchemaOptions = {}): SchemaMigration[] {
  const prefix = options.prefix ?? DEFAULT_PREFIX
  return [{ version: 1, sql: v1(prefix).trim() }]
}

/**
 * Create what is missing and record the version in `<prefix>schema_version`. Idempotent; takes the
 * write lock. Rejects with {@link SqliteSchemaError} (`EH_SQLITE_SCHEMA_NEWER`) when the database
 * is newer than this package; it never downgrades.
 */
export function migrate(driver: SqlDriver, options: SchemaOptions = {}): void {
  const prefix = options.prefix ?? DEFAULT_PREFIX
  const versionTable = tables(prefix).schemaVersion
  driver.transaction(() => {
    driver.exec(
      `CREATE TABLE IF NOT EXISTS ${versionTable} (version INTEGER NOT NULL PRIMARY KEY, applied_at INTEGER NOT NULL)`,
    )
    const current = Number(
      driver.query<{ v: number | null }>(`SELECT MAX(version) AS v FROM ${versionTable}`)[0]?.v ??
        0,
    )
    if (current > SCHEMA_VERSION) throw new SqliteSchemaError(current, SCHEMA_VERSION)
    for (const step of schemaSql({ prefix })) {
      if (step.version <= current) continue
      driver.exec(step.sql)
      driver.run(`INSERT INTO ${versionTable} (version, applied_at) VALUES (?, ?)`, [
        step.version,
        Date.now(),
      ])
    }
  })
}
