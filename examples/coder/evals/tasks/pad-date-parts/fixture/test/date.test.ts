import { expect, test } from 'bun:test'
import { formatDate } from '../src/date.ts'

test('pads', () => {
  expect(formatDate(new Date(Date.UTC(2024, 2, 7)))).toBe('2024-03-07')
  expect(formatDate(new Date(Date.UTC(2024, 11, 25)))).toBe('2024-12-25')
})
