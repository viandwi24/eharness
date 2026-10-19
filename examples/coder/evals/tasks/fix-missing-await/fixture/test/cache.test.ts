import { expect, test } from 'bun:test'
import { load, peek } from '../src/cache.ts'

test('load caches plain numbers', async () => {
  expect(await load('abc')).toBe(3)
  expect(peek('abc')).toBe(3)
})
