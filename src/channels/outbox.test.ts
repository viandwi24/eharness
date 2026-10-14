import { describe, expect, test } from 'bun:test'
import { outboxStoreConformance } from '../testing/channels.conformance.ts'
import {
  createOutbox,
  createRateGovernor,
  memoryOutboxStore,
  PermanentSendError,
  RetryAfter,
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
