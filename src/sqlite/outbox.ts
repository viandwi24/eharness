/**
 * `OutboxStore` (spec 31 §3) on `<prefix>outbox`: a record is one JSON document with the columns
 * the queries need (`state`, `available_at`, `lease_until`, `updated_at`). `claim` and every state
 * transition run in one write transaction, so two owners (also in two processes) never hold the
 * same item.
 */
import type { ClaimOptions, OutboxRecord, OutboxState, OutboxStore } from '../channels/index.ts'
import type { SqlDriver } from './driver.ts'
import { type AdapterOptions, clock, one, tables } from './util.ts'

export function sqliteOutboxStore(driver: SqlDriver, options: AdapterOptions = {}): OutboxStore {
  const t = tables(options.prefix).outbox
  const now = clock(options)

  const read = (id: string): OutboxRecord | undefined => {
    const row = one<{ doc: string }>(driver, `SELECT doc FROM ${t} WHERE id = ?`, [id])
    return row === undefined ? undefined : (JSON.parse(row.doc) as OutboxRecord)
  }
  const write = (r: OutboxRecord): void => {
    driver.run(
      `INSERT INTO ${t} (id, state, available_at, lease_until, updated_at, doc) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET state = excluded.state, available_at = excluded.available_at,
         lease_until = excluded.lease_until, updated_at = excluded.updated_at, doc = excluded.doc`,
      [r.id, r.state, r.availableAt, r.leaseUntil ?? null, r.updatedAt, JSON.stringify(r)],
    )
  }
  /** Leave the leased state: owner and lease are cleared. */
  const settle = (r: OutboxRecord, state: OutboxState): void => {
    r.state = state
    delete r.owner
    delete r.leaseUntil
    r.updatedAt = now()
    write(r)
  }
  /** The record when `owner` holds its lease. */
  const held = (id: string, owner: string): OutboxRecord | undefined => {
    const r = read(id)
    return r !== undefined && r.state === 'claimed' && r.owner === owner ? r : undefined
  }

  return {
    async enqueue(item) {
      return driver.transaction(() => {
        const existing = read(item.id)
        if (existing !== undefined) return { created: false, record: existing }
        const at = now()
        const record: OutboxRecord = {
          ...structuredClone(item),
          state: 'pending',
          createdAt: at,
          updatedAt: at,
        }
        write(record)
        return { created: true, record }
      })
    },

    async claim(at, owner, leaseMs, limit, claimOptions: ClaimOptions = {}) {
      const reclaim = claimOptions.reclaimExpired !== false
      return driver.transaction(() => {
        const out: OutboxRecord[] = []
        const seen = new Set<string>()
        while (out.length < limit) {
          const rows = driver.query<{ doc: string }>(
            `SELECT doc FROM ${t}
             WHERE (state = 'pending' AND available_at <= ?)
                OR (? = 1 AND state = 'claimed' AND coalesce(lease_until, 0) <= ?)
             ORDER BY available_at, id LIMIT ?`,
            [at, reclaim ? 1 : 0, at, limit - out.length + seen.size],
          )
          const fresh = rows
            .map((row) => JSON.parse(row.doc) as OutboxRecord)
            .filter((r) => !seen.has(r.id))
          if (fresh.length === 0) break
          for (const r of fresh) {
            if (out.length >= limit) break
            seen.add(r.id)
            if (r.state === 'claimed' && r.attempts >= r.maxAttempts) {
              r.error = r.error ?? 'lease expired after the last attempt'
              settle(r, 'dead')
              continue
            }
            r.state = 'claimed'
            r.owner = owner
            r.leaseUntil = at + leaseMs
            r.attempts += 1
            r.updatedAt = now()
            write(r)
            out.push(r)
          }
        }
        return out
      })
    },

    async holdExpired(at) {
      return driver.transaction(() => {
        const out: OutboxRecord[] = []
        const rows = driver.query<{ doc: string }>(
          `SELECT doc FROM ${t} WHERE state = 'claimed' AND coalesce(lease_until, 0) <= ?
           ORDER BY available_at, id`,
          [at],
        )
        for (const row of rows) {
          const r = JSON.parse(row.doc) as OutboxRecord
          r.error = 'the lease expired while sending; delivery unknown'
          settle(r, 'held')
          out.push(r)
        }
        return out
      })
    },

    async release(id, resolution, at) {
      return driver.transaction(() => {
        const r = read(id)
        if (r === undefined || r.state !== 'held') return undefined
        if (resolution === 'retry') r.availableAt = at
        else r.error = 'dropped after the lease expired'
        settle(r, resolution === 'retry' ? 'pending' : 'skipped')
        return r
      })
    },

    async skip(id, owner, reason) {
      return driver.transaction(() => {
        const r = held(id, owner)
        if (r === undefined) return false
        r.error = reason
        settle(r, 'skipped')
        return true
      })
    },

    async succeed(id, owner, result) {
      return driver.transaction(() => {
        const r = held(id, owner)
        if (r === undefined) return false
        if (result !== undefined) r.result = structuredClone(result)
        settle(r, 'done')
        return true
      })
    },

    async fail(id, owner, failure) {
      return driver.transaction(() => {
        const r = held(id, owner)
        if (r === undefined) return undefined
        r.error = failure.error
        const dead = failure.permanent === true || r.attempts >= r.maxAttempts
        if (!dead) r.availableAt = failure.retryAt ?? now()
        settle(r, dead ? 'dead' : 'pending')
        return dead ? 'dead' : 'pending'
      })
    },

    async defer(id, owner, availableAt) {
      return driver.transaction(() => {
        const r = held(id, owner)
        if (r === undefined) return false
        r.attempts = Math.max(0, r.attempts - 1)
        r.availableAt = availableAt
        settle(r, 'pending')
        return true
      })
    },

    async get(id) {
      return read(id)
    },

    async list(query = {}) {
      const rows = driver.query<{ doc: string }>(
        `SELECT doc FROM ${t} WHERE (? IS NULL OR state = ?) ORDER BY available_at, id LIMIT ?`,
        [query.state ?? null, query.state ?? null, query.limit ?? -1],
      )
      return rows.map((row) => JSON.parse(row.doc) as OutboxRecord)
    },

    async purge(olderThan) {
      return driver.run(
        `DELETE FROM ${t} WHERE state IN ('done', 'dead', 'skipped') AND updated_at < ?`,
        [olderThan],
      ).changes
    },
  }
}
