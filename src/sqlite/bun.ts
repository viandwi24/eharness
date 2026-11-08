/**
 * `eharness/sqlite/bun`: the driver for `bun:sqlite`. Imports nothing at runtime: pass the
 * `Database` you opened.
 *
 * @example
 * ```ts
 * import { Database } from 'bun:sqlite'
 * const driver = bunSqlite(new Database('keith.db'), { owned: true })
 * ```
 */

import type { SqlDriver } from './driver.ts'
import { createDriver, type DriverOptions, type RawStatement } from './driver-base.ts'

export type { DriverOptions } from './driver-base.ts'

/** The part of `bun:sqlite`'s `Database` the driver uses. */
export interface BunDatabase {
  exec(sql: string): unknown
  prepare(sql: string): RawStatement
}

/** A {@link SqlDriver} over a `bun:sqlite` `Database`. */
export function bunSqlite(db: BunDatabase, options?: DriverOptions): SqlDriver {
  return createDriver(db, options)
}
