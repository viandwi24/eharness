import { describe, expect, test } from 'bun:test'
import { isHarnessError } from '../errors.ts'
import type { Skill, SkillSource } from '../registry/types.ts'
import { defineSkill, defineSkillSource, skillMetaError, skillNameError } from './define.ts'
import { staticSkillSource } from './static-source.ts'

const throwsInvalid = (fn: () => unknown, text?: string) => {
  try {
    fn()
  } catch (error) {
    expect(isHarnessError(error, 'EH_CONFIG_INVALID')).toBe(true)
    if (text !== undefined) expect((error as Error).message).toContain(text)
    return
  }
  throw new Error('expected EH_CONFIG_INVALID')
}

const skill = (over: Partial<Skill> = {}): Skill => ({
  name: 'pine-v6',
  description: 'Pine v6. Use when writing Pine.',
  content: 'Body',
  ...over,
})

describe('skill names (spec 07 §1)', () => {
  test('valid and invalid names', () => {
    for (const name of ['a', 'pine-v6', 'a1-b2-c3', '404', 'a'.repeat(64)]) {
      expect(skillNameError(name)).toBeUndefined()
    }
    for (const name of ['', 'A', 'a_b', '-a', 'a-', 'a--b', 'a b', 'a.b', 'a'.repeat(65), 1]) {
      expect(skillNameError(name)).toBeString()
    }
  })

  test('skillMetaError', () => {
    expect(skillMetaError({ name: 'a', description: 'd' })).toBeUndefined()
    expect(skillMetaError({ name: 'a', description: 'd', meta: { x: 1 } })).toBeUndefined()
    expect(skillMetaError(null)).toBeString()
    expect(skillMetaError([])).toBeString()
    expect(skillMetaError({ name: 'a' })).toBeString()
    expect(skillMetaError({ name: 'a', description: '   ' })).toBeString()
    expect(skillMetaError({ name: 'a', description: 'x'.repeat(1025) })).toBeString()
    expect(skillMetaError({ name: 'a', description: 'd', meta: [] })).toBeString()
  })
})

describe('defineSkill', () => {
  test('returns the skill unchanged', () => {
    const s = skill({ files: [{ path: 'scripts/a.py', content: 'x' }], meta: { license: 'MIT' } })
    expect(defineSkill(s)).toBe(s)
  })

  test('validates name, description, content, meta and files', () => {
    throwsInvalid(() => defineSkill(null as unknown as Skill))
    throwsInvalid(() => defineSkill(skill({ name: 'Bad' })), 'must match')
    throwsInvalid(() => defineSkill(skill({ description: '' })), 'empty')
    throwsInvalid(() => defineSkill(skill({ content: 1 as unknown as string })), 'content')
    throwsInvalid(() => defineSkill(skill({ meta: [] as unknown as Record<string, unknown> })))
    throwsInvalid(() => defineSkill(skill({ files: {} as unknown as Skill['files'] })))
    throwsInvalid(() => defineSkill(skill({ files: [{ path: '../x', content: '' }] })), '..')
    throwsInvalid(() => defineSkill(skill({ files: [{ path: 'SKILL.md', content: '' }] })))
    throwsInvalid(() => defineSkill(skill({ files: [{ path: './a', content: '' }] })), 'normalized')
    throwsInvalid(
      () =>
        defineSkill(
          skill({
            files: [
              { path: 'a', content: '' },
              { path: 'a', content: '' },
            ],
          }),
        ),
      'twice',
    )
    throwsInvalid(() => defineSkill(skill({ files: [{ path: 'a' } as never] })))
  })
})

describe('defineSkillSource', () => {
  const src = (over: Partial<SkillSource> = {}): SkillSource => ({
    id: 'db:x',
    list: () => [],
    load: () => null,
    readFile: () => null,
    ...over,
  })

  test('returns the source unchanged', () => {
    const s = src({ refresh: 'turn', search: () => [], locate: () => null })
    expect(defineSkillSource(s)).toBe(s)
  })

  test('validates the shape', () => {
    throwsInvalid(() => defineSkillSource(null as unknown as SkillSource))
    throwsInvalid(() => defineSkillSource(src({ id: '' })), 'id')
    throwsInvalid(() => defineSkillSource(src({ list: 1 as never })), 'list')
    throwsInvalid(() => defineSkillSource(src({ load: undefined as never })), 'load')
    throwsInvalid(() => defineSkillSource(src({ readFile: undefined as never })), 'readFile')
    throwsInvalid(() => defineSkillSource(src({ search: 'x' as never })), 'search')
    throwsInvalid(() => defineSkillSource(src({ locate: 1 as never })), 'locate')
    throwsInvalid(() => defineSkillSource(src({ refresh: 'always' as never })), 'refresh')
  })
})

describe('staticSkillSource', () => {
  const source = staticSkillSource('static:app', [
    skill({
      meta: { license: 'MIT' },
      files: [
        { path: 'z.md', content: 'zz' },
        { path: 'a/é.txt', content: 'é' },
      ],
    }),
    skill({ name: 'other', description: 'Other.' }),
  ])

  test('list, load, readFile', async () => {
    expect(await source.list({} as never)).toEqual([
      { name: 'pine-v6', description: 'Pine v6. Use when writing Pine.', meta: { license: 'MIT' } },
      { name: 'other', description: 'Other.' },
    ])
    expect(await source.load('pine-v6', {} as never)).toEqual({
      name: 'pine-v6',
      description: 'Pine v6. Use when writing Pine.',
      meta: { license: 'MIT' },
      content: 'Body',
      manifest: [
        { path: 'a/é.txt', size: 2 },
        { path: 'z.md', size: 2 },
      ],
    })
    expect(await source.load('missing', {} as never)).toBeNull()
    expect(await source.readFile('pine-v6', 'z.md', {} as never)).toEqual({
      type: 'text',
      text: 'zz',
    })
    expect(await source.readFile('pine-v6', 'nope', {} as never)).toBeNull()
    expect(await source.readFile('other', 'z.md', {} as never)).toBeNull()
    expect(source.refresh).toBe('session')
  })

  test('returns copies', async () => {
    const first = (await source.list({} as never)) as Array<{ meta?: Record<string, unknown> }>
    ;(first[0]?.meta as Record<string, unknown>).license = 'changed'
    const second = (await source.list({} as never)) as Array<{ meta?: Record<string, unknown> }>
    expect(second[0]?.meta).toEqual({ license: 'MIT' })
  })
})
