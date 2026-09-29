import { describe, expect, test } from 'bun:test'
import {
  dirPrefix,
  isUnder,
  isUnderAny,
  joinPath,
  normalizePath,
  normalizePrefixes,
} from './paths.ts'

const ok = (path: string) => normalizePath(path)
const error = (path: string): string | undefined => {
  const result = normalizePath(path)
  return result.ok ? undefined : result.error
}

describe('normalizePath (spec 08 §1)', () => {
  test('normalizes to absolute POSIX paths', () => {
    expect(ok('/src/main.pine')).toEqual({ ok: true, path: '/src/main.pine' })
    expect(ok('src/main.pine')).toEqual({ ok: true, path: '/src/main.pine' })
    expect(ok('//src///a//b.md')).toEqual({ ok: true, path: '/src/a/b.md' })
    expect(ok('/src/./a/./b.md')).toEqual({ ok: true, path: '/src/a/b.md' })
    expect(ok('/src/a/../b.md')).toEqual({ ok: true, path: '/src/b.md' })
    expect(ok('/src/')).toEqual({ ok: true, path: '/src' })
    expect(ok('/')).toEqual({ ok: true, path: '/' })
    expect(ok('.')).toEqual({ ok: true, path: '/' })
    expect(ok('/a/..')).toEqual({ ok: true, path: '/' })
    expect(ok('/ünï code/ø.md')).toEqual({ ok: true, path: '/ünï code/ø.md' })
  })

  test('rejects escaping, empty and malformed paths', () => {
    expect(error('/../etc/passwd')).toBe('the path escapes the root')
    expect(error('a/../../b')).toBe('the path escapes the root')
    expect(error('..')).toBe('the path escapes the root')
    expect(error('')).toBe('the path is empty')
    expect(error('   ')).toBe('the path is empty')
    expect(error('/a\u0000b')).toBe('the path contains a NUL character')
    expect(error('C:\\a.md')).toBe("use '/' as separator, not '\\'")
    expect(error(42 as unknown as string)).toBe('the path must be a string')
    expect(error(`/${'a'.repeat(5000)}`)).toContain('longer than 4096')
  })
})

describe('prefix helpers', () => {
  test('isUnder uses directory semantics', () => {
    expect(isUnder('/skills', '/skills')).toBe(true)
    expect(isUnder('/skills/a/SKILL.md', '/skills')).toBe(true)
    expect(isUnder('/skillsx/a.md', '/skills')).toBe(false)
    expect(isUnder('/anything', '/')).toBe(true)
    expect(isUnderAny('/b/c', ['/a', '/b'])).toBe(true)
    expect(isUnderAny('/c', ['/a', '/b'])).toBe(false)
    expect(isUnderAny('/c', [])).toBe(false)
  })

  test('dirPrefix and joinPath', () => {
    expect(dirPrefix('/')).toBe('/')
    expect(dirPrefix('/a')).toBe('/a/')
    expect(joinPath('/', 'a/b')).toBe('/a/b')
    expect(joinPath('/skills', 'a/b')).toBe('/skills/a/b')
  })

  test('normalizePrefixes dedupes and throws on invalid prefixes', () => {
    expect(normalizePrefixes(['skills/', '/skills', '/b//c'], 'x')).toEqual(['/skills', '/b/c'])
    expect(normalizePrefixes(undefined, 'x')).toEqual([])
    expect(() => normalizePrefixes(['/../x'], 'hiddenPrefixes')).toThrow(TypeError)
  })
})
