/**
 * Proves the sqlite entries of the built package (run after `bun run build`, ADR-0071):
 *
 * - no entry (`sqlite/index.js`, `sqlite/bun.js`, `sqlite/node.js`) imports a `bun:` or `node:` module at runtime, directly or
 *   through a shared chunk (spec 36 §1: the drivers take a handle, they never open a binding);
 * - every bare import is a declared peer of `eharness` (`ai`, `zod`, ...; shared chunks hold the core);
 * - the sqlite entry loads and exposes `createSqliteStorage` without either binding being touched;
 * - `codes/index.js` (`eharness/codes`, ADR-0072) imports nothing but relative chunks, and none of
 *   them imports a bare or `bun:`/`node:` module: the entry is pure constants.
 */
import { dirname, join, relative, resolve } from 'node:path'

const dist = resolve(import.meta.dir, '../dist')
const entries = ['sqlite/index.js', 'sqlite/bun.js', 'sqlite/node.js']
const transpiler = new Bun.Transpiler({ loader: 'js' })
const problems: string[] = []
const pkg = (await Bun.file(resolve(dist, '../package.json')).json()) as {
  peerDependencies: Record<string, string>
}
const peers = Object.keys(pkg.peerDependencies)

async function walk(file: string, seen: Set<string>): Promise<void> {
  if (seen.has(file)) return
  seen.add(file)
  const source = await Bun.file(join(dist, file)).text()
  for (const { path } of transpiler.scanImports(source)) {
    if (path.startsWith('.')) await walk(relative(dist, resolve(dist, dirname(file), path)), seen)
    else if (path.startsWith('bun:') || path.startsWith('node:')) {
      problems.push(`${file} imports ${path}`)
    } else if (!peers.some((peer) => path === peer || path.startsWith(`${peer}/`))) {
      problems.push(`${file} imports ${path}, which is not a declared peer`)
    }
  }
}

for (const entry of entries) await walk(entry, new Set())

const mod = (await import(join(dist, 'sqlite/index.js'))) as Record<string, unknown>
for (const name of ['createSqliteStorage', 'migrate', 'schemaSql']) {
  if (typeof mod[name] !== 'function') problems.push(`sqlite/index.js does not export ${name}()`)
}

const codesSeen = new Set<string>()
await walk('codes/index.js', codesSeen)
for (const file of codesSeen) {
  const source = await Bun.file(join(dist, file)).text()
  for (const { path } of transpiler.scanImports(source)) {
    if (!path.startsWith('.'))
      problems.push(`${file} imports ${path}; eharness/codes must import nothing`)
  }
}
const codes = (await import(join(dist, 'codes/index.js'))) as Record<string, unknown>
if (typeof codes.STOP_REASONS !== 'object' || typeof codes.NOTICE_CODES !== 'object') {
  problems.push('codes/index.js does not export STOP_REASONS and NOTICE_CODES')
}

if (problems.length > 0) {
  console.error(`check-sqlite-entry failed:\n${problems.map((p) => `  - ${p}`).join('\n')}`)
  process.exit(1)
}
console.log(
  'check-sqlite-entry: no entry imports bun: or node:; the sqlite entry loads; eharness/codes imports nothing',
)
