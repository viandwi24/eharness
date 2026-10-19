import { expect, test } from 'bun:test'
import { average } from '../src/stats.ts'

test('empty', () => {
  expect(average([])).toBe(0)
})
