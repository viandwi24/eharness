import { expect, test } from 'bun:test'
import { repeat } from '../src/repeat.ts'

test('default', () => {
  expect(repeat('ab', 2)).toBe('abab')
})
