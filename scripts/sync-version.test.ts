import { expect, test } from 'bun:test'
import pkg from '../package.json'
import { version } from '../src/index.ts'

test('the exported version equals package.json (bun scripts/sync-version.ts)', () => {
  expect(version).toBe(pkg.version)
})
