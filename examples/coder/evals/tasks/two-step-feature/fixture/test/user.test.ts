import { expect, test } from 'bun:test'
import { describeUser } from '../src/user.ts'

test('name only', () => {
  expect(describeUser({ name: 'Ada' })).toBe('Ada')
})
