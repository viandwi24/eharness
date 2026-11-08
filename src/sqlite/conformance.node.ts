/**
 * The conformance suites of `eharness/testing` against `node:sqlite` (spec 36 §7). Run from the repo
 * root with Node >= 22.5 (Node strips the types of the sources; no build needed):
 *
 *   node --experimental-sqlite --test src/sqlite/conformance.node.ts   (or: bun run test:node-sqlite)
 *
 * (`--experimental-sqlite` is only needed on Node 22.5 to 22.12; Node 22.18+ strips the types.)
 * Not named `*.test.ts` on purpose: `bun test` must not pick it up.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { after, describe, test } from 'node:test'
import { prepare, suiteGroups } from './conformance-suites.ts'
import { nodeSqlite } from './node.ts'

const dir = mkdtempSync(join(tmpdir(), 'eharness-sqlite-node-'))
const opened: DatabaseSync[] = []
let counter = 0

const open = (path: string): DatabaseSync => {
  const db = new DatabaseSync(path)
  opened.push(db)
  return db
}

after(() => {
  for (const db of opened) db.close()
  rmSync(dir, { recursive: true, force: true })
})

const groups = suiteGroups({
  memory: () => prepare(nodeSqlite(open(':memory:'), { owned: true })),
  file: (path) => prepare(nodeSqlite(open(path), { owned: true })),
  newPath: () => join(dir, `db-${counter++}.sqlite`),
})

for (const group of groups) {
  describe(`${group.name} (node:sqlite)`, () => {
    for (const c of group.cases) test(c.name, c.run)
  })
}
