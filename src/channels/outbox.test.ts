import { describe, expect, test } from 'bun:test'
import { outboxStoreConformance } from '../testing/channels.conformance.ts'
import {
  createOutbox,
  createRateGovernor,
  memoryOutboxStore,
  PermanentSendError,
  RetryAfter,
  SkipSend,
} from './index.ts'

describe('memoryOutboxStore conformance', () => {
  for (const c of outboxStoreConformance(() => memoryOutboxStore())) test(c.name, c.run)
})

function setup(over: Partial<Parameters<typeof createOutbox>[0]> = {}) {
  let t = 10_000
  const store = memoryOutboxStore({ now: () => t })
  const sent: string[] = []
  const events: string[] = []
  const box = createOutbox({
    store,
    now: () => t,
    random: () => 0,
    send: async (rec) => {
      sent.push(rec.id)
      return { ok: true }
    },
    onEvent: (e) => events.push(e.type),
    ...over,
  })
  return {
    store,
    box,
    sent,
    events,
    advance: (ms: number) => {
      t += ms
    },
    now: () => t,
  }
}

describe('outbox worker', () => {
  test('sends, marks done and stores the result; enqueue is idempotent', async () => {
    const s = setup()
    await s.box.enqueue({ id: 'a', target: 't', payload: 1 })
    await s.box.enqueue({ id: 'a', target: 't', payload: 2 })
    await s.box.drain()
    expect(s.sent).toEqual(['a'])
    const rec = await s.store.get('a')
    expect(rec?.state).toBe('done')
    expect(rec?.result).toEqual({ ok: true })
  })

  test('retries with exponential backoff, then dead-letters at maxAttempts', async () => {
    let calls = 0
    const s = setup({
      backoff: { baseMs: 1000, jitter: 0 },
      breaker: { threshold: 100 },
      send: async () => {
        calls++
        throw new Error('boom')
      },
    })
    await s.box.enqueue({ id: 'a', target: 't', payload: 1, maxAttempts: 3 })
    await s.box.drain()
    expect((await s.store.get('a'))?.availableAt).toBe(s.now() + 1000)
    await s.box.drain()
    expect(calls).toBe(1) // not due yet
    s.advance(1000)
    await s.box.drain()
    expect((await s.store.get('a'))?.availableAt).toBe(s.now() + 2000)
    s.advance(2000)
    await s.box.drain()
    const rec = await s.store.get('a')
    expect(calls).toBe(3)
    expect(rec?.state).toBe('dead')
    expect(rec?.error).toBe('boom')
    expect(s.events).toEqual(['retry', 'retry', 'dead'])
  })

  test('a permanent error dead-letters at once', async () => {
    const s = setup({
      send: async () => {
        throw new PermanentSendError('blocked')
      },
    })
    await s.box.enqueue({ id: 'a', target: 't', payload: 1 })
    await s.box.drain()
    expect((await s.store.get('a'))?.state).toBe('dead')
  })

  test('RetryAfter parks the target in the governor and retries after the wait', async () => {
    let n = 0
    let t = 10_000
    const store = memoryOutboxStore({ now: () => t })
    const governor = createRateGovernor({ classes: {}, now: () => t })
    const sent: string[] = []
    const box = createOutbox({
      store,
      governor,
      now: () => t,
      send: async (rec) => {
        if (n++ === 0) throw new RetryAfter(5000)
        sent.push(rec.id)
        return null
      },
    })
    await box.enqueue({ id: 'a', target: 'chat1', payload: 1 })
    await box.enqueue({ id: 'b', target: 'chat1', payload: 1, availableAt: t + 1 })
    await box.drain()
    expect(governor.parkedFor('chat1')).toBe(5000)
    t += 1
    await box.drain() // b is due but the target is parked: deferred, no attempt used
    expect(sent).toEqual([])
    expect((await store.get('b'))?.attempts).toBe(0)
    t += 5000
    await box.drain()
    expect(sent.sort()).toEqual(['a', 'b'])
  })

  test('the breaker opens after N failures, holds items, and half-opens after the cool-down', async () => {
    let fail = true
    const s = setup({
      backoff: { baseMs: 1, jitter: 0 },
      breaker: { threshold: 2, cooldownMs: 10_000 },
      send: async () => {
        if (fail) throw new Error('down')
        return null
      },
    })
    for (const id of ['a', 'b', 'c']) {
      await s.box.enqueue({ id, target: 't', payload: 1, maxAttempts: 10 })
    }
    await s.box.drain()
    s.advance(10)
    await s.box.drain()
    expect(s.box.breaker('t').state).toBe('open')
    const attemptsOpen = (await s.store.list()).map((r) => r.attempts)
    s.advance(100)
    await s.box.drain() // open: held, attempts unchanged
    expect((await s.store.list()).map((r) => r.attempts)).toEqual(attemptsOpen)
    expect(s.box.breaker('other').state).toBe('closed')
    s.advance(10_000)
    expect(s.box.breaker('t').state).toBe('half-open')
    fail = false
    await s.box.drain()
    expect(s.box.breaker('t').state).toBe('closed')
    s.advance(60_000)
    await s.box.drain()
    expect((await s.store.list({ state: 'done' })).length).toBe(3)
    expect(s.events).toContain('breaker-open')
    expect(s.events).toContain('breaker-close')
  })

  test('two workers on one store never double-send', async () => {
    const t = 10_000
    const store = memoryOutboxStore({ now: () => t })
    const sent: string[] = []
    const mk = (owner: string) =>
      createOutbox({
        store,
        owner,
        now: () => t,
        batch: 5,
        send: async (rec) => {
          await Promise.resolve()
          sent.push(rec.id)
          return null
        },
      })
    const w1 = mk('w1')
    const w2 = mk('w2')
    for (let i = 0; i < 30; i++) await w1.enqueue({ id: `i${i}`, target: `t${i % 3}`, payload: i })
    await Promise.all([w1.drain(), w2.drain()])
    expect(sent.length).toBe(30)
    expect(new Set(sent).size).toBe(30)
  })

  test('same-target items are sent in order', async () => {
    const order: string[] = []
    const s = setup({
      send: async (rec) => {
        await Promise.resolve()
        order.push(rec.id)
        return null
      },
    })
    for (const id of ['a', 'b', 'c']) {
      await s.box.enqueue({ id, target: 't', payload: 1, availableAt: 1 })
    }
    await s.box.drain()
    expect(order).toEqual(['a', 'b', 'c'])
  })

  test('start polls; stop waits for in-flight work', async () => {
    const s = setup({ pollMs: 5 })
    s.box.start()
    await s.box.enqueue({ id: 'a', target: 't', payload: 1 })
    for (let i = 0; i < 100 && s.sent.length === 0; i++) await new Promise((r) => setTimeout(r, 5))
    await s.box.stop()
    expect(s.sent).toEqual(['a'])
  })

  test('flush drains and returns the record', async () => {
    const s = setup()
    await s.box.enqueue({ id: 'a', target: 't', payload: 1 })
    expect((await s.box.flush('a'))?.state).toBe('done')
  })
})

describe('flood storm', () => {
  function stormSetup(
    floodStorm: Parameters<typeof createOutbox>[0]['floodStorm'],
    retryFor: (target: string) => number | undefined,
  ) {
    let t = 10_000
    const store = memoryOutboxStore({ now: () => t })
    const events: Array<{ type: string; target?: string; until?: number }> = []
    const sent: string[] = []
    const box = createOutbox({
      store,
      now: () => t,
      random: () => 0,
      breaker: { threshold: 100, cooldownMs: 1000 },
      floodStorm,
      send: async (rec) => {
        const ms = retryFor(rec.target)
        if (ms !== undefined) throw new RetryAfter(ms)
        sent.push(rec.id)
        return null
      },
      onEvent: (e) => events.push(e as { type: string }),
    })
    return {
      box,
      store,
      events,
      sent,
      advance: (ms: number) => {
        t += ms
      },
    }
  }

  test('N rate limits in the window open the breaker for the longest retry-after seen', async () => {
    let limit: number | undefined = 100
    let ms = 100
    const s = stormSetup({ count: 3, windowMs: 60_000 }, () =>
      limit === undefined ? undefined : ms,
    )
    await s.box.enqueue({ id: 'a', target: 'chat1', payload: 1, maxAttempts: 50 })
    for (const m of [100, 5000, 200]) {
      ms = m
      await s.box.drain()
      s.advance(m)
    }
    expect(s.events.filter((e) => e.type === 'rate-limited')).toHaveLength(3)
    const storm = s.events.find((e) => e.type === 'storm')
    expect(storm?.target).toBe('chat1')
    expect(s.box.breaker('chat1').state).toBe('open')
    // held for the longest retry-after (5000), not just the cooldown (1000)
    expect(storm?.until).toBe(s.box.breaker('chat1').until)
    limit = undefined
    s.advance(4000)
    await s.box.drain()
    expect(s.sent).toEqual([])
    s.advance(2000)
    await s.box.drain()
    expect(s.sent).toEqual(['a'])
    expect(s.box.breaker('chat1').state).toBe('closed')
  })

  test('rate limits outside the window do not add up', async () => {
    const s = stormSetup({ count: 2, windowMs: 1000 }, () => 10)
    await s.box.enqueue({ id: 'a', target: 'c', payload: 1, maxAttempts: 50 })
    await s.box.drain()
    s.advance(5000)
    await s.box.drain()
    expect(s.events.some((e) => e.type === 'storm')).toBe(false)
  })

  test('count 0 disables detection', async () => {
    const s = stormSetup({ count: 0 }, () => 10)
    await s.box.enqueue({ id: 'a', target: 'c', payload: 1, maxAttempts: 50 })
    for (let i = 0; i < 8; i++) {
      await s.box.drain()
      s.advance(20)
    }
    expect(s.events.some((e) => e.type === 'storm')).toBe(false)
  })

  test('global scope counts across targets and holds every target', async () => {
    let limited = true
    const s = stormSetup({ count: 3, windowMs: 60_000, scope: 'global' }, (t) =>
      limited && t !== 'quiet' ? 50 : undefined,
    )
    for (const t of ['x', 'y', 'z']) {
      await s.box.enqueue({ id: t, target: t, payload: 1, maxAttempts: 50 })
    }
    await s.box.drain()
    expect(s.events.find((e) => e.type === 'storm')?.target).toBe('*')
    expect(s.box.breaker('quiet').state).toBe('open')
    limited = false
    await s.box.enqueue({ id: 'q', target: 'quiet', payload: 1 })
    await s.box.drain()
    expect(s.sent).toEqual([]) // held
    s.advance(1100)
    await s.box.drain()
    expect(s.sent.sort()).toEqual(['q', 'x', 'y', 'z'])
  })
})

describe('expired leases', () => {
  /** An item a crashed worker claimed: its lease ended before the worker under test runs. */
  async function crashed(over: Partial<Parameters<typeof createOutbox>[0]>) {
    const s = setup(over)
    await s.box.enqueue({ id: 'a', target: 't', payload: 1, maxAttempts: 1 })
    await s.store.claim(s.now(), 'dead-worker', 1000, 1)
    s.advance(5000)
    return s
  }

  test("'retry' (default) sends the item again", async () => {
    const s = await crashed({ owner: 'w2' })
    // attempts exhausted: the default policy dead-letters it instead, as before
    await s.box.drain()
    expect((await s.store.get('a'))?.state).toBe('dead')
    const s2 = setup({ owner: 'w2' })
    await s2.box.enqueue({ id: 'b', target: 't', payload: 1 })
    await s2.store.claim(s2.now(), 'dead-worker', 1000, 1)
    s2.advance(5000)
    await s2.box.drain()
    expect(s2.sent).toEqual(['b'])
  })

  test("'hold' parks the item as held, never resends it, and release resolves it", async () => {
    const s = await crashed({ expiredLeases: 'hold', owner: 'w2' })
    await s.box.drain()
    expect(s.sent).toEqual([])
    expect(s.events).toContain('held')
    expect((await s.store.list({ state: 'held' })).map((r) => r.id)).toEqual(['a'])
    // a held item is reported once, not on every tick
    s.events.length = 0
    await s.box.drain()
    expect(s.events).not.toContain('held')
    const back = await s.box.release('a', 'retry')
    expect(back?.state).toBe('pending')
    await s.box.drain()
    expect(s.sent).toEqual(['a'])
    expect((await s.store.get('a'))?.state).toBe('done')
  })

  test("'hold' then drop settles the item skipped", async () => {
    const s = await crashed({ expiredLeases: 'hold', owner: 'w2' })
    await s.box.drain()
    expect((await s.box.release('a', 'drop'))?.state).toBe('skipped')
    expect(await s.box.release('a', 'retry')).toBeUndefined()
    await s.box.drain()
    expect(s.sent).toEqual([])
  })
})

describe('skipped items', () => {
  test('SkipSend settles the item skipped with the reason and emits an event', async () => {
    const seen: unknown[] = []
    const s = setup({
      send: async () => {
        throw new SkipSend('the chat is gone')
      },
      onEvent: (e) => seen.push(e),
    })
    await s.box.enqueue({ id: 'a', target: 't', payload: 1 })
    const rec = await s.box.flush('a')
    expect(rec?.state).toBe('skipped')
    expect(rec?.error).toBe('the chat is gone')
    expect(seen).toContainEqual({
      type: 'skipped',
      id: 'a',
      target: 't',
      reason: 'the chat is gone',
    })
    expect(s.box.breaker('t').failures).toBe(0)
  })
})

describe('external breaker and shared storm detector', () => {
  test('openBreaker defers items without using an attempt, then lets one trial pass', async () => {
    const seen: Array<{ type: string; reason?: string }> = []
    const s = setup({ breaker: { cooldownMs: 1000 }, onEvent: (e) => seen.push(e) })
    await s.box.enqueue({ id: 'a', target: 't', payload: 1 })
    s.box.openBreaker('t', s.now() + 5000, 'fatal: bad token')
    expect(seen.find((e) => e.type === 'breaker-open')?.reason).toBe('fatal: bad token')
    expect(s.box.breaker('t').state).toBe('open')
    await s.box.drain()
    expect(s.sent).toEqual([])
    expect((await s.store.get('a'))?.attempts).toBe(0)
    s.advance(5000)
    expect(s.box.breaker('t').state).toBe('half-open')
    await s.box.drain()
    expect(s.sent).toEqual(['a'])
    expect(s.box.breaker('t').state).toBe('closed')
    s.box.openBreaker('t', s.now() + 5000)
    s.box.resetBreaker('t')
    expect(s.box.breaker('t').state).toBe('closed')
  })

  test('noteRateLimit feeds the storm; stormKey maps per-chat park keys to the connection', async () => {
    const seen: Array<{ type: string; target?: string; id?: string }> = []
    const s = setup({
      floodStorm: { count: 3, windowMs: 60_000, stormKey: (k) => k.split('\n')[0] ?? k },
      breaker: { cooldownMs: 1000 },
      onEvent: (e) => seen.push(e as { type: string }),
    })
    s.box.noteRateLimit('c\nchat1', 100)
    s.box.noteRateLimit('c\nchat2', 4000)
    expect(s.box.floods('c')).toBe(2)
    expect(seen.find((e) => e.type === 'rate-limited')?.id).toBe('')
    expect(s.box.breaker('c').state).toBe('closed')
    s.box.noteRateLimit('c\nchat1', 100)
    expect(seen.find((e) => e.type === 'storm')?.target).toBe('c')
    expect(s.box.breaker('c').state).toBe('open')
    expect(s.box.floods('c')).toBe(0)
    // held for the longest retry-after seen (4000), not just the cooldown (1000)
    s.advance(3000)
    expect(s.box.breaker('c').state).toBe('open')
    s.advance(1100)
    expect(s.box.breaker('c').state).toBe('half-open')
  })

  test('a RetryAfter marked counted is parked but not counted again; count and window may be functions', async () => {
    let n = 0
    const s = setup({
      floodStorm: { count: () => 2, windowMs: () => 60_000 },
      send: async () => {
        n++
        throw new RetryAfter(10, { counted: true })
      },
    })
    await s.box.enqueue({ id: 'a', target: 't', payload: 1, maxAttempts: 50 })
    for (let i = 0; i < 4; i++) {
      await s.box.drain()
      s.advance(20)
    }
    expect(n).toBeGreaterThan(2)
    expect(s.events).not.toContain('storm')
    s.box.noteRateLimit('t', 10)
    s.box.noteRateLimit('t', 10)
    expect(s.events).toContain('storm')
  })
})
