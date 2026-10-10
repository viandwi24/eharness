import type { StreamLogAdapter, StreamLogKey } from '../index.ts'
import { assertJsonEqual, assertTrue, uniqueSessionId } from './assert.ts'
import type { ConformanceCase } from './types.ts'

/** Options of {@link streamLogConformance}. */
export interface StreamLogConformanceOptions {
  /** Retention used by the expiry case (ms). Default 50; skipped when the adapter has no `expire`. */
  expireMs?: number
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const chunk = (n: number) => ({
  type: 'text-delta',
  id: 't',
  delta: `chunk ${n} ø ✓ 😀`,
  extra: { n, list: [1, null, true, 2.5] },
})

/**
 * Conformance cases for a {@link StreamLogAdapter} (spec 04 §6.2): ordered append, concurrent
 * readers, `read` from a cursor and with `limit`, close and status, `missing`, idempotent append
 * by length (`at`), a gap rejected, JSON round trip, key isolation, and — when implemented —
 * `subscribe` notifications and `expire`.
 *
 * @example
 * ```ts
 * for (const c of streamLogConformance(() => memoryStreamLog())) test(c.name, c.run)
 * ```
 * @see docs/specs/04-streaming.md#62-stream-log-port
 */
export function streamLogConformance(
  factory: () => StreamLogAdapter | Promise<StreamLogAdapter>,
  options: StreamLogConformanceOptions = {},
): ConformanceCase[] {
  const ttl = options.expireMs ?? 50
  const key = (): StreamLogKey => ({
    sessionId: uniqueSessionId('stream'),
    turnId: uniqueSessionId('turn'),
  })
  return [
    {
      name: 'an unknown key reads as missing',
      run: async () => {
        const log = await factory()
        const result = await log.read(key(), 0)
        assertTrue(result.status === 'missing', `status: ${result.status}`)
        assertTrue(result.chunks.length === 0, 'no chunks')
      },
    },
    {
      name: 'append returns the new length and keeps order',
      run: async () => {
        const log = await factory()
        const k = key()
        assertTrue((await log.append(k, [chunk(0), chunk(1)])) === 2, 'length after first append')
        assertTrue((await log.append(k, [chunk(2)])) === 3, 'length after second append')
        const result = await log.read(k, 0)
        assertJsonEqual(result.chunks, [chunk(0), chunk(1), chunk(2)], 'chunks')
        assertTrue(result.next === 3, `next: ${result.next}`)
        assertTrue(result.status === 'streaming', `status: ${result.status}`)
      },
    },
    {
      name: 'read from a cursor and with a limit',
      run: async () => {
        const log = await factory()
        const k = key()
        await log.append(k, [0, 1, 2, 3, 4].map(chunk))
        const tail = await log.read(k, 3)
        assertJsonEqual(tail.chunks, [chunk(3), chunk(4)], 'tail')
        assertTrue(tail.next === 5, `tail next: ${tail.next}`)
        const page = await log.read(k, 1, { limit: 2 })
        assertJsonEqual(page.chunks, [chunk(1), chunk(2)], 'page')
        assertTrue(page.next === 3, `page next: ${page.next}`)
        const end = await log.read(k, 5)
        assertTrue(end.chunks.length === 0 && end.next === 5, 'reading at the end is empty')
      },
    },
    {
      name: 'close sets the status and later appends are ignored',
      run: async () => {
        const log = await factory()
        const k = key()
        await log.append(k, [chunk(0)])
        await log.close(k, 'aborted')
        await log.close(k, 'done')
        const result = await log.read(k, 0)
        assertTrue(result.status === 'aborted', `the first status wins: ${result.status}`)
        await log.append(k, [chunk(1)])
        assertTrue((await log.read(k, 0)).chunks.length === 1, 'append after close is ignored')
      },
    },
    {
      name: 'append with `at` is idempotent by length',
      run: async () => {
        const log = await factory()
        const k = key()
        await log.append(k, [chunk(0), chunk(1)], { at: 0 })
        // a retry of the same batch, then a batch that overlaps
        assertTrue((await log.append(k, [chunk(0), chunk(1)], { at: 0 })) === 2, 'retry')
        assertTrue(
          (await log.append(k, [chunk(1), chunk(2), chunk(3)], { at: 1 })) === 4,
          'overlap',
        )
        assertJsonEqual((await log.read(k, 0)).chunks, [0, 1, 2, 3].map(chunk), 'no duplicates')
      },
    },
    {
      name: 'append with `at` beyond the length rejects',
      run: async () => {
        const log = await factory()
        const k = key()
        await log.append(k, [chunk(0)])
        let rejected = false
        try {
          await log.append(k, [chunk(5)], { at: 5 })
        } catch {
          rejected = true
        }
        assertTrue(rejected, 'a gap must reject')
        assertTrue((await log.read(k, 0)).chunks.length === 1, 'nothing was stored')
      },
    },
    {
      name: 'concurrent readers each see the full ordered sequence',
      run: async () => {
        const log = await factory()
        const k = key()
        const follow = async (): Promise<unknown[]> => {
          const seen: unknown[] = []
          let cursor = 0
          for (let i = 0; i < 500; i++) {
            const result = await log.read(k, cursor)
            seen.push(...result.chunks)
            cursor = result.next
            if (result.status !== 'streaming' && result.status !== 'missing') return seen
            await sleep(5)
          }
          throw new Error('reader never saw the end')
        }
        const readers = [follow(), follow(), follow()]
        for (let i = 0; i < 20; i += 5) {
          await log.append(k, [i, i + 1, i + 2, i + 3, i + 4].map(chunk))
          await sleep(5)
        }
        await log.close(k, 'done')
        const expected = Array.from({ length: 20 }, (_, i) => chunk(i))
        for (const seen of await Promise.all(readers)) assertJsonEqual(seen, expected, 'reader')
      },
    },
    {
      name: 'chunks round-trip as JSON and are copies',
      run: async () => {
        const log = await factory()
        const k = key()
        const original = chunk(1)
        await log.append(k, [original])
        original.extra.n = 99
        const first = await log.read(k, 0)
        assertJsonEqual(first.chunks, [chunk(1)], 'stored value')
        ;(first.chunks[0] as { extra: { n: number } }).extra.n = 7
        assertJsonEqual((await log.read(k, 0)).chunks, [chunk(1)], 'read copy')
      },
    },
    {
      name: 'logs of different keys are isolated',
      run: async () => {
        const log = await factory()
        const a = key()
        const b = { sessionId: a.sessionId, turnId: uniqueSessionId('turn') }
        await log.append(a, [chunk(0)])
        await log.append(b, [chunk(1), chunk(2)])
        await log.close(b, 'error')
        assertTrue((await log.read(a, 0)).chunks.length === 1, 'a length')
        assertTrue((await log.read(a, 0)).status === 'streaming', 'a status')
        assertTrue((await log.read(b, 0)).status === 'error', 'b status')
      },
    },
    {
      name: 'subscribe is called after appends and close, and stops after unsubscribe',
      run: async () => {
        const log = await factory()
        if (log.subscribe === undefined) return
        const k = key()
        let calls = 0
        const off = log.subscribe(k, () => {
          calls++
        })
        await log.append(k, [chunk(0)])
        await sleep(10)
        assertTrue(calls >= 1, 'notified by append')
        await log.close(k, 'done')
        await sleep(10)
        const afterClose = calls
        off()
        const other = key()
        await log.append(other, [chunk(0)])
        await sleep(10)
        assertTrue(calls === afterClose, 'no calls after unsubscribe')
        assertTrue(afterClose >= 2, 'notified by close')
      },
    },
    {
      name: 'expire drops the log after the ttl',
      run: async () => {
        const log = await factory()
        if (log.expire === undefined) return
        const k = key()
        await log.append(k, [chunk(0)])
        await log.close(k, 'done')
        await log.expire(k, ttl)
        assertTrue((await log.read(k, 0)).status === 'done', 'readable before the ttl')
        await sleep(ttl * 3)
        assertTrue((await log.read(k, 0)).status === 'missing', 'missing after the ttl')
      },
    },
  ]
}
