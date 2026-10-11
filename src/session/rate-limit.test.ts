import { expect, test } from 'bun:test'
import { createRateLimitedWarn } from './rate-limit.ts'

test('logs a key at most once per interval, keys are independent', () => {
  let t = 0
  const out: string[] = []
  const warn = createRateLimitedWarn((m) => out.push(m), { intervalMs: 100, now: () => t })
  warn('a', 'first')
  warn('a', 'again')
  warn('b', 'other')
  t = 99
  warn('a', 'still limited')
  t = 100
  warn('a', 'after the interval')
  expect(out).toEqual(['first', 'other', 'after the interval'])
})
