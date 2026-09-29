import { describe, expect, test } from 'bun:test'
import type { HarnessWarning } from '../errors.ts'
import type { HarnessContext, HarnessHooks } from '../plugin/types.ts'
import type { SkillDoc, SkillMeta, SkillSource } from '../registry/types.ts'
import type { HookRunner } from '../session/hooks.ts'
import { buildSessionSkills, resolveTurnSkills } from './registry.ts'
import {
  createSkillTools,
  formatSkillDoc,
  formatSkillFile,
  loadSkillText,
  NO_SKILLS_MATCH,
  readSkillFileText,
  type SkillToolDeps,
  searchSkillsText,
} from './tools.ts'

const ctx = (owner: string) => ({ plugin: { name: owner } }) as unknown as HarnessContext

function hookRunner(hooks: Array<{ owner: string; fn: HarnessHooks['skill.load'] }>): HookRunner {
  return {
    list: ((name: string) => (name === 'skill.load' ? hooks : [])) as HookRunner['list'],
    has: (name) => name === 'skill.load' && hooks.length > 0,
  }
}

async function deps(
  sources: Array<{ owner?: string; source: SkillSource }>,
  options: { hooks?: Parameters<typeof hookRunner>[0]; limit?: number } = {},
): Promise<SkillToolDeps & { warnings: HarnessWarning[] }> {
  const warnings: HarnessWarning[] = []
  const warn = (w: HarnessWarning) => warnings.push(w)
  const session = buildSessionSkills(
    [],
    sources.map((s) => ({ owner: s.owner ?? 'app', source: s.source })),
    ['app', 'p'],
    options.limit,
  )
  const skills = await resolveTurnSkills({ skills: session, contextOf: ctx, warn })
  return { skills, hooks: hookRunner(options.hooks ?? []), contextOf: ctx, warn, warnings }
}

const doc = (over: Partial<SkillDoc> = {}): SkillDoc => ({
  name: 'pine-v6',
  description: 'Pine v6.',
  content: '# Pine\n\nUse reference.md.\n',
  manifest: [],
  ...over,
})

function memory(
  id: string,
  docs: SkillDoc[],
  files: Record<string, string> = {},
  over: Partial<SkillSource> = {},
): SkillSource & { reads: string[] } {
  const src = {
    id,
    reads: [] as string[],
    list: (): SkillMeta[] => docs.map(({ name, description }) => ({ name, description })),
    load: (name: string) => docs.find((d) => d.name === name) ?? null,
    readFile: (name: string, path: string) => {
      src.reads.push(`${name}:${path}`)
      const text = files[`${name}:${path}`]
      return text === undefined ? null : { type: 'text' as const, text }
    },
    ...over,
  }
  return src
}

describe('formatSkillDoc', () => {
  test('frontmatter summary, body, sorted Files list, notes', () => {
    const text = formatSkillDoc(
      'pine-v6',
      doc({
        meta: { license: 'MIT', tags: ['a', 'b'], name: 'ignored' },
        manifest: [
          { path: 'scripts/check.py', size: 120 },
          { path: 'reference.md' },
          { path: '../evil' },
          { path: 'SKILL.md' },
          { path: 'reference.md', size: 3 },
          { nope: 1 } as never,
        ],
      }),
      ['Executable copy: /skills/pine-v6 (sandbox).', '  '],
    )
    expect(text).toBe(
      [
        '---',
        'name: pine-v6',
        'description: Pine v6.',
        'license: MIT',
        'tags: [a, b]',
        '---',
        '# Pine',
        '',
        'Use reference.md.',
        '',
        'Files:',
        '- reference.md',
        '- scripts/check.py (120 bytes)',
        '',
        'Executable copy: /skills/pine-v6 (sandbox).',
      ].join('\n'),
    )
  })

  test('no Files section without files', () => {
    expect(formatSkillDoc('a', doc({ content: '' }), [])).toBe(
      '---\nname: a\ndescription: Pine v6.\n---',
    )
  })
})

test('formatSkillFile', () => {
  expect(formatSkillFile({ type: 'text', text: 'hello' })).toBe('hello')
  expect(
    formatSkillFile({ type: 'binary', mediaType: 'image/png', data: new Uint8Array(12) }),
  ).toBe('[binary image/png, 12 bytes]')
})

describe('load_skill', () => {
  test('not found: unknown to the turn or null from the source', async () => {
    const d = await deps([
      {
        source: memory('db', [doc()], {}, { load: () => null }),
      },
    ])
    expect(await loadSkillText(d, 'missing')).toBe('ERROR: skill "missing" not found')
    expect(await loadSkillText(d, 'pine-v6')).toBe('ERROR: skill "pine-v6" not found')
  })

  test('source failures become ERROR strings', async () => {
    const throwing = await deps([
      {
        source: memory(
          'db',
          [doc()],
          {},
          {
            load: () => {
              throw new Error('timeout')
            },
          },
        ),
      },
    ])
    expect(await loadSkillText(throwing, 'pine-v6')).toBe(
      'ERROR: skill "pine-v6" could not be loaded: timeout',
    )
    const invalid = await deps([
      { source: memory('db', [doc()], {}, { load: () => ({ name: 'x' }) as never }) },
    ])
    expect(await loadSkillText(invalid, 'pine-v6')).toContain('invalid document')
  })

  test('skill.load hooks: chain in order, replace doc, add notes, failing hook skipped', async () => {
    const seen: string[] = []
    const d = await deps([{ owner: 'p', source: memory('db', [doc()]) }], {
      hooks: [
        {
          owner: 'app',
          fn: (c, e) => {
            seen.push(`${c.plugin.name}:${e.source}:${e.skill.name}`)
            return { skill: { ...e.skill, content: 'Replaced body.' }, notes: ['First note.'] }
          },
        },
        {
          owner: 'p',
          fn: () => {
            throw new Error('boom')
          },
        },
        { owner: 'p', fn: (_c, e) => ({ notes: [`Saw: ${e.skill.content}`, 42 as never] }) },
        { owner: 'p', fn: () => ({ skill: { bad: true } as never }) },
        { owner: 'p', fn: () => undefined },
      ],
    })
    const text = await loadSkillText(d, 'pine-v6')
    expect(text).toBe(
      '---\nname: pine-v6\ndescription: Pine v6.\n---\nReplaced body.\n\nFirst note.\n\nSaw: Replaced body.',
    )
    expect(seen).toEqual(['app:db:pine-v6'])
    expect(d.warnings.map((w) => [w.code, w.details?.hook])).toEqual([
      ['W_HOOK_FAILED', 'skill.load'],
      ['W_HOOK_FAILED', 'skill.load'],
    ])
  })

  test('a doc without description uses the listed one', async () => {
    const d = await deps([
      {
        source: memory(
          'db',
          [doc()],
          {},
          { load: () => ({ content: 'x', manifest: [] }) as never },
        ),
      },
    ])
    expect(await loadSkillText(d, 'pine-v6')).toBe(
      '---\nname: pine-v6\ndescription: Pine v6.\n---\nx',
    )
  })
})

describe('read_skill_file', () => {
  test('reads text and binary files', async () => {
    const bin = memory(
      'bin',
      [doc({ name: 'img' })],
      {},
      {
        readFile: () => ({
          type: 'binary',
          mediaType: 'image/png',
          data: new Uint8Array([1, 2, 3]),
        }),
      },
    )
    const d = await deps([
      { source: memory('db', [doc()], { 'pine-v6:reference.md': 'REF' }) },
      { source: bin },
    ])
    expect(await readSkillFileText(d, 'pine-v6', 'reference.md')).toBe('REF')
    expect(await readSkillFileText(d, 'pine-v6', './reference.md')).toBe('REF')
    expect(await readSkillFileText(d, 'img', 'a.png')).toBe('[binary image/png, 3 bytes]')
  })

  test('errors: unknown skill, missing file, throwing and invalid results', async () => {
    const d = await deps([
      { source: memory('db', [doc()]) },
      {
        source: memory(
          't',
          [doc({ name: 'thrower' })],
          {},
          {
            readFile: () => {
              throw new Error('io')
            },
          },
        ),
      },
      {
        source: memory(
          'w',
          [doc({ name: 'weird' })],
          {},
          { readFile: () => ({ type: 'x' }) as never },
        ),
      },
    ])
    expect(await readSkillFileText(d, 'nope', 'a.md')).toBe('ERROR: skill "nope" not found')
    expect(await readSkillFileText(d, 'pine-v6', 'a.md')).toBe(
      'ERROR: file "a.md" not found in skill "pine-v6"',
    )
    expect(await readSkillFileText(d, 'thrower', 'a.md')).toBe(
      'ERROR: file "a.md" of skill "thrower" could not be read: io',
    )
    expect(await readSkillFileText(d, 'weird', 'a.md')).toContain('invalid result')
  })

  test('no invalid path ever reaches SkillSource.readFile (spy)', async () => {
    const src = memory('db', [doc()], { 'pine-v6:ok.md': 'ok' })
    const d = await deps([{ source: src }])
    const invalid = [
      '../x',
      '/etc/passwd',
      'a/../../b',
      'a\\b',
      'a\u0000b',
      '',
      'a//b',
      'a/',
      'SKILL.md',
      './SKILL.md',
      'x'.repeat(513),
    ]
    for (const path of invalid) {
      expect(await readSkillFileText(d, 'pine-v6', path)).toStartWith('ERROR: invalid path')
    }
    const [, readTool] = createSkillTools(d)
    for (const path of invalid) {
      const out = await readTool?.tool.execute?.({ name: 'pine-v6', path }, {
        toolCallId: 'c',
        messages: [],
      } as never)
      expect(out).toStartWith('ERROR: invalid path')
    }
    expect(src.reads).toEqual([])
    expect(await readSkillFileText(d, 'pine-v6', './ok.md')).toBe('ok')
    expect(src.reads).toEqual(['pine-v6:ok.md'])
  })
})

describe('search_skills', () => {
  const docs = [
    doc({ name: 'pine-v6', description: 'Pine Script v6 syntax. Use when writing Pine.' }),
    doc({ name: 'python-lint', description: 'Lint Python code.' }),
    doc({ name: 'pdf-forms', description: 'Fill PDF forms.' }),
  ]

  test('core token matcher: case-insensitive, ranked by matching tokens, then name', async () => {
    const d = await deps([{ source: memory('db', docs) }])
    expect(await searchSkillsText(d, 'PINE syntax')).toBe(
      '- pine-v6: Pine Script v6 syntax. Use when writing Pine.',
    )
    expect(await searchSkillsText(d, 'python pdf')).toBe(
      '- pdf-forms: Fill PDF forms.\n- python-lint: Lint Python code.',
    )
    expect(await searchSkillsText(d, 'code python')).toBe('- python-lint: Lint Python code.')
    expect(await searchSkillsText(d, 'rust')).toBe(NO_SKILLS_MATCH)
    expect(await searchSkillsText(d, '  ')).toBe(NO_SKILLS_MATCH)
  })

  test('at most 10 matches', async () => {
    const many = Array.from({ length: 15 }, (_, i) =>
      doc({ name: `skill-${String(i).padStart(2, '0')}`, description: 'Common topic.' }),
    )
    const d = await deps([{ source: memory('db', many) }])
    const lines = (await searchSkillsText(d, 'common')).split('\n')
    expect(lines).toHaveLength(10)
    expect(lines[0]).toBe('- skill-00: Common topic.')
  })

  test('sources with search() are asked; results limited to their own resolved skills', async () => {
    const queries: string[] = []
    const searchable = memory(
      'remote',
      docs,
      {},
      {
        search: (query) => {
          queries.push(query)
          return [
            { name: 'pdf-forms', description: 'ignored' },
            { name: 'pdf-forms', description: 'dup' },
            { name: 'unknown', description: 'not listed' },
            { name: 'other', description: 'from another source' },
            null as never,
          ]
        },
      },
    )
    const other = memory('local', [doc({ name: 'other', description: 'Semantic stuff.' })])
    const d = await deps([{ source: searchable }, { source: other }])
    expect(await searchSkillsText(d, 'semantic')).toBe(
      '- pdf-forms: Fill PDF forms.\n- other: Semantic stuff.',
    )
    expect(queries).toEqual(['semantic'])
  })

  test('a failing search() falls back to the core matcher with a warning', async () => {
    const broken = memory(
      'remote',
      docs,
      {},
      {
        search: () => {
          throw new Error('offline')
        },
      },
    )
    const d = await deps([{ source: broken }])
    expect(await searchSkillsText(d, 'pdf')).toBe('- pdf-forms: Fill PDF forms.')
    expect(d.warnings.map((w) => w.code)).toEqual(['W_SKILL_SOURCE_FAILED'])
  })
})

describe('createSkillTools', () => {
  test('none without skills; load/read in index mode; + search_skills in search mode', async () => {
    expect(createSkillTools(await deps([]))).toEqual([])
    const index = createSkillTools(await deps([{ source: memory('db', [doc()]) }]))
    expect(index.map((t) => t.name)).toEqual(['load_skill', 'read_skill_file'])
    const search = createSkillTools(await deps([{ source: memory('db', [doc()]) }], { limit: 0 }))
    expect(search.map((t) => t.name)).toEqual(['load_skill', 'read_skill_file', 'search_skills'])
  })

  test('tools validate their input and return strings', async () => {
    const d = await deps([{ source: memory('db', [doc()], { 'pine-v6:a.md': 'A' }) }], {
      limit: 0,
    })
    const [load, read, search] = createSkillTools(d)
    const run = (t: typeof load, input: unknown) =>
      t?.tool.execute?.(input, { toolCallId: 'c', messages: [] } as never)
    expect(await run(load, {})).toBe('ERROR: `name` must be a string')
    expect(await run(read, { name: 'pine-v6' })).toBe('ERROR: `path` must be a string')
    expect(await run(read, { path: 'a.md' })).toBe('ERROR: `name` must be a string')
    expect(await run(search, null)).toBe('ERROR: `query` must be a string')
    expect(await run(load, { name: 'pine-v6' })).toStartWith('---\nname: pine-v6')
    expect(await run(read, { name: 'pine-v6', path: 'a.md' })).toBe('A')
    expect(await run(search, { query: 'pine' })).toBe('- pine-v6: Pine v6.')
  })
})
