import { expect, test } from 'bun:test'
import { isEmail } from '../src/email.ts'

test('valid', () => {
  expect(isEmail('a@b.co')).toBe(true)
  expect(isEmail('first.last@sub.example.org')).toBe(true)
})

test('invalid', () => {
  expect(isEmail('a@b')).toBe(false)
  expect(isEmail('a b@c.com')).toBe(false)
  expect(isEmail('nope')).toBe(false)
})
