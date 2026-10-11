/**
 * Export snapshot: every entry of `package.json#exports` and the runtime export names it
 * provides, committed in `scripts/exports.snapshot.json`. Adding or removing a public export is
 * therefore always a deliberate, reviewed diff (docs/engineering/api-stability.md).
 *
 *   bun scripts/exports-snapshot.ts           compare the source entries with the snapshot
 *   bun scripts/exports-snapshot.ts --dist    compare the built entries (`bun run build` first)
 *   bun scripts/exports-snapshot.ts --write   rewrite the snapshot from the source entries
 *
 * `src/exports.test.ts` runs the same comparison against the source in `bun test`.
 */

import { resolve } from 'node:path'

const root = resolve(import.meta.dir, '..')
export const snapshotPath: string = resolve(root, 'scripts/exports.snapshot.json')

/** Public entries of the package: [specifier, path of the entry file]. */
export async function entryFiles(dist: boolean): Promise<[string, string][]> {
  const pkg = (await Bun.file(resolve(root, 'package.json')).json()) as {
    exports: Record<string, string>
  }
  const out: [string, string][] = []
  for (const [key, target] of Object.entries(pkg.exports)) {
    if (key === './package.json') continue
    const specifier = key === '.' ? 'eharness' : `eharness/${key.slice(2)}`
    const file = dist
      ? resolve(root, target)
      : resolve(root, target.replace(/^\.\/dist\//, 'src/').replace(/\.js$/, '.ts'))
    out.push([specifier, file])
  }
  return out
}

/** Runtime export names per entry, sorted. */
export async function currentExports(dist: boolean): Promise<Record<string, string[]>> {
  const result: Record<string, string[]> = {}
  for (const [specifier, file] of await entryFiles(dist)) {
    result[specifier] = Object.keys(await import(file)).sort()
  }
  return result
}

/** Human-readable differences between the snapshot and the current exports (empty = equal). */
export function diffExports(
  expected: Record<string, string[]>,
  actual: Record<string, string[]>,
): string[] {
  const problems: string[] = []
  for (const entry of new Set([...Object.keys(expected), ...Object.keys(actual)])) {
    const want = new Set(expected[entry])
    const have = new Set(actual[entry])
    if (expected[entry] === undefined) problems.push(`${entry}: new entry, not in the snapshot`)
    else if (actual[entry] === undefined) problems.push(`${entry}: entry removed`)
    for (const name of have) if (!want.has(name)) problems.push(`${entry}: + ${name} (new export)`)
    for (const name of want) if (!have.has(name)) problems.push(`${entry}: - ${name} (removed)`)
  }
  return problems
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const actual = await currentExports(args.includes('--dist'))
  if (args.includes('--write')) {
    await Bun.write(snapshotPath, `${JSON.stringify(actual, null, 2)}\n`)
    console.log(`exports snapshot written (${Object.keys(actual).length} entries)`)
  } else {
    const expected = (await Bun.file(snapshotPath).json()) as Record<string, string[]>
    const problems = diffExports(expected, actual)
    if (problems.length > 0) {
      console.error(`export snapshot mismatch:\n  ${problems.join('\n  ')}`)
      console.error('\nIf the change is deliberate: bun scripts/exports-snapshot.ts --write')
      process.exit(1)
    }
    console.log(`exports snapshot: ok (${Object.keys(actual).length} entries)`)
  }
}
