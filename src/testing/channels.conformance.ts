import type { OutboxItem, OutboxStore } from '../channels/index.ts'
import { assertJsonEqual, assertTrue } from './assert.ts'
import type { ConformanceCase } from './types.ts'

/** What the factory of {@link outboxStoreConformance} returns: a fresh, empty store. */
export interface OutboxStoreUnderTest {
  store: OutboxStore
  /** A second handle on the SAME store (another process object). Default: `store` itself. */
  peer?: () => OutboxStore
}

const item = (id: string, over: Partial<OutboxItem> = {}): OutboxItem => ({
  id,
  target: 't1',
  payload: { text: id },
  availableAt: 1000,
  attempts: 0,
  maxAttempts: 3,
  ...over,
})

/**
 * Conformance cases for an {@link OutboxStore} (spec 31 §3): idempotent enqueue, due-only claims in
 * order, exclusive leases (also across handles), lease expiry takeover, owner-checked
 * succeed/fail/defer, retry vs dead-letter, attempts accounting, listing and purge.
 *
 * Times are explicit epoch values; `purge` uses the store's own clock, so its case purges with a
 * far-future cutoff.
 *
 * @see docs/specs/31-channels.md#3-outbox
 */
export function outboxStoreConformance(
  factory: () => OutboxStoreUnderTest | Promise<OutboxStoreUnderTest> | OutboxStore,
): ConformanceCase[] {
  const make = async (): Promise<{ store: OutboxStore; peer: () => OutboxStore }> => {
    const made = await factory()
    if ('enqueue' in made) return { store: made, peer: () => made }
    return { store: made.store, peer: made.peer ?? (() => made.store) }
  }
  const cases: ConformanceCase[] = []
  const add = (
    name: string,
    run: (s: OutboxStore, peer: () => OutboxStore) => Promise<void>,
  ): void => {
    cases.push({
      name,
      run: async () => {
        const { store, peer } = await make()
        await run(store, peer)
      },
    })
  }

  add('enqueue is idempotent by id and keeps the first payload', async (s) => {
    const a = await s.enqueue(item('a'))
    const b = await s.enqueue(item('a', { payload: { text: 'other' } }))
    assertTrue(a.created && !b.created, 'second enqueue must report created: false')
    assertJsonEqual(b.record.payload, { text: 'a' }, 'payload of the existing record')
    assertTrue((await s.list()).length === 1, 'one record')
  })

  add('claim returns only due items, oldest first, and counts the attempt', async (s) => {
    await s.enqueue(item('late', { availableAt: 5000 }))
    await s.enqueue(item('b', { availableAt: 1200 }))
    await s.enqueue(item('a', { availableAt: 1100 }))
    const got = await s.claim(2000, 'w1', 1000, 10)
    assertJsonEqual(
      got.map((r) => r.id),
      ['a', 'b'],
      'claimed ids',
    )
    assertTrue(
      got.every((r) => r.attempts === 1 && r.state === 'claimed'),
      'attempt counted',
    )
    assertTrue(
      (await s.claim(2000, 'w1', 1000, 10)).length === 0,
      'leased items are not claimed again',
    )
  })

  add('claim respects limit', async (s) => {
    for (const id of ['a', 'b', 'c']) await s.enqueue(item(id))
    assertTrue((await s.claim(2000, 'w1', 1000, 2)).length === 2, 'limit 2')
    assertTrue((await s.claim(2000, 'w1', 1000, 2)).length === 1, 'the rest')
  })

  add('two owners never claim the same item', async (s, peer) => {
    for (let i = 0; i < 20; i++) await s.enqueue(item(`i${i}`))
    const [x, y] = await Promise.all([
      s.claim(2000, 'w1', 1000, 20),
      peer().claim(2000, 'w2', 1000, 20),
    ])
    const ids = [...x, ...y].map((r) => r.id)
    assertTrue(ids.length === 20 && new Set(ids).size === 20, 'each item claimed exactly once')
  })

  add('an expired lease is claimable again; the old owner is fenced out', async (s) => {
    await s.enqueue(item('a'))
    await s.claim(2000, 'w1', 1000, 1)
    assertTrue((await s.claim(2500, 'w2', 1000, 1)).length === 0, 'lease still valid')
    const again = await s.claim(3000, 'w2', 1000, 1)
    assertTrue(again.length === 1 && again[0]?.attempts === 2, 'taken over, attempt 2')
    assertTrue(!(await s.succeed('a', 'w1')), 'stale owner cannot succeed')
    assertTrue((await s.fail('a', 'w1', { error: 'x' })) === undefined, 'stale owner cannot fail')
    assertTrue(await s.succeed('a', 'w2', { ok: true }), 'current owner succeeds')
    const rec = await s.get('a')
    assertTrue(rec?.state === 'done', 'done')
    assertJsonEqual(rec?.result, { ok: true }, 'result stored')
  })

  add('an expired lease on an item with no attempts left is dead-lettered', async (s) => {
    await s.enqueue(item('a', { maxAttempts: 1 }))
    await s.claim(2000, 'w1', 1000, 1)
    assertTrue((await s.claim(4000, 'w2', 1000, 1)).length === 0, 'not claimed')
    assertTrue((await s.get('a'))?.state === 'dead', 'dead')
  })

  add('fail retries until maxAttempts, then dead-letters', async (s) => {
    await s.enqueue(item('a', { maxAttempts: 2 }))
    await s.claim(2000, 'w', 1000, 1)
    assertTrue((await s.fail('a', 'w', { error: 'e1', retryAt: 3000 })) === 'pending', 'pending')
    assertTrue((await s.claim(2500, 'w', 1000, 1)).length === 0, 'not due before retryAt')
    assertTrue((await s.claim(3000, 'w', 1000, 1)).length === 1, 'due at retryAt')
    assertTrue((await s.fail('a', 'w', { error: 'e2', retryAt: 4000 })) === 'dead', 'dead')
    const rec = await s.get('a')
    assertTrue(rec?.state === 'dead' && rec.error === 'e2', 'dead with the last error')
  })

  add('a permanent failure dead-letters at once', async (s) => {
    await s.enqueue(item('a'))
    await s.claim(2000, 'w', 1000, 1)
    assertTrue((await s.fail('a', 'w', { error: 'bad', permanent: true })) === 'dead', 'dead')
  })

  add('defer gives the item back without counting the attempt', async (s) => {
    await s.enqueue(item('a'))
    await s.claim(2000, 'w', 1000, 1)
    assertTrue(await s.defer('a', 'w', 6000), 'deferred')
    assertTrue(!(await s.defer('a', 'w', 7000)), 'no longer held')
    const rec = await s.get('a')
    assertTrue(rec?.state === 'pending' && rec.attempts === 0 && rec.availableAt === 6000, 'record')
    assertTrue((await s.claim(5000, 'w', 1000, 1)).length === 0, 'not due yet')
    assertTrue((await s.claim(6000, 'w', 1000, 1)).length === 1, 'due')
  })

  add('list filters by state and honours limit', async (s) => {
    await s.enqueue(item('a'))
    await s.enqueue(item('b'))
    await s.claim(2000, 'w', 1000, 1)
    assertTrue((await s.list({ state: 'claimed' })).length === 1, 'one claimed')
    assertTrue((await s.list({ state: 'pending' })).length === 1, 'one pending')
    assertTrue((await s.list({ limit: 1 })).length === 1, 'limit')
    assertTrue((await s.get('missing')) === undefined, 'get of a missing id')
  })

  add('purge removes finished records only', async (s) => {
    await s.enqueue(item('done'))
    await s.enqueue(item('wait'))
    await s.claim(2000, 'w', 1000, 1)
    await s.succeed('done', 'w')
    assertTrue((await s.purge(0)) === 0, 'nothing older than the epoch')
    assertTrue((await s.purge(Number.MAX_SAFE_INTEGER)) === 1, 'one finished record')
    assertTrue((await s.get('wait')) !== undefined, 'unfinished record stays')
  })

  return cases
}
