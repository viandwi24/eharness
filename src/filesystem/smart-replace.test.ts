import { describe, expect, test } from 'bun:test'
import { smartReplace } from './smart-replace.ts'

const replaced = (...args: Parameters<typeof smartReplace>) => {
  const result = smartReplace(...args)
  if (!result.ok) throw new Error(result.error)
  return result
}
const failure = (...args: Parameters<typeof smartReplace>): string => {
  const result = smartReplace(...args)
  if (result.ok) throw new Error(`expected an error, got ${JSON.stringify(result)}`)
  return result.error
}

describe('smartReplace cascade (spec 08 §4)', () => {
  test('exact match', () => {
    expect(replaced('let a = 1\nlet b = 2\n', 'let b = 2', 'let b = 3')).toEqual({
      ok: true,
      content: 'let a = 1\nlet b = 3\n',
      count: 1,
      strategy: 'exact',
    })
  })

  test('inserts the replacement verbatim ($ patterns are not special)', () => {
    expect(replaced('price', 'price', "$& $1 $$ $'").content).toBe("$& $1 $$ $'")
  })

  test('line-trimmed match ignores indentation and trailing spaces per line', () => {
    const content = 'function f() {\n    if (x) {\n        return 1  \n    }\n}\n'
    const result = replaced(content, 'if (x) {\n  return 1\n}', 'if (x) {\n        return 2\n    }')
    expect(result.strategy).toBe('line-trimmed')
    expect(result.content).toBe('function f() {\n    if (x) {\n        return 2\n    }\n}\n')
  })

  test('line-trimmed: an indented needle replaces whole lines (no double indentation)', () => {
    const content = 'class A {\n    foo() {\n        return 1\n    }\n}'
    const result = replaced(content, '  foo() {\n    return 1\n  }', '  foo() {\n    return 2\n  }')
    expect(result.strategy).toBe('line-trimmed')
    expect(result.content).toBe('class A {\n  foo() {\n    return 2\n  }\n}')
  })

  test('line-trimmed: Python-like indented needle keeps the replacement indentation verbatim', () => {
    const content = 'def f():\n        if x:\n            return 1\n        return 0\n'
    const result = replaced(
      content,
      '    if x:\n        return 1',
      '        if x:\n            return 2',
    )
    expect(result.strategy).toBe('line-trimmed')
    expect(result.content).toBe('def f():\n        if x:\n            return 2\n        return 0\n')
  })

  test('line-trimmed: an unindented needle keeps the file indentation of the first line', () => {
    const content = 'def f():\n    if x:\n        return 1\n'
    const result = replaced(content, 'if x:\nreturn 1', 'if y:\n        return 2')
    expect(result.strategy).toBe('line-trimmed')
    expect(result.content).toBe('def f():\n    if y:\n        return 2\n')
  })

  test('line-trimmed match ignores blank lines around the needle and CRLF', () => {
    const content = 'a\r\n  b\r\n  c\r\nd'
    const result = replaced(content, '\nb\r\nc\n\n', 'X')
    expect(result.strategy).toBe('line-trimmed')
    expect(result.content).toBe('a\r\n  X\r\nd')
  })

  test('whitespace-normalized match collapses whitespace runs', () => {
    const content = 'call(a,   b,\n      c)\nrest'
    const result = replaced(content, 'call(a, b, c)', 'call(a, b)')
    expect(result.strategy).toBe('whitespace-normalized')
    expect(result.content).toBe('call(a, b)\nrest')
  })

  test('the first matching level decides', () => {
    // exact wins although the trimmed form would match twice
    const content = '  x = 1\nx = 1 \n'
    const result = replaced(content, '  x = 1', 'y')
    expect(result).toMatchObject({ strategy: 'exact', content: 'y\nx = 1 \n' })
  })

  test('ambiguity is rejected without replace_all, at every level', () => {
    expect(failure('a\na\n', 'a', 'b')).toContain('matches 2 places')
    expect(failure('  a\n\ta\n', ' a ', 'b')).toContain('matches 2 places')
    expect(failure('x  y z; x y\tz', 'x y z', 'q')).toContain('matches 2 places')
  })

  test('replace_all replaces every non-overlapping match', () => {
    expect(replaced('aaa', 'a', 'b', true)).toMatchObject({ content: 'bbb', count: 3 })
    expect(replaced('aaaa', 'aa', 'x', true)).toMatchObject({ content: 'xx', count: 2 })
    expect(replaced('  a\n\ta\n', 'a ', 'b', true)).toMatchObject({
      content: '  b\n\tb\n',
      count: 2,
      strategy: 'line-trimmed',
    })
  })

  test('errors: empty old_string, identical strings, not found', () => {
    expect(failure('abc', '', 'x')).toContain('must not be empty')
    expect(failure('abc', 'b', 'b')).toContain('identical')
    expect(failure('abc', 'zzz', 'x')).toContain('was not found')
    expect(failure('abc', '   ', 'x')).toContain('was not found')
  })
})
