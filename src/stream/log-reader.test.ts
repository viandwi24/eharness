import { describe, expect, test } from 'bun:test'
import type { StreamLogAdapter } from '../agent/session-types.ts'
import { isHarnessError } from '../errors.ts'
import { until } from '../testing/test-utils.ts'
import { createLogStream, PROBE_FAILURE_LIMIT } from './log-reader.ts'

/** A log that is "streaming" and empty forever. */
const idleLog: StreamLogAdapter = {
  async append() {
    return 0
  },
  async close() {},
  async read() {
    return { chunks: [], next: 0, status: 'streaming' }
  },
}

describe('createLogStream: a failing isActive probe (K-11, P3-23)', () => {
  test('errors with EH_STORAGE after N consecutive failures, warning rate-limited', async () => {
    const warnings: unknown[] = []
    let probes = 0
    const { stream, ended } = createLogStream({
      adapter: idleLog,
      key: { sessionId: 's', turnId: 't' },
      from: 0,
      pollMs: 1,
      isActive: async () => {
        probes++
        throw new Error('state store down')
      },
      warn: (message, data) => warnings.push({ message, data }),
    })
    let failure: unknown
    try {
      for await (const _ of stream) {
        // no chunks
      }
    } catch (error) {
      failure = error
    }
    expect(isHarnessError(failure, 'EH_STORAGE')).toBe(true)
    expect(probes).toBe(PROBE_FAILURE_LIMIT)
    expect(warnings).toHaveLength(2) // the first and the last failure, not every poll
    expect((await ended).status).toBe('error')
  })

  test('one successful probe resets the count', async () => {
    let calls = 0
    const { stream, ended } = createLogStream({
      adapter: idleLog,
      key: { sessionId: 's', turnId: 't' },
      from: 0,
      pollMs: 1,
      isActive: async () => {
        calls++
        if (calls % 3 === 0) return true
        throw new Error('flaky')
      },
    })
    const reader = stream.getReader()
    const pending = reader.read()
    await until('probe failures exceeded the limit', () => calls > PROBE_FAILURE_LIMIT)
    expect(calls).toBeGreaterThan(PROBE_FAILURE_LIMIT)
    await reader.cancel()
    await pending.catch(() => {})
    expect((await ended).status).toBe('orphaned')
  })
})
