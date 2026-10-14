import { describe, expect, test } from 'bun:test'
import { isHarnessError } from '../index.ts'
import { scheduleStoreConformance } from '../testing/scheduler.conformance.ts'
import { memoryScheduleStore } from './memory.ts'
import { type CronNext, createScheduler } from './scheduler.ts'
import type { FireContext, ScheduleStore } from './types.ts'

describe('memoryScheduleStore conformance', () => {
  for (const c of scheduleStoreConformance(() => memoryScheduleStore())) test(c.name, c.run)
})

/** Hourly cron stand-in: every full hour. */
const hourly: CronNext = (_expr, after) => (Math.floor(after / 3_600_000) + 1) * 3_600_000

function setup(opts: { store?: ScheduleStore; owner?: string; start?: number } = {}) {
  const clock = { t: opts.start ?? 0 }
  const fires: FireContext[] = []
  const store = opts.store ?? memoryScheduleStore()
  const scheduler = createScheduler({
    store,
    next: hourly,
    now: () => clock.t,
    tickMs: 1000,
    leaseMs: 5000,
    ...(opts.owner ? { owner: opts.owner } : {}),
    fire: (ctx) => {
      fires.push(ctx)
    },
  })
  return { clock, fires, store, scheduler }
}

describe('scheduler', () => {
  test('interval fires on time with a deterministic id and advances', async () => {
    const { clock, fires, scheduler } = setup()
    const s = await scheduler.create({
      id: 'a',
      sessionId: 'x',
      spec: { kind: 'interval', everyMs: 1000 },
      payload: 'p',
    })
    expect(s.nextFireAt).toBe(1000)
    clock.t = 999
    expect((await scheduler.tick()).fired).toHaveLength(0)
    clock.t = 1000
    await scheduler.tick()
    expect(fires.map((f) => f.fireId)).toEqual(['sched:a:1000'])
    expect(fires[0]?.schedule.payload).toBe('p')
    expect((await scheduler.store.get('a'))?.nextFireAt).toBe(2000)
    expect((await scheduler.store.get('a'))?.lastFireAt).toBe(1000)
  })

  test('once fires a single time then is exhausted', async () => {
    const { clock, fires, scheduler } = setup()
    await scheduler.create({ id: 'o', sessionId: 'x', spec: { kind: 'once', at: 500 } })
    clock.t = 500
    await scheduler.tick()
    clock.t = 10_000
    await scheduler.tick()
    expect(fires).toHaveLength(1)
    expect((await scheduler.store.get('o'))?.nextFireAt).toBeNull()
  })

  test('cron uses the injected next; without it creation is refused', async () => {
    const { clock, fires, scheduler } = setup()
    const s = await scheduler.create({
      id: 'c',
      sessionId: 'x',
      spec: { kind: 'cron', expr: '0 * * * *' },
    })
    expect(s.nextFireAt).toBe(3_600_000)
    clock.t = 3_600_000
    await scheduler.tick()
    expect(fires).toHaveLength(1)
    expect((await scheduler.store.get('c'))?.nextFireAt).toBe(7_200_000)
    const bare = createScheduler({ store: memoryScheduleStore(), fire: () => {} })
    const err = await bare
      .create({ sessionId: 'x', spec: { kind: 'cron', expr: '* * * * *' } })
      .catch((e: unknown) => e)
    expect(isHarnessError(err, 'EH_INVALID_INPUT')).toBe(true)
    // interval and once work without next
    await bare.create({ sessionId: 'x', spec: { kind: 'interval', everyMs: 10 } })
  })

  test('catch-up skip drops missed slots, once fires the latest, max fires the latest n', async () => {
    // now = 9500, grace = 2000: slots 1000..7000 are missed, 8000 and 9000 are fresh
    for (const [catchUp, expected] of [
      ['skip', [9000]],
      ['once', [7000, 9000]],
      [{ max: 2 }, [6000, 7000, 9000]],
    ] as const) {
      const { clock, fires, scheduler } = setup()
      await scheduler.create({
        id: 'm',
        sessionId: 'x',
        spec: { kind: 'interval', everyMs: 1000 },
        catchUp,
      })
      clock.t = 9500
      const r = await scheduler.tick()
      expect(fires.map((f) => f.scheduledAt)).toEqual([...expected])
      expect(r.skipped.length).toBeGreaterThan(0)
      expect((await scheduler.store.get('m'))?.nextFireAt).toBe(10_000)
    }
  })

  test('overlap queue fires every fresh slot, skip only the latest', async () => {
    const q = setup()
    await q.scheduler.create({
      id: 'q',
      sessionId: 'x',
      spec: { kind: 'interval', everyMs: 500 },
      overlap: 'queue',
    })
    q.clock.t = 1500
    await q.scheduler.tick()
    expect(q.fires.map((f) => f.scheduledAt)).toEqual([500, 1000, 1500])
    const s = setup()
    await s.scheduler.create({ id: 's', sessionId: 'x', spec: { kind: 'interval', everyMs: 500 } })
    s.clock.t = 1500
    const r = await s.scheduler.tick()
    expect(s.fires.map((f) => f.scheduledAt)).toEqual([1500])
    expect(r.skipped.every((k) => k.reason === 'overlap')).toBe(true)
  })

  test('a slow fire holds the claim: a second scheduler does not fire the slot', async () => {
    const store = memoryScheduleStore()
    const clock = { t: 0 }
    const seen: string[] = []
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => {
      release = r
    })
    const a = createScheduler({
      store,
      owner: 'a',
      now: () => clock.t,
      fire: async (c) => {
        seen.push(`a:${c.fireId}`)
        await gate
      },
    })
    const b = createScheduler({
      store,
      owner: 'b',
      now: () => clock.t,
      fire: (c) => {
        seen.push(`b:${c.fireId}`)
      },
    })
    await a.create({ id: 'z', sessionId: 'x', spec: { kind: 'interval', everyMs: 1000 } })
    clock.t = 1000
    const first = a.tick()
    await new Promise((r) => setTimeout(r, 5))
    expect((await b.tick()).claimed).toBe(0)
    release()
    await first
    expect(seen).toEqual(['a:sched:z:1000'])
  })

  test('two schedulers on one store never double-fire the same fireId', async () => {
    const store = memoryScheduleStore()
    const clock = { t: 0 }
    const seen: string[] = []
    const mk = (owner: string) =>
      createScheduler({
        store,
        owner,
        now: () => clock.t,
        fire: (c) => {
          seen.push(c.fireId)
        },
      })
    const [a, b, c] = [mk('a'), mk('b'), mk('c')] as const
    await a.create({ id: 'k', sessionId: 'x', spec: { kind: 'interval', everyMs: 1000 } })
    for (let i = 1; i <= 5; i++) {
      clock.t = i * 1000
      await Promise.all([a.tick(), b.tick(), c.tick()])
    }
    expect(seen).toHaveLength(5)
    expect(new Set(seen).size).toBe(5)
  })

  test('pause stops fires; resume drops what passed meanwhile', async () => {
    const { clock, fires, scheduler } = setup()
    await scheduler.create({ id: 'p', sessionId: 'x', spec: { kind: 'interval', everyMs: 1000 } })
    await scheduler.pause('p')
    clock.t = 5000
    await scheduler.tick()
    expect(fires).toHaveLength(0)
    const r = await scheduler.resume('p')
    expect(r.state).toBe('active')
    expect(r.nextFireAt).toBe(6000)
    clock.t = 6000
    await scheduler.tick()
    expect(fires.map((f) => f.scheduledAt)).toEqual([6000])
  })

  test('lease recovery: a dead owner’s slot fires again with the same id', async () => {
    const { clock, fires, store, scheduler } = setup()
    await scheduler.create({ id: 'l', sessionId: 'x', spec: { kind: 'interval', everyMs: 1000 } })
    const row = await store.get('l')
    clock.t = 1000
    await store.claim('l', row?.version ?? 0, 'dead', 1000 + 5000)
    expect((await scheduler.tick()).claimed).toBe(0)
    clock.t = 6000
    const r = await scheduler.tick()
    expect(r.recovered).toBe(1)
    expect(fires.map((f) => f.fireId)).toEqual(['sched:l:6000'])
  })

  test('a failing fire releases the row, reports, and retries next tick', async () => {
    const store = memoryScheduleStore()
    const clock = { t: 0 }
    const errors: unknown[] = []
    let fail = true
    const ids: string[] = []
    const sc = createScheduler({
      store,
      now: () => clock.t,
      onError: (e) => errors.push(e),
      fire: (c) => {
        if (fail) throw new Error('boom')
        ids.push(c.fireId)
      },
    })
    await sc.create({ id: 'f', sessionId: 'x', spec: { kind: 'once', at: 100 }, catchUp: 'once' })
    clock.t = 100
    expect((await sc.tick()).failed).toBe(1)
    expect(errors).toHaveLength(1)
    fail = false
    await sc.tick()
    expect(ids).toEqual(['sched:f:100'])
  })

  test('update with a new spec recomputes nextFireAt; remove deletes; fireNow fires', async () => {
    const { clock, fires, scheduler } = setup({ start: 100 })
    await scheduler.create({ id: 'u', sessionId: 'x', spec: { kind: 'interval', everyMs: 1000 } })
    const u = await scheduler.update('u', { spec: { kind: 'interval', everyMs: 50 }, payload: 1 })
    expect(u.nextFireAt).toBe(150)
    clock.t = 120
    expect(await scheduler.fireNow('u')).toBe('sched:u:120')
    expect(fires[0]?.schedule.payload).toBe(1)
    expect(await scheduler.remove('u')).toBe(true)
    const err = await scheduler.pause('u').catch((e: unknown) => e)
    expect(isHarnessError(err, 'EH_INVALID_INPUT')).toBe(true)
  })

  test('start/stop runs the ticker and stop awaits the in-flight tick', async () => {
    const store = memoryScheduleStore()
    let n = 0
    const sc = createScheduler({ store, tickMs: 10, fire: () => void n++ })
    await sc.create({ sessionId: 'x', spec: { kind: 'interval', everyMs: 5 } })
    sc.start()
    await new Promise((r) => setTimeout(r, 60))
    await sc.stop()
    const after = n
    expect(after).toBeGreaterThan(0)
    await new Promise((r) => setTimeout(r, 40))
    expect(n).toBe(after)
  })
})
