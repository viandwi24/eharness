/** `SessionLock` (spec 05 §8): a row per session with a lease. */
import { HarnessError, type SessionLock, uuidv7 } from 'eharness'
import type { SqlDriver } from './driver.ts'
import { type AdapterOptions, clock, one, tables } from './util.ts'

/** Options of {@link sqliteLock}. */
export interface SqliteLockOptions extends AdapterOptions {
  /** Lease length (ms). The holder renews it every third of it. Default 30 000. */
  ms?: number
  /** Owner string of this instance. Default a random id. */
  owner?: string
}

/**
 * Cross-process turn exclusion. `acquire` takes the row when no live lease holds it and rejects
 * `EH_SESSION_BUSY` otherwise; a holder that died stops renewing and its lease expires. When
 * `acquire` receives an `owner` (an instance id that survives a restart), a lease held under that
 * same owner by a holder this process does not know is taken over at once (P62 workstream E).
 */
export function sqliteLock(driver: SqlDriver, options: SqliteLockOptions = {}): SessionLock {
  const t = tables(options.prefix).locks
  const now = clock(options)
  const leaseMs = options.ms ?? 30_000
  const defaultInstance = options.owner ?? uuidv7()
  /** Leases this lock object holds: a live holder is never taken over by the same object. */
  const held = new Set<string>()
  return {
    async acquire(
      sessionId: string,
      opts: { signal: AbortSignal; owner?: string },
    ): Promise<() => Promise<void>> {
      opts.signal.throwIfAborted()
      const instance = opts.owner ?? defaultInstance
      const owner = `${instance}:${uuidv7()}`
      const taken = driver.transaction(() => {
        const at = now()
        driver.run(`DELETE FROM ${t} WHERE session_id = ? AND until <= ?`, [sessionId, at])
        if (opts.owner !== undefined) {
          const row = one<{ owner: string }>(
            driver,
            `SELECT owner FROM ${t} WHERE session_id = ?`,
            [sessionId],
          )
          if (row?.owner.startsWith(`${instance}:`) && !held.has(row.owner)) {
            driver.run(`DELETE FROM ${t} WHERE session_id = ?`, [sessionId])
          }
        }
        return (
          driver.run(
            `INSERT INTO ${t} (session_id, owner, until) VALUES (?, ?, ?) ON CONFLICT DO NOTHING`,
            [sessionId, owner, at + leaseMs],
          ).changes === 1
        )
      })
      if (!taken) {
        throw new HarnessError('EH_SESSION_BUSY', `session ${sessionId} is locked elsewhere`)
      }
      held.add(owner)
      const timer = setInterval(
        () => {
          try {
            driver.run(`UPDATE ${t} SET until = ? WHERE session_id = ? AND owner = ?`, [
              now() + leaseMs,
              sessionId,
              owner,
            ])
          } catch {
            // the database was closed under a turn that is still unwinding: nothing to extend
            clearInterval(timer)
          }
        },
        Math.max(10, Math.floor(leaseMs / 3)),
      )
      ;(timer as { unref?: () => void }).unref?.()
      let released = false
      return async () => {
        if (released) return
        released = true
        held.delete(owner)
        clearInterval(timer)
        driver.run(`DELETE FROM ${t} WHERE session_id = ? AND owner = ?`, [sessionId, owner])
      }
    },
  }
}
