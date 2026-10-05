import { describe, expect, test } from 'bun:test'
import { GREP_SCAN_CHARS, unsafePatternReason } from './text.ts'

describe('grep pattern safe subset (spec 08 §3)', () => {
  test('refuses the shapes of catastrophic or polynomial backtracking', () => {
    const refused: Array<[string, string]> = [
      ['(a+)+$', 'a repeated group contains a repeating quantifier'],
      ['(\\w+\\s?)*$', 'a repeated group contains a repeating quantifier'],
      ['(\\d+\\.)+\\d+', 'a repeated group contains a repeating quantifier'],
      ['(a+){2,5}$', 'a repeated group contains a repeating quantifier'],
      ['(a|a)*b', 'a repeated group contains an alternation'],
      ['(foo|bar)+', 'a repeated group contains an alternation'],
      ['\\w*\\w*x', 'more than one unbounded quantifier'],
      ['\\w*\\w*\\w*x', 'more than one unbounded quantifier'],
      ['.*.*.*x', 'more than one unbounded quantifier'],
      ['.*foo.*bar', 'more than one unbounded quantifier'],
      ['a{1,500}b{1,500}', 'more than one unbounded quantifier'],
      ['(a|b)\\1', 'backreferences are not supported'],
      ['(?<x>a)\\k<x>', 'backreferences are not supported'],
      ['(?=a)b', 'lookaround assertions are not supported'],
      ['a(?<!b)', 'lookaround assertions are not supported'],
      ['x'.repeat(600), 'longer than 512 characters'],
    ]
    for (const [pattern, reason] of refused) {
      expect({ pattern, reason: unsafePatternReason(pattern) }).toEqual({ pattern, reason })
    }
  })

  test('accepts common simple patterns', () => {
    for (const pattern of [
      'TODO|FIXME',
      '^hit',
      'foo bar',
      '(ab)+',
      '\\d{4}-\\d{2}-\\d{2}',
      'function \\w+\\(',
      'a.*?b',
      '[*+]{2}x+',
      '(?:foo|bar)baz',
      '\\(a+\\)',
    ]) {
      expect({ pattern, reason: unsafePatternReason(pattern) }).toEqual({
        pattern,
        reason: undefined,
      })
    }
  })

  test('an accepted single-quantifier worst case stays fast on a scanned line', () => {
    const line = `${'a'.repeat(GREP_SCAN_CHARS)}!`
    for (const pattern of ['\\w*x', '.*x', '[a-z]*x$', 'a+x', '(ab)*x', 'a{0,100}x']) {
      expect(unsafePatternReason(pattern)).toBeUndefined()
      const started = performance.now()
      new RegExp(pattern).test(line)
      expect({ pattern, slow: performance.now() - started > 50 }).toEqual({ pattern, slow: false })
    }
  })
})
