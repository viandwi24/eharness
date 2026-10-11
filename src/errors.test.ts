import { describe, expect, spyOn, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { HARNESS_ERROR_CODES, HARNESS_NOTICE_CODES, WARNING_CODES } from './codes.ts'
import {
  asInvalidInputError,
  configError,
  createWarningEmitter,
  HarnessError,
  HarnessToolError,
  type HarnessWarning,
  invalidInputError,
  isHarnessError,
  lockFailure,
  sessionBusyError,
  sessionClosedError,
  storageError,
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

  test('default handler repeats a key after the window and counts the suppressed repeats', () => {
    const spy = spyOn(console, 'warn').mockImplementation(() => {})
    try {
      let t = 0
      const emit = createWarningEmitter({ dedupeWindowMs: 1_000, now: () => t })
      emit(warning, 'x')
      t = 500
      emit(warning, 'x')
      emit(warning, 'x')
      expect(spy).toHaveBeenCalledTimes(1)
      t = 1_000
      emit(warning, 'x')
      expect(spy).toHaveBeenCalledTimes(2)
      expect(String(spy.mock.calls[1]?.[0])).toContain('2 similar suppressed')
      // the window restarted: no stale count on the next report
      t = 2_500
      emit(warning, 'x')
      expect(String(spy.mock.calls[2]?.[0])).not.toContain('suppressed')
    } finally {
      spy.mockRestore()
    }
  })

  test('dedupeWindowMs 0 prints every occurrence', () => {
    const spy = spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const emit = createWarningEmitter({ dedupeWindowMs: 0 })
      emit(warning, 'x')
      emit(warning, 'x')
      expect(spy).toHaveBeenCalledTimes(2)
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

describe('error factories (K-10)', () => {
  test('one construction point per code, with the same message and details everywhere', () => {
    expect(sessionClosedError('s1')).toMatchObject({
      code: 'EH_SESSION_CLOSED',
      details: { sessionId: 's1' },
    })
    expect(sessionBusyError('s1')).toMatchObject({ code: 'EH_SESSION_BUSY' })
    expect(sessionBusyError('s1').message).toContain("'s1'")
    expect(configError('bad', { key: 1 })).toMatchObject({
      code: 'EH_CONFIG_INVALID',
      details: { key: 1 },
    })
    expect(invalidInputError('nope').code).toBe('EH_INVALID_INPUT')
  })

  test('storageError wraps a foreign error once and passes a HarnessError through', () => {
    const cause = new Error('db down')
    const wrapped = storageError('State', 'get', cause)
    expect(wrapped).toMatchObject({ code: 'EH_STORAGE', cause })
    expect(wrapped.message).toBe('State storage failed (get).')
    const own = new HarnessError('EH_INVALID_INPUT', 'x')
    expect(storageError('Message', 'save', own)).toBe(own)
  })

  test('lockFailure: contention is EH_SESSION_BUSY, anything else EH_LOCK_UNAVAILABLE', () => {
    const busy = lockFailure('s1', new HarnessError('EH_SESSION_BUSY', 'held'))
    expect(busy.code).toBe('EH_SESSION_BUSY')
    const down = lockFailure('s1', new Error('ECONNREFUSED'))
    expect(down.code).toBe('EH_LOCK_UNAVAILABLE')
    expect(down.message).toContain('ECONNREFUSED')
    expect(lockFailure('s1', 'timeout').code).toBe('EH_LOCK_UNAVAILABLE')
  })

  test('asInvalidInputError keeps a HarnessError and wraps the rest', () => {
    const own = new HarnessError('EH_STORAGE', 'x')
    expect(asInvalidInputError(own)).toBe(own)
    expect(asInvalidInputError(new Error('bad')).code).toBe('EH_INVALID_INPUT')
    expect(asInvalidInputError('text').message).toBe('text')
  })
})

describe('code lists (one source of truth, documented in spec 10)', () => {
  const spec = readFileSync(
    new URL('../docs/specs/10-errors-and-stop-reasons.md', import.meta.url),
    'utf8',
  )
  const all = [...HARNESS_ERROR_CODES, ...HARNESS_NOTICE_CODES, ...WARNING_CODES]

  test('no code is listed twice', () => {
    expect(new Set(all).size).toBe(all.length)
  })

  test('every code is documented in spec 10', () => {
    const missing = all.filter((code) => !spec.includes(`\`${code}\``))
    expect(missing).toEqual([])
  })

  test('every code used in src (non-test) is declared', () => {
    const declared = new Set<string>(all)
    // `EH_HTTP_*` are wire codes of eharness/http, `EH_INTERNAL` is the HTTP fallback
    const wire = /^EH_(HTTP_|INTERNAL$)/
    const unknown: string[] = []
    const walk = (dir: URL): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const url = new URL(entry.name + (entry.isDirectory() ? '/' : ''), dir)
        if (entry.isDirectory()) walk(url)
        else if (
          /\.ts$/.test(entry.name) &&
          !/(\.test|\.test-d|\.conformance)\.ts$|test-kit/.test(entry.name)
        ) {
          for (const m of readFileSync(url, 'utf8').matchAll(/'((?:EH|W)_[A-Z_]+)'/g)) {
            const code = m[1] as string
            if (!declared.has(code) && !wire.test(code)) unknown.push(`${entry.name}: ${code}`)
          }
        }
      }
    }
    walk(new URL('./', import.meta.url))
    expect(unknown).toEqual([])
  })
})
