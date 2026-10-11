import { describe, expect, test } from 'bun:test'
import type { SessionEvent } from '../agent/session-types.ts'
import { isHarnessError } from '../errors.ts'
import { createEventHub } from './events.ts'

const event = (n: number): SessionEvent =>
  ({ type: 'data', data: { n } }) as unknown as SessionEvent

describe('createEventHub', () => {
  test('a reader that falls too far behind errors with EH_EVENTS_OVERFLOW (not a normal end)', async () => {
    const overflows: unknown[] = []
    const hub = createEventHub({ onOverflow: (info) => overflows.push(info) })
    const slow = hub.stream()
    const fast = hub.stream()
    const fastReader = fast.getReader()
    const received: SessionEvent[] = []
    for (let i = 0; i < 1_100; i++) {
      hub.emit(event(i))
      // the fast reader keeps up
      const next = await fastReader.read()
      if (next.value !== undefined) received.push(next.value)
    }
    expect(received).toHaveLength(1_100)
    expect(overflows).toHaveLength(1)
    expect(hub.readers).toBe(1)
    const reader = slow.getReader()
    let failure: unknown
    try {
      for (;;) {
        const next = await reader.read()
        if (next.done) break
      }
    } catch (error) {
      failure = error
    }
    expect(isHarnessError(failure, 'EH_EVENTS_OVERFLOW')).toBe(true)
  })

  test('every reader receives one shared copy of an emit, not the original object', async () => {
    const hub = createEventHub()
    const a = hub.stream().getReader()
    const b = hub.stream().getReader()
    const original = event(1)
    hub.emit(original)
    const [ra, rb] = await Promise.all([a.read(), b.read()])
    expect(ra.value).toEqual(original)
    expect(ra.value).not.toBe(original)
    expect(rb.value).toBe(ra.value)
  })

  test('close ends every reader normally', async () => {
    const hub = createEventHub()
    const reader = hub.stream().getReader()
    hub.close()
    expect((await reader.read()).done).toBe(true)
  })
})
