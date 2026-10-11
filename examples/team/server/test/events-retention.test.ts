/** Events retention: age and count pruning, what survives, and the resync signal for old cursors. */
import { afterEach, describe, expect, test } from 'bun:test'
import { sqliteActivityStore } from '../src/infra/db/activity-store.ts'
import { openDatabase } from '../src/infra/db/client.ts'
import { sqliteTaskStore } from '../src/infra/db/tasks-repo.ts'
import { scriptedModelConfig } from '../src/infra/eh/provider.ts'
import { compose, type Server } from '../src/main.ts'

const HOUR = 3_600_000
const NOW = Date.now()

/** What the server keeps on retention: the last `message-added` of every agent survives. */
const KEEP = [{ type: 'message-added', by: 'agentId' }] as const

describe('prune (sqlite activity store)', () => {
  const setup = () => {
    const sqlite = openDatabase(':memory:').sqlite
    return { store: sqliteActivityStore(sqlite), tasks: sqliteTaskStore(sqlite) }
  }

  test('removes events older than the cutoff, keeps the head and the last message of each agent', async () => {
    const { store, tasks } = setup()
    await store.append([
      {
        type: 'message-added',
        agentId: 'a1',
        payload: { preview: 'old a1' },
        at: NOW - 100 * HOUR,
      }, // 1: last of a1
      { type: 'model-call', at: NOW - 99 * HOUR }, // 2
      { type: 'message-added', agentId: 'a2', payload: { preview: 'old a2' }, at: NOW - 98 * HOUR }, // 3
      {
        type: 'message-added',
        agentId: 'a2',
        payload: { preview: 'newer a2' },
        at: NOW - 97 * HOUR,
      }, // 4: last of a2
      { type: 'model-call', at: NOW - 96 * HOUR }, // 5: head, old
    ])
    expect(await store.prunedThrough()).toBe(0)
    const removed = await store.prune({ olderThan: NOW - 72 * HOUR, keepLatestOf: KEEP })
    expect(removed.deleted).toBe(2) // seq 2 and 3
    expect((await store.read({ after: 0, limit: 100 })).map((e) => e.seq)).toEqual([1, 4, 5])
    expect(await store.prunedThrough()).toBe(4) // the head (5) is never pruned
    expect(tasks.activity().get('a2')?.preview).toBe('newer a2')
    expect(tasks.activity().get('a1')?.preview).toBe('old a1')
  })

  test('keeps recent events and prunes by count', async () => {
    const { store } = setup()
    for (let i = 0; i < 10; i++) await store.append({ type: 'model-call', at: NOW - i })
    expect((await store.prune({ olderThan: NOW - 72 * HOUR })).deleted).toBe(0)
    expect(await store.prunedThrough()).toBe(0)
    expect((await store.prune({ keepLast: 4 })).deleted).toBe(6)
    expect((await store.read({ after: 0, limit: 100 })).map((e) => e.seq)).toEqual([7, 8, 9, 10])
    expect(await store.prunedThrough()).toBe(6)
    // the mark never goes down, and seq is not reused
    await store.prune({ olderThan: 1 })
    expect(await store.prunedThrough()).toBe(6)
    const [next] = await store.append({ type: 'model-call' })
    expect(next?.seq).toBe(11)
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

  const seed = async (s: Server): Promise<ReturnType<typeof sqliteActivityStore>> => {
    const store = sqliteActivityStore(s.conn.sqlite)
    for (let i = 0; i < 6; i++) await store.append({ type: 'model-call', at: NOW - 200 * HOUR })
    await store.append({ type: 'model-call', at: NOW })
    return store
  }

  test('GET /events flags a cursor older than the retention mark', async () => {
    const s = boot()
    const store = await seed(s)
    const head = await store.lastSeq()
    const before = (await (await s.app.request(`/activity?after=${head - 1}`)).json()) as {
      resync?: boolean
    }
    expect(before.resync).toBeUndefined()
    await store.prune({ olderThan: NOW - 72 * HOUR })
    const stale = (await (await s.app.request('/activity?after=2')).json()) as {
      resync?: boolean
      events: Array<{ seq: number }>
    }
    expect(stale.resync).toBe(true)
    const fresh = (await (await s.app.request(`/activity?after=${head}`)).json()) as {
      resync?: boolean
    }
    expect(fresh.resync).toBeUndefined()
    const zero = (await (await s.app.request('/activity?after=0')).json()) as { resync?: boolean }
    expect(zero.resync).toBeUndefined()
  })

  test('the stream sends a resync frame first, then continues from the mark', async () => {
    const s = boot()
    const store = await seed(s)
    await store.prune({ olderThan: NOW - 72 * HOUR })
    const res = await s.app.request('/activity/stream?after=2')
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
    const ok = await s.app.request(`/activity/stream?after=${await store.lastSeq()}`)
    const r2 = (ok.body as ReadableStream<Uint8Array>).getReader()
    const first = await r2.read()
    await r2.cancel()
    expect(new TextDecoder().decode(first.value)).not.toContain('resync')
  })
})
