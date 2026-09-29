import type { HarnessContext, Skill, SkillDoc, SkillMeta, SkillSource } from '../index.ts'
import { validateSkillPath } from '../index.ts'
import { assertJsonEqual, assertTrue } from './assert.ts'
import type { ConformanceCase } from './types.ts'

/** Options of {@link skillSourceConformance}. */
export interface SkillSourceConformanceOptions {
  /** Context passed to every source call. Default: a minimal stub (`agent`, `session`, `plugin`, `runtime`, `log`, `signal`). */
  context?: HarnessContext
  /** Check that extra frontmatter (`meta.license`) survives `load()`. Default true. */
  meta?: boolean
}

/**
 * The skills every source under test must serve (the factory receives them). Content uses
 * nested directories and non-ASCII text.
 */
export const SKILL_SOURCE_FIXTURE: readonly Skill[] = [
  {
    name: 'pine-v6',
    description: 'Pine Script v6 syntax and pitfalls. Use when writing Pine.',
    content: '# Pine v6\n\nRead reference.md before answering.\n',
    meta: { license: 'MIT' },
    files: [
      { path: 'reference.md', content: '# Reference\n\nplot(close) ✓\n' },
      { path: 'scripts/check.py', content: 'print("ok")\n' },
      { path: 'docs/deep/notes.txt', content: 'ø — ünïcødé\n' },
    ],
  },
  {
    name: 'plain-notes',
    description: 'Notes without supporting files. Use for plain notes.',
    content: 'Just notes.\n',
  },
]

const encoder = new TextEncoder()

function stubContext(): HarnessContext {
  const noop = () => {}
  return {
    agent: { id: 'conformance' },
    session: { id: 'conformance' },
    plugin: { name: 'app' },
    turn: undefined,
    step: undefined,
    services: {},
    stream: { active: false, data: noop, write: noop },
    state: { get: () => undefined, set: noop },
    runtime: {},
    log: { debug: noop, info: noop, warn: noop, error: noop },
    signal: new AbortController().signal,
  } as HarnessContext
}

const byName = <T extends { name: string }>(list: readonly T[]): T[] =>
  [...list].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))

/**
 * Conformance cases for a {@link SkillSource} (spec 07 §3, §5). The factory receives the fixture
 * skills ({@link SKILL_SOURCE_FIXTURE}) and returns a source serving exactly them (seed a
 * database, write `SKILL.md` files, …).
 *
 * Checks: a non-empty `id` and a valid `refresh`; `list()` returns metadata only (names and
 * descriptions of the fixture); `load()` returns the body and a manifest of every supporting file
 * (relative, valid paths, never `SKILL.md`, sizes in UTF-8 bytes when given) or `null`;
 * `readFile()` returns the exact text or `null` (unknown skill, unknown path, a file of another
 * skill); results are copies; `search()` and `locate()`, when implemented, return well-formed
 * values. Bodies are compared with surrounding whitespace trimmed.
 *
 * @example
 * ```ts
 * for (const c of skillSourceConformance((skills) => dbSkillSource(seed(db, skills))))
 *   test(c.name, c.run)
 * ```
 * @see docs/specs/07-skills.md#3-dynamic-skills--skillsource
 */
export function skillSourceConformance(
  factory: (skills: readonly Skill[]) => SkillSource | Promise<SkillSource>,
  options: SkillSourceConformanceOptions = {},
): ConformanceCase[] {
  const ctx = options.context ?? stubContext()
  const make = async () => factory(structuredClone(SKILL_SOURCE_FIXTURE) as Skill[])
  const [pine, plain] = SKILL_SOURCE_FIXTURE as [Skill, Skill]
  const load = async (source: SkillSource, name: string): Promise<SkillDoc> => {
    const doc = await source.load(name, ctx)
    assertTrue(doc !== null && typeof doc === 'object', `load('${name}') returned ${String(doc)}`)
    return doc as SkillDoc
  }

  return [
    {
      name: 'has a non-empty id and a valid refresh',
      run: async () => {
        const source = await make()
        assertTrue(typeof source.id === 'string' && source.id.length > 0, 'id must be non-empty')
        assertTrue(
          source.refresh === undefined || source.refresh === 'session' || source.refresh === 'turn',
          `invalid refresh ${String(source.refresh)}`,
        )
      },
    },
    {
      name: 'list returns the metadata of every skill, without content',
      run: async () => {
        const source = await make()
        const listed = await source.list(ctx)
        assertTrue(Array.isArray(listed), 'list() must return an array')
        assertJsonEqual(
          byName(listed).map((m) => ({ name: m.name, description: m.description })),
          byName(SKILL_SOURCE_FIXTURE).map((s) => ({ name: s.name, description: s.description })),
          'list()',
        )
        for (const meta of listed) {
          assertTrue(!('content' in meta), `list() must not return content (${meta.name})`)
          assertTrue(!('manifest' in meta), `list() must not return a manifest (${meta.name})`)
        }
      },
    },
    {
      name: 'load returns the body and the manifest of every supporting file',
      run: async () => {
        const source = await make()
        const doc = await load(source, pine.name)
        assertJsonEqual(doc.name, pine.name, 'load().name')
        assertJsonEqual(doc.description, pine.description, 'load().description')
        assertJsonEqual(doc.content.trim(), pine.content.trim(), 'load().content')
        assertTrue(Array.isArray(doc.manifest), 'load().manifest must be an array')
        const paths = doc.manifest.map((f) => f.path).sort()
        assertJsonEqual(paths, (pine.files ?? []).map((f) => f.path).sort(), 'manifest paths')
        for (const file of doc.manifest) {
          const checked = validateSkillPath(file.path)
          assertTrue(checked.ok && checked.path === file.path, `invalid manifest path ${file.path}`)
          if (file.size !== undefined) {
            const expected = (pine.files ?? []).find((f) => f.path === file.path)?.content ?? ''
            assertJsonEqual(file.size, encoder.encode(expected).byteLength, `size of ${file.path}`)
          }
        }
      },
    },
    {
      name: 'load of a skill without files has an empty manifest',
      run: async () => {
        const source = await make()
        const doc = await load(source, plain.name)
        assertJsonEqual(doc.content.trim(), plain.content.trim(), 'load().content')
        assertJsonEqual(doc.manifest, [], 'manifest')
      },
    },
    {
      name: 'load preserves extra frontmatter in meta',
      run: async () => {
        if (options.meta === false) return
        const source = await make()
        const doc = await load(source, pine.name)
        assertJsonEqual(doc.meta?.license, 'MIT', 'load().meta.license')
      },
    },
    {
      name: 'load returns null for an unknown skill',
      run: async () => {
        const source = await make()
        assertJsonEqual(await source.load('no-such-skill', ctx), null, "load('no-such-skill')")
      },
    },
    {
      name: 'readFile returns the exact text of every supporting file',
      run: async () => {
        const source = await make()
        for (const file of pine.files ?? []) {
          const content = await source.readFile(pine.name, file.path, ctx)
          assertJsonEqual(content, { type: 'text', text: file.content }, `readFile(${file.path})`)
        }
      },
    },
    {
      name: 'readFile returns null for unknown skills, unknown paths and files of other skills',
      run: async () => {
        const source = await make()
        assertJsonEqual(await source.readFile(pine.name, 'missing.md', ctx), null, 'unknown path')
        assertJsonEqual(await source.readFile(pine.name, 'scripts', ctx), null, 'a directory')
        assertJsonEqual(
          await source.readFile('no-such-skill', 'reference.md', ctx),
          null,
          'unknown skill',
        )
        assertJsonEqual(
          await source.readFile(plain.name, 'reference.md', ctx),
          null,
          'file of another skill',
        )
      },
    },
    {
      name: 'returns copies (mutating a result does not change the source)',
      run: async () => {
        const source = await make()
        const listed = (await source.list(ctx)) as SkillMeta[]
        for (const meta of listed) meta.description = 'mutated'
        listed.length = 0
        const again = await source.list(ctx)
        assertJsonEqual(again.length, SKILL_SOURCE_FIXTURE.length, 'list() length after mutation')
        assertTrue(
          again.every((m) => m.description !== 'mutated'),
          'list() returned mutated data',
        )
        const doc = await load(source, pine.name)
        doc.content = 'mutated'
        doc.manifest.length = 0
        const reloaded = await load(source, pine.name)
        assertJsonEqual(reloaded.content.trim(), pine.content.trim(), 'content after mutation')
        assertJsonEqual(
          reloaded.manifest.length,
          pine.files?.length ?? 0,
          'manifest after mutation',
        )
      },
    },
    {
      name: 'search (when implemented) returns listed skills and finds a skill by name',
      run: async () => {
        const source = await make()
        if (typeof source.search !== 'function') return
        const found = await source.search('pine', ctx)
        assertTrue(Array.isArray(found), 'search() must return an array')
        const names = new Set(SKILL_SOURCE_FIXTURE.map((s) => s.name))
        for (const meta of found) {
          assertTrue(names.has(meta.name), `search() returned unknown skill ${meta.name}`)
          assertTrue(typeof meta.description === 'string', 'search() results need a description')
        }
        assertTrue(
          found.some((m) => m.name === pine.name),
          "search('pine') must find pine-v6",
        )
      },
    },
    {
      name: 'locate (when implemented) returns null or { service, root }',
      run: async () => {
        const source = await make()
        if (typeof source.locate !== 'function') return
        for (const name of [pine.name, 'no-such-skill']) {
          const location = await source.locate(name, ctx)
          assertTrue(
            location === null ||
              (typeof location === 'object' &&
                typeof location.service === 'string' &&
                typeof location.root === 'string'),
            `locate('${name}') must return null or { service, root }`,
          )
        }
      },
    },
  ]
}
