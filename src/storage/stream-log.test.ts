import { describe, expect, test } from 'bun:test'
import { streamLogConformance } from '../testing/stream-log.conformance.ts'
import { memoryStreamLog } from './memory.ts'

describe('memoryStreamLog() conformance', () => {
  for (const c of streamLogConformance(() => memoryStreamLog())) test(c.name, c.run)
})

describe('memoryStreamLog()', () => {
  test('retention follows the injected clock, also for an unclosed log', async () => {
    let now = 1_000
    const log = memoryStreamLog({ retentionMs: 100, now: () => now })
    const k = { sessionId: 's', turnId: 't' }
    await log.append(k, [{ a: 1 }])
    now += 99
    expect((await log.read(k, 0)).status).toBe('streaming')
    now += 100
    expect((await log.read(k, 0)).status).toBe('missing')
  })

  test('a subscriber registered before the first append is notified', async () => {
    const log = memoryStreamLog()
    const k = { sessionId: 's', turnId: 't' }
    let calls = 0
    log.subscribe?.(k, () => calls++)
    await log.append(k, [{ a: 1 }])
    expect(calls).toBe(1)
  })
})
