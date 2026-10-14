import type { Schedule, ScheduleStore } from '../scheduler/index.ts'
import { assertTrue, uniqueSessionId } from './assert.ts'
import type { ConformanceCase } from './types.ts'

/**
 * Conformance cases for a {@link ScheduleStore} (spec 29 §2): put assigns increasing versions;
 * get/list/delete; `due` returns only active, unclaimed (or expired) rows at or before `now`;
 * `claim` is a compare-and-set (exactly one of many parallel claimers wins, a stale version
 * loses); `complete`/`release` only work for the owner; a paused row is never due or claimable.
 *
 * Claims are judged by `leaseUntil <= now` against the `now` passed to `due`, so the cases use
 * explicit timestamps and need no real clock.
 *
 * @example
 * ```ts
 * for (const c of scheduleStoreConformance(() => myStore(db))) test(c.name, c.run)
 * ```
 * @see docs/specs/29-scheduler.md#9-conformance
 */
export function scheduleStoreConformance(
  factory: () => ScheduleStore | Promise<ScheduleStore>,
): ConformanceCase[] {
  const row = (over: Partial<Schedule> = {}): Schedule => ({
    id: uniqueSessionId('sch'),
    sessionId: uniqueSessionId('s'),
    spec: { kind: 'interval', everyMs: 1000 },
    payload: { hello: 'world' },
    state: 'active',
    overlap: 'skip',
    catchUp: 'skip',
    nextFireAt: 1000,
    version: 0,
    ...over,
  })
  const ids = async (store: ScheduleStore, now: number): Promise<string[]> =>
    (await store.due(now, 1000)).map((s) => s.id)

  return [
    {
      name: 'put creates with version 1 and replaces with an increasing version',
      run: async () => {
        const store = await factory()
        const a = await store.put(row())
        assertTrue(a.version === 1, 'first put has version 1')
        const b = await store.put({ ...a, payload: 2 })
        assertTrue(b.version === 2, 'replace bumps the version')
        const got = await store.get(a.id)
        assertTrue(got?.version === 2 && got.payload === 2, 'get returns the replaced row')
      },
    },
    {
      name: 'get of an unknown id is undefined; delete reports whether a row existed',
      run: async () => {
        const store = await factory()
        assertTrue((await store.get('nope')) === undefined, 'unknown id')
        const a = await store.put(row())
        assertTrue((await store.delete(a.id)) === true, 'delete existing')
        assertTrue((await store.delete(a.id)) === false, 'delete again')
        assertTrue((await store.get(a.id)) === undefined, 'gone')
      },
    },
    {
      name: 'list filters by sessionId and state and pages with a cursor',
      run: async () => {
        const store = await factory()
        const sessionId = uniqueSessionId('list')
        const made: Schedule[] = []
        for (let i = 0; i < 3; i++) made.push(await store.put(row({ sessionId })))
        await store.put(row({ sessionId, state: 'paused' }))
        await store.put(row())
        const active = await store.list({ sessionId, state: 'active' })
        assertTrue(active.items.length === 3, 'session + state filter')
        const seen: string[] = []
        let cursor: string | undefined
        for (let guard = 0; guard < 10; guard++) {
          const page = await store.list({ sessionId, limit: 2, ...(cursor ? { cursor } : {}) })
          assertTrue(page.items.length <= 2, 'page size respected')
          seen.push(...page.items.map((s) => s.id))
          cursor = page.nextCursor
          if (!cursor) break
        }
        assertTrue(seen.length === 4 && new Set(seen).size === 4, 'cursor visits every row once')
      },
    },
    {
      name: 'due returns active rows at or before now, oldest first, honouring the limit',
      run: async () => {
        const store = await factory()
        const late = await store.put(row({ nextFireAt: 500 }))
        const soon = await store.put(row({ nextFireAt: 900 }))
        const future = await store.put(row({ nextFireAt: 5000 }))
        const done = await store.put(row({ nextFireAt: null }))
        const paused = await store.put(row({ nextFireAt: 100, state: 'paused' }))
        const got = await ids(store, 1000)
        assertTrue(got.includes(late.id) && got.includes(soon.id), 'past rows are due')
        assertTrue(!got.includes(future.id), 'future row is not due')
        assertTrue(!got.includes(done.id), 'exhausted row is not due')
        assertTrue(!got.includes(paused.id), 'paused row is not due')
        assertTrue(got.indexOf(late.id) < got.indexOf(soon.id), 'oldest first')
        assertTrue((await store.due(1000, 1)).length === 1, 'limit')
      },
    },
    {
      name: 'claim is a compare-and-set: one winner, a stale version loses',
      run: async () => {
        const store = await factory()
        const a = await store.put(row())
        const results = await Promise.all(
          ['a', 'b', 'c', 'd', 'e'].map((o) => store.claim(a.id, a.version, o, 10_000)),
        )
        const winners = results.filter((r) => r !== undefined)
        assertTrue(winners.length === 1, 'exactly one parallel claimer wins')
        const won = winners[0] as Schedule
        assertTrue(won.version === a.version + 1, 'claim bumps the version')
        assertTrue(won.claimedUntil === 10_000 && won.claimedBy !== undefined, 'claim fields set')
        assertTrue((await store.claim(a.id, a.version, 'z', 20_000)) === undefined, 'stale version')
      },
    },
    {
      name: 'a claimed row is not due until its lease expires, then it can be taken over',
      run: async () => {
        const store = await factory()
        const a = await store.put(row({ nextFireAt: 100 }))
        await store.claim(a.id, a.version, 'dead', 2000)
        assertTrue(!(await ids(store, 1500)).includes(a.id), 'live claim hides the row')
        const due = (await store.due(2000, 10)).find((s) => s.id === a.id)
        assertTrue(due !== undefined && due.claimedBy === 'dead', 'expired claim is due again')
        const taken = await store.claim(a.id, (due as Schedule).version, 'live', 9000)
        assertTrue(taken?.claimedBy === 'live', 'takeover succeeds')
        assertTrue(
          (await store.complete(a.id, 'dead', { nextFireAt: 5000 })) === undefined,
          'the dead owner cannot complete',
        )
      },
    },
    {
      name: 'complete advances and clears the claim; only the owner may complete or release',
      run: async () => {
        const store = await factory()
        const a = await store.put(row())
        await store.claim(a.id, a.version, 'me', 9000)
        assertTrue(
          (await store.complete(a.id, 'other', { nextFireAt: 1 })) === undefined,
          'not owner',
        )
        assertTrue((await store.release(a.id, 'other')) === false, 'release not owner')
        const done = await store.complete(a.id, 'me', { nextFireAt: 7000, lastFireAt: 1000 })
        assertTrue(done?.nextFireAt === 7000 && done.lastFireAt === 1000, 'advanced')
        assertTrue(
          done !== undefined && done.claimedBy === undefined && done.claimedUntil === undefined,
          'claim cleared',
        )
        assertTrue(
          (await store.complete(a.id, 'me', { nextFireAt: 9 })) === undefined,
          'second complete',
        )
      },
    },
    {
      name: 'release clears the claim without advancing and the row is due again',
      run: async () => {
        const store = await factory()
        const a = await store.put(row({ nextFireAt: 100 }))
        await store.claim(a.id, a.version, 'me', 99_000)
        assertTrue((await store.release(a.id, 'me')) === true, 'released')
        const got = await store.get(a.id)
        assertTrue(got?.nextFireAt === 100 && got.claimedBy === undefined, 'not advanced')
        assertTrue((await ids(store, 1000)).includes(a.id), 'due again')
      },
    },
    {
      name: 'a paused row cannot be claimed',
      run: async () => {
        const store = await factory()
        const a = await store.put(row({ state: 'paused' }))
        assertTrue((await store.claim(a.id, a.version, 'me', 9000)) === undefined, 'paused')
      },
    },
    {
      name: 'rows are returned as copies (mutating a result does not change the store)',
      run: async () => {
        const store = await factory()
        const a = await store.put(row({ payload: { n: 1 } }))
        ;(a.payload as { n: number }).n = 99
        const got = await store.get(a.id)
        assertTrue((got?.payload as { n: number } | undefined)?.n === 1, 'isolated')
      },
    },
  ]
}
