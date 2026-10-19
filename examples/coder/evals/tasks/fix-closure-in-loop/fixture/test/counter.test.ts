import { expect, test } from 'bun:test'
import { makeCounter } from '../src/counter.ts'

test('independent counters', () => {
  const a = makeCounter()
  const b = makeCounter()
  a.next()
  a.next()
  expect(b.next()).toBe(1)
  expect(a.next()).toBe(3)
})
