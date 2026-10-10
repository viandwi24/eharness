/**
 * Import rules for `src/` (ADR-0008, ADR-0010, docs/engineering/conventions.md):
 *
 * 1. Subpath modules (`src/filesystem|storage|mcp|testing|todos|memory|guard|openapi|group|ask|permissions|providers|connectors|shell|subagent|web`) import core only through the relative
 *    path to `src/index.ts`, never through other core files or the `eharness` self-reference.
 *    Non-test files never import another subpath; test files of a subpath may (e.g. a filesystem
 *    test running `fileSystemConformance` from `src/testing`), but still never core internals.
 *    Exception: the pairs in `allowedImports` (ADR-0049).
 * 2. Non-test files under `src/` never use `Bun.` or import `node:` built-ins, except the Node-only
 *    modules listed in `nodeOnly` (ADR-0036): they may import `node:` built-ins (never `Bun.`).
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
  'permissions',
  'providers',
  'connectors',
  'shell',
  'subagent',
  'web',
]
/**
 * Documented exceptions (ADR-0049): `eharness/connectors` reuses the generic configuration
 * machinery of `eharness/providers` (forms, secret redaction, profiles) instead of copying it.
 */
const allowedImports: Record<string, string[]> = { connectors: ['providers'] }
/** Node-only modules (ADR-0036): `node:` built-ins allowed. */
const nodeOnly = ['filesystem/node.ts', 'filesystem/node/', 'shell/']
const coreIndex = join(src, 'index.ts')

const specifierPattern =
  /(?:^|[\s;])(?:import|export)\s[^'"`]*?from\s*['"]([^'"]+)['"]|(?:^|[^\w.])import\s*\(\s*['"]([^'"]+)['"]\s*\)|(?:^|[\s;])import\s*['"]([^'"]+)['"]/gm
const testFile = /\.(?:int\.)?test(?:-d)?\.ts$/

const violations: string[] = []

for await (const file of new Glob('**/*.{ts,mts,cts,js,mjs}').scan({ cwd: src })) {
  const path = join(src, file)
  const shown = relative(root, path)
  const text = await Bun.file(path).text()
  const isTest = testFile.test(file)
  const subpath = subpaths.find((name) => file.startsWith(`${name}/`))

  if (!isTest && /\bBun\./.test(text)) violations.push(`${shown}: uses the Bun global`)

  for (const match of text.matchAll(specifierPattern)) {
    const specifier = match[1] ?? match[2] ?? match[3]
    if (specifier === undefined) continue

    if (!isTest && specifier.startsWith('node:') && !nodeOnly.some((p) => file.startsWith(p))) {
      violations.push(`${shown}: imports Node built-in '${specifier}'`)
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
