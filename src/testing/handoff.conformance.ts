import type { HandoffInput, HandoffStore } from '../handoff/index.ts'
import { assertTrue, uniqueSessionId } from './assert.ts'
import type { ConformanceCase } from './types.ts'

/**
 * Conformance cases for a {@link HandoffStore} (spec 32 §2): create is idempotent by id; `answer`
 * and `cancel` are compare-and-set out of `open` (exactly one of many parallel answers wins);
 * `expire` closes only open, due requests; `list` filters by status, session and audience and
 * pages with a cursor.
 *
 * @example
 * ```ts
 * for (const c of handoffStoreConformance(() => myStore(db))) test(c.name, c.run)
 * ```
 * @see docs/specs/32-handoff.md#8-conformance
 */
export function handoffStoreConformance(
  factory: () => HandoffStore | Promise<HandoffStore>,
): ConformanceCase[] {
  const input = (over: Partial<HandoffInput> = {}): HandoffInput => {
    const sessionId = uniqueSessionId('s')
    return {
      id: `${sessionId}:w_1`,
      sessionId,
      toolCallId: '1',
      waitId: 'w_1',
      kind: 'decision',
      title: 'Approve?',
      body: 'Please approve',
      options: [
        { id: 'yes', label: 'Yes' },
        { id: 'no', label: 'No' },
      ],
      createdAt: 1000,
      ...over,
    }
  }
  const answer = (by: string): { optionId: string; by: string; at: number } => ({
    optionId: 'yes',
    by,
    at: 2000,
  })

  return [
    {
      name: 'create is idempotent by id and starts open',
      run: async () => {
        const store = await factory()
        const a = await store.create(input())
        assertTrue(a.created && a.request.status === 'open', 'created open')
        const b = await store.create({ ...input(), id: a.request.id, title: 'other' })
        assertTrue(!b.created && b.request.title === 'Approve?', 'second create returns existing')
        assertTrue((await store.get('nope')) === undefined, 'unknown id')
      },
    },
    {
      name: 'answer is a compare-and-set: one of many parallel answers wins',
      run: async () => {
        const store = await factory()
        const { request } = await store.create(input())
        const results = await Promise.all(
          ['a', 'b', 'c', 'd'].map((by) => store.answer(request.id, answer(by))),
        )
        assertTrue(results.filter((r) => r.ok).length === 1, 'exactly one winner')
        const loser = results.find((r) => !r.ok)
        assertTrue(
          loser !== undefined &&
            !loser.ok &&
            loser.reason === 'already-answered' &&
            loser.alreadyAnswered === true &&
            loser.request?.status === 'answered',
          'losers see alreadyAnswered with the request',
        )
        const stored = await store.get(request.id)
        assertTrue(stored?.status === 'answered' && stored.answer?.optionId === 'yes', 'stored')
        const missing = await store.answer('nope', answer('x'))
        assertTrue(!missing.ok && missing.reason === 'not-found', 'unknown id')
      },
    },
    {
      name: 'cancel only works on open requests; a cancelled request cannot be answered',
      run: async () => {
        const store = await factory()
        const { request } = await store.create(input())
        const c = await store.cancel(request.id)
        assertTrue(c.ok && c.request.status === 'cancelled', 'cancelled')
        const again = await store.cancel(request.id)
        assertTrue(!again.ok && again.reason === 'cancelled', 'cancel twice')
        const a = await store.answer(request.id, answer('x'))
        assertTrue(!a.ok && a.reason === 'cancelled', 'answer after cancel')
      },
    },
    {
      name: 'expire closes only open requests that are due and returns them',
      run: async () => {
        const store = await factory()
        const due = await store.create(input({ expiresAt: 5000 }))
        const later = await store.create(
          input({ expiresAt: 9000, id: 'later', sessionId: 'later', waitId: 'w_2' }),
        )
        const never = await store.create(input({ id: 'never', sessionId: 'never' }))
        const done = await store.create(
          input({ expiresAt: 5000, id: 'done', sessionId: 'done', waitId: 'w_3' }),
        )
        await store.answer(done.request.id, answer('x'))
        const expired = await store.expire(6000)
        assertTrue(
          expired.length === 1 &&
            expired[0]?.id === due.request.id &&
            expired[0].status === 'expired',
          'only the due open one',
        )
        assertTrue((await store.get(later.request.id))?.status === 'open', 'later stays open')
        assertTrue((await store.get(never.request.id))?.status === 'open', 'no expiry stays open')
        assertTrue((await store.expire(6000)).length === 0, 'second sweep finds nothing')
        const a = await store.answer(due.request.id, answer('x'))
        assertTrue(!a.ok && a.reason === 'expired', 'cannot answer an expired request')
      },
    },
    {
      name: 'list filters by status, session and audience and pages with a cursor',
      run: async () => {
        const store = await factory()
        const tag = uniqueSessionId('t')
        const mk = (n: number, over: Partial<HandoffInput> = {}): HandoffInput =>
          input({
            id: `${tag}-${n}`,
            sessionId: `${tag}-s${n % 2}`,
            createdAt: 1000 + n,
            ...over,
          })
        await store.create(mk(1, { audience: ['finance'] }))
        await store.create(mk(2, { audience: ['legal'] }))
        await store.create(mk(3))
        await store.create(mk(4))
        await store.answer(`${tag}-4`, answer('x'))
        const mine = (await store.list({ limit: 100 })).items.filter((r) => r.id.startsWith(tag))
        assertTrue(mine.length === 4 && mine[0]?.id === `${tag}-1`, 'oldest first')
        const open = (await store.list({ status: 'open', limit: 100 })).items.filter((r) =>
          r.id.startsWith(tag),
        )
        assertTrue(open.length === 3, 'status filter')
        const bySession = await store.list({ sessionId: `${tag}-s1` })
        assertTrue(bySession.items.length === 2, 'session filter')
        const fin = (await store.list({ audience: ['finance'], limit: 100 })).items.filter((r) =>
          r.id.startsWith(tag),
        )
        assertTrue(
          fin.map((r) => r.id).join() === `${tag}-1,${tag}-3,${tag}-4`,
          'audience matches its own and unaddressed requests',
        )
        const seen: string[] = []
        let cursor: string | undefined
        for (let i = 0; i < 100; i++) {
          const page = await store.list({
            sessionId: `${tag}-s1`,
            limit: 1,
            ...(cursor ? { cursor } : {}),
          })
          seen.push(...page.items.map((r) => r.id))
          cursor = page.nextCursor
          if (cursor === undefined) break
        }
        assertTrue(seen.length === 2 && new Set(seen).size === 2, 'cursor pages without repeats')
      },
    },
  ]
}
