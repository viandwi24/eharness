import { expect, test } from 'bun:test'
import { greet } from '../src/greet.ts'
import { getUser } from '../src/users.ts'

test('getUser finds a user', () => {
  expect(getUser(1)?.name).toBe('Ada')
})

test('greet', () => {
  expect(greet(2)).toBe('Hello, Linus')
  expect(greet(9)).toBe('Hello, stranger')
})
