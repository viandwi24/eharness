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

describe('rate governor: charge, reserve, per-key classes', () => {
  test('charge takes tokens without waiting; the balance may go negative and the next acquire pays it back', async () => {
    const c = clock()
    const g = createRateGovernor({
      classes: { send: { capacity: 2, refillPerSec: 1 } },
      now: c.now,
      sleep: c.sleep,
    })
    g.charge('send', 'k', 2)
    g.charge('send', 'k', 1)
    expect(g.state().buckets[0]?.tokens).toBe(-1)
    // one token is owed plus one needed: two seconds
    expect(g.waitFor('send', 'k')).toBe(2000)
    const t0 = c.now()
    await g.acquire('send', 'k')
    expect(c.now() - t0).toBe(2000)
  })

  test('reserve leaves tokens behind for interactive callers', async () => {
    const c = clock()
    const g = createRateGovernor({
      classes: { read: { capacity: 3, refillPerSec: 1 } },
      now: c.now,
      sleep: c.sleep,
    })
    expect(g.waitFor('read', 'k', 1, { reserve: 2 })).toBe(0)
    await g.acquire('read', 'k', 1, { reserve: 2 })
    // two tokens left: a patient call needs three to leave two behind
    expect(g.tryAcquire('read', 'k', 1, { reserve: 2 })).toBe(false)
    expect(g.waitFor('read', 'k', 1, { reserve: 2 })).toBe(1000)
    // an interactive call still gets one at once
    expect(g.tryAcquire('read', 'k')).toBe(true)
    // the reserve is clamped to what the bucket can hold
    expect(g.waitFor('read', 'other', 1, { reserve: 99 })).toBe(0)
  })

  test('a class may be a function of the key and follow runtime changes; resetBuckets refills', () => {
    const c = clock()
    let burst = 2
    const g = createRateGovernor({
      classes: { read: (key) => ({ capacity: key === 'big' ? 10 : burst, refillPerSec: 1 }) },
      now: c.now,
      sleep: c.sleep,
    })
    g.charge('read', 'big', 1)
    g.charge('read', 'small', 2)
    expect(g.waitFor('read', 'small')).toBe(1000)
    const tokens = (key: string) => g.state().buckets.find((b) => b.key === key)?.tokens
    expect(tokens('big')).toBe(9)
    burst = 1
    expect(g.waitFor('read', 'small')).toBe(1000)
    g.resetBuckets('small')
    expect(g.state().buckets.map((b) => b.key)).toEqual(['big'])
    expect(g.waitFor('read', 'small')).toBe(0)
  })
})
