import { describe, expect, test } from 'bun:test'
import { type HarnessContext, type HarnessWarning, isHarnessError, type Skill } from '../index.ts'
import { skillSourceConformance } from '../testing/skill-source.conformance.ts'
import { memoryFs } from './memory.ts'
import { fsSkillSource } from './skill-source.ts'
import type { FileSystem } from './types.ts'

/** `SKILL.md` text of a skill (frontmatter values as JSON strings, a valid YAML subset). */
function skillMarkdown(skill: Skill): string {
  const lines = [`name: ${skill.name}`, `description: ${JSON.stringify(skill.description)}`]
  if (skill.version !== undefined) lines.push(`version: ${skill.version}`)
  for (const [key, value] of Object.entries(skill.meta ?? {})) {
    lines.push(`${key}: ${JSON.stringify(value)}`)
  }
  return `---\n${lines.join('\n')}\n---\n${skill.content}`
}

function seed(skills: readonly Skill[], root = '/skills'): Record<string, string> {
  const files: Record<string, string> = {}
  for (const skill of skills) {
    files[`${root}/${skill.name}/SKILL.md`] = skillMarkdown(skill)
    for (const file of skill.files ?? []) files[`${root}/${skill.name}/${file.path}`] = file.content
  }
  return files
}

function context(warnings: HarnessWarning[] = []): HarnessContext {
  return { warn: (w: HarnessWarning) => warnings.push(w) } as unknown as HarnessContext
}

describe('fsSkillSource conformance (spec 07 §3)', () => {
  for (const c of skillSourceConformance((skills) =>
    fsSkillSource(memoryFs({ ...seed(skills), '/other.md': 'x' }), { root: '/skills' }),
  )) {
    test(c.name, c.run)
  }
})

describe('fsSkillSource conformance with root /', () => {
  for (const c of skillSourceConformance((skills) =>
    fsSkillSource(memoryFs(seed(skills, '')), { root: '/', refresh: 'turn' }),
  )) {
    test(c.name, c.run)
  }
})

const valid = (name: string, description = `Skill ${name}.`) =>
  `---\nname: ${name}\ndescription: ${description}\n---\nBody of ${name}.\n`

describe('fsSkillSource', () => {
  test('id, refresh, locate and root normalization', () => {
    const source = fsSkillSource(memoryFs(), { root: 'skills/', refresh: 'turn' })
    expect(source.id).toBe('fs:/skills')
    expect(source.refresh).toBe('turn')
    expect(source.locate?.('pine-v6', context())).toEqual({
      service: 'fs',
      root: '/skills/pine-v6',
    })
    expect(source.locate?.('../x', context())).toBeNull()
    expect(fsSkillSource(memoryFs(), { root: '/s' }).refresh).toBe('session')
  })

  test('invalid options throw EH_CONFIG_INVALID', () => {
    for (const opts of [{ root: '/../x' }, { root: '' }, { root: '/s', refresh: 'always' }]) {
      let error: unknown
      try {
        fsSkillSource(memoryFs(), opts as never)
      } catch (e) {
        error = e
      }
      expect(isHarnessError(error, 'EH_CONFIG_INVALID')).toBe(true)
    }
  })

  test('lists one level deep and skips invalid or mismatched SKILL.md with W_INVALID_SKILL', async () => {
    const warnings: HarnessWarning[] = []
    const fs = memoryFs({
      '/skills/good/SKILL.md': valid('good'),
      '/skills/good/nested/SKILL.md': valid('nested'),
      '/skills/broken/SKILL.md': '---\nname: broken\n',
      '/skills/renamed/SKILL.md': valid('other-name'),
      '/skills/README.md': 'not a skill',
      '/elsewhere/x/SKILL.md': valid('x'),
    })
    const source = fsSkillSource(fs, { root: '/skills', refresh: 'turn' })
    const ctx = context(warnings)
    expect(await source.list(ctx)).toEqual([{ name: 'good', description: 'Skill good.' }])
    expect(warnings.map((w) => [w.code, w.details])).toEqual([
      ['W_INVALID_SKILL', { source: 'fs:/skills', path: '/skills/broken/SKILL.md' }],
      ['W_INVALID_SKILL', { source: 'fs:/skills', path: '/skills/renamed/SKILL.md' }],
    ])
    expect(warnings[1]?.message).toContain('does not match its directory "renamed"')
    // once per file version
    await source.list(ctx)
    expect(warnings).toHaveLength(2)
    await fs.write('/skills/broken/SKILL.md', '---\nname: [\n---\n')
    await source.list(ctx)
    expect(warnings).toHaveLength(3)
    // a deleted file is forgotten: the same broken content warns again when it comes back
    const broken = (await fs.read('/skills/broken/SKILL.md'))?.content as string
    await fs.delete('/skills/broken/SKILL.md')
    await source.list(ctx)
    await fs.write('/skills/broken/SKILL.md', broken)
    await source.list(ctx)
    expect(warnings).toHaveLength(4)
    // a fixed file appears
    await fs.write('/skills/broken/SKILL.md', valid('broken'))
    expect((await source.list(ctx)).map((m) => m.name)).toEqual(['broken', 'good'])
  })

  test('caches parsed frontmatter by version: unchanged files are not read again', async () => {
    const inner = memoryFs({ '/skills/a/SKILL.md': valid('a'), '/skills/b/SKILL.md': valid('b') })
    const reads: string[] = []
    const fs: FileSystem = {
      ...inner,
      read: (path) => {
        reads.push(path)
        return inner.read(path)
      },
    }
    const source = fsSkillSource(fs, { root: '/skills', refresh: 'turn' })
    await source.list(context())
    await source.list(context())
    expect(reads).toEqual(['/skills/a/SKILL.md', '/skills/b/SKILL.md'])
    await inner.write('/skills/b/SKILL.md', valid('b', 'Changed.'))
    expect((await source.list(context())).map((m) => m.description)).toEqual([
      'Skill a.',
      'Changed.',
    ])
    expect(reads).toHaveLength(3)
  })

  test('load: body, meta, sorted manifest with UTF-8 sizes; errors and unknown names', async () => {
    const fs = memoryFs({
      '/skills/pine/SKILL.md': '---\nname: pine\ndescription: Pine.\nlicense: MIT\n---\n\n# Pine\n',
      '/skills/pine/z.md': 'ø',
      '/skills/pine/a/b.md': 'ab',
      '/skills/broken/SKILL.md': '---\nname: broken\ndescription: [x\n---\n',
      '/skills/renamed/SKILL.md': valid('other'),
    })
    const source = fsSkillSource(fs, { root: '/skills' })
    expect(await source.load('pine', context())).toEqual({
      name: 'pine',
      description: 'Pine.',
      meta: { license: 'MIT' },
      content: '# Pine\n',
      manifest: [
        { path: 'a/b.md', size: 2 },
        { path: 'z.md', size: 2 },
      ],
    })
    expect(await source.load('missing', context())).toBeNull()
    expect(await source.load('../pine', context())).toBeNull()
    expect(await source.load('renamed', context())).toBeNull()
    await expect(Promise.resolve(source.load('broken', context()))).rejects.toThrow(
      'invalid SKILL.md',
    )
  })

  test('readFile re-validates paths and never escapes the skill', async () => {
    const fs = memoryFs({
      '/skills/pine/SKILL.md': valid('pine'),
      '/skills/pine/ref.md': 'ref',
      '/skills/secret.md': 'secret',
      '/secret.md': 'secret',
    })
    const source = fsSkillSource(fs, { root: '/skills' })
    const read = (name: string, path: string) => source.readFile(name, path, context())
    expect(await read('pine', 'ref.md')).toEqual({ type: 'text', text: 'ref' })
    expect(await read('pine', './ref.md')).toEqual({ type: 'text', text: 'ref' })
    expect(await read('pine', '../secret.md')).toBeNull()
    expect(await read('pine', '/secret.md')).toBeNull()
    expect(await read('pine', 'SKILL.md')).toBeNull()
    expect(await read('..', 'secret.md')).toBeNull()
    expect(await read('pine', 'missing.md')).toBeNull()
  })

  test('readFile returns binary assets as bytes when the adapter has readBytes', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2])
    const fs = memoryFs({
      '/skills/pine/SKILL.md': valid('pine'),
      '/skills/pine/ref.md': 'ref',
      '/skills/pine/logo.png': png,
      '/skills/pine/blob.dat': new Uint8Array([0xff, 0xfe, 0, 1]),
    })
    const source = fsSkillSource(fs, { root: '/skills' })
    const read = (path: string) => source.readFile('pine', path, context())
    expect(await read('ref.md')).toEqual({ type: 'text', text: 'ref' })
    expect(await read('logo.png')).toEqual({ type: 'binary', mediaType: 'image/png', data: png })
    expect(await read('blob.dat')).toEqual({
      type: 'binary',
      mediaType: 'application/octet-stream',
      data: new Uint8Array([0xff, 0xfe, 0, 1]),
    })
  })
})
