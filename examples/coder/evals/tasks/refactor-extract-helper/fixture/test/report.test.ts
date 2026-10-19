import { expect, test } from 'bun:test'
import { lineItem, totalLine } from '../src/report.ts'

test('lines', () => {
  expect(lineItem('pen', 250)).toBe('pen: $2.50')
  expect(totalLine(1999)).toBe('TOTAL: $19.99')
})
