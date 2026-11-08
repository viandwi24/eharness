import { describe, expect, test } from 'bun:test'
import * as root from '../index.ts'
import * as entry from './index.ts'

describe('eharness/codes', () => {
  test('exports exactly the constants of the package root, the same objects', () => {
    expect(Object.keys(entry).sort()).toEqual(['NOTICE_CODES', 'STOP_REASONS'])
    expect(entry.STOP_REASONS).toBe(root.STOP_REASONS)
    expect(entry.NOTICE_CODES).toBe(root.NOTICE_CODES)
  })

  test('the source of the entry imports only src/codes.ts', async () => {
    const source = await Bun.file(new URL('./index.ts', import.meta.url)).text()
    const specifiers = [...source.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1])
    expect(specifiers).toEqual(['../codes.ts'])
  })
})
