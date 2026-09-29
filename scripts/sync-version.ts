/**
 * Keeps `export const version` in `src/index.ts` equal to `package.json#version`.
 *
 * Run by `bun run release:version` right after `changeset version` (the version PR), so the
 * exported constant never lags behind the published version (`scripts/sync-version.test.ts`
 * fails on drift). Docs: docs/engineering/release.md §5.
 */
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dir, '..')
const indexPath = join(root, 'src/index.ts')
const pattern = /export const version: string = '([^']*)'/

const { version } = (await Bun.file(join(root, 'package.json')).json()) as { version: string }
const source = await Bun.file(indexPath).text()
const current = source.match(pattern)?.[1]
if (current === undefined) {
  console.error('sync-version: `export const version` not found in src/index.ts')
  process.exit(1)
}
if (current === version) {
  console.log(`sync-version: src/index.ts already exports ${version}`)
} else {
  await Bun.write(indexPath, source.replace(pattern, `export const version: string = '${version}'`))
  console.log(`sync-version: src/index.ts ${current} → ${version}`)
}
