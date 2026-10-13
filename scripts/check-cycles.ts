/**
 * Runtime import cycles between top-level core folders (K-18).
 *
 * The core is layered: messages/models/errors/internal <- plugin/registry/skills <- compaction
 * <- loop <- session <- agent/stream. A runtime import that points "up" the stack creates a cycle
 * between folders, which makes module initialisation order fragile. This check builds the folder
 * graph from non-test files (type-only imports are erased and do not count) and fails on any cycle.
 * Subpath modules are out of scope here (`check-imports.ts` already limits them to `src/index.ts`).
 *
 * Exits with code 1 and prints each cycle.
 */

import { dirname, join, relative, resolve } from 'node:path'
import { Glob } from 'bun'

const root = resolve(import.meta.dir, '..')
const src = join(root, 'src')
const nonCore = new Set([
  'filesystem',
  'storage',
  'mcp',
  'testing',
  'todos',
  'memory',
  'guard',
  'openapi',
  'group',
  'ask',
  'activity',
  'permissions',
  'providers',
  'connectors',
  'code',
  'shell',
  'subagent',
  'web',
  'http',
  'client',
])
const testFile = /\.(?:int\.)?test(?:-d)?\.ts$|(?:^|\/)test-kit\.ts$/
const statement =
  /(?:^|[\n;])\s*(import|export)\s+(type\s+)?([^'"`;]*?\sfrom\s*)?['"](\.[^'"]*)['"]/g

/** Top-level node of a file: its folder under `src/`, or the file name for root files. */
function node(file: string): string {
  const parts = relative(src, file).split('/')
  return parts.length > 1 ? (parts[0] as string) : (parts[0] as string).replace(/\.ts$/, '')
}

const edges = new Map<string, Map<string, string>>()
for await (const rel of new Glob('**/*.ts').scan({ cwd: src })) {
  if (testFile.test(rel) || rel === 'index.ts') continue
  const from = node(join(src, rel))
  if (nonCore.has(from)) continue
  const text = await Bun.file(join(src, rel)).text()
  for (const match of text.matchAll(statement)) {
    if (match[2] !== undefined) continue
    const clause = match[3]
    // `import { type A, type B } from` imports nothing at runtime.
    if (clause !== undefined && /^\s*(?:import|export)?\s*\{[^}]*\}\s*from/.test(`x ${clause}`)) {
      const names = clause
        .replace(/\s*from\s*$/, '')
        .replace(/[{}]/g, '')
        .split(',')
        .map((n) => n.trim())
        .filter(Boolean)
      if (names.length > 0 && names.every((n) => n.startsWith('type '))) continue
    }
    const target = resolve(dirname(join(src, rel)), match[4] as string)
    if (target === join(src, 'index') || target === join(src, 'index.ts')) continue
    const to = node(target)
    if (to === from || nonCore.has(to)) continue
    const map = edges.get(from) ?? new Map<string, string>()
    if (!map.has(to)) map.set(to, rel)
    edges.set(from, map)
  }
}

const cycles: string[] = []
const state = new Map<string, 1 | 2>()
const stack: string[] = []
function visit(name: string): void {
  state.set(name, 1)
  stack.push(name)
  for (const next of edges.get(name)?.keys() ?? []) {
    if (state.get(next) === 1) {
      const loop = [...stack.slice(stack.indexOf(next)), next]
      const detail = loop
        .slice(0, -1)
        .map((n, i) => `${n} -> ${loop[i + 1]} (${edges.get(n)?.get(loop[i + 1] as string)})`)
      cycles.push(detail.join(', '))
    } else if (state.get(next) === undefined) visit(next)
  }
  stack.pop()
  state.set(name, 2)
}
for (const name of [...edges.keys()].sort()) if (state.get(name) === undefined) visit(name)

if (cycles.length > 0) {
  console.error(
    `check:cycles found ${cycles.length} runtime import cycle(s) between core folders:\n`,
  )
  for (const cycle of cycles) console.error(`  ${cycle}`)
  process.exit(1)
}
console.log('check:cycles: ok')
