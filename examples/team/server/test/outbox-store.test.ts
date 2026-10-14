import { describe, expect, test } from 'bun:test'
import { webCryptoVault } from 'eharness/providers'
import { outboxStoreConformance } from 'eharness/testing'
import { sqliteOutboxStore } from '../src/infra/channels/delivery-store.ts'
import { openDatabase } from '../src/infra/db/client.ts'

const vault = webCryptoVault(new Uint8Array(32).fill(7))

describe('sqlite delivery table passes the eharness/channels outbox store conformance suite', () => {
  const cases = outboxStoreConformance(() => {
    const { sqlite } = openDatabase(':memory:')
    const team = sqliteOutboxStore(sqlite, vault)
    return { store: team.queue(), peer: () => team.queue() }
  })
  for (const c of cases) test(c.name, c.run)
})

describe('the team rows on the library port', () => {
  const setup = () => {
    const { sqlite } = openDatabase(':memory:')
    return sqliteOutboxStore(sqlite, vault)
  }
  const row = (conversationId: string, chunk: number, triggerId = 't1') => ({
    connectionId: 'c1',
    conversationId,
    kind: 'reply' as const,
    triggerId,
    chunkIndex: chunk,
    chunkCount: 2,
    text: `chunk ${chunk}`,
  })

  test('a later chunk waits for the earlier one, and a retrying row holds its conversation', async () => {
    const team = setup()
    const q = team.queue({ connectionId: 'c1' })
    const ids = await team.enqueue([row('n1', 0), row('n1', 1)], 10)
    const other = await team.enqueue([row('n2', 0, 't2')], 11)
    const first = await q.claim(100, 'w', 1_000, 10)
    // chunk 1 is not claimed with chunk 0; another conversation is
    expect(first.map((r) => r.id)).toEqual([ids[0] as string, other[0] as string])
    expect(first[0]?.payload).toMatchObject({ text: 'chunk 0' })
    // chunk 0 fails and waits for a retry: chunk 1 keeps waiting
    expect(await q.fail(ids[0] as string, 'w', { error: 'glitch', retryAt: 500 })).toBe('pending')
    expect(await q.succeed(other[0] as string, 'w', { nativeId: 'p1' })).toBe(true)
    expect(await q.claim(200, 'w', 1_000, 10)).toEqual([])
    const retry = await q.claim(500, 'w', 1_000, 10)
    expect(retry.map((r) => r.id)).toEqual([ids[0] as string])
    await q.succeed(ids[0] as string, 'w', { nativeId: 'p2' })
    expect((await q.claim(600, 'w', 1_000, 10)).map((r) => r.id)).toEqual([ids[1] as string])
    expect((await team.get(other[0] as string))?.platformId).toBe('p1')
  })

  test('post rows and rows of other connections are not claimed; skip settles as skipped', async () => {
    const team = setup()
    await team.enqueue([{ ...row('n1', 0), kind: 'post' }], 10)
    await team.enqueue([{ ...row('n9', 0, 'x'), connectionId: 'c2' }], 10)
    const [id] = await team.enqueue([row('n3', 0, 't3')], 10)
    const q = team.queue({ connectionId: 'c1' })
    const got = await q.claim(100, 'w', 1_000, 10)
    expect(got.map((r) => r.id)).toEqual([id as string])
    expect(await q.skip(id as string, 'w', 'answered before it was sent')).toBe(true)
    expect(team.counts('c1')).toMatchObject({ skipped: 1, pending: 1 })
  })

  test('a row a crashed process left sending is never reclaimed by the worker', async () => {
    const team = setup()
    const [id] = await team.enqueue([row('n1', 0)], 10)
    expect(team.claimNow(id as string, 20)).toBe(true)
    const q = team.queue({ connectionId: 'c1' })
    expect(await q.claim(Number.MAX_SAFE_INTEGER, 'w', 1_000, 10)).toEqual([])
    expect(team.holdStale('c1')).toBe(1)
    expect((await team.held('c1')).map((r) => r.id)).toEqual([id as string])
    // held rows are not claimed either, and they hold their conversation
    expect(await q.claim(Number.MAX_SAFE_INTEGER, 'w', 1_000, 10)).toEqual([])
  })

  test('hold leaves the row sending when the process is stopping', async () => {
    const team = setup()
    const [id] = await team.enqueue([row('n1', 0)], 10)
    const q = team.queue({ connectionId: 'c1' })
    await q.claim(100, 'w', 1_000, 10)
    q.hold(id as string)
    await q.fail(id as string, 'w', { error: 'stopped' })
    expect(team.counts('c1').sending).toBe(1)
  })

  test('an expired lease is held, not resent; the held row blocks its conversation until released', async () => {
    const team = setup()
    const q = team.queue({ connectionId: 'c1' })
    const [first, second] = await team.enqueue([row('n1', 0), row('n1', 1)], 10)
    const other = await team.enqueue([row('n2', 0, 't2')], 11)
    await q.claim(100, 'w', 1_000, 1) // chunk 0 of n1
    // the lease runs out while sending: held, and a worker that does not reclaim finds nothing for n1
    const [held] = await q.holdExpired(5_000)
    expect(held).toMatchObject({ id: first, state: 'held', attempts: 1 })
    const next = await q.claim(5_000, 'w2', 1_000, 10, { reclaimExpired: false })
    expect(next.map((r) => r.id)).toEqual([other[0] as string])
    await q.succeed(other[0] as string, 'w2', { nativeId: 'p0' })
    expect((await q.list({ state: 'held' })).map((r) => r.id)).toEqual([first as string])
    expect((await team.held('c1')).map((r) => r.id)).toEqual([first as string])
    // retry: back to pending, then chunk 1 follows chunk 0
    expect((await q.release(first as string, 'retry', 6_000))?.state).toBe('pending')
    expect((await q.claim(6_000, 'w2', 1_000, 10)).map((r) => r.id)).toEqual([first as string])
    await q.succeed(first as string, 'w2', { nativeId: 'p1' })
    expect((await q.claim(7_000, 'w2', 1_000, 10)).map((r) => r.id)).toEqual([second as string])
  })

  test('release drop settles a held row as skipped', async () => {
    const team = setup()
    const q = team.queue({ connectionId: 'c1' })
    const [id] = await team.enqueue([row('n1', 0)], 10)
    await q.claim(100, 'w', 1_000, 1)
    await q.holdExpired(5_000)
    expect((await q.release(id as string, 'drop', 6_000))?.state).toBe('skipped')
    expect(team.counts('c1')).toMatchObject({ skipped: 1, held: 0 })
  })
})
