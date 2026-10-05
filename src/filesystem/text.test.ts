import { describe, expect, test } from 'bun:test'
import { GREP_SCAN_CHARS, unsafePatternReason } from './text.ts'

/** Time one match of `pattern` against a worst-case line of the scanned length. */
function timeMatch(pattern: string): number {
  const line = `${'a'.repeat(GREP_SCAN_CHARS)}!`
  const started = performance.now()
  new RegExp(pattern).test(line)
  return performance.now() - started
}

describe('grep pattern safe subset (spec 08 §3)', () => {
  test('refuses every pattern outside the rule (no hangs: refused before matching)', () => {
    const refused: Array<[string, string]> = [
      // stacked variable repeats (each froze a 2 000-char line for seconds)
      ['a{1,99}a{1,99}a{1,99}a{1,99}b', 'more than one variable-width quantifier'],
      ['a*[^b]{0,99}[a-z]{0,99}c', 'more than one variable-width quantifier'],
      ['(\\w?\\w?\\w?){30}x', 'more than one variable-width quantifier'],
      ['(?:a?a?){50}b', 'more than one variable-width quantifier'],
      ['\\w+\\d{0,99}\\w{0,99}x', 'more than one variable-width quantifier'],
      ['\\w*\\w*x', 'more than one variable-width quantifier'],
      ['.*foo.*bar', 'more than one variable-width quantifier'],
      ['a?b?', 'more than one variable-width quantifier'],
      // quantified groups of any kind
      ['(a+)+$', 'a quantified group'],
      ['(\\d+\\.)+\\d+', 'a quantified group'],
      ['(a|a)*b', 'a quantified group'],
      ['(ab){3}', 'a quantified group'],
      ['(?:foo|bar)?baz', 'a quantified group'],
      // unsupported features
      ['(a|b)\\1', 'backreferences are not supported'],
      ['(?<x>a)\\k<x>', 'backreferences are not supported'],
      ['(?=a)b', 'lookaround assertions are not supported'],
      ['a(?<!b)', 'lookaround assertions are not supported'],
      ['x'.repeat(600), 'longer than 512 characters'],
    ]
    for (const [pattern, reason] of refused) {
      const started = performance.now()
      expect({ pattern, reason: unsafePatternReason(pattern) }).toEqual({ pattern, reason })
      expect(performance.now() - started).toBeLessThan(50)
    }
  })

  test('accepts common patterns, and each stays fast on a worst-case line', () => {
    for (const pattern of [
      'foo',
      'foo|bar',
      'import .* from',
      'function \\w+\\(',
      '^\\s*export',
      'TODO|FIXME',
      '[A-Z][a-z]+Error',
      'a.{0,90}b',
      '\\d{4}-\\d{2}-\\d{2}',
      '(?:foo|bar)baz',
      '[*+?]{2}x+',
      '.*?b',
      '\\w*x',
      '[a-z]*x$',
    ]) {
      expect({ pattern, reason: unsafePatternReason(pattern) }).toEqual({
        pattern,
        reason: undefined,
      })
      expect({ pattern, slow: timeMatch(pattern) > 50 }).toEqual({ pattern, slow: false })
    }
  })
})
