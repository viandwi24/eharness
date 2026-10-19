import { expect, test } from 'bun:test'
import { sortNumbers } from '../src/sort.ts'

test('numeric order', () => {
  expect(sortNumbers([10, 9, 1])).toEqual([1, 9, 10])
})

test('does not mutate', () => {
  const input = [3, 1, 2]
  sortNumbers(input)
  expect(input).toEqual([3, 1, 2])
})
