import type { DeadInboxItem, InboxAdapter, InboxItem, InboxItemInput } from '../index.ts'
import { assertJsonEqual, assertTrue, uniqueSessionId } from './assert.ts'
import type { ConformanceCase } from './types.ts'

/** Options of {@link inboxAdapterConformance}. */
export interface InboxAdapterConformanceOptions {
  /** Require `notify` + `subscribe`. Default false: their cases run only when both are present. */
  requireNotify?: boolean
  /** Require `pending`. Default false: its case runs only when present. */
  requirePending?: boolean
  /**
   * Require the retry semantics of 0.5 (spec 05 §12 rules 11 and 14): `release` honours
   * `uncount`, `delayMs` and `lastError`, and `availableAt` timers. Default false: those cases do
   * not run (an adapter may ignore the options, which keeps the 0.4 behaviour).
   */
  requireRetry?: boolean
  /**
   * Require `deadLetter` + `redrive` + `listDead`. Default false: their cases run only when
   * `deadLetter` is present (then all three are required).
   */
  requireDeadLetter?: boolean
  /** Require `stats`. Default false: its case runs only when present. */
  requireStats?: boolean
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
        {
          type: 'file',
          mediaType: 'image/png',
          url: 'https://example.com/a.png',
          filename: 'a.png',
        },
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
  const { id: _id, attempts: _attempts, lastError: _lastError, ...rest } = item
  return rest as InboxItemInput
}

/** The stored input of a dead item (`reason` is the dead reason, not an abort's `reason`). */
function stripDead(item: DeadInboxItem): InboxItemInput {
  const { sessionId: _s, deadAt: _d, reason: _r, ...rest } = item
  return strip(rest as InboxItem)
}

const ids = (items: readonly InboxItem[]) => items.map((i) => i.id)

/**
 * Conformance cases for an {@link InboxAdapter} (spec 05 §12): durability (an enqueued item is
 * claimable once `enqueue` resolved), JSON round trip, FIFO per session, exactly one winner per
 * item under concurrent claims, head of line (nothing is claimed behind an item another owner
 * holds), renewal by the holder, claim expiry, `release`, `ack`, `limit`, session isolation,
 * copies, and — when implemented (or required) — `notify` / `subscribe` and `pending`; with
 * `requireRetry` the 0.5 retry semantics (`uncount`, `lastError`, delayed items holding back later
 * `send` / `wake` items but not `abort`, `availableAt` timers that hold nothing back); when
 * implemented (or required) the dead-letter store (`deadLetter`, `listDead`, `redrive`) and
 * `stats`.
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
        // head of line: the winners hold the oldest items; ack them, then claim what is left
        await adapter.ack(results.flat().map((i) => i.id))
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
      name: 'head of line: no item is claimed behind an older item another owner holds',
      run: async () => {
        const adapter = await factory()
        const sessionId = uniqueSessionId('head')
        const a = await adapter.enqueue(sessionId, send('a'))
        const b = await adapter.enqueue(sessionId, send('b'))
        const c = await adapter.enqueue(sessionId, send('c'))
        const first = await adapter.claim(sessionId, 'owner-a', { limit: 1 })
        assertJsonEqual(
          first.map((i) => i.id),
          [a],
          'limit 1 claims the oldest',
        )
        assertTrue(
          (await adapter.claim(sessionId, 'owner-b')).length === 0,
          'nothing behind an item owner-a holds may be claimed by owner-b',
        )
        const own = await adapter.claim(sessionId, 'owner-a')
        assertJsonEqual(
          own.map((i) => [i.id, i.attempts]),
          [
            [b, 1],
            [c, 1],
          ],
          'the holder claims the rest in id order (its held item is not returned again)',
        )
        await adapter.ack([a])
        assertTrue(
          (await adapter.claim(sessionId, 'owner-b')).length === 0,
          'b and c are still held by owner-a',
        )
        await adapter.release([b, c])
        const next = await adapter.claim(sessionId, 'owner-b')
        assertJsonEqual(
          next.map((i) => [i.id, i.attempts]),
          [
            [b, 2],
            [c, 2],
          ],
          'released items: claimable in id order',
        )
        if (adapter.pending !== undefined) {
          const list = await adapter.pending({ limit: 10_000 })
          assertTrue(
            !list.includes(sessionId),
            'a session whose oldest item is held is not pending',
          )
        }
      },
    },
    {
      name: 'a claim of the same owner renews the claims it holds',
      run: async () => {
        const adapter = await factory()
        const sessionId = uniqueSessionId('renew')
        const id = await adapter.enqueue(sessionId, send('x'))
        await adapter.claim(sessionId, 'owner-a', { claimTtlMs: ttl * 4 })
        await sleep(ttl * 3)
        assertTrue(
          (await adapter.claim(sessionId, 'owner-a', { claimTtlMs: ttl * 4 })).length === 0,
          'a held item is not returned again to its owner',
        )
        await sleep(ttl * 2) // past the first claim's expiry, within the renewed one
        assertTrue(
          (await adapter.claim(sessionId, 'owner-b', { claimTtlMs: ttl })).length === 0,
          'the renewed claim has not expired',
        )
        await sleep(ttl * 3 + 20)
        const again = await adapter.claim(sessionId, 'owner-b', { claimTtlMs: 60_000 })
        assertJsonEqual(
          again.map((i) => [i.id, i.attempts]),
          [[id, 2]],
          'renewal does not count as an attempt; the renewed claim expires too',
        )
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
        assertJsonEqual(
          again === undefined ? null : strip(again),
          send('original'),
          'after release',
        )
      },
    },
    {
      name: 'notify reaches the subscribers of the session only, until they unsubscribe',
      run: async () => {
        const adapter = await factory()
        if (adapter.notify === undefined || adapter.subscribe === undefined) {
          assertTrue(
            options.requireNotify !== true,
            'notify/subscribe required but not implemented',
          )
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
    {
      name: 'retry: release with uncount undoes the attempt; lastError round-trips',
      run: async () => {
        if (options.requireRetry !== true) return
        const adapter = await factory()
        const sessionId = uniqueSessionId('uncount')
        const id = await adapter.enqueue(sessionId, send('x'))
        for (let i = 0; i < 3; i++) {
          const [item] = await adapter.claim(sessionId, 'owner-a')
          assertTrue(item?.attempts === 1, `deferred claims are not counted, got ${item?.attempts}`)
          await adapter.release([id], { uncount: true })
        }
        await adapter.claim(sessionId, 'owner-a')
        await adapter.release([id], { lastError: 'EH_STORAGE: boom ✓' })
        const [failed] = await adapter.claim(sessionId, 'owner-b')
        assertJsonEqual(
          failed === undefined ? null : [failed.id, failed.attempts, failed.lastError],
          [id, 2, 'EH_STORAGE: boom ✓'],
          'a failed attempt keeps its count and its lastError',
        )
        assertJsonEqual(failed === undefined ? null : strip(failed), send('x'), 'item unchanged')
        await adapter.release([id], { uncount: true })
        const [again] = await adapter.claim(sessionId, 'owner-b')
        assertTrue(again?.attempts === 2, 'uncount undoes only the claim being released')
        await adapter.release(['unknown-id'], { uncount: true, delayMs: 10, lastError: 'x' })
      },
    },
    {
      name: 'retry: a claim that expires keeps its attempt (crash loops are counted)',
      run: async () => {
        if (options.requireRetry !== true) return
        const adapter = await factory()
        const sessionId = uniqueSessionId('crash')
        const id = await adapter.enqueue(sessionId, send('x'))
        for (let i = 1; i <= 3; i++) {
          const [item] = await adapter.claim(sessionId, `owner-${i}`, { claimTtlMs: ttl })
          assertJsonEqual(item === undefined ? null : [item.id, item.attempts], [id, i], 'attempt')
          await sleep(ttl * 2 + 20)
        }
      },
    },
    {
      name: 'retry: a delayed item is invisible until due and holds back later send/wake items, not abort',
      run: async () => {
        if (options.requireRetry !== true) return
        const adapter = await factory()
        const sessionId = uniqueSessionId('delay')
        const a = await adapter.enqueue(sessionId, send('a'))
        const b = await adapter.enqueue(sessionId, send('b'))
        const c = await adapter.enqueue(sessionId, { kind: 'abort', turnId: 't', at: 1 })
        const d = await adapter.enqueue(sessionId, { kind: 'wake', messageId: 'm', at: 2 })
        await adapter.claim(sessionId, 'owner-a')
        const delayMs = ttl * 4
        await adapter.release([a], { delayMs, lastError: 'boom' })
        await adapter.release([b, c, d], { uncount: true })
        const early = await adapter.claim(sessionId, 'owner-b')
        assertJsonEqual(ids(early), [c], 'only the abort is claimable behind a delayed item')
        await adapter.release([c], { uncount: true })
        if (adapter.pending !== undefined) {
          const list = await adapter.pending({ limit: 10_000 })
          assertTrue(list.includes(sessionId), 'a claimable abort makes the session pending')
        }
        await sleep(delayMs + 30)
        const due = await adapter.claim(sessionId, 'owner-b')
        assertJsonEqual(
          due.map((i) => [i.id, i.attempts]),
          [
            [a, 2],
            [b, 1],
            [c, 1],
            [d, 1],
          ],
          'once due the delayed item is claimed first, then the rest in id order',
        )
      },
    },
    {
      name: 'retry: an availableAt timer is invisible until due and holds nothing back',
      run: async () => {
        if (options.requireRetry !== true) return
        const adapter = await factory()
        const sessionId = uniqueSessionId('timer')
        const availableAt = Date.now() + ttl * 4
        const timer = send('later', { availableAt })
        const t = await adapter.enqueue(sessionId, timer)
        const n = await adapter.enqueue(sessionId, send('now'))
        const p = await adapter.enqueue(sessionId, send('past', { availableAt: 1 }))
        const first = await adapter.claim(sessionId, 'owner-a')
        assertJsonEqual(ids(first), [n, p], 'a future timer is skipped, later items are claimed')
        await adapter.ack([n, p])
        if (adapter.pending !== undefined) {
          const list = await adapter.pending({ limit: 10_000 })
          assertTrue(!list.includes(sessionId), 'a session with only a future timer is not pending')
        }
        await sleep(ttl * 4 + 50)
        const due = await adapter.claim(sessionId, 'owner-b')
        assertJsonEqual(ids(due), [t], 'the timer is claimable once due')
        assertJsonEqual(due[0] === undefined ? null : strip(due[0]), timer, 'availableAt kept')
      },
    },
    {
      name: 'dead letter: dead items are never claimed, hold nothing back, are listed and redriven in id order',
      run: async () => {
        const adapter = await factory()
        if (adapter.deadLetter === undefined) {
          assertTrue(options.requireDeadLetter !== true, 'deadLetter required but not implemented')
          return
        }
        assertTrue(
          adapter.redrive !== undefined && adapter.listDead !== undefined,
          'an adapter with deadLetter must implement redrive and listDead',
        )
        const redrive = adapter.redrive?.bind(adapter)
        const listDead = adapter.listDead?.bind(adapter)
        if (redrive === undefined || listDead === undefined) return
        const sessionId = uniqueSessionId('dead')
        const fixture = FIXTURES[0] as InboxItemInput
        const a = await adapter.enqueue(sessionId, fixture)
        const b = await adapter.enqueue(sessionId, send('b'))
        const c = await adapter.enqueue(sessionId, send('c'))
        const d = await adapter.enqueue(sessionId, send('d'))
        await adapter.claim(sessionId, 'owner-a', { claimTtlMs: ttl })
        await adapter.deadLetter([c], {
          reason: 'non-retryable',
          lastError: 'EH_INVALID_INPUT: bad',
        })
        await adapter.deadLetter([a, 'unknown-id'], { reason: 'max-attempts' })
        await adapter.release([b, d])
        await sleep(ttl * 2 + 20) // dead items never come back through an expired claim
        const live = await adapter.claim(sessionId, 'owner-b')
        assertJsonEqual(ids(live), [b, d], 'dead items are skipped and hold nothing back')
        await adapter.ack([b, d])
        const dead = await listDead({ sessionId })
        assertJsonEqual(ids(dead), [a, c], 'listDead: oldest (lowest id) first')
        const [deadA, deadC] = dead
        assertJsonEqual(deadA === undefined ? null : stripDead(deadA), fixture, 'dead item JSON')
        assertTrue(
          deadA?.sessionId === sessionId &&
            deadA.reason === 'max-attempts' &&
            deadA.attempts === 1 &&
            typeof deadA.deadAt === 'number' &&
            deadA.lastError === undefined,
          `dead item fields: ${JSON.stringify(deadA)}`,
        )
        assertJsonEqual(
          deadC === undefined ? null : [deadC.reason, deadC.lastError],
          ['non-retryable', 'EH_INVALID_INPUT: bad'],
          'deadLetter records reason and lastError',
        )
        assertJsonEqual(ids(await listDead({ sessionId, limit: 1 })), [a], 'listDead limit')
        const all = await listDead({ limit: 100_000 })
        assertTrue(
          ids(all).includes(a) && ids(all).includes(c),
          'listDead without sessionId lists every session',
        )
        await adapter.release([a]) // a dead item is not released
        assertTrue((await adapter.claim(sessionId, 'owner-c')).length === 0, 'dead stays dead')
        await redrive([c, a, b, 'unknown-id'])
        assertJsonEqual(ids(await listDead({ sessionId })), [], 'redriven items are not dead')
        const back = await adapter.claim(sessionId, 'owner-c')
        assertJsonEqual(
          back.map((i) => [i.id, i.attempts]),
          [
            [a, 1],
            [c, 1],
          ],
          'redriven items are claimable in id order with attempts reset',
        )
        assertJsonEqual(back[0] === undefined ? null : strip(back[0]), fixture, 'redriven JSON')
      },
    },
    {
      name: 'stats counts ready, claimed, delayed and dead items',
      run: async () => {
        const adapter = await factory()
        if (adapter.stats === undefined) {
          assertTrue(options.requireStats !== true, 'stats required but not implemented')
          return
        }
        const sessionId = uniqueSessionId('stats')
        const r = await adapter.enqueue(sessionId, send('ready'))
        await adapter.enqueue(sessionId, send('claimed'))
        const d = await adapter.enqueue(sessionId, send('delayed'))
        const x = await adapter.enqueue(sessionId, send('dead'))
        await adapter.claim(sessionId, 'owner-a', { claimTtlMs: 60_000 })
        await adapter.release([r])
        const retry = options.requireRetry === true
        await adapter.release([d], retry ? { delayMs: 60_000 } : undefined)
        const dead = adapter.deadLetter !== undefined
        if (dead) await adapter.deadLetter?.([x], { reason: 'max-attempts' })
        else await adapter.ack([x])
        if (retry)
          await adapter.enqueue(sessionId, send('timer', { availableAt: Date.now() + 60_000 }))
        assertJsonEqual(
          await adapter.stats({ sessionId }),
          { ready: retry ? 1 : 2, claimed: 1, delayed: retry ? 2 : 0, dead: dead ? 1 : 0 },
          'stats of the session',
        )
        const total = await adapter.stats()
        assertTrue(
          total.ready >= 1 && total.claimed >= 1 && total.dead >= (dead ? 1 : 0),
          `stats of the whole inbox include the session: ${JSON.stringify(total)}`,
        )
      },
    },
  ]
}
