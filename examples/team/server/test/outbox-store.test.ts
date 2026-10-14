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

describe('rows that need a look', () => {
  const setup = () => {
    const { sqlite } = openDatabase(':memory:')
    return sqliteOutboxStore(sqlite, vault)
  }
  const msg = (conversationId: string, text: string, kind: 'reply' | 'post' = 'reply') => ({
    connectionId: 'c1',
    conversationId,
    kind,
    triggerId: text,
    chunkIndex: 0,
    chunkCount: 1,
    text,
  })

  test('held and failed rows are listed newest first, with paging; sent and dismissed rows are not', async () => {
    const team = setup()
    const [a, b, c, d, e] = await team.enqueue(
      ['a', 'b', 'c', 'd', 'e'].map((t, i) => msg(`n${i}`, t)),
      10,
    )
    team.markSent(a as string, 'p1', 20)
    team.markFailed(b as string, 'boom', 20)
    team.markFailed(c as string, 'boom', 20)
    expect(team.claimNow(d as string, 20)).toBe(true)
    team.holdStale('c1')
    // e stays pending: not listed
    void e
    const all = await team.attention('c1')
    expect(all.rows.map((r) => r.text)).toEqual(['d', 'c', 'b'])
    expect(all.next).toBeUndefined()
    const first = await team.attention('c1', { limit: 2 })
    expect(first.rows.map((r) => r.text)).toEqual(['d', 'c'])
    const second = await team.attention('c1', {
      limit: 2,
      ...(first.next ? { before: first.next } : {}),
    })
    expect(second.rows.map((r) => r.text)).toEqual(['b'])
    // other connections are not mixed in; a failed row older than `since` is left out
    expect((await team.attention('other')).rows).toEqual([])
    expect((await team.attention('c1', { since: 21 })).rows.map((r) => r.text)).toEqual(['d'])
    // dismiss: it leaves the list and the failed count, and nothing is deleted
    expect(team.counts('c1').failed).toBe(2)
    expect(team.dismiss('c1', b as string, 30)).toBe(true)
    expect(team.dismiss('c1', b as string, 31)).toBe(false)
    expect(team.dismiss('c1', d as string, 31)).toBe(false) // held: nothing to dismiss
    expect((await team.attention('c1')).rows.map((r) => r.text)).toEqual(['d', 'c'])
    expect(team.counts('c1')).toMatchObject({ failed: 1, held: 1 })
    expect((await team.get(b as string))?.reviewedAt).toBe(30)
  })

  test('retry re-queues a failed row with fresh attempts; tool calls and other connections are refused', async () => {
    const team = setup()
    const [id, post] = await team.enqueue([msg('n1', 'hello'), msg('n2', 'tool', 'post')], 10)
    team.markFailed(id as string, 'boom', 20)
    team.markFailed(post as string, 'boom', 20)
    expect(team.retry('c2', id as string, 40)).toBe(false)
    expect(team.retry('c1', post as string, 40)).toBe(false)
    expect(team.retry('c1', id as string, 40)).toBe(true)
    expect(team.retry('c1', id as string, 41)).toBe(false) // pending now
    const row = await team.get(id as string)
    expect(row).toMatchObject({ status: 'pending', attempts: 0, nextAt: 40, reviewedAt: null })
    const claimed = await team.queue({ connectionId: 'c1' }).claim(50, 'w', 1_000, 10)
    expect(claimed.map((r) => r.id)).toEqual([id as string])
  })
})
