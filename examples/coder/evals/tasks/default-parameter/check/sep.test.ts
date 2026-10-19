import { expect, test } from 'bun:test'
import { repeat } from '../src/repeat.ts'

test('sep', () => {
  expect(repeat('a', 3, '-')).toBe('a-a-a')
  expect(repeat('a', 0, '-')).toBe('')
})
