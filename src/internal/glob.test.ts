import { describe, expect, test } from 'bun:test'
import {
  compileGitignorePattern,
  compileGlobRegExp,
  GLOB_MAX_DOUBLE_STARS,
  GLOB_MAX_STARS,
} from './glob.ts'
import { collapseSegments, foldSegment, normalizeRootedPath } from './path-segments.ts'

const glob = (
  pattern: string,
  path: string,
  opts: Parameters<typeof compileGlobRegExp>[1],
): boolean => {
  const compiled = compileGlobRegExp(pattern, opts)
  if (!compiled.ok) throw new Error(compiled.error)
  return compiled.regex.test(path)
}

describe('compileGlobRegExp (default dialect)', () => {
  // expectations captured from the pre-unification `filesystem/glob.ts`
  const cases: Array<[string, string, boolean]> = [
    ['*.ts', 'a.ts', true],
    ['*.ts', 'src/a.ts', false],
    ['**/*.ts', 'a.ts', true],
    ['**/*.ts', 'src/x/y/a.ts', true],
    ['**/*.ts', 'src/.hidden/a.ts', false],
    ['src/**', 'src', false],
    ['src/**', 'src/a/b', true],
    ['.env*', '.env.local', true],
    ['*', '.env', false],
    ['**/.env', 'a/.env', true],
    ['a/**/b', 'a/b', true],
    ['a/**/b', 'a/q/r/b', true],
    ['*.{ts,js}', 'a.js', true],
    ['[!abc].txt', 'd.txt', true],
    ['[!abc].txt', 'a.txt', false],
    ['f?o', 'fxo', true],
  ]
  test.each(cases)('%s vs %s', (pattern, path, expected) => {
    expect(glob(pattern, path, { dot: false })).toBe(expected)
  })

  test('dot: true lets wildcards match a leading dot (permission rules)', () => {
    expect(glob('*', '.env', { dot: true })).toBe(true)
    expect(glob('**/*.ts', 'src/.hidden/a.ts', { dot: true })).toBe(true)
  })

  test('caseFold', () => {
    expect(glob('*.TS', 'a.ts', { caseFold: true })).toBe(true)
    expect(glob('*.TS', 'a.ts', {})).toBe(false)
  })

  test('consecutive ** collapse and cannot blow up', () => {
    const path = Array.from({ length: 30 }, (_, i) => `d${i}`).join('/')
    const pattern = `${'**/'.repeat(10)}zzz`
    const compiled = compileGlobRegExp(pattern)
    expect(compiled.ok).toBe(true)
    if (!compiled.ok) return
    const started = performance.now()
    for (let i = 0; i < 1000; i++) expect(compiled.regex.test(path)).toBe(false)
    expect(performance.now() - started).toBeLessThan(50)
    expect(compiled.regex.source.match(/\(\?:/g)?.length).toBeLessThanOrEqual(3)
  })

  test('non-consecutive ** and * counts are capped', () => {
    const doubles = Array.from({ length: GLOB_MAX_DOUBLE_STARS + 2 }, () => 'a').join('/**/')
    expect(compileGlobRegExp(doubles).ok).toBe(false)
    expect(
      compileGlobRegExp(
        Array(GLOB_MAX_DOUBLE_STARS + 1)
          .fill('a')
          .join('/**/'),
      ).ok,
    ).toBe(true)
    const stars = Array.from({ length: GLOB_MAX_STARS + 2 }, () => 'a').join('*')
    expect(compileGlobRegExp(stars).ok).toBe(false)
  })

  test('a capped pattern with many ** stays fast', () => {
    const path = Array.from({ length: 30 }, (_, i) => `d${i}`).join('/')
    const compiled = compileGlobRegExp(
      `${Array(GLOB_MAX_DOUBLE_STARS + 1)
        .fill('a')
        .join('/**/')}/zzz`,
    )
    if (!compiled.ok) throw new Error(compiled.error)
    const started = performance.now()
    for (let i = 0; i < 100; i++) compiled.regex.test(path)
    expect(performance.now() - started).toBeLessThan(50)
  })
})

describe('compileGlobRegExp (wildcard dialect)', () => {
  test('* stays in a segment, ** crosses, the rest is literal', () => {
    expect(glob('/pets/*', '/pets/1', { wildcard: true })).toBe(true)
    expect(glob('/pets/*', '/pets/1/x', { wildcard: true })).toBe(false)
    expect(glob('/pets/**', '/pets/1/x', { wildcard: true })).toBe(true)
    expect(glob('/pets/{id}', '/pets/{id}', { wildcard: true })).toBe(true)
    expect(glob('/a?b', '/a?b', { wildcard: true })).toBe(true)
    expect(glob('/a?b', '/axb', { wildcard: true })).toBe(false)
  })
})

describe('compileGitignorePattern', () => {
  const hit = (line: string, path: string, ci = false): boolean => {
    const p = compileGitignorePattern(line, { caseFold: ci })
    if (p === undefined) throw new Error(`no pattern for ${line}`)
    return p.regex.test(path)
  }

  test('anchoring, ** and a leading dot', () => {
    expect(hit('*.ts', 'a/b/c.ts')).toBe(true)
    expect(hit('src/*.ts', 'src/a.ts')).toBe(true)
    expect(hit('src/*.ts', 'x/src/a.ts')).toBe(false)
    expect(hit('a/**/b', 'a/b')).toBe(true)
    expect(hit('a/**/**/b', 'a/x/y/b')).toBe(true)
    expect(hit('.env*', 'x/.env.local')).toBe(true)
    expect(hit('*', '.env')).toBe(true)
  })

  test('negation, directories and comments', () => {
    expect(compileGitignorePattern('!keep')?.negate).toBe(true)
    expect(compileGitignorePattern('build/')?.dirOnly).toBe(true)
    expect(compileGitignorePattern('# note')).toBeUndefined()
    expect(compileGitignorePattern('  ')).toBeUndefined()
    expect(hit('\\#a', '#a')).toBe(true)
  })

  test('too many ** is not compiled', () => {
    expect(
      compileGitignorePattern(
        Array(GLOB_MAX_DOUBLE_STARS + 2)
          .fill('a')
          .join('/**/'),
      ),
    ).toBeUndefined()
  })
})

describe('path segments', () => {
  test('collapseSegments', () => {
    expect(collapseSegments('a//b/./c/../d'.split('/'), { keepLeadingDotDot: false })).toEqual([
      'a',
      'b',
      'd',
    ])
    expect(collapseSegments('../../a'.split('/'), { keepLeadingDotDot: true })).toEqual([
      '..',
      '..',
      'a',
    ])
    expect(collapseSegments('../a'.split('/'), { keepLeadingDotDot: false })).toEqual(['a'])
    expect(collapseSegments(['a', '..', '..', 'b'], { keepLeadingDotDot: true })).toEqual([
      '..',
      'b',
    ])
  })

  test('normalizeRootedPath', () => {
    expect(normalizeRootedPath('src//a/../main.ts')).toEqual({ ok: true, path: '/src/main.ts' })
    expect(normalizeRootedPath('/../etc')).toEqual({
      ok: false,
      error: 'the path escapes the root',
    })
    expect(normalizeRootedPath('a/../../b').ok).toBe(false)
    expect(normalizeRootedPath('a\\b').ok).toBe(false)
    expect(normalizeRootedPath('   ').ok).toBe(false)
  })

  test('foldSegment', () => {
    expect(foldSegment('.GIT.')).toBe('.git')
    expect(foldSegment('É')).toBe('é')
  })
})
