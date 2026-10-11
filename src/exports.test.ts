import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { currentExports, diffExports, snapshotPath } from '../scripts/exports-snapshot.ts'

// Every public export change must be deliberate: update the snapshot with
// `bun scripts/exports-snapshot.ts --write` and review the diff (docs/engineering/api-stability.md).
describe('public export snapshot', () => {
  test('the runtime exports of every package.json#exports entry match the snapshot', async () => {
    const expected = (await Bun.file(snapshotPath).json()) as Record<string, string[]>
    expect(diffExports(expected, await currentExports(false))).toEqual([])
  })

  test('docs/architecture.md lists every entry point', async () => {
    const table = await Bun.file(resolve(import.meta.dir, '../docs/architecture.md')).text()
    const expected = (await Bun.file(snapshotPath).json()) as Record<string, string[]>
    for (const entry of Object.keys(expected)) {
      expect(table).toContain(`| \`${entry}\` |`)
    }
  })
})
