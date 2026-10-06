import { describe, expect, test } from 'bun:test'
import { HarnessError } from '../../errors.ts'
import { backoffDelay, failureInfo, failureText, isNonRetryable } from './retry.ts'

describe('backoffDelay', () => {
  const noJitter = { jitter: false } as const

  test('defaults: exponential from 1 000 ms, capped at 60 000 ms', () => {
    expect([1, 2, 3, 4].map((n) => backoffDelay(n, noJitter))).toEqual([1_000, 2_000, 4_000, 8_000])
    expect(backoffDelay(7, noJitter)).toBe(60_000)
    expect(backoffDelay(10_000, noJitter)).toBe(60_000)
  })

  test('fixed waits delayMs every time', () => {
    const fixed = { type: 'fixed', delayMs: 250, jitter: false } as const
    expect([1, 2, 9].map((n) => backoffDelay(n, fixed))).toEqual([250, 250, 250])
  })

  test('exponential: delayMs × 2^(attempts − 1), capped', () => {
    const exp = { type: 'exponential', delayMs: 100, maxDelayMs: 500, jitter: false } as const
    expect([1, 2, 3, 4, 5].map((n) => backoffDelay(n, exp))).toEqual([100, 200, 400, 500, 500])
    expect(backoffDelay(0, exp)).toBe(100) // attempts below 1 count as the first
  })

  test('full jitter draws from [0, delay] with an injectable random', () => {
    const exp = { delayMs: 100 }
    expect(backoffDelay(3, exp, () => 0)).toBe(0)
    expect(backoffDelay(3, exp, () => 0.5)).toBe(200)
    expect(backoffDelay(3, exp, () => 1)).toBe(400)
    expect(backoffDelay(3, exp, () => 7)).toBe(400) // clamped
    expect(backoffDelay(1, undefined, () => 0.25)).toBe(250)
  })

  test('a zero delay never waits', () => {
    expect(backoffDelay(5, { delayMs: 0 })).toBe(0)
  })
})

describe('failure classification', () => {
  test('failureInfo / failureText read code and message', () => {
    const error = new HarnessError('EH_STORAGE', 'boom')
    expect(failureInfo(error)).toEqual({ code: 'EH_STORAGE', message: 'boom' })
    expect(failureText(error)).toBe('EH_STORAGE: boom')
    expect(failureInfo({ code: 'EH_X', message: 'plain' })).toEqual({
      code: 'EH_X',
      message: 'plain',
    })
    expect(failureText('text')).toBe('text')
  })

  test('default nonRetryable: EH_INVALID_INPUT only', () => {
    expect(isNonRetryable({}, new HarnessError('EH_INVALID_INPUT', 'bad'))).toBe(true)
    expect(isNonRetryable({}, new HarnessError('EH_STORAGE', 'down'))).toBe(false)
    expect(isNonRetryable({}, new Error('other'))).toBe(false)
  })

  test('a custom nonRetryable decides; a throwing one means retryable', () => {
    const custom = { nonRetryable: (e: { code?: string }) => e.code === 'EH_STORAGE' }
    expect(isNonRetryable(custom, new HarnessError('EH_STORAGE', 'x'))).toBe(true)
    expect(isNonRetryable(custom, new HarnessError('EH_INVALID_INPUT', 'x'))).toBe(false)
    const broken = {
      nonRetryable: () => {
        throw new Error('bug')
      },
    }
    expect(isNonRetryable(broken, new Error('x'))).toBe(false)
  })
})
