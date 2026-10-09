/** Lexical path helpers and the gitignore matcher. */
import { describe, expect, test } from 'bun:test'
import {
  compilePattern,
  ignoreMatcher,
  isInside,
  join,
  normalize,
  patternMatches,
  relative,
  resolve,
} from './paths.ts'

describe('lexical paths', () => {
  test('normalize', () => {
    expect(normalize('/a//b/./c/../d')).toBe('/a/b/d')
    expect(normalize('/../..')).toBe('/')
    expect(normalize('a/../..')).toBe('..')
    expect(normalize('')).toBe('.')
    expect(normalize('/')).toBe('/')
  })

  test('join and resolve', () => {
    expect(join('/a', 'b', '../c')).toBe('/a/c')
    expect(join('/a', '/b')).toBe('/a/b')
    expect(resolve('/proj', 'x/y')).toBe('/proj/x/y')
    expect(resolve('/proj', '/etc/x')).toBe('/etc/x')
    expect(resolve('/proj', '../x')).toBe('/x')
  })

  test('relative and isInside', () => {
    expect(relative('/a/b', '/a/b/c/d')).toBe('c/d')
    expect(relative('/a/b', '/a/x')).toBe('../x')
    expect(relative('/a', '/a')).toBe('')
    expect(isInside('/a/b', '/a')).toBe(true)
    expect(isInside('/a', '/a')).toBe(true)
    expect(isInside('/ab', '/a')).toBe(false)
    expect(isInside('/x', '/a')).toBe(false)
    expect(isInside('/anything', '/')).toBe(true)
  })
})

describe('ignore patterns', () => {
  const matches = (pattern: string, path: string): boolean => {
    const compiled = compilePattern(pattern)
    return compiled !== undefined && patternMatches(compiled, path)
  }

  test('any depth versus anchored', () => {
    expect(matches('.git', 'a/b/.git/config')).toBe(true)
    expect(matches('a/b', 'a/b/c')).toBe(true)
    expect(matches('a/b', 'x/a/b')).toBe(false)
    expect(matches('/a', 'a/x')).toBe(true)
    expect(matches('/a', 'x/a')).toBe(false)
  })

  test('globs', () => {
    expect(matches('*.md', 'docs/a.md')).toBe(true)
    expect(matches('docs/*.md', 'docs/a/b.md')).toBe(false)
    expect(matches('**/x', 'x')).toBe(true)
    expect(matches('**/x', 'a/b/x')).toBe(true)
    expect(matches('a/**', 'a/b/c')).toBe(true)
    expect(matches('a/**', 'a')).toBe(false)
    expect(matches('a/**/b', 'a/b')).toBe(true)
    expect(matches('a/**/b', 'a/x/y/b')).toBe(true)
    expect(matches('[a-c].ts', 'b.ts')).toBe(true)
    expect(matches('[!a-c].ts', 'b.ts')).toBe(false)
    expect(matches('\\#x', '#x')).toBe(true)
  })

  test('blank, comments and negations compile to nothing', () => {
    expect(compilePattern('')).toBeUndefined()
    expect(compilePattern('#c')).toBeUndefined()
    expect(compilePattern('!x')).toBeUndefined()
    expect(compilePattern('/')).toBeUndefined()
  })

  test('ignoreMatcher over a list', () => {
    const m = ignoreMatcher(['.git', '.app/settings*.json'])
    expect(m('.git/config')).toBe(true)
    expect(m('.app/settings.local.json')).toBe(true)
    expect(m('.app/notes.md')).toBe(false)
  })
})
