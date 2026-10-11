/**
 * In-memory {@link ActivityStore}: for tests, prototypes and single-process apps. Every read and
 * write deep-copies.
 *
 * @see docs/specs/25-activity.md#3-activitystore
 */
import type {
  ActivityInput,
  ActivityPruneOptions,
  ActivityReadQuery,
  ActivityRecord,
  ActivityStore,
} from './types.ts'

/** Options of {@link inMemoryActivityStore}. */
export interface InMemoryActivityStoreOptions {
  /** Clock in epoch ms. Default `Date.now`. */
  now?: () => number
}

/**
 * The retention rule shared by adapters: the highest `seq` that pruning may remove for `options`
 * (`0` = nothing), given the records (oldest first) and the head. Exported for adapters that
 * keep records outside SQL.
 */
export function pruneBoundary(
  records: ReadonlyArray<Pick<ActivityRecord, 'seq' | 'createdAt'>>,
  options: ActivityPruneOptions,
): number {
  const head = records.at(-1)?.seq ?? 0
  let boundary = 0
  if (options.olderThan !== undefined) {
    const cutoff = options.olderThan
    for (const r of records) if (r.createdAt < cutoff && r.seq > boundary) boundary = r.seq
  }
  if (options.keepLast !== undefined && options.keepLast >= 1) {
    const cut = records[records.length - 1 - options.keepLast]
    if (cut !== undefined) boundary = Math.max(boundary, cut.seq)
  }
  // the newest record is the head every cursor compares to: it always stays
  return Math.max(0, Math.min(boundary, head - 1))
}

/**
 * Create an in-memory store. Two stores are two independent logs; to model two instances over one
 * log, share one store object.
 */
export function inMemoryActivityStore(options: InMemoryActivityStoreOptions = {}): ActivityStore {
  const now = options.now ?? ((): number => Date.now())
  let records: ActivityRecord[] = []
  let seq = 0
  let pruned = 0

  const copy = (r: ActivityRecord): ActivityRecord => structuredClone(r)

  return {
    async append(events) {
      const list: readonly ActivityInput[] = Array.isArray(events)
        ? (events as readonly ActivityInput[])
        : [events as ActivityInput]
      const out: ActivityRecord[] = []
      for (const e of list) {
        seq += 1
        const record: ActivityRecord = {
          seq,
          type: e.type,
          sessionId: e.sessionId ?? null,
          agentId: e.agentId ?? null,
          payload: structuredClone(e.payload ?? {}),
          createdAt: e.at ?? now(),
        }
        records.push(record)
        out.push(copy(record))
      }
      return out
    },

    async read(q: ActivityReadQuery) {
      const out: ActivityRecord[] = []
      for (const r of records) {
        if (r.seq <= q.after) continue
        if (q.types !== undefined && !q.types.includes(r.type)) continue
        if (q.sessionId !== undefined && r.sessionId !== q.sessionId) continue
        out.push(copy(r))
        if (out.length >= q.limit) break
      }
      return out
    },

    async lastSeq() {
      return seq
    },

    async prunedThrough() {
      return pruned
    },

    async prune(o) {
      const boundary = pruneBoundary(records, o)
      if (boundary <= 0) return { deleted: 0, prunedThrough: pruned }
      const survivors = new Set<number>()
      for (const rule of o.keepLatestOf ?? []) {
        const latest = new Map<string, number>()
        for (const r of records) {
          if (r.type !== rule.type) continue
          const key = rule.by === 'agentId' ? r.agentId : r.sessionId
          if (key !== null) latest.set(key, r.seq)
        }
        for (const s of latest.values()) survivors.add(s)
      }
      const before = records.length
      records = records.filter((r) => r.seq > boundary || survivors.has(r.seq))
      pruned = Math.max(pruned, boundary)
      return { deleted: before - records.length, prunedThrough: pruned }
    },
  }
}
