/**
 * In-memory {@link OutboxStore}: for tests, prototypes and single-process apps. Every read and
 * write copies.
 *
 * @see docs/specs/31-channels.md#3-outbox
 */
import type { OutboxRecord, OutboxStore } from './types.ts'

/** Options of {@link memoryOutboxStore}. */
export interface MemoryOutboxStoreOptions {
  /** Clock for `createdAt` / `updatedAt` / `purge` in epoch ms. Default `Date.now`. */
  now?: () => number
}

const copy = (r: OutboxRecord): OutboxRecord => structuredClone(r)

/** Create an in-memory {@link OutboxStore}. */
export function memoryOutboxStore(options: MemoryOutboxStoreOptions = {}): OutboxStore {
  const clock = options.now ?? Date.now
  const rows = new Map<string, OutboxRecord>()

  const touch = (r: OutboxRecord): void => {
    r.updatedAt = clock()
  }
  const release = (r: OutboxRecord, state: 'pending' | 'dead'): void => {
    r.state = state
    delete r.owner
    delete r.leaseUntil
    touch(r)
  }
  const held = (id: string, owner: string): OutboxRecord | undefined => {
    const r = rows.get(id)
    return r !== undefined && r.state === 'claimed' && r.owner === owner ? r : undefined
  }

  return {
    async enqueue(item) {
      const existing = rows.get(item.id)
      if (existing !== undefined) return { created: false, record: copy(existing) }
      const t = clock()
      const record: OutboxRecord = {
        ...structuredClone(item),
        state: 'pending',
        createdAt: t,
        updatedAt: t,
      }
      rows.set(item.id, record)
      return { created: true, record: copy(record) }
    },
    async claim(now, owner, leaseMs, limit) {
      const due = [...rows.values()]
        .filter(
          (r) =>
            (r.state === 'pending' && r.availableAt <= now) ||
            (r.state === 'claimed' && (r.leaseUntil ?? 0) <= now),
        )
        .sort((a, b) => a.availableAt - b.availableAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      const out: OutboxRecord[] = []
      for (const r of due) {
        if (out.length >= limit) break
        if (r.state === 'claimed' && r.attempts >= r.maxAttempts) {
          r.error = r.error ?? 'lease expired after the last attempt'
          release(r, 'dead')
          continue
        }
        r.state = 'claimed'
        r.owner = owner
        r.leaseUntil = now + leaseMs
        r.attempts += 1
        touch(r)
        out.push(copy(r))
      }
      return out
    },
    async succeed(id, owner, result) {
      const r = held(id, owner)
      if (r === undefined) return false
      r.state = 'done'
      delete r.owner
      delete r.leaseUntil
      if (result !== undefined) r.result = structuredClone(result)
      touch(r)
      return true
    },
    async fail(id, owner, failure) {
      const r = held(id, owner)
      if (r === undefined) return undefined
      r.error = failure.error
      const dead = failure.permanent === true || r.attempts >= r.maxAttempts
      if (!dead) r.availableAt = failure.retryAt ?? clock()
      release(r, dead ? 'dead' : 'pending')
      return dead ? 'dead' : 'pending'
    },
    async defer(id, owner, availableAt) {
      const r = held(id, owner)
      if (r === undefined) return false
      r.attempts = Math.max(0, r.attempts - 1)
      r.availableAt = availableAt
      release(r, 'pending')
      return true
    },
    async get(id) {
      const r = rows.get(id)
      return r === undefined ? undefined : copy(r)
    },
    async list(query = {}) {
      const all = [...rows.values()]
        .filter((r) => query.state === undefined || r.state === query.state)
        .sort((a, b) => a.availableAt - b.availableAt || (a.id < b.id ? -1 : 1))
      return all.slice(0, query.limit ?? all.length).map(copy)
    },
    async purge(olderThan) {
      let n = 0
      for (const [id, r] of rows) {
        if ((r.state === 'done' || r.state === 'dead') && r.updatedAt < olderThan) {
          rows.delete(id)
          n++
        }
      }
      return n
    },
  }
}
