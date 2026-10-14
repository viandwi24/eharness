/**
 * Import rules for `src/` (ADR-0008, ADR-0010, docs/engineering/conventions.md):
 *
 * 1. Subpath modules (`src/filesystem|storage|mcp|testing|todos|memory|guard|openapi|group|ask|activity|permissions|providers|connectors|code|shell|subagent|web|http|client`) import core only through the relative
 *    path to `src/index.ts`, never through other core files or the `eharness` self-reference.
 *    Non-test files never import another subpath; test files of a subpath may (e.g. a filesystem
 *    test running `fileSystemConformance` from `src/testing`), but still never core internals.
 *    Exception: the pairs in `allowedImports` (ADR-0049; `testing` may import the types of `activity`, ADR-0058).

 *    `eharness/client` (ADR-0059) is stricter: a non-test file under `src/client` may import at
 *    runtime only from `ai` and from files inside `src/client`. Every import that leaves
 *    `src/client` (core, `http`, `activity`) must be a statement-level `import type` /
 *    `export type` (an inline `{ type X }` still leaves a side-effect import under
 *    `verbatimModuleSyntax`), and `import()` is not allowed. `scripts/check-client-bundle.ts`
 *    verifies the built output.
 * 2. Non-test files under `src/` never use `Bun.` or import `node:` built-ins, except the Node-only
 *    modules listed in `nodeOnly` (ADR-0036): they may import `node:` built-ins (never `Bun.`).
 *
 * 3. Runtime-neutral files (everything outside `nodeOnly`, tests excluded) also never use Node-only
 *    globals or bare built-in specifiers: `Buffer`, `process.`, `setImmediate`, `require(`,
 *    `__dirname`/`__filename`, and `fs`, `path`, `os`, `child_process`, `crypto`, ... without the
 *    `node:` prefix. `allowedNodeGlobals` lists the reviewed exceptions.
 *
 * 4. Production files never import a test kit (`test-kit.ts`) or `src/testing/**`, so test helpers are
 *    never bundled. Only subpath modules named in `allowedImports` may use `src/testing` (it is a
 *    subpath itself); core files (e.g. `src/session/*.ts`) may not.
 *
 * Exits with code 1 and lists every violation.
 */

import { dirname, join, relative, resolve } from 'node:path'
import { Glob } from 'bun'

const root = resolve(import.meta.dir, '..')
const src = join(root, 'src')
const subpaths = [
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
  'scheduler',
  'identity',
  'channels',
  'handoff',
  'limits',
  'clock',
  'browser',
]
/**
 * Documented exceptions (ADR-0049): `eharness/connectors` reuses the generic configuration
 * machinery of `eharness/providers` (forms, secret redaction, profiles) instead of copying it.
 */
const allowedImports: Record<string, string[]> = {
  connectors: ['providers'],
  http: ['activity'],
  client: ['http', 'activity'],
  testing: ['activity', 'http', 'scheduler', 'channels', 'identity', 'handoff', 'browser'],
  browser: ['providers'],
}
/** Node-only modules (ADR-0036): `node:` built-ins allowed. */
const nodeOnly = [
  'filesystem/node.ts',
  'filesystem/node/',
  'shell/',
  'web/node.ts',
  'browser/node/',
  'browser/node.ts',
]
/**
 * Reviewed exceptions to rule 3: file -> patterns (as source text of the rule name) that may appear.
 * `src/session` reads `globalThis.process` behind a `typeof` guard (no bare `process.` use).
 */
const allowedNodeGlobals: Record<string, string[]> = {
  'session/session.ts': ['process.'],
}
const neutralGlobals: Array<[name: string, pattern: RegExp]> = [
  ['Buffer', /\bBuffer\b/],
  ['process.', /(?<![\w.])process\./],
  ['setImmediate', /\bsetImmediate\b/],
  ['require(', /(?<![\w.])require\s*\(/],
  ['__dirname', /\b__(?:dirname|filename)\b/],
]
const bareBuiltins = new Set([
  'fs',
  'path',
  'os',
  'child_process',
  'crypto',
  'url',
  'util',
  'stream',
  'events',
  'http',
  'https',
  'net',
  'zlib',
  'buffer',
  'assert',
  'tty',
  'worker_threads',
  'readline',
  'dns',
  'timers',
  'module',
  'vm',
])
/** Source without comments, so prose mentioning `Buffer` is not flagged. */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
}
const coreIndex = join(src, 'index.ts')

const specifierPattern =
  /(?:^|[\s;])(?:import|export)\s[^'"`]*?from\s*['"]([^'"]+)['"]|(?:^|[^\w.])import\s*\(\s*['"]([^'"]+)['"]\s*\)|(?:^|[\s;])import\s*['"]([^'"]+)['"]/gm
const testFile = /\.(?:int\.)?test(?:-d)?\.ts$|(?:^|\/)test-kit\.ts$/

const violations: string[] = []

/** Statement-level imports/exports with their `type` flag (for the client rule). */
const statementPattern =
  /(?:^|[\n;])\s*(import|export)\s+(type\s+)?(?:[^'"`;]*?\sfrom\s*)?['"]([^'"]+)['"]/g

function checkClientFile(file: string, shown: string, text: string): void {
  const path = join(src, file)
  for (const match of text.matchAll(statementPattern)) {
    const isType = match[2] !== undefined
    const specifier = match[3] as string
    if (specifier.startsWith('.')) {
      const target = resolve(dirname(path), specifier)
      if (!target.startsWith(`${join(src, 'client')}/`) && !isType) {
        violations.push(
          `${shown}: runtime import of '${specifier}' leaves src/client; use \`import type\` (ADR-0059)`,
        )
      }
    } else if (specifier !== 'ai' && !isType) {
      violations.push(
        `${shown}: runtime import of '${specifier}'; src/client may import only 'ai' (ADR-0059)`,
      )
    }
  }
  if (/(?:^|[^\w.])import\s*\(/.test(text)) {
    violations.push(`${shown}: dynamic import() is not allowed in src/client (ADR-0059)`)
  }
}

for await (const file of new Glob('**/*.{ts,mts,cts,js,mjs}').scan({ cwd: src })) {
  const path = join(src, file)
  const shown = relative(root, path)
  const text = await Bun.file(path).text()
  const isTest = testFile.test(file)
  const subpath = subpaths.find((name) => file.startsWith(`${name}/`))

  if (!isTest && /\bBun\./.test(text)) violations.push(`${shown}: uses the Bun global`)
  if (!isTest && !nodeOnly.some((p) => file.startsWith(p))) {
    const code = stripComments(text)
    for (const [name, pattern] of neutralGlobals) {
      if (pattern.test(code) && !allowedNodeGlobals[file]?.includes(name)) {
        violations.push(`${shown}: runtime-neutral module uses '${name}' (Node-only)`)
      }
    }
  }
  if (!isTest && file.startsWith('client/')) checkClientFile(file, shown, text)

  for (const match of text.matchAll(specifierPattern)) {
    const specifier = match[1] ?? match[2] ?? match[3]
    if (specifier === undefined) continue

    if (!isTest && specifier.startsWith('node:') && !nodeOnly.some((p) => file.startsWith(p))) {
      violations.push(`${shown}: imports Node built-in '${specifier}'`)
    }
    if (!isTest && bareBuiltins.has(specifier) && !nodeOnly.some((p) => file.startsWith(p))) {
      violations.push(`${shown}: imports bare Node built-in '${specifier}'`)
    }
    if (!isTest && specifier.startsWith('.') && subpath !== 'testing') {
      const target = resolve(dirname(path), specifier)
      if (/(^|\/)test-kit(\.ts)?$/.test(target) || target.startsWith(`${join(src, 'testing')}/`)) {
        violations.push(`${shown}: production code imports test helper '${specifier}'`)
      }
    }
    if (subpath === undefined) continue

    if (specifier === 'eharness' || specifier.startsWith('eharness/')) {
      violations.push(`${shown}: imports '${specifier}'; use the relative path to src/index.ts`)
      continue
    }
    if (!specifier.startsWith('.')) continue

    const target = resolve(dirname(path), specifier)
    const insideOwnSubpath = target.startsWith(`${join(src, subpath)}/`)
    const insideOtherSubpath =
      isTest && subpaths.some((name) => target.startsWith(`${join(src, name)}/`))
    const insideAllowedSubpath = (allowedImports[subpath] ?? []).some((name) =>
      target.startsWith(`${join(src, name)}/`),
    )
    const isCoreIndex = target === coreIndex || target === join(src, 'index')
    if (!insideOwnSubpath && !insideOtherSubpath && !insideAllowedSubpath && !isCoreIndex) {
      violations.push(`${shown}: imports '${specifier}'; core is reachable only via src/index.ts`)
    }
  }
}

if (violations.length > 0) {
  console.error(`check:imports found ${violations.length} violation(s):\n`)
  for (const violation of violations.sort()) console.error(`  ${violation}`)
  process.exit(1)
}
console.log('check:imports: ok')
