import { expect, test } from 'bun:test'
import { format } from '../src/format.ts'

test('format', () => {
  expect(format('a')).toBe('[a]')
})
