/** Resource bounds of the in-memory adapters (they must not grow without limit). */
import { describe, expect, test } from 'bun:test'
import { inMemoryBudgetLedger, inMemoryInbox, inMemoryStreamLog } from './memory.ts'

describe('inMemoryBudgetLedger reservations', () => {
  test('settled reservations are idempotent and a late commit after retention is dropped', async () => {
    let t = 0
    const ledger = inMemoryBudgetLedger({
      limits: { u: 10 },
      now: () => t,
      expiredRetentionMs: 1000,
    })
    const a = await ledger.reserve({ key: 'a', scopes: ['u'], amountUsd: 1, ttlMs: 100 })
    if (!a.ok) throw new Error('reserve failed')
    await ledger.commit(a.reservationId, 1)
    await ledger.commit(a.reservationId, 1) // idempotent although the reservation is deleted
    await ledger.release(a.reservationId)
    expect((await ledger.check(['u'])).scopes[0]).toMatchObject({ spentUsd: 1, reservedUsd: 0 })

    const b = await ledger.reserve({ key: 'b', scopes: ['u'], amountUsd: 2, ttlMs: 100 })
    if (!b.ok) throw new Error('reserve failed')
    t = 500 // expired but within the retention: still charges
    await ledger.commit(b.reservationId, 2)
    expect((await ledger.check(['u'])).scopes[0]).toMatchObject({ spentUsd: 3 })

    const c = await ledger.reserve({ key: 'c', scopes: ['u'], amountUsd: 2, ttlMs: 100 })
    if (!c.ok) throw new Error('reserve failed')
    t = 10_000 // expired long ago: swept by the next reserve
    await ledger.reserve({ key: 'd', scopes: ['u'], amountUsd: 1, ttlMs: 100 })
    await ledger.commit(c.reservationId, 2)
    expect((await ledger.check(['u'])).scopes[0]).toMatchObject({ spentUsd: 3 })
  })
})

describe('inMemoryInbox dead letters', () => {
  test('the oldest dead letters are dropped past maxDeadLetters', async () => {
    const inbox = inMemoryInbox({ maxDeadLetters: 2 })
    const ids: string[] = []
    for (let i = 0; i < 4; i++) {
      ids.push(await inbox.enqueue('s', { kind: 'send', payload: { i } } as never))
    }
    for (const id of ids) await inbox.deadLetter?.([id], { reason: 'boom' })
    const dead = (await inbox.listDead?.()) ?? []
    expect(dead.map((d) => d.id)).toEqual(ids.slice(2))
    expect((await inbox.stats?.({ sessionId: 's' }))?.dead).toBe(2)
  })
})

describe('inMemoryStreamLog sweep', () => {
  test('an expired log is gone for readers even though the sweep is throttled', async () => {
    let t = 0
    const log = inMemoryStreamLog({ now: () => t, retentionMs: 100 })
    const key = { sessionId: 's', turnId: 'x' }
    await log.append(key, [{ type: 'text-delta', id: '1', delta: 'a' }] as never)
    await log.append({ sessionId: 's', turnId: 'y' }, [] as never)
    t = 200
    await log.append({ sessionId: 's', turnId: 'z' }, [] as never)
    expect((await log.read(key, 0)).status).toBe('missing')
  })
})
