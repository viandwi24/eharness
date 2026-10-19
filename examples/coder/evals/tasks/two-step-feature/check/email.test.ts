import { expect, test } from 'bun:test'
import { describeUser } from '../src/user.ts'

test('email', () => {
  expect(describeUser({ name: 'Ada', email: 'a@x.io' })).toBe('Ada <a@x.io>')
})
