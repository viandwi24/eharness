import { type HarnessUIMessage, type MessageAdapter, uuidv7 } from '../index.ts'
import { assertJsonEqual, assertTrue, uniqueSessionId } from './assert.ts'
import type { ConformanceCase } from './types.ts'

/** Options of {@link messageAdapterConformance}. */
export interface MessageAdapterConformanceOptions {
  /**
   * Require `lastId` to be implemented. Default false: the `lastId` case runs only when the adapter
   * has it.
   */
  requireLastId?: boolean
}

function message(
  id: string,
  text: string,
  extra: Partial<HarnessUIMessage> = {},
): HarnessUIMessage {
  return {
    id,
    role: 'user',
    metadata: { eharness: { v: 1, createdAt: 1_790_000_000_000 } },
    parts: [{ type: 'text', text }],
    ...extra,
  }
}

/** `count` UUIDv7 ids in ascending order. */
function ids(count: number): string[] {
  return Array.from({ length: count }, () => uuidv7())
}

const idsOf = (messages: readonly { id: string }[]): string[] => messages.map((m) => m.id)

/**
 * Conformance cases for a {@link MessageAdapter} (spec 05 §4): ordering by id, upsert (a whole
 * replacement, never a merge), `fromId` (inclusive, also between stored ids), `beforeId`
 * (exclusive, with and without `limit`), `{ limit }`, `{}`, empty sessions, session
 * isolation, JSON round-trip with unknown keys and data parts, copies on load, `lastId`.
 *
 * `factory` is called once per case; each case uses its own random session ids, so a factory
 * may return adapters that share one store (e.g. one database).
 *
 * @example
 * ```ts
 * for (const c of messageAdapterConformance(() => postgresMessages(db))) test(c.name, c.run)
 * ```
 * @see docs/specs/05-session-and-storage.md#4-messageadapter-the-storage-contract
 * @see docs/engineering/testing.md#conformance-suites-public-in-eharnesstesting
 */
export function messageAdapterConformance(
  factory: () => MessageAdapter | Promise<MessageAdapter>,
  options: MessageAdapterConformanceOptions = {},
): ConformanceCase[] {
  return [
    {
      name: 'orders by id, not by insertion order',
      run: async () => {
        const adapter = await factory()
        const sessionId = uniqueSessionId('order')
        const [a, b, c, d] = ids(4) as [string, string, string, string]
        await adapter.save(sessionId, [message(c, 'c')])
        await adapter.save(sessionId, [message(a, 'a'), message(d, 'd')])
        await adapter.save(sessionId, [message(b, 'b')])
        assertJsonEqual(idsOf(await adapter.load({ sessionId })), [a, b, c, d], 'load({})')
      },
    },
    {
      name: 'save is an upsert by id (replaces parts, metadata and role)',
      run: async () => {
        const adapter = await factory()
        const sessionId = uniqueSessionId('upsert')
        const [a, b] = ids(2) as [string, string]
        await adapter.save(sessionId, [message(a, 'first'), message(b, 'other')])
        const replaced = message(a, 'second', {
          role: 'assistant',
          metadata: { eharness: { v: 1, createdAt: 2, stop: 'complete' } },
        })
        await adapter.save(sessionId, [replaced])
        await adapter.save(sessionId, [replaced]) // idempotent
        const loaded = await adapter.load({ sessionId })
        assertJsonEqual(idsOf(loaded), [a, b], 'ids after upsert')
        assertJsonEqual(loaded[0], replaced, 'replaced message')
      },
    },
    {
      name: 'save replaces the whole message (dropped keys stay dropped)',
      run: async () => {
        const adapter = await factory()
        const sessionId = uniqueSessionId('replace')
        const [a] = ids(1) as [string]
        const first = {
          ...message(a, 'first'),
          role: 'assistant',
          metadata: {
            eharness: { v: 1, createdAt: 1, pending: { messageId: a } },
            app: { rating: 5 },
          },
          parts: [
            { type: 'text', text: 'first' },
            { type: 'data-x', id: 'x', data: { n: 1 } },
          ],
          extra: { dropped: true },
        } as unknown as HarnessUIMessage
        await adapter.save(sessionId, [first])
        // the core drops keys on purpose (e.g. `pending` resolved, a part removed): no merge
        const second = message(a, 'second', {
          role: 'assistant',
          metadata: { eharness: { v: 1, createdAt: 1, stop: 'complete' } },
        })
        await adapter.save(sessionId, [second])
        assertJsonEqual(await adapter.load({ sessionId }), [second], 'replaced message')
      },
    },
    {
      name: '{ fromId } between stored ids starts at the next newer one',
      run: async () => {
        const adapter = await factory()
        const sessionId = uniqueSessionId('from-between')
        const list = ids(5)
        // list[2] is never stored: fromId need not exist (e.g. a deleted boundary)
        await adapter.save(
          sessionId,
          list.filter((_, i) => i !== 2).map((id, i) => message(id, `m${i}`)),
        )
        const loaded = await adapter.load({ sessionId, fromId: list[2] as string })
        assertJsonEqual(idsOf(loaded), list.slice(3), 'load({ fromId }) without an exact match')
      },
    },
    {
      name: '{ beforeId } without limit returns every older message',
      run: async () => {
        const adapter = await factory()
        const sessionId = uniqueSessionId('before-all')
        const list = ids(5)
        await adapter.save(
          sessionId,
          list.map((id, i) => message(id, `m${i}`)),
        )
        const loaded = await adapter.load({ sessionId, beforeId: list[3] as string })
        assertJsonEqual(idsOf(loaded), list.slice(0, 3), 'load({ beforeId })')
      },
    },
    {
      name: '{ fromId } returns every message with id >= fromId (inclusive, no limit)',
      run: async () => {
        const adapter = await factory()
        const sessionId = uniqueSessionId('from')
        const list = ids(5)
        await adapter.save(
          sessionId,
          list.map((id, i) => message(id, `m${i}`)),
        )
        const loaded = await adapter.load({ sessionId, fromId: list[2] as string })
        assertJsonEqual(idsOf(loaded), list.slice(2), 'load({ fromId })')
      },
    },
    {
      name: '{ beforeId, limit } returns the newest `limit` messages before beforeId, chronological',
      run: async () => {
        const adapter = await factory()
        const sessionId = uniqueSessionId('before')
        const list = ids(6)
        await adapter.save(
          sessionId,
          list.map((id, i) => message(id, `m${i}`)),
        )
        const loaded = await adapter.load({ sessionId, beforeId: list[4] as string, limit: 2 })
        assertJsonEqual(idsOf(loaded), list.slice(2, 4), 'load({ beforeId, limit })')
        const all = await adapter.load({ sessionId, beforeId: list[4] as string, limit: 100 })
        assertJsonEqual(idsOf(all), list.slice(0, 4), 'load({ beforeId, limit: 100 })')
      },
    },
    {
      name: '{ limit } returns the newest `limit` messages, chronological',
      run: async () => {
        const adapter = await factory()
        const sessionId = uniqueSessionId('limit')
        const list = ids(5)
        await adapter.save(
          sessionId,
          list.map((id, i) => message(id, `m${i}`)),
        )
        assertJsonEqual(
          idsOf(await adapter.load({ sessionId, limit: 3 })),
          list.slice(2),
          'load({ limit: 3 })',
        )
      },
    },
    {
      name: 'an unknown session is empty',
      run: async () => {
        const adapter = await factory()
        const sessionId = uniqueSessionId('empty')
        assertJsonEqual(await adapter.load({ sessionId }), [], 'load({})')
        assertJsonEqual(await adapter.load({ sessionId, limit: 10 }), [], 'load({ limit })')
        assertJsonEqual(await adapter.load({ sessionId, fromId: uuidv7() }), [], 'load({ fromId })')
      },
    },
    {
      name: 'sessions are isolated',
      run: async () => {
        const adapter = await factory()
        const one = uniqueSessionId('iso-a')
        const two = uniqueSessionId('iso-b')
        const [a, b] = ids(2) as [string, string]
        await adapter.save(one, [message(a, 'one')])
        await adapter.save(two, [message(b, 'two')])
        assertJsonEqual(idsOf(await adapter.load({ sessionId: one })), [a], 'session one')
        assertJsonEqual(idsOf(await adapter.load({ sessionId: two })), [b], 'session two')
      },
    },
    {
      name: 'round-trips JSON deep-equal (unknown keys, data parts, tool parts, part order)',
      run: async () => {
        const adapter = await factory()
        const sessionId = uniqueSessionId('json')
        const [a, b] = ids(2) as [string, string]
        const assistant = {
          id: b,
          role: 'assistant',
          metadata: {
            eharness: {
              v: 1,
              createdAt: 1_790_000_000_001,
              turnId: 't1',
              usage: { inputTokens: 10, outputTokens: 5 },
              stop: 'complete',
              futureKey: { nested: [1, 'two', null, true] },
            },
            app: { rating: 5 },
          },
          parts: [
            { type: 'step-start' },
            { type: 'reasoning', text: 'thinking', providerMetadata: { mock: { sig: 'x' } } },
            {
              type: 'tool-weather',
              toolCallId: 'call-1',
              state: 'output-available',
              input: { city: 'Oslo' },
              output: { temp: 20.5, unicode: 'ø ✓ 😀' },
            },
            { type: 'data-invoice', id: 'inv-1', data: { total: 12.5, lines: [{ n: 1 }] } },
            { type: 'data-eh.input', data: { source: 'user', text: 'steer' } },
            { type: 'text', text: 'Done.', state: 'done' },
          ],
        } as unknown as HarnessUIMessage
        const saved = [message(a, 'hi'), assistant]
        await adapter.save(sessionId, saved)
        assertJsonEqual(await adapter.load({ sessionId }), saved, 'round-trip')
      },
    },
    {
      name: 'load returns copies (mutating the result does not change stored data)',
      run: async () => {
        const adapter = await factory()
        const sessionId = uniqueSessionId('copy')
        const [a] = ids(1) as [string]
        const original = message(a, 'original')
        await adapter.save(sessionId, [original])
        // mutating the saved object after save must not change storage either
        ;(original.parts[0] as { text: string }).text = 'changed after save'
        const first = await adapter.load({ sessionId })
        ;(first[0]?.parts[0] as { text: string }).text = 'mutated'
        first.push(message(uuidv7(), 'pushed'))
        const second = await adapter.load({ sessionId })
        assertJsonEqual(second, [message(a, 'original')], 'second load')
      },
    },
    {
      name: 'lastId returns the newest id (or null for an empty session)',
      run: async () => {
        const adapter = await factory()
        if (adapter.lastId === undefined) {
          assertTrue(options.requireLastId !== true, 'lastId is required but not implemented')
          return
        }
        const sessionId = uniqueSessionId('last')
        assertTrue((await adapter.lastId(sessionId)) === null, 'lastId of an empty session')
        const [a, b, c] = ids(3) as [string, string, string]
        await adapter.save(sessionId, [message(c, 'c'), message(a, 'a')])
        await adapter.save(sessionId, [message(b, 'b')])
        const last = await adapter.lastId(sessionId)
        assertTrue(last === c, `lastId: expected ${c}, got ${String(last)}`)
        await adapter.save(sessionId, [message(a, 'a patched')]) // patching keeps lastId
        assertTrue(
          (await adapter.lastId(sessionId)) === c,
          'lastId after patching an older message',
        )
      },
    },
  ]
}
