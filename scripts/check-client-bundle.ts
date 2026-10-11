/**
 * Post-build guard of `eharness/client` (ADR-0059). The browser bundle must not drag in the server
 * side of the package: starting from every `dist/client/*.js`, follow the static and dynamic
 * imports and fail when
 *
 * - a bare specifier other than `ai` is imported (no `eharness` core, no `react`, no `zod`),
 * - a reached file is the entry of another subpath (`dist/index.js`, `dist/http/index.js`, ...),
 * - a reached chunk is also imported by a file outside the client graph (a shared chunk would mean
 *   client code and server code were bundled together).
 *
 * Run after `bun run build` (wired into `check:package`).
 */
import { dirname, join, relative, resolve } from 'node:path'
import { Glob } from 'bun'

const root = resolve(import.meta.dir, '..')
const dist = join(root, 'dist')
const specifierPattern =
  /(?:^|[\s;{}])(?:import|export)\s[^'"`]*?from\s*['"]([^'"]+)['"]|(?:^|[^\w.])import\s*\(\s*['"]([^'"]+)['"]\s*\)|(?:^|[\s;{}])import\s*['"]([^'"]+)['"]/g

const specifiersOf = (text: string): string[] =>
  [...text.matchAll(specifierPattern)].map((m) => (m[1] ?? m[2] ?? m[3]) as string)

const files = new Map<string, string>()
for await (const file of new Glob('**/*.js').scan({ cwd: dist })) {
  files.set(join(dist, file), await Bun.file(join(dist, file)).text())
}

const clientDir = `${join(dist, 'client')}/`
const entries = new Set(
  Object.values(
    (
      JSON.parse(await Bun.file(join(root, 'package.json')).text()) as {
        exports: Record<string, string>
      }
    ).exports,
  )
    .filter((p) => typeof p === 'string' && p.endsWith('.js'))
    .map((p) => resolve(root, p)),
)
const clientEntries = [...files.keys()].filter((f) => f.startsWith(clientDir))
const violations: string[] = []
if (!clientEntries.some((f) => f === join(dist, 'client', 'index.js'))) {
  violations.push('dist/client/index.js is missing: run `bun run build` first')
}

const reached = new Set<string>(clientEntries)
const queue = [...clientEntries]
while (queue.length > 0) {
  const file = queue.pop() as string
  const shown = relative(root, file)
  for (const specifier of specifiersOf(files.get(file) ?? '')) {
    if (!specifier.startsWith('.')) {
      if (specifier !== 'ai') {
        violations.push(`${shown}: imports '${specifier}'; the client bundle may import only 'ai'`)
      }
      continue
    }
    const target = resolve(dirname(file), specifier)
    if (!files.has(target)) {
      violations.push(`${shown}: imports '${specifier}', which is not in dist/`)
      continue
    }
    if (!target.startsWith(clientDir) && entries.has(target)) {
      violations.push(`${shown}: imports the entry '${relative(root, target)}' of another subpath`)
      continue
    }
    if (!reached.has(target)) {
      reached.add(target)
      queue.push(target)
    }
  }
}

for (const [file, text] of files) {
  if (reached.has(file)) continue
  for (const specifier of specifiersOf(text)) {
    if (!specifier.startsWith('.')) continue
    const target = resolve(dirname(file), specifier)
    if (reached.has(target) && !target.startsWith(clientDir)) {
      violations.push(
        `${relative(root, file)}: imports the client chunk '${relative(root, target)}'; client code is shared with other modules`,
      )
    }
  }
}

if (violations.length > 0) {
  console.error(`check:client-bundle found ${violations.length} violation(s):\n`)
  for (const violation of [...new Set(violations)].sort()) console.error(`  ${violation}`)
  process.exit(1)
}
console.log(
  `check:client-bundle: ok (${clientEntries.length} entries, ${reached.size - clientEntries.length} chunk(s), imports only 'ai')`,
)
