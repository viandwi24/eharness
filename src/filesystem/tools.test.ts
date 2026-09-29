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

  test('a single line longer than the budget is cut', () => {
    const window = renderWindow(`${'x'.repeat(500)}\nnext`, 1, 10, 100)
    expect('text' in window && window.text).toBe(
      `     1\t${'x'.repeat(53)} … [line truncated]\n\n(Showing lines 1-1 of 2. Continue with offset=2.)`,
    )
  })
})
