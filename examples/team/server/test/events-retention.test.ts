/** Events retention: age and count pruning, what survives, and the resync signal for old cursors. */
import { afterEach, describe, expect, test } from 'bun:test'
import { openDatabase } from '../src/infra/db/client.ts'
import { sqliteTaskStore } from '../src/infra/db/tasks-repo.ts'
import { scriptedModelConfig } from '../src/infra/eh/provider.ts'
import { compose, type Server } from '../src/main.ts'

const HOUR = 3_600_000
const NOW = Date.now()

describe('pruneEvents', () => {
  const setup = () => {
    const store = sqliteTaskStore(openDatabase(':memory:').sqlite)
    return store
  }

  test('removes events older than the cutoff, keeps the head and the last message of each agent', () => {
    const store = setup()
    store.appendEvent(
      { type: 'message-added', agentId: 'a1', payload: { preview: 'old a1' } },
      NOW - 100 * HOUR,
    ) // 1: last of a1
    store.appendEvent({ type: 'model-call', payload: {} }, NOW - 99 * HOUR) // 2
    store.appendEvent(
      { type: 'message-added', agentId: 'a2', payload: { preview: 'old a2' } },
      NOW - 98 * HOUR,
    ) // 3
    store.appendEvent(
      { type: 'message-added', agentId: 'a2', payload: { preview: 'newer a2' } },
      NOW - 97 * HOUR,
    ) // 4: last of a2
    store.appendEvent({ type: 'model-call', payload: {} }, NOW - 96 * HOUR) // 5: head, old
    expect(store.prunedThrough()).toBe(0)
    const removed = store.pruneEvents({ before: NOW - 72 * HOUR })
    expect(removed).toBe(2) // seq 2 and 3
    expect(store.events(0, 100).map((e) => e.seq)).toEqual([1, 4, 5])
    expect(store.prunedThrough()).toBe(4) // the head (5) is never pruned
    expect(store.activity().get('a2')?.preview).toBe('newer a2')
    expect(store.activity().get('a1')?.preview).toBe('old a1')
  })

  test('keeps recent events and prunes by count', () => {
    const store = setup()
    for (let i = 0; i < 10; i++) store.appendEvent({ type: 'model-call', payload: {} }, NOW - i)
    expect(store.pruneEvents({ before: NOW - 72 * HOUR })).toBe(0)
    expect(store.prunedThrough()).toBe(0)
    expect(store.pruneEvents({ maxRows: 4 })).toBe(6)
    expect(store.events(0, 100).map((e) => e.seq)).toEqual([7, 8, 9, 10])
    expect(store.prunedThrough()).toBe(6)
    // the mark never goes down, and seq is not reused
    store.pruneEvents({ before: 1 })
    expect(store.prunedThrough()).toBe(6)
    expect(store.appendEvent({ type: 'model-call', payload: {} }, NOW)).toBe(11)
  })
})

describe('resync signal', () => {
  let server: Server | undefined
  afterEach(async () => {
    await server?.close()
    server = undefined
  })

  const boot = (): Server => {
    server = compose({
      dbFile: ':memory:',
      models: scriptedModelConfig('x' as never),
      eventsPollMs: 20,
      events: { pruneEveryMs: 0 },
    })
    return server
  }

  const seed = (s: Server): ReturnType<typeof sqliteTaskStore> => {
    const store = sqliteTaskStore(s.conn.sqlite)
    for (let i = 0; i < 6; i++)
      store.appendEvent({ type: 'model-call', payload: {} }, NOW - 200 * HOUR)
    store.appendEvent({ type: 'model-call', payload: {} }, NOW)
    return store
  }

  test('GET /events flags a cursor older than the retention mark', async () => {
    const s = boot()
    const store = seed(s)
    const head = store.lastSeq()
    const before = (await (await s.app.request(`/events?after=${head - 1}`)).json()) as {
      resync?: boolean
    }
    expect(before.resync).toBeUndefined()
    store.pruneEvents({ before: NOW - 72 * HOUR })
    const stale = (await (await s.app.request('/events?after=2')).json()) as {
      resync?: boolean
      events: Array<{ seq: number }>
    }
    expect(stale.resync).toBe(true)
    const fresh = (await (await s.app.request(`/events?after=${head}`)).json()) as {
      resync?: boolean
    }
    expect(fresh.resync).toBeUndefined()
    const zero = (await (await s.app.request('/events?after=0')).json()) as { resync?: boolean }
    expect(zero.resync).toBeUndefined()
  })

  test('the stream sends a resync frame first, then continues from the mark', async () => {
    const s = boot()
    const store = seed(s)
    store.pruneEvents({ before: NOW - 72 * HOUR })
    const res = await s.app.request('/events/stream?after=2')
    const reader = (res.body as ReadableStream<Uint8Array>).getReader()
    const decoder = new TextDecoder()
    let text = ''
    const end = Date.now() + 4000
    while (!text.includes('model-call') && Date.now() < end) {
      const chunk = await Promise.race([
        reader.read(),
        new Promise<undefined>((r) => setTimeout(() => r(undefined), 200)),
      ])
      if (chunk !== undefined && !chunk.done) text += decoder.decode(chunk.value)
    }
    await reader.cancel()
    expect(text.indexOf('event: resync')).toBeGreaterThan(-1)
    expect(text).toContain('"seq":6')
    expect(text.indexOf('event: resync')).toBeLessThan(text.indexOf('event: model-call'))
    // a current cursor gets no resync
    const ok = await s.app.request(`/events/stream?after=${store.lastSeq()}`)
    const r2 = (ok.body as ReadableStream<Uint8Array>).getReader()
    const first = await r2.read()
    await r2.cancel()
    expect(new TextDecoder().decode(first.value)).not.toContain('resync')
  })
})
