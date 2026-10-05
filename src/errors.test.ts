import { describe, expect, spyOn, test } from 'bun:test'
import {
  createWarningEmitter,
  HarnessError,
  HarnessToolError,
  type HarnessWarning,
  isHarnessError,
} from './errors.ts'

describe('HarnessError', () => {
  test('carries code, details and cause', () => {
    const cause = new Error('db down')
    const error = new HarnessError('EH_STORAGE', 'save failed', {
      details: { sessionId: 's1' },
      cause,
    })
    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('HarnessError')
    expect(error.code).toBe('EH_STORAGE')
    expect(error.details).toEqual({ sessionId: 's1' })
    expect(error.cause).toBe(cause)
  })

  test('omits details when not given', () => {
    const error = new HarnessError('EH_CONFIG_INVALID', 'bad')
    expect(error.details).toBeUndefined()
    expect(error.cause).toBeUndefined()
  })
})

describe('isHarnessError', () => {
  test('matches any or a specific code', () => {
    const error = new HarnessError('EH_SESSION_BUSY', 'busy')
    expect(isHarnessError(error)).toBe(true)
    expect(isHarnessError(error, 'EH_SESSION_BUSY')).toBe(true)
    expect(isHarnessError(error, 'EH_SESSION_CLOSED')).toBe(false)
  })

  test('rejects other values', () => {
    expect(isHarnessError(new Error('x'))).toBe(false)
    expect(isHarnessError({ name: 'HarnessError', code: 'EH_STORAGE' })).toBe(false)
    expect(isHarnessError(undefined)).toBe(false)
  })

  test('accepts an error from another package copy', () => {
    const foreign = Object.assign(new Error('x'), { name: 'HarnessError', code: 'EH_STORAGE' })
    expect(isHarnessError(foreign, 'EH_STORAGE')).toBe(true)
  })
})

describe('HarnessToolError', () => {
  test('String() equals the original error', () => {
    class RateLimit extends Error {
      override name = 'RateLimit'
    }
    const original = new RateLimit('slow down')
    const wrapped = new HarnessToolError(original, { toolName: 'get_price', toolCallId: 'c1' })
    expect(String(wrapped)).toBe(String(original))
    expect(wrapped.cause).toBe(original)
    expect(wrapped.toolName).toBe('get_price')
    expect(wrapped.toolCallId).toBe('c1')
  })

  test('wraps non-errors', () => {
    const wrapped = new HarnessToolError('boom', { toolName: 't', toolCallId: 'c' })
    expect(String(wrapped)).toBe('Error: boom')
  })
})

describe('createWarningEmitter', () => {
  const warning: HarnessWarning = { code: 'W_SHADOWED', message: 'tool x shadowed' }

  test('delivers every occurrence to onWarning', () => {
    const seen: HarnessWarning[] = []
    const emit = createWarningEmitter({ onWarning: (w) => seen.push(w) })
    emit(warning, 'x')
    emit(warning, 'x')
    expect(seen).toHaveLength(2)
  })

  test('default handler deduplicates per code + key', () => {
    const spy = spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const emit = createWarningEmitter({})
      emit(warning, 'x')
      emit(warning, 'x')
      emit(warning, 'y')
      emit({ code: 'W_CACHE_BUST', message: 'bust' }, 'x')
      expect(spy).toHaveBeenCalledTimes(3)
      // a second agent (emitter) does not share the dedupe set
      createWarningEmitter({})(warning, 'x')
      expect(spy).toHaveBeenCalledTimes(4)
    } finally {
      spy.mockRestore()
    }
  })

  test('the dedupe set is bounded (10 000 per-turn keys keep at most 1 000)', () => {
    const spy = spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const emit = createWarningEmitter({})
      for (let i = 0; i < 10_000; i++) emit(warning, `turn-${i}`)
      expect(spy).toHaveBeenCalledTimes(10_000)
      // a recent key is still deduplicated, the oldest one was evicted
      emit(warning, 'turn-9999')
      expect(spy).toHaveBeenCalledTimes(10_000)
      emit(warning, 'turn-0')
      expect(spy).toHaveBeenCalledTimes(10_001)
    } finally {
      spy.mockRestore()
    }
  })

  test('strict turns misuse warnings into EH_CONFIG_INVALID', () => {
    const emit = createWarningEmitter({ strict: true, onWarning: () => {} })
    expect(() => emit({ code: 'W_UNKNOWN_DATA_PART', message: 'nope' })).toThrow(HarnessError)
    try {
      emit({ code: 'W_WRITE_OUTSIDE_TURN', message: 'idle' })
    } catch (error) {
      expect(isHarnessError(error, 'EH_CONFIG_INVALID')).toBe(true)
    }
    // non-misuse warnings are never escalated
    expect(() => emit({ code: 'W_UNKNOWN_STORED_PART', message: 'old' })).not.toThrow()
  })
})
