import { describe, expect, test } from 'bun:test'
import { MAX_SKILL_PATH_LENGTH, validateSkillPath } from './paths.ts'

const ok = (input: string, path: string) =>
  expect(validateSkillPath(input)).toEqual({ ok: true, path })
const bad = (input: string) => {
  const result = validateSkillPath(input)
  expect(result.ok).toBe(false)
  if (!result.ok) expect(result.error.length).toBeGreaterThan(0)
}

describe('validateSkillPath', () => {
  test('accepts plain relative paths', () => {
    ok('reference.md', 'reference.md')
    ok('scripts/check.py', 'scripts/check.py')
    ok('a/b/c/d.txt', 'a/b/c/d.txt')
    ok('.hidden', '.hidden')
    ok('...', '...')
    ok('dir..name/file', 'dir..name/file')
    ok('docs/SKILL.md', 'docs/SKILL.md')
    ok('ünïcødé/файл.md', 'ünïcødé/файл.md')
    ok('with space.md', 'with space.md')
  })

  test('removes . segments', () => {
    ok('./reference.md', 'reference.md')
    ok('scripts/./check.py', 'scripts/check.py')
    ok('././a', 'a')
  })

  test('rejects traversal', () => {
    bad('..')
    bad('../secret')
    bad('a/../b')
    bad('a/..')
    bad('./..')
  })

  test('rejects absolute paths and backslashes', () => {
    bad('/etc/passwd')
    bad('/')
    bad('a\\b')
    bad('..\\x')
    bad('C:\\x')
  })

  test('rejects NUL and empty segments', () => {
    bad('a\u0000b')
    bad('')
    bad('a//b')
    bad('a/')
    bad('.')
    bad('./')
  })

  test('enforces the length limit', () => {
    ok('a'.repeat(MAX_SKILL_PATH_LENGTH), 'a'.repeat(MAX_SKILL_PATH_LENGTH))
    bad('a'.repeat(MAX_SKILL_PATH_LENGTH + 1))
  })

  test('SKILL.md itself is not addressable', () => {
    bad('SKILL.md')
    bad('./SKILL.md')
    bad('skill.md')
  })

  test('rejects non-strings', () => {
    bad(42 as unknown as string)
    bad(undefined as unknown as string)
  })
})
