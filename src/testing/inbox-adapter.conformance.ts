import type { InboxAdapter, InboxItem, InboxItemInput } from '../index.ts'
import { assertJsonEqual, assertTrue, uniqueSessionId } from './assert.ts'
import type { ConformanceCase } from './types.ts'

/** Options of {@link inboxAdapterConformance}. */
export interface InboxAdapterConformanceOptions {
  /** Require `notify` + `subscribe`. Default false: their cases run only when both are present. */
  requireNotify?: boolean
  /** Require `pending`. Default false: its case runs only when present. */
  requirePending?: boolean
  /**
   * Claim expiry used by the expiry case (ms). Default 50; raise it for adapters whose clock
   * resolution is coarse (e.g. a database `now()` on another host).
   */
  claimTtlMs?: number
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function send(text: string, extra: Partial<Extract<InboxItemInput, { kind: 'send' }>> = {}) {
  return {
    kind: 'send' as const,
    mode: 'queue' as const,
    input: { parts: [{ type: 'text' as const, text }] },
    at: 1_790_000_000_000,
    ...extra,
  }
}

/** Every kind of item, with every optional field (JSON round trip). */
const FIXTURES: InboxItemInput[] = [
  send('hello ø ✓ 😀', {
    mode: 'collect',
    input: {
      parts: [
        { type: 'text', text: 'see file' },
        { type: 'file', mediaType: 'image/png', url: 'https://example.com/a.png', filename: 'a.png' },
      ],
      clientId: 'client-1',
      appMetadata: { tenant: 't1', flags: [1, 'two', null, true] },
    },
    collect: { quietMs: 500, maxWaitMs: 2_000, maxItems: 5 },
  }),
  send('steer me', { mode: 'steer' }),
  { kind: 'wake', messageId: 'm-1', at: 1_790_000_000_001 },
  { kind: 'abort', turnId: 't-1', reason: 'user stop', at: 1_790_000_000_002 },
  { kind: 'abort', at: 1_790_000_000_003 },
]

function strip(item: InboxItem): InboxItemInput {
  const { id: _id, attempts: _attempts, ...rest } = item
  return rest as InboxItemInput
}

/**
 * Conformance cases for an {@link InboxAdapter} (spec 05 §12): durability (an enqueued item is
 * claimable once `enqueue` resolved), JSON round trip, FIFO per session, exactly one winner per
 * item under concurrent claims, claim expiry, `release`, `ack`, `limit`, session isolation,
 * copies, and — when implemented (or required) — `notify` / `subscribe` and `pending`.
 *
 * @example
 * ```ts
 * for (const c of inboxAdapterConformance(() => postgresInbox(db))) test(c.name, c.run)
 * ```
 * @see docs/specs/05-session-and-storage.md#12-inbox
 */
export function inboxAdapterConformance(
  factory: () => InboxAdapter | Promise<InboxAdapter>,
  options: InboxAdapterConformanceOptions = {},
): ConformanceCase[] {
  const ttl = options.claimTtlMs ?? 50
  return [
    {
      name: 'an enqueued item is claimable at once and round-trips JSON deep-equal',
      run: async () => {
        const adapter = await factory()
        const sessionId = uniqueSessionId('roundtrip')
        const ids: string[] = []
        for (const item of FIXTURES) ids.push(await adapter.enqueue(sessionId, item))
        assertTrue(
          ids.every((id) => typeof id === 'string' && id.length > 0),
          'ids must be strings',
        )
        assertTrue(new Set(ids).size === ids.length, 'ids must be unique')
        const claimed = await adapter.claim(sessionId, 'owner-a')
        assertJsonEqual(
          claimed.map((i) => i.id),
          ids,
          'claimed ids (enqueue order)',
        )
        assertJsonEqual(claimed.map(strip), FIXTURES, 'claimed items')
        assertTrue(
          claimed.every((i) => i.attempts === 1),
          `attempts after the first claim must be 1, got ${claimed.map((i) => i.attempts)}`,
        )
      },
    },
    {
      name: 'items are FIFO per session and ids sort in enqueue order',
      run: async () => {
        const adapter = await factory()
        const sessionId = uniqueSessionId('fifo')
        const ids: string[] = []
        for (let i = 0; i < 12; i++) ids.push(await adapter.enqueue(sessionId, send(`m${i}`)))
        assertJsonEqual([...ids].sort(), ids, 'ids sort in enqueue order')
        const first = await adapter.claim(sessionId, 'owner-a', { limit: 5 })
        assertJsonEqual(
          first.map((i) => i.id),
          ids.slice(0, 5),
          'claim honours limit and returns the oldest first',
        )
        const rest = await adapter.claim(sessionId, 'owner-a')
        assertJsonEqual(
          rest.map((i) => i.id),
          ids.slice(5),
          'second claim returns the rest in order',
        )
      },
    },
    {
      name: 'a claimed item is invisible to other claims until ack or release',
      run: async () => {
        const adapter = await factory()
        const sessionId = uniqueSessionId('hidden')
        const id = await adapter.enqueue(sessionId, send('x'))
        assertTrue((await adapter.claim(sessionId, 'owner-a')).length === 1, 'first claim')
        assertTrue(
          (await adapter.claim(sessionId, 'owner-b')).length === 0,
          'a claimed item must not be claimed again',
        )
        await adapter.release([id])
        const again = await adapter.claim(sessionId, 'owner-b')
        assertJsonEqual(
          again.map((i) => [i.id, i.attempts]),
          [[id, 2]],
          'released item claimed again (attempts 2)',
        )
        await adapter.ack([id])
        await adapter.release([id]) // releasing an acked id is a no-op
        assertTrue((await adapter.claim(sessionId, 'owner-c')).length === 0, 'acked item is gone')
      },
    },
    {
      name: 'concurrent claimers: every item is claimed exactly once',
      run: async () => {
        const adapter = await factory()
        const sessionId = uniqueSessionId('race')
        const ids: string[] = []
        for (let i = 0; i < 20; i++) ids.push(await adapter.enqueue(sessionId, send(`m${i}`)))
        const results = await Promise.all(
          Array.from({ length: 6 }, (_, i) =>
            adapter.claim(sessionId, `owner-${i}`, { limit: 4 + (i % 3) }),
          ),
        )
        const rounds = [...results]
        // claim what is left so every item is accounted for
        for (;;) {
          const more = await adapter.claim(sessionId, 'owner-late')
          if (more.length === 0) break
          rounds.push(more)
        }
        const claimed = rounds.flat().map((i) => i.id)
        assertTrue(
          claimed.length === ids.length,
          `expected ${ids.length} claims, got ${claimed.length}`,
        )
        assertJsonEqual([...claimed].sort(), [...ids].sort(), 'each item claimed exactly once')
      },
    },
    {
      name: 'a claim expires after claimTtlMs (the owner died)',
      run: async () => {
        const adapter = await factory()
        const sessionId = uniqueSessionId('expiry')
        const id = await adapter.enqueue(sessionId, send('x'))
        await adapter.claim(sessionId, 'owner-a', { claimTtlMs: ttl })
        assertTrue(
          (await adapter.claim(sessionId, 'owner-b', { claimTtlMs: ttl })).length === 0,
          'still claimed before the expiry',
        )
        await sleep(ttl * 2 + 20)
        const again = await adapter.claim(sessionId, 'owner-b', { claimTtlMs: 60_000 })
        assertJsonEqual(
          again.map((i) => [i.id, i.attempts]),
          [[id, 2]],
          'expired claim: claimable by another owner',
        )
      },
    },
    {
      name: 'ack removes items for good; unknown ids are ignored',
      run: async () => {
        const adapter = await factory()
        const sessionId = uniqueSessionId('ack')
        const a = await adapter.enqueue(sessionId, send('a'))
        const b = await adapter.enqueue(sessionId, send('b'))
        await adapter.claim(sessionId, 'owner-a', { claimTtlMs: ttl })
        await adapter.ack([a, 'unknown-id'])
        await adapter.release([b])
        await sleep(ttl * 2 + 20)
        const left = await adapter.claim(sessionId, 'owner-b')
        assertJsonEqual(
          left.map((i) => i.id),
          [b],
          'only the released item is left',
        )
        await adapter.ack([])
        await adapter.release([])
      },
    },
    {
      name: 'sessions are isolated',
      run: async () => {
        const adapter = await factory()
        const one = uniqueSessionId('iso-a')
        const two = uniqueSessionId('iso-b')
        await adapter.enqueue(one, send('a'))
        assertTrue((await adapter.claim(two, 'owner-a')).length === 0, 'other session is empty')
        assertTrue((await adapter.claim(one, 'owner-a')).length === 1, 'own session has the item')
      },
    },
    {
      name: 'enqueue copies its input and claim returns copies',
      run: async () => {
        const adapter = await factory()
        const sessionId = uniqueSessionId('copy')
        const input = send('original')
        const id = await adapter.enqueue(sessionId, input)
        input.input.parts[0] = { type: 'text', text: 'mutated after enqueue' }
        const [claimed] = await adapter.claim(sessionId, 'owner-a')
        assertJsonEqual(claimed === undefined ? null : strip(claimed), send('original'), 'stored')
        if (claimed?.kind === 'send') claimed.input.parts.length = 0
        await adapter.release([id])
        const [again] = await adapter.claim(sessionId, 'owner-a')
        assertJsonEqual(again === undefined ? null : strip(again), send('original'), 'after release')
      },
    },
    {
      name: 'notify reaches the subscribers of the session only, until they unsubscribe',
      run: async () => {
        const adapter = await factory()
        if (adapter.notify === undefined || adapter.subscribe === undefined) {
          assertTrue(options.requireNotify !== true, 'notify/subscribe required but not implemented')
          return
        }
        const sessionId = uniqueSessionId('notify')
        const other = uniqueSessionId('notify-other')
        let mine = 0
        let theirs = 0
        const unsubscribe = adapter.subscribe(sessionId, () => {
          mine++
        })
        const unsubscribeOther = adapter.subscribe(other, () => {
          theirs++
        })
        try {
          await sleep(20) // subscriptions may connect asynchronously (LISTEN)
          await adapter.notify(sessionId)
          for (let i = 0; i < 100 && mine === 0; i++) await sleep(10)
          assertTrue(mine >= 1, 'the subscriber was not notified')
          assertTrue(theirs === 0, 'a subscriber of another session was notified')
          unsubscribe()
          const before = mine
          await adapter.notify(sessionId)
          await sleep(50)
          assertTrue(mine === before, 'notified after unsubscribe')
        } finally {
          unsubscribe()
          unsubscribeOther()
        }
      },
    },
    {
      name: 'pending lists sessions with ready items',
      run: async () => {
        const adapter = await factory()
        if (adapter.pending === undefined) {
          assertTrue(options.requirePending !== true, 'pending required but not implemented')
          return
        }
        const ready = uniqueSessionId('pending-ready')
        const claimed = uniqueSessionId('pending-claimed')
        const acked = uniqueSessionId('pending-acked')
        await adapter.enqueue(ready, send('a'))
        await adapter.enqueue(claimed, send('b'))
        await adapter.claim(claimed, 'owner-a', { claimTtlMs: 60_000 })
        const id = await adapter.enqueue(acked, send('c'))
        await adapter.ack([id])
        const list = await adapter.pending({ limit: 10_000 })
        assertTrue(list.includes(ready), 'a session with a ready item must be listed')
        assertTrue(!list.includes(claimed), 'a session whose items are all claimed is not listed')
        assertTrue(!list.includes(acked), 'a session without items is not listed')
      },
    },
  ]
}
