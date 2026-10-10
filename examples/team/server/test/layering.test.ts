/** Layering (docs/plans/P32-team-example.md §3): a grep over the imports of src/. */
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

const SRC = resolve(import.meta.dir, '../src')

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? files(path) : path.endsWith('.ts') ? [path] : []
  })
}

function importsOf(file: string): string[] {
  const text = readFileSync(file, 'utf8')
  const out: string[] = []
  for (const m of text.matchAll(
    /(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]|import\s+['"]([^'"]+)['"]/g,
  )) {
    out.push((m[1] ?? m[2]) as string)
  }
  return out
}

const layerOf = (file: string): string => relative(SRC, file).split('/')[0] as string
const isRelative = (spec: string): boolean => spec.startsWith('.')
const IO_PACKAGES = /^(eharness(\/|$)|drizzle-orm(\/|$)|bun:|node:)/

function violations(layer: string, allowed: (file: string, spec: string) => boolean): string[] {
  return files(SRC)
    .filter((f) => layerOf(f) === layer)
    .flatMap((file) =>
      importsOf(file)
        .filter((spec) => !allowed(file, spec))
        .map((spec) => `${relative(SRC, file)} imports ${spec}`),
    )
}

const target = (file: string, spec: string): string =>
  relative(SRC, resolve(join(file, '..'), spec)).split('/')[0] as string

describe('layering', () => {
  test('domain imports nothing outside domain/', () => {
    expect(violations('domain', (f, s) => isRelative(s) && target(f, s) === 'domain')).toEqual([])
  })

  test('app imports domain and itself only (no packages)', () => {
    expect(
      violations('app', (f, s) => isRelative(s) && ['domain', 'app'].includes(target(f, s))),
    ).toEqual([])
  })

  test('http imports app and http only, plus the web framework packages', () => {
    expect(
      violations('http', (f, s) =>
        isRelative(s)
          ? ['app', 'http'].includes(target(f, s))
          : !IO_PACKAGES.test(s) && /^(hono|@hono\/|@scalar\/|zod)/.test(s),
      ),
    ).toEqual([])
  })

  test('only infra and the composition root import eharness, drizzle-orm and bun:sqlite', () => {
    const bad = files(SRC)
      .filter((f) => !['infra'].includes(layerOf(f)) && !f.endsWith('main.ts'))
      .flatMap((file) =>
        importsOf(file)
          .filter((s) => /^(eharness(\/|$)|drizzle-orm(\/|$)|bun:sqlite)/.test(s))
          .map((s) => `${relative(SRC, file)} imports ${s}`),
      )
    expect(bad).toEqual([])
  })

  test('infra imports eharness only through public subpaths', () => {
    const bad = files(SRC).flatMap((file) =>
      importsOf(file)
        .filter((s) => /eharness\/src\/|\/src\/index/.test(s))
        .map((s) => `${relative(SRC, file)} imports ${s}`),
    )
    expect(bad).toEqual([])
  })
})
