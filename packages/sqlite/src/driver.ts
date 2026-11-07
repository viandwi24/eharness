/**
 * The driver port the adapters talk to (spec 36 §2). Synchronous on purpose: every read-modify-write
 * of an adapter is one `transaction(fn)` without an `await`.
 */

/** A bound parameter. Booleans are stored as 0 / 1. */
export type SqlParam = string | number | bigint | boolean | null | Uint8Array

/** Result of {@link SqlDriver.run}. */
export interface SqlRunResult {
  changes: number
  lastInsertRowid: number | bigint
}

/** A synchronous SQLite connection, reduced to what the adapters need. */
export interface SqlDriver {
  /** Run statements without parameters (DDL, pragmas). */
  exec(sql: string): void
  /** Rows of a query. */
  query<T = Record<string, unknown>>(sql: string, params?: readonly SqlParam[]): T[]
  /** A statement that changes rows. */
  run(sql: string, params?: readonly SqlParam[]): SqlRunResult
  /**
   * One write transaction that takes the write lock up front (`BEGIN IMMEDIATE`). `fn` is
   * synchronous (a function that returns a promise is rejected and rolled back). Nested calls
   * join the outer transaction.
   */
  transaction<T>(fn: () => T): T
}
