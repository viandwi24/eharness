import { expect, test } from 'bun:test'
import { slugify } from '../src/strings.ts'

test('slugify', () => {
  expect(slugify('  Hello, World!  ')).toBe('hello-world')
  expect(slugify('a--b__c')).toBe('a-b-c')
  expect(slugify('---')).toBe('')
})
