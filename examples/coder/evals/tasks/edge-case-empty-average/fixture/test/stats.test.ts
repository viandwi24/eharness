import { expect, test } from 'bun:test'
import { average } from '../src/stats.ts'

test('average', () => {
  expect(average([2, 4])).toBe(3)
})
