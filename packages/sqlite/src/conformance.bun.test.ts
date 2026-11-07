/** The conformance suites of `eharness/testing` against `bun:sqlite` (spec 36 §7). */

import { Database } from 'bun:sqlite'
import { afterAll, describe, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bunSqlite } from './bun.ts'
import { prepare, suiteGroups } from './conformance-suites.ts'

const dir = mkdtempSync(join(tmpdir(), 'eharness-sqlite-bun-'))
const opened: Database[] = []
let counter = 0

const open = (path: string): Database => {
  const db = new Database(path)
  opened.push(db)
  return db
}

afterAll(() => {
  for (const db of opened) db.close()
  rmSync(dir, { recursive: true, force: true })
})

const groups = suiteGroups({
  memory: () => prepare(bunSqlite(open(':memory:'), { owned: true })),
  file: (path) => prepare(bunSqlite(open(path), { owned: true })),
  newPath: () => join(dir, `db-${counter++}.sqlite`),
})

for (const group of groups) {
  describe(`${group.name} (bun:sqlite)`, () => {
    for (const c of group.cases) test(c.name, c.run)
  })
}
