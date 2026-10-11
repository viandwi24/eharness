import { describe, expect, test } from 'bun:test'
import { streamLogConformance } from '../testing/stream-log.conformance.ts'
import { inMemoryStreamLog } from './memory.ts'

describe('inMemoryStreamLog() conformance', () => {
  for (const c of streamLogConformance(() => inMemoryStreamLog())) test(c.name, c.run)
})

describe('inMemoryStreamLog()', () => {
  test('retention follows the injected clock, also for an unclosed log', async () => {
    let now = 1_000
    const log = inMemoryStreamLog({ retentionMs: 100, now: () => now })
    const k = { sessionId: 's', turnId: 't' }
    await log.append(k, [{ a: 1 }])
    now += 99
    expect((await log.read(k, 0)).status).toBe('streaming')
    now += 100
    expect((await log.read(k, 0)).status).toBe('missing')
  })

  test('a subscriber registered before the first append is notified', async () => {
    const log = inMemoryStreamLog()
    const k = { sessionId: 's', turnId: 't' }
    let calls = 0
    log.subscribe?.(k, () => calls++)
    await log.append(k, [{ a: 1 }])
    expect(calls).toBe(1)
  })
})
