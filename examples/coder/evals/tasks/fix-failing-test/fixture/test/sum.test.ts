import { expect, test } from 'bun:test'
import { sum } from '../src/sum.ts'

test('sums all values', () => {
  expect(sum([1, 2, 3])).toBe(6)
})
