import { describe, expect, test } from 'bun:test'
import type { Skill, SkillSource } from '../registry/types.ts'
import { skillSourceConformance } from '../testing/skill-source.conformance.ts'
import { defineSkillSource } from './define.ts'
import { staticSkillSource } from './static-source.ts'

describe('static skills source (in-memory)', () => {
  for (const c of skillSourceConformance((skills) => staticSkillSource('static:app', skills))) {
    test(c.name, c.run)
  }
})

/** A "database" source over plain rows, written against the public contract only. */
function rowsSource(skills: readonly Skill[], leak = false, versions = true): SkillSource {
  const rows = structuredClone(skills) as Skill[]
  const version = (r: Skill) => (versions && r.version !== undefined ? { version: r.version } : {})
  return defineSkillSource({
    id: 'db:rows',
    refresh: 'turn',
    list: () => rows.map((r) => ({ name: r.name, description: r.description, ...version(r) })),
    load: (name) => {
      const row = rows.find((r) => r.name === name)
      if (row === undefined) return null
      const manifest = (row.files ?? []).map((f) => ({ path: f.path }))
      if (leak) manifest.push({ path: 'SKILL.md' })
      return {
        name: row.name,
        description: row.description,
        ...version(row),
        ...(row.meta === undefined ? {} : { meta: { ...row.meta } }),
        content: row.content,
        manifest,
      }
    },
    readFile: (name, path) => {
      const file = rows.find((r) => r.name === name)?.files?.find((f) => f.path === path)
      return file === undefined ? null : { type: 'text', text: file.content }
    },
    search: (query) =>
      rows
        .filter((r) => `${r.name} ${r.description}`.includes(query))
        .map((r) => ({ name: r.name, description: r.description })),
    locate: (name) => (rows.some((r) => r.name === name) ? { service: 'db', root: name } : null),
  })
}

describe('dynamic source over rows', () => {
  for (const c of skillSourceConformance((skills) => rowsSource(skills))) test(c.name, c.run)
})

describe('the suite catches broken sources', () => {
  const run = async (factory: Parameters<typeof skillSourceConformance>[0], name: string) => {
    const c = skillSourceConformance(factory).find((x) => x.name.startsWith(name))
    if (c === undefined) throw new Error(`no case ${name}`)
    return c.run()
  }

  test('a manifest listing SKILL.md fails', async () => {
    await expect(run((s) => rowsSource(s, true), 'load returns the body')).rejects.toThrow()
  })

  test('a source that shares its rows fails the copy case', async () => {
    await expect(
      run((skills) => {
        const shared = structuredClone(skills) as Skill[]
        const base = rowsSource(skills)
        return { ...base, list: () => shared as never }
      }, 'returns copies'),
    ).rejects.toThrow()
  })

  test('a source that drops versions fails, unless { version: false }', async () => {
    const name = 'list and load carry the skill version'
    await expect(run((s) => rowsSource(s, false, false), name)).rejects.toThrow()
    const optOut = skillSourceConformance((s) => rowsSource(s, false, false), { version: false })
    for (const c of optOut) await c.run()
  })

  test('a list() with content fails', async () => {
    await expect(
      run((skills) => ({ ...rowsSource(skills), list: () => skills as never }), 'list returns'),
    ).rejects.toThrow()
  })
})
