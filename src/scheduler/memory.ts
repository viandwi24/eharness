import type { Schedule, ScheduleListQuery, ScheduleListResult, ScheduleStore } from './types.ts'

const clone = (s: Schedule): Schedule => structuredClone(s)

/**
 * In-memory {@link ScheduleStore} (tests, single process, examples).
 *
 * @example
 * ```ts
 * const store = memoryScheduleStore()
 * ```
 * @see docs/specs/29-scheduler.md#2-the-store-port
 */
export function memoryScheduleStore(): ScheduleStore {
  const rows = new Map<string, Schedule>()
  const free = (s: Schedule, now: number): boolean =>
    s.claimedBy === undefined || (s.claimedUntil ?? 0) <= now

  return {
    async get(id: string): Promise<Schedule | undefined> {
      const s = rows.get(id)
      return s && clone(s)
    },
    async list(query: ScheduleListQuery = {}): Promise<ScheduleListResult> {
      const limit = query.limit ?? 100
      const items = [...rows.values()]
        .filter((s) => query.sessionId === undefined || s.sessionId === query.sessionId)
        .filter((s) => query.state === undefined || s.state === query.state)
        .filter((s) => query.cursor === undefined || s.id > query.cursor)
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      const page = items.slice(0, limit)
      const last = page[page.length - 1]
      return {
        items: page.map(clone),
        ...(items.length > limit && last ? { nextCursor: last.id } : {}),
      }
    },
    async put(schedule: Schedule): Promise<Schedule> {
      const next = { ...clone(schedule), version: (rows.get(schedule.id)?.version ?? 0) + 1 }
      rows.set(next.id, next)
      return clone(next)
    },
    async update(schedule: Schedule, expectedVersion: number): Promise<Schedule | undefined> {
      const cur = rows.get(schedule.id)
      if (!cur || cur.version !== expectedVersion) return undefined
      const next = { ...clone(schedule), version: expectedVersion + 1 }
      rows.set(next.id, next)
      return clone(next)
    },
    async delete(id: string): Promise<boolean> {
      return rows.delete(id)
    },
    async due(now: number, limit: number): Promise<Schedule[]> {
      return [...rows.values()]
        .filter((s) => s.state === 'active' && s.nextFireAt !== null && s.nextFireAt <= now)
        .filter((s) => free(s, now))
        .sort((a, b) => (a.nextFireAt ?? 0) - (b.nextFireAt ?? 0))
        .slice(0, limit)
        .map(clone)
    },
    async claim(
      id: string,
      version: number,
      owner: string,
      leaseUntil: number,
    ): Promise<Schedule | undefined> {
      const s = rows.get(id)
      if (!s || s.version !== version || s.state !== 'active') return undefined
      s.claimedBy = owner
      s.claimedUntil = leaseUntil
      s.version += 1
      return clone(s)
    },
    async complete(
      id: string,
      owner: string,
      advance: { nextFireAt: number | null; lastFireAt?: number },
    ): Promise<Schedule | undefined> {
      const s = rows.get(id)
      if (!s || s.claimedBy !== owner) return undefined
      s.nextFireAt = advance.nextFireAt
      if (advance.lastFireAt !== undefined) s.lastFireAt = advance.lastFireAt
      delete s.claimedBy
      delete s.claimedUntil
      s.version += 1
      return clone(s)
    },
    async release(id: string, owner: string): Promise<boolean> {
      const s = rows.get(id)
      if (!s || s.claimedBy !== owner) return false
      delete s.claimedBy
      delete s.claimedUntil
      s.version += 1
      return true
    },
  }
}
