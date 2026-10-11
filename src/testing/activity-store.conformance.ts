import type { ActivityRecord, ActivityStore } from '../activity/types.ts'
import { assertJsonEqual, assertTrue } from './assert.ts'
import type { ConformanceCase } from './types.ts'

/** What the factory of {@link activityStoreConformance} returns: a fresh, empty log. */
export interface ActivityStoreUnderTest {
  store: ActivityStore
  /**
   * A second handle on the SAME log (another instance: another connection, another process object).
   * Enables the multi-instance cases; for an in-memory adapter return `store` itself.
   */
  peer?: () => ActivityStore
}

/** Options of {@link activityStoreConformance}. */
export interface ActivityStoreConformanceOptions {
  /** Parallel appends of the concurrency case. Default 50. */
  concurrency?: number
}

const HOUR = 3_600_000
const T0 = Date.UTC(2026, 0, 1)

const seqs = (records: readonly ActivityRecord[]): number[] => records.map((r) => r.seq)

/**
 * Conformance cases for an {@link ActivityStore} (spec 25 §3): strictly increasing seq across
 * batches and instances, reads after a cursor with filters and limits, deep-copied records,
 * pruning by age, count and survivors with the head kept and `prunedThrough` monotonic, and no
 * seq reuse after pruning.
 *
 * @example
 * ```ts
 * for (const c of activityStoreConformance(() => ({ store: memoryActivityStore() }))) test(c.name, c.run)
 * ```
 * @see docs/specs/25-activity.md#3-activitystore
 */
export function activityStoreConformance(
  factory: () => ActivityStoreUnderTest | Promise<ActivityStoreUnderTest>,
  options: ActivityStoreConformanceOptions = {},
): ConformanceCase[] {
  const parallel = options.concurrency ?? 50
  return [
    {
      name: 'an empty log has lastSeq 0 and prunedThrough 0 and reads nothing',
      run: async () => {
        const { store } = await factory()
        assertTrue((await store.lastSeq()) === 0, 'lastSeq of an empty log is 0')
        assertTrue((await store.prunedThrough()) === 0, 'prunedThrough of an empty log is 0')
        assertTrue((await store.read({ after: 0, limit: 10 })).length === 0, 'nothing to read')
      },
    },
    {
      name: 'append assigns increasing seq values (single and batch) and returns the records',
      run: async () => {
        const { store } = await factory()
        const [a] = await store.append({
          type: 'a',
          sessionId: 's1',
          agentId: 'x',
          payload: { n: 1 },
        })
        assertTrue(a !== undefined && a.seq >= 1, 'first seq is positive')
        const batch = await store.append([
          { type: 'b' },
          { type: 'c', payload: { deep: { k: [1] } } },
        ])
        assertTrue(batch.length === 2, 'a batch returns one record per input')
        const [b, c] = batch as [ActivityRecord, ActivityRecord]
        assertTrue((a as ActivityRecord).seq < b.seq && b.seq < c.seq, 'seq strictly increases')
        assertTrue(b.sessionId === null && b.agentId === null, 'missing ids are null')
        assertJsonEqual(b.payload, {}, 'missing payload is {}')
        assertJsonEqual(c.payload, { deep: { k: [1] } }, 'payload round-trips')
        assertTrue((await store.lastSeq()) === c.seq, 'lastSeq is the newest seq')
        const read = await store.read({ after: 0, limit: 10 })
        assertJsonEqual(seqs(read), [(a as ActivityRecord).seq, b.seq, c.seq], 'read order')
        assertJsonEqual(read[0], a, 'the stored record equals the returned one')
      },
    },
    {
      name: 'createdAt is the given `at`, else a current time',
      run: async () => {
        const { store } = await factory()
        const [a, b] = (await store.append([{ type: 'a', at: T0 }, { type: 'b' }])) as [
          ActivityRecord,
          ActivityRecord,
        ]
        assertTrue(a.createdAt === T0, 'at is stored as createdAt')
        assertTrue(Math.abs(b.createdAt - Date.now()) < 60_000, 'createdAt defaults to now')
      },
    },
    {
      name: 'read returns records after a cursor, oldest first, up to the limit',
      run: async () => {
        const { store } = await factory()
        for (let i = 0; i < 5; i++) await store.append({ type: 'e', payload: { i } })
        const all = await store.read({ after: 0, limit: 100 })
        assertTrue(all.length === 5, 'five records')
        const page = await store.read({ after: (all[1] as ActivityRecord).seq, limit: 2 })
        assertJsonEqual(seqs(page), seqs(all.slice(2, 4)), 'cursor and limit')
        const none = await store.read({ after: (all[4] as ActivityRecord).seq, limit: 10 })
        assertTrue(none.length === 0, 'nothing after the head')
        const beyond = await store.read({ after: 10_000_000, limit: 10 })
        assertTrue(beyond.length === 0, 'a cursor beyond the head reads nothing')
      },
    },
    {
      name: 'read filters by types and sessionId; the cursor still advances over skipped records',
      run: async () => {
        const { store } = await factory()
        await store.append([
          { type: 'a', sessionId: 's1' },
          { type: 'b', sessionId: 's2' },
          { type: 'a', sessionId: 's2' },
          { type: 'c', sessionId: 's1' },
        ])
        const types = await store.read({ after: 0, limit: 10, types: ['a'] })
        assertTrue(types.length === 2 && types.every((r) => r.type === 'a'), 'filter by type')
        const session = await store.read({ after: 0, limit: 10, sessionId: 's2' })
        assertTrue(session.length === 2 && session.every((r) => r.sessionId === 's2'), 'by session')
        const both = await store.read({ after: 0, limit: 10, types: ['a'], sessionId: 's2' })
        assertTrue(both.length === 1, 'both filters')
        const limited = await store.read({ after: 0, limit: 1, types: ['c'] })
        assertTrue(
          limited.length === 1 && limited[0]?.type === 'c',
          'limit applies after the filter',
        )
      },
    },
    {
      name: 'records are copies: mutating a result changes nothing stored',
      run: async () => {
        const { store } = await factory()
        const input = { type: 'a', payload: { list: [1] } }
        const [rec] = await store.append(input)
        input.payload.list.push(2)
        ;((rec as ActivityRecord).payload.list as number[]).push(3)
        const [read] = await store.read({ after: 0, limit: 1 })
        assertJsonEqual((read as ActivityRecord).payload, { list: [1] }, 'stored payload')
      },
    },
    {
      name: 'concurrent appends never share a seq',
      run: async () => {
        const { store, peer } = await factory()
        const other = peer?.() ?? store
        const results = await Promise.all(
          Array.from({ length: parallel }, (_, i) =>
            (i % 2 === 0 ? store : other).append({ type: 'c', payload: { i } }),
          ),
        )
        const all = results.flat().map((r) => r.seq)
        assertTrue(new Set(all).size === parallel, 'every append got its own seq')
        const read = await store.read({ after: 0, limit: parallel + 10 })
        assertTrue(read.length === parallel, 'all records are readable')
        for (let i = 1; i < read.length; i++) {
          assertTrue(
            (read[i] as ActivityRecord).seq > (read[i - 1] as ActivityRecord).seq,
            'ordered',
          )
        }
      },
    },
    {
      name: 'two instances: each sees the other’s appends in one seq order',
      run: async () => {
        const { store, peer } = await factory()
        const other = peer?.() ?? store
        const a = await store.append({ type: 'from-a' })
        const b = await other.append({ type: 'from-b' })
        const c = await store.append({ type: 'from-a' })
        assertTrue(
          (a[0] as ActivityRecord).seq < (b[0] as ActivityRecord).seq &&
            (b[0] as ActivityRecord).seq < (c[0] as ActivityRecord).seq,
          'seq follows the real order across instances',
        )
        const seenByA = await store.read({ after: 0, limit: 10 })
        const seenByB = await other.read({ after: 0, limit: 10 })
        assertJsonEqual(seqs(seenByA), seqs(seenByB), 'both read the same log')
        assertTrue(seenByA.length === 3, 'three records')
        assertTrue((await other.lastSeq()) === (c[0] as ActivityRecord).seq, 'lastSeq is shared')
        // a tailing reader on B resumes from its cursor
        const tail = await other.read({ after: (a[0] as ActivityRecord).seq, limit: 10 })
        assertJsonEqual(seqs(tail), seqs(seenByA.slice(1)), 'tail by seq')
      },
    },
    {
      name: 'prune by age removes older records, keeps the head and raises prunedThrough',
      run: async () => {
        const { store } = await factory()
        await store.append([
          { type: 'e', at: T0 - 100 * HOUR },
          { type: 'e', at: T0 - 99 * HOUR },
          { type: 'e', at: T0 - 98 * HOUR },
          { type: 'e', at: T0 },
        ])
        const r = await store.prune({ olderThan: T0 - 72 * HOUR })
        assertTrue(r.deleted === 3, `deleted 3, got ${r.deleted}`)
        const left = await store.read({ after: 0, limit: 10 })
        assertTrue(left.length === 1 && left[0]?.createdAt === T0, 'only the recent record is left')
        assertTrue(r.prunedThrough === 3 && (await store.prunedThrough()) === 3, 'prunedThrough')
        const again = await store.prune({ olderThan: T0 - 72 * HOUR })
        assertTrue(again.deleted === 0 && again.prunedThrough === 3, 'a second prune is a no-op')
      },
    },
    {
      name: 'the newest record is never pruned, even when it is old',
      run: async () => {
        const { store } = await factory()
        await store.append([
          { type: 'e', at: T0 - 100 * HOUR },
          { type: 'e', at: T0 - 99 * HOUR },
        ])
        const r = await store.prune({ olderThan: T0 })
        assertTrue(r.deleted === 1, 'the head stays')
        const left = await store.read({ after: 0, limit: 10 })
        assertTrue(left.length === 1 && left[0]?.seq === 2, 'seq 2 is the head')
        assertTrue((await store.lastSeq()) === 2, 'lastSeq unchanged')
      },
    },
    {
      name: 'prune by count keeps the newest records; seq is never reused; the mark never goes down',
      run: async () => {
        const { store } = await factory()
        for (let i = 0; i < 10; i++) await store.append({ type: 'e', at: T0 })
        const none = await store.prune({ olderThan: T0 - 72 * HOUR })
        assertTrue(none.deleted === 0 && none.prunedThrough === 0, 'nothing old enough')
        const r = await store.prune({ keepLast: 4 })
        assertTrue(r.deleted === 6 && r.prunedThrough === 6, 'six oldest removed')
        assertJsonEqual(seqs(await store.read({ after: 0, limit: 100 })), [7, 8, 9, 10], 'kept')
        await store.prune({ olderThan: 1 })
        assertTrue((await store.prunedThrough()) === 6, 'the mark never goes down')
        const [next] = await store.append({ type: 'e' })
        assertTrue((next as ActivityRecord).seq === 11, 'seq is not reused after pruning')
      },
    },
    {
      name: 'keepLatestOf keeps the newest record of a type for every key',
      run: async () => {
        const { store } = await factory()
        await store.append([
          { type: 'message-added', agentId: 'a1', payload: { p: 'old a1' }, at: T0 - 100 * HOUR }, // 1: last of a1
          { type: 'noise', at: T0 - 99 * HOUR }, // 2
          { type: 'message-added', agentId: 'a2', payload: { p: 'old a2' }, at: T0 - 98 * HOUR }, // 3
          { type: 'message-added', agentId: 'a2', payload: { p: 'newer a2' }, at: T0 - 97 * HOUR }, // 4: last of a2
          { type: 'noise', at: T0 - 96 * HOUR }, // 5: head
        ])
        const r = await store.prune({
          olderThan: T0 - 72 * HOUR,
          keepLatestOf: [{ type: 'message-added', by: 'agentId' }],
        })
        assertTrue(r.deleted === 2, `deleted seq 2 and 3, got ${r.deleted}`)
        assertJsonEqual(seqs(await store.read({ after: 0, limit: 10 })), [1, 4, 5], 'survivors')
        assertTrue(r.prunedThrough === 4, 'the mark is the boundary, the head (5) stays')
      },
    },
    {
      name: 'reads below the mark still return the surviving records after the cursor',
      run: async () => {
        const { store } = await factory()
        for (let i = 0; i < 6; i++) await store.append({ type: 'e', at: T0 })
        await store.prune({ keepLast: 2 })
        const read = await store.read({ after: 1, limit: 10 })
        assertJsonEqual(seqs(read), [5, 6], 'a reader behind the mark gets what is left')
        assertTrue((await store.prunedThrough()) > 1, 'and can tell it is behind (prunedThrough)')
      },
    },
  ]
}
