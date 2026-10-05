import { describe, expect, test } from 'bun:test'
import type { JSONValue } from 'ai'
import type { PluginState } from '../index.ts'
import { classifyToolResult } from './classify.ts'
import { LAST_READ_KEY, LAST_READ_LIMIT, lastReadOf } from './last-read.ts'
import { renderWindow } from './tools.ts'

function memoryPluginState(): PluginState & { data: Record<string, JSONValue> } {
  const data: Record<string, JSONValue> = {}
  return {
    data,
    get: <T extends JSONValue>(key: string) =>
      (data[key] === undefined ? undefined : structuredClone(data[key])) as T | undefined,
    set: (key, value) => {
      if (value === undefined) delete data[key]
      else data[key] = structuredClone(value)
    },
  }
}

describe('classifyToolResult (spec 08 §3)', () => {
  test('classifies by prefix', () => {
    expect(classifyToolResult('ERROR: file not found: /a')).toBe('error')
    expect(classifyToolResult('STALE: /a changed')).toBe('stale')
    expect(classifyToolResult('CONFLICT: /a was changed')).toBe('conflict')
    expect(classifyToolResult('REJECTED: /a is read-only.')).toBe('rejected')
    expect(classifyToolResult('Edited /a.md (1 replacement).')).toBe('ok')
    expect(classifyToolResult(' ERROR: not a prefix')).toBe('ok')
    expect(classifyToolResult({ type: 'json' })).toBe('ok')
    expect(classifyToolResult(undefined)).toBe('ok')
  })
})

describe('lastRead (spec 08 §4)', () => {
  test('stores path → version in plugin state; delete removes the key when empty', () => {
    const state = memoryPluginState()
    const lastRead = lastReadOf(state)
    expect(lastRead.get('/a')).toBeUndefined()
    lastRead.set('/a', 'v1')
    lastRead.set('/b', 'v2')
    lastRead.set('/a', 'v3')
    expect(state.data[LAST_READ_KEY]).toEqual({ '/b': 'v2', '/a': 'v3' })
    expect(Object.keys(state.data[LAST_READ_KEY] as object)).toEqual(['/b', '/a'])
    lastRead.delete('/b')
    lastRead.delete('/missing')
    lastRead.delete('/a')
    expect(LAST_READ_KEY in state.data).toBe(false)
  })

  test(`caps at ${LAST_READ_LIMIT} entries, evicting the least recently recorded`, () => {
    const state = memoryPluginState()
    const lastRead = lastReadOf(state)
    for (let i = 0; i < LAST_READ_LIMIT; i++) lastRead.set(`/f${i}`, `v${i}`)
    lastRead.set('/f0', 'again') // refresh the oldest
    lastRead.set('/new', 'v')
    const keys = Object.keys(state.data[LAST_READ_KEY] as object)
    expect(keys).toHaveLength(LAST_READ_LIMIT)
    expect(keys).not.toContain('/f1')
    expect(keys.at(-2)).toBe('/f0')
    expect(keys.at(-1)).toBe('/new')
  })

  test('ignores malformed stored values', () => {
    const state = memoryPluginState()
    state.set(LAST_READ_KEY, { '/a': 1, '/b': 'v' })
    expect(lastReadOf(state).get('/a')).toBeUndefined()
    expect(lastReadOf(state).get('/b')).toBe('v')
    state.set(LAST_READ_KEY, ['x'])
    expect(lastReadOf(state).get('/b')).toBeUndefined()
  })
})

describe('renderWindow', () => {
  test('a trailing newline does not add a line; CRLF is shown without \\r', () => {
    expect(renderWindow('a\r\nb\n', 1, 10, 1000)).toEqual({ text: '     1\ta\n     2\tb' })
    expect(renderWindow('a\n\n', 1, 10, 1000)).toEqual({ text: '     1\ta\n     2\t' })
  })

  test('a single line longer than the budget is cut; the hint names its charOffset', () => {
    const window = renderWindow(`${'x'.repeat(500)}\nnext`, 1, 10, 100)
    expect('text' in window && window.text).toBe(
      `     1\t${'x'.repeat(23)} … [line truncated]\n\n(Line 1 continues; use offset=1 charOffset=23.)`,
    )
    expect('text' in window && window.text.length).toBeLessThanOrEqual(100)
  })

  test('a 200 000-character single line is readable completely with charOffset', () => {
    const line = Array.from({ length: 20_000 }, (_, i) => String(i % 10).repeat(10)).join('')
    expect(line.length).toBe(200_000)
    let charOffset = 0
    let read = ''
    for (let page = 0; page < 100; page++) {
      const window = renderWindow(`${line}\nnext`, 1, 10, 10_000, charOffset)
      const text = 'text' in window ? window.text : ''
      expect(text.length).toBeLessThanOrEqual(10_000)
      const hint = /\(Line 1 continues; use offset=1 charOffset=(\d+)\.\)$/.exec(text)
      const body = text.slice('     1\t'.length).split('\n')[0] as string
      if (hint === null) {
        read += body
        expect(text.endsWith('\n     2\tnext')).toBe(true)
        break
      }
      read += body.replace(/ … \[line truncated\]$/, '')
      charOffset = Number(hint[1])
    }
    expect(read).toBe(line)
    expect(renderWindow('abc', 1, 10, 1000, 3)).toEqual({
      error: 'charOffset 3 is past the end of line 1 (3 characters)',
    })
  })

  test('the continuation hint fits inside maxChars (no cut by the 50k tool output limit)', () => {
    const content = Array.from({ length: 20_000 }, (_, i) => `row ${i} ${'x'.repeat(30)}`).join(
      '\n',
    )
    const window = renderWindow(content, 1, 2_000, 50_000)
    const text = 'text' in window ? window.text : ''
    expect(text.length).toBeLessThanOrEqual(50_000)
    expect(text).toContain('Continue with offset=')
    // a window without a hint may use the whole budget
    const exact = renderWindow('a'.repeat(50), 1, 10, 58)
    expect('text' in exact && exact.text).toBe(`     1\t${'a'.repeat(50)}`)
  })
})
