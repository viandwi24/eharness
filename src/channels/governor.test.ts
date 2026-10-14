import { describe, expect, test } from 'bun:test'
import { createRateGovernor } from './index.ts'

/** A fake clock whose sleep advances time. */
function clock() {
  let t = 0
  const sleeps: number[] = []
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms
    },
    sleeps,
    sleep: async (ms: number) => {
      sleeps.push(ms)
      t += ms
    },
  }
}

describe('rate governor', () => {
  test('a bucket serves its burst, then refills', async () => {
    const c = clock()
    const g = createRateGovernor({
      classes: { send: { capacity: 2, refillPerSec: 1 } },
      now: c.now,
      sleep: c.sleep,
    })
    await g.acquire('send')
    await g.acquire('send')
    expect(c.sleeps).toEqual([])
    await g.acquire('send')
    expect(c.sleeps).toEqual([1000])
    expect(g.tryAcquire('send')).toBe(false)
    c.advance(1000)
    expect(g.tryAcquire('send')).toBe(true)
  })

  test('keys have their own buckets; cost above capacity throws', async () => {
    const c = clock()
    const g = createRateGovernor({
      classes: { send: { capacity: 1, refillPerSec: 1 } },
      now: c.now,
      sleep: c.sleep,
    })
    expect(g.tryAcquire('send', 'a')).toBe(true)
    expect(g.tryAcquire('send', 'b')).toBe(true)
    expect(g.tryAcquire('send', 'a')).toBe(false)
    expect(() => g.tryAcquire('send', 'a', 2)).toThrow(
      /EH_INVALID_INPUT|unknown rate class|exceeds the capacity/,
    )
    expect(() => g.tryAcquire('nope')).toThrow(
      /EH_INVALID_INPUT|unknown rate class|exceeds the capacity/,
    )
  })

  test('park holds every call of the key, only extends, and expires', async () => {
    const c = clock()
    const g = createRateGovernor({
      classes: { send: { capacity: 5, refillPerSec: 5 } },
      now: c.now,
      sleep: c.sleep,
    })
    g.park('chat1', 3000, 'flood')
    g.park('chat1', 1000, 'shorter')
    expect(g.parkedFor('chat1')).toBe(3000)
    expect(g.parkedFor('chat2')).toBe(0)
    expect(g.state().parks).toEqual([{ key: 'chat1', until: 3000, reason: 'flood' }])
    await g.acquire('send', 'chat1')
    expect(c.now()).toBe(3000)
    expect(g.state().parks).toEqual([])
    g.park('*', 5000, 'all')
    expect(g.tryAcquire('send', 'other')).toBe(false)
  })

  test('acquire aborts with the signal', async () => {
    const c = clock()
    const ac = new AbortController()
    const g = createRateGovernor({
      classes: { send: { capacity: 1, refillPerSec: 1 } },
      now: c.now,
      sleep: () => new Promise(() => {}), // never resolves: only the abort can end the wait
    })
    g.tryAcquire('send')
    const p = g.acquire('send', '', 1, { signal: ac.signal })
    ac.abort(new Error('stop'))
    await expect(p).rejects.toThrow('stop')
    const pre = new AbortController()
    pre.abort(new Error('early'))
    await expect(g.acquire('send', '', 1, { signal: pre.signal })).rejects.toThrow('early')
  })

  test('state reports tokens', () => {
    const c = clock()
    const g = createRateGovernor({
      classes: { send: { capacity: 4, refillPerSec: 2 } },
      now: c.now,
    })
    g.tryAcquire('send', 'k', 3)
    expect(g.state().buckets[0]).toEqual({ class: 'send', key: 'k', tokens: 1, capacity: 4 })
    c.advance(1000)
    expect(g.state().buckets[0]?.tokens).toBe(3)
  })
})
