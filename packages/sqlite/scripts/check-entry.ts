/**
 * Proves the entries of the built package (run after `bun run build`):
 *
 * - no entry (`.`, `./bun`, `./node`) imports a `bun:` or `node:` module at runtime, directly or
 *   through a shared chunk (spec 36 §1: the drivers take a handle, they never open a binding);
 * - every bare import is `eharness`, one of its subpaths, or `ai` (the peers);
 * - the root entry loads and exposes `createSqliteStorage` without either binding being touched.
 */
import { join, resolve } from 'node:path'

const dist = resolve(import.meta.dir, '../dist')
const entries = ['index.js', 'bun.js', 'node.js']
const transpiler = new Bun.Transpiler({ loader: 'js' })
const problems: string[] = []

async function walk(file: string, seen: Set<string>): Promise<void> {
  if (seen.has(file)) return
  seen.add(file)
  const source = await Bun.file(join(dist, file)).text()
  for (const { path } of transpiler.scanImports(source)) {
    if (path.startsWith('./')) await walk(path.slice(2), seen)
    else if (path.startsWith('bun:') || path.startsWith('node:')) {
      problems.push(`${file} imports ${path}`)
    } else if (!(path === 'eharness' || path.startsWith('eharness/') || path === 'ai')) {
      problems.push(`${file} imports ${path}, which is not a declared peer`)
    }
  }
}

for (const entry of entries) await walk(entry, new Set())

const mod = (await import(join(dist, 'index.js'))) as Record<string, unknown>
for (const name of ['createSqliteStorage', 'migrate', 'schemaSql']) {
  if (typeof mod[name] !== 'function') problems.push(`index.js does not export ${name}()`)
}

if (problems.length > 0) {
  console.error(`check-entry failed:\n${problems.map((p) => `  - ${p}`).join('\n')}`)
  process.exit(1)
}
console.log('check-entry: no entry imports bun: or node:; the root entry loads')
