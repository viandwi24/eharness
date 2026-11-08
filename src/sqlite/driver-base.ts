/**
 * Shared body of the runtime drivers: statement cache, parameter normalization and the
 * `BEGIN IMMEDIATE` transaction with join-the-outer nesting. The runtime entries only adapt their
 * binding to {@link RawDatabase}. Internal, not exported from the package.
 */
import type { SqlDriver, SqlParam, SqlRunResult } from './driver.ts'

/** The statement shape `bun:sqlite` and `node:sqlite` have in common. */
export interface RawStatement {
  all(...params: never[]): unknown[]
  run(...params: never[]): { changes: number | bigint; lastInsertRowid: number | bigint }
  finalize?(): void
}

/** The database shape `bun:sqlite` and `node:sqlite` have in common. */
export interface RawDatabase {
  exec(sql: string): unknown
  prepare(sql: string): RawStatement
}

/** Options shared by the runtime drivers. */
export interface DriverOptions {
  /**
   * The driver's database was opened for this package: set `journal_mode = WAL`,
   * `foreign_keys = ON` and `busy_timeout`. Default `false`: a handle the app opened keeps its
   * pragmas, except `busy_timeout`, which is raised to at least {@link MIN_BUSY_TIMEOUT_MS}.
   */
  owned?: boolean
  /** `busy_timeout` in ms when `owned` (default 5 000). */
  busyTimeoutMs?: number
  /** Called with the warning when a borrowed handle's `busy_timeout` is raised. Default `console.warn`. */
  onWarn?: (message: string) => void
}

/** Lowest `busy_timeout` the drivers accept on a handle the app opened. */
export const MIN_BUSY_TIMEOUT_MS = 1_000
const DEFAULT_BUSY_TIMEOUT_MS = 5_000
const CACHE_SIZE = 128

const bind = (params: readonly SqlParam[] | undefined): never[] =>
  (params ?? []).map((p) =>
    typeof p === 'boolean' ? (p ? 1 : 0) : p === undefined ? null : p,
  ) as never[]

/** Build a {@link SqlDriver} over a raw database and apply the pragma policy of `options`. */
export function createDriver(db: RawDatabase, options: DriverOptions = {}): SqlDriver {
  const cache = new Map<string, RawStatement>()
  const prepare = (sql: string): RawStatement => {
    const hit = cache.get(sql)
    if (hit !== undefined) return hit
    const statement = db.prepare(sql)
    if (cache.size >= CACHE_SIZE) {
      const oldest = cache.keys().next().value as string
      cache.get(oldest)?.finalize?.()
      cache.delete(oldest)
    }
    cache.set(sql, statement)
    return statement
  }
  let depth = 0

  const driver: SqlDriver = {
    exec(sql) {
      db.exec(sql)
    },
    query<T = Record<string, unknown>>(sql: string, params?: readonly SqlParam[]): T[] {
      return prepare(sql).all(...bind(params)) as T[]
    },
    run(sql, params): SqlRunResult {
      const r = prepare(sql).run(...bind(params))
      return { changes: Number(r.changes), lastInsertRowid: r.lastInsertRowid }
    },
    transaction<T>(fn: () => T): T {
      if (depth > 0) return fn()
      db.exec('BEGIN IMMEDIATE')
      depth = 1
      try {
        const result = fn()
        if (result instanceof Promise) {
          // plain-error: programmer error: a transaction callback must be synchronous
          throw new TypeError('transaction: fn must be synchronous (it returned a promise)')
        }
        db.exec('COMMIT')
        return result
      } catch (error) {
        try {
          db.exec('ROLLBACK')
        } catch {
          // the transaction is already gone (a failed COMMIT rolls back by itself)
        }
        throw error
      } finally {
        depth = 0
      }
    },
  }

  if (options.owned === true) {
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA foreign_keys = ON')
    db.exec(
      `PRAGMA busy_timeout = ${Math.max(0, Math.floor(options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS))}`,
    )
  } else {
    const current = Number(
      driver.query<{ timeout: number }>('PRAGMA busy_timeout')[0]?.timeout ?? 0,
    )
    if (current < MIN_BUSY_TIMEOUT_MS) {
      db.exec(`PRAGMA busy_timeout = ${MIN_BUSY_TIMEOUT_MS}`)
      const warn = options.onWarn ?? ((m: string) => console.warn(m))
      warn(
        `eharness/sqlite: busy_timeout was ${current} ms; raised to ${MIN_BUSY_TIMEOUT_MS} ms so concurrent writers wait instead of failing`,
      )
    }
  }
  return driver
}
