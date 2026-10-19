import { expect, test } from 'bun:test'
import { capitalize } from '../src/strings.ts'

test('capitalize', () => {
  expect(capitalize('abc')).toBe('Abc')
})
