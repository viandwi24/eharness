/**
 * `@eharness/sqlite/node`: the driver for `node:sqlite` (Node >= 22.5; the module is experimental
 * in Node 22 and this driver follows its API). Imports nothing at runtime: pass the
 * `DatabaseSync` you opened.
 *
 * @example
 * ```ts
 * import { DatabaseSync } from 'node:sqlite'
 * const driver = nodeSqlite(new DatabaseSync('app.db'), { owned: true })
 * ```
 */

import type { SqlDriver } from './driver.ts'
import { createDriver, type DriverOptions, type RawStatement } from './driver-base.ts'

export type { DriverOptions } from './driver-base.ts'

/** The part of `node:sqlite`'s `DatabaseSync` the driver uses. */
export interface NodeDatabase {
  exec(sql: string): unknown
  prepare(sql: string): RawStatement
}

/** A {@link SqlDriver} over a `node:sqlite` `DatabaseSync`. */
export function nodeSqlite(db: NodeDatabase, options?: DriverOptions): SqlDriver {
  return createDriver(db, options)
}
