import { describe, expect, test } from 'bun:test'
import type { HarnessWarning } from '../errors.ts'
import type { HarnessContext } from '../plugin/types.ts'
import type { Skill, SkillMeta, SkillSource } from '../registry/types.ts'
import {
  buildSessionSkills,
  DEFAULT_SKILLS_INDEX_LIMIT,
  resolveTurnSkills,
  type SessionSkills,
  SKILLS_INDEX_INTRO,
  SKILLS_SEARCH_HINT,
  SKILLS_SEARCH_MORE_HINT,
} from './registry.ts'

const ctx = (owner: string) => ({ plugin: { name: owner } }) as unknown as HarnessContext

const skill = (name: string, description = `About ${name}.`): Skill => ({
  name,
  description,
  content: `Body of ${name}`,
})

function source(
  id: string,
  list: () => SkillMeta[] | Promise<SkillMeta[]>,
  over: Partial<SkillSource> = {},
): SkillSource & { calls: number } {
  const src = {
    id,
    calls: 0,
    list() {
      src.calls++
      return list()
    },
    load: () => null,
    readFile: () => null,
    ...over,
  }
  return src
}

async function resolve(skills: SessionSkills) {
  const warnings: HarnessWarning[] = []
  const turn = await resolveTurnSkills({ skills, contextOf: ctx, warn: (w) => warnings.push(w) })
  return { turn, warnings }
}

describe('buildSessionSkills', () => {
  test('orders per plugin: static skills first, then sources (spec 07 §6)', () => {
    const a = source('a', () => [])
    const b = source('b', () => [])
    const c = source('c', () => [])
    const built = buildSessionSkills(
      [
        { owner: 'p2', skill: skill('x') },
        { owner: 'app', skill: skill('y') },
        { owner: 'app', skill: skill('z') },
      ],
      [
        { owner: 'app', source: a },
        { owner: 'p1', source: b },
        { owner: 'p2', source: c },
      ],
      ['app', 'p1', 'p2'],
      undefined,
    )
    expect(built.sources.map((s) => [s.owner, s.source.id, s.static])).toEqual([
      ['app', 'static:app', true],
      ['app', 'a', false],
      ['p1', 'b', false],
      ['p2', 'static:p2', true],
      ['p2', 'c', false],
    ])
    expect(built.indexLimit).toBe(DEFAULT_SKILLS_INDEX_LIMIT)
  })

  test('tool presence is decided per session', () => {
    const dyn = source('db', () => [])
    const none = buildSessionSkills([], [], ['app'], undefined)
    expect([none.hasTools, none.hasSearch]).toEqual([false, false])
    const staticSmall = buildSessionSkills([{ owner: 'app', skill: skill('a') }], [], ['app'], 1)
    expect([staticSmall.hasTools, staticSmall.hasSearch]).toEqual([true, false])
    const staticLarge = buildSessionSkills(
      [
        { owner: 'app', skill: skill('a') },
        { owner: 'app', skill: skill('b') },
      ],
      [],
      ['app'],
      1,
    )
    expect([staticLarge.hasTools, staticLarge.hasSearch]).toEqual([true, true])
    const dynamic = buildSessionSkills([], [{ owner: 'app', source: dyn }], ['app'], undefined)
    expect([dynamic.hasTools, dynamic.hasSearch]).toEqual([true, true])
    const unlimited = buildSessionSkills(
      [],
      [{ owner: 'app', source: dyn }],
      ['app'],
      Number.POSITIVE_INFINITY,
    )
    expect([unlimited.hasTools, unlimited.hasSearch]).toEqual([true, false])
    expect(unlimited.indexLimit).toBe(Number.POSITIVE_INFINITY)
  })

  test('index limit: explicit values, invalid values fall back to the default', () => {
    expect(buildSessionSkills([], [], ['app'], 3).indexLimit).toBe(3)
    expect(buildSessionSkills([], [], ['app'], 0).indexLimit).toBe(0)
    expect(buildSessionSkills([], [], ['app'], -1).indexLimit).toBe(DEFAULT_SKILLS_INDEX_LIMIT)
    expect(buildSessionSkills([], [], ['app'], Number.NaN).indexLimit).toBe(
      DEFAULT_SKILLS_INDEX_LIMIT,
    )
  })
})

describe('resolveTurnSkills', () => {
  test('no skills: no text, mode none', async () => {
    const { turn } = await resolve(buildSessionSkills([], [], ['app'], undefined))
    expect(turn).toMatchObject({ mode: 'none', staticText: undefined, dynamicText: undefined })
    expect(turn.entries).toEqual([])
  })

  test('static index in block 1, sorted, whitespace collapsed', async () => {
    const skills = buildSessionSkills(
      [
        { owner: 'app', skill: skill('zeta', 'Last\n  one.') },
        { owner: 'app', skill: skill('alpha', 'First one.') },
      ],
      [],
      ['app'],
      undefined,
    )
    const { turn } = await resolve(skills)
    expect(turn.mode).toBe('index')
    expect(turn.staticText).toBe(
      `# Skills\n${SKILLS_INDEX_INTRO}\n- alpha: First one.\n- zeta: Last one.`,
    )
    expect(turn.dynamicText).toBeUndefined()
    expect(turn.entries).toEqual([
      { name: 'alpha', description: 'First one.', source: 'static:app' },
      { name: 'zeta', description: 'Last\n  one.', source: 'static:app' },
    ])
  })

  test('dynamic skills go to block 2 ("# More skills" after a static index)', async () => {
    const dyn = source('db', () => [{ name: 'beta', description: 'Beta.' }])
    const both = await resolve(
      buildSessionSkills(
        [{ owner: 'app', skill: skill('alpha') }],
        [{ owner: 'app', source: dyn }],
        ['app'],
        undefined,
      ),
    )
    expect(both.turn.staticText).toBe(`# Skills\n${SKILLS_INDEX_INTRO}\n- alpha: About alpha.`)
    expect(both.turn.dynamicText).toBe('# More skills\n- beta: Beta.')
    const only = await resolve(
      buildSessionSkills([], [{ owner: 'app', source: dyn }], ['app'], undefined),
    )
    expect(only.turn.staticText).toBeUndefined()
    expect(only.turn.dynamicText).toBe(`# Skills\n${SKILLS_INDEX_INTRO}\n- beta: Beta.`)
  })

  test('search mode above the limit; hint in block 2 when dynamic sources exist', async () => {
    const dyn = source('db', () => [
      { name: 'b', description: 'B.' },
      { name: 'c', description: 'C.' },
    ])
    const withDynamic = await resolve(
      buildSessionSkills(
        [{ owner: 'app', skill: skill('a') }],
        [{ owner: 'app', source: dyn }],
        ['app'],
        2,
      ),
    )
    expect(withDynamic.turn.mode).toBe('search')
    // block 1 keeps the static index; block 2 only points to search
    expect(withDynamic.turn.staticText).toBe(`# Skills\n${SKILLS_INDEX_INTRO}\n- a: About a.`)
    expect(withDynamic.turn.dynamicText).toBe(`# More skills\n${SKILLS_SEARCH_MORE_HINT}`)
    expect(withDynamic.turn.entries.map((e) => e.name)).toEqual(['a', 'b', 'c'])

    const staticOnly = await resolve(
      buildSessionSkills(
        [
          { owner: 'app', skill: skill('a') },
          { owner: 'app', skill: skill('b') },
        ],
        [],
        ['app'],
        1,
      ),
    )
    expect(staticOnly.turn.staticText).toBe(`# Skills\n${SKILLS_SEARCH_HINT}`)
    expect(staticOnly.turn.dynamicText).toBeUndefined()
    expect(SKILLS_SEARCH_HINT).not.toContain('\n')

    const dynamicOnly = await resolve(
      buildSessionSkills([], [{ owner: 'app', source: dyn }], ['app'], 1),
    )
    expect(dynamicOnly.turn.staticText).toBeUndefined()
    expect(dynamicOnly.turn.dynamicText).toBe(`# Skills\n${SKILLS_SEARCH_HINT}`)
  })

  test('block 1 never depends on dynamic listings', async () => {
    let rows: SkillMeta[] = []
    const dyn = source('db', () => rows, { refresh: 'turn' })
    const skills = buildSessionSkills(
      [
        { owner: 'app', skill: skill('a') },
        { owner: 'app', skill: skill('b') },
      ],
      [{ owner: 'app', source: dyn }],
      ['app'],
      3,
    )
    const texts: Array<string | undefined> = []
    for (const next of [
      [],
      [{ name: 'c', description: 'C.' }],
      [
        { name: 'c', description: 'C.' },
        { name: 'd', description: 'D.' },
      ],
      [{ name: 'a', description: 'Shadowed.' }],
    ]) {
      rows = next
      texts.push((await resolve(skills)).turn.staticText)
    }
    expect(new Set(texts).size).toBe(1)
  })

  test('first source wins; later duplicates are shadowed with W_SHADOWED', async () => {
    const first = source('first', () => [{ name: 'dup', description: 'From first.' }])
    const second = source('second', () => [
      { name: 'dup', description: 'From second.' },
      { name: 'dup', description: 'Twice.' },
      { name: 'own', description: 'Own.' },
    ])
    const { turn, warnings } = await resolve(
      buildSessionSkills(
        [{ owner: 'p', skill: skill('static-one') }],
        [
          { owner: 'app', source: first },
          { owner: 'p', source: second },
          { owner: 'p', source: source('late', () => [{ name: 'static-one', description: 'x' }]) },
        ],
        ['app', 'p'],
        undefined,
      ),
    )
    expect(turn.entries.map((e) => [e.name, e.source])).toEqual([
      ['dup', 'first'],
      ['own', 'second'],
      ['static-one', 'static:p'],
    ])
    expect(turn.sourceOf('dup')?.source.id).toBe('first')
    expect(turn.sourceOf('missing')).toBeUndefined()
    expect(warnings.map((w) => [w.code, w.details?.source, w.details?.skill])).toEqual([
      ['W_SHADOWED', 'second', 'dup'],
      ['W_SHADOWED', 'second', 'dup'],
      ['W_SHADOWED', 'late', 'static-one'],
    ])
  })

  test('static skills win over dynamic sources listed earlier (spec 02 §7)', async () => {
    const dyn = source('db', () => [{ name: 'x', description: 'Dynamic x.' }])
    const { turn, warnings } = await resolve(
      buildSessionSkills(
        [{ owner: 'p', skill: skill('x') }],
        [{ owner: 'app', source: dyn }],
        ['app', 'p'],
        undefined,
      ),
    )
    expect(turn.entries).toEqual([{ name: 'x', description: 'About x.', source: 'static:p' }])
    expect(turn.staticText).toBe(`# Skills\n${SKILLS_INDEX_INTRO}\n- x: About x.`)
    expect(turn.dynamicText).toBeUndefined()
    expect(warnings.map((w) => [w.code, w.details?.source, w.details?.winner])).toEqual([
      ['W_SHADOWED', 'db', 'static:p'],
    ])
  })

  test('invalid metadata is skipped with W_INVALID_SKILL', async () => {
    const bad = source('db', () => [
      { name: 'Bad Name', description: 'x' },
      { name: 'ok', description: '' },
      null as unknown as SkillMeta,
      { name: 'fine', description: 'Fine.', meta: { k: 1 } },
    ])
    const { turn, warnings } = await resolve(
      buildSessionSkills([], [{ owner: 'app', source: bad }], ['app'], undefined),
    )
    expect(turn.entries).toEqual([
      { name: 'fine', description: 'Fine.', meta: { k: 1 }, source: 'db' },
    ])
    expect(warnings.map((w) => w.code)).toEqual([
      'W_INVALID_SKILL',
      'W_INVALID_SKILL',
      'W_INVALID_SKILL',
    ])
  })

  test("refresh 'session' lists once; 'turn' lists every turn", async () => {
    const perSession = source('s', () => [{ name: 'a', description: 'A.' }])
    const perTurn = source('t', () => [{ name: 'b', description: 'B.' }], { refresh: 'turn' })
    const skills = buildSessionSkills(
      [],
      [
        { owner: 'app', source: perSession },
        { owner: 'app', source: perTurn },
      ],
      ['app'],
      undefined,
    )
    await resolve(skills)
    await resolve(skills)
    await resolve(skills)
    expect(perSession.calls).toBe(1)
    expect(perTurn.calls).toBe(3)
  })

  test('a failing list() contributes nothing and is retried next turn (W_SKILL_SOURCE_FAILED)', async () => {
    let fail = true
    const flaky = source('flaky', () => {
      if (fail) throw new Error('db down')
      return [{ name: 'a', description: 'A.' }]
    })
    const notArray = source('weird', () => 'nope' as unknown as SkillMeta[])
    const skills = buildSessionSkills(
      [],
      [
        { owner: 'app', source: flaky },
        { owner: 'app', source: notArray },
      ],
      ['app'],
      undefined,
    )
    const first = await resolve(skills)
    expect(first.turn.entries).toEqual([])
    expect(first.warnings.map((w) => [w.code, w.details?.source])).toEqual([
      ['W_SKILL_SOURCE_FAILED', 'flaky'],
      ['W_SKILL_SOURCE_FAILED', 'weird'],
    ])
    expect(first.warnings[0]?.message).toContain('db down')
    fail = false
    const second = await resolve(skills)
    expect(second.turn.entries.map((e) => e.name)).toEqual(['a'])
    await resolve(skills)
    expect(flaky.calls).toBe(2)
  })

  test('sources are called with the context of their owner', async () => {
    const seen: string[] = []
    const src = source('db', () => [])
    src.list = (c: HarnessContext) => {
      seen.push(c.plugin.name)
      return []
    }
    await resolve(buildSessionSkills([], [{ owner: 'p', source: src }], ['app', 'p'], undefined))
    expect(seen).toEqual(['p'])
  })
})
