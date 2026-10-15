/**
 * SQLite connection (bun:sqlite, WAL) and boot-time migrations. Two processes can share one
 * database file: `busy_timeout` makes writers wait, and the adapters take write locks with
 * `BEGIN IMMEDIATE` (see `infra/eh/storage.ts`).
 */
import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'
import * as schema from './schema.ts'

export type Db = ReturnType<typeof createDrizzle>

function createDrizzle(sqlite: Database) {
  return drizzle({ client: sqlite, schema })
}

export interface Connection {
  /** The raw handle: adapters use plain SQL on it. */
  sqlite: Database
  /** Drizzle on the same handle: repositories use it. */
  db: Db
  close(): void
}

const MIGRATIONS = new URL('../../../drizzle', import.meta.url).pathname

/** Open (creating the directory) a database file, or `:memory:`; apply the migrations. */
export function openDatabase(file: string): Connection {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true })
  const sqlite = new Database(file, { create: true, strict: true })
  // a new database starts in INCREMENTAL mode (before WAL and the first table fix the mode), so
  // freed media pages can go back to the file system; an existing one keeps its mode
  const fresh =
    sqlite.query<{ page_count: number }, []>('PRAGMA page_count').get()?.page_count === 0
  if (fresh) sqlite.run('PRAGMA auto_vacuum = INCREMENTAL')
  sqlite.run('PRAGMA journal_mode = WAL')
  sqlite.run('PRAGMA busy_timeout = 5000')
  sqlite.run('PRAGMA synchronous = NORMAL')
  sqlite.run('PRAGMA foreign_keys = ON')
  const db = createDrizzle(sqlite)
  migrate(db, { migrationsFolder: MIGRATIONS })
  return { sqlite, db, close: () => sqlite.close() }
}
