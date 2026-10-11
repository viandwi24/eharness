import { isHarnessError, type SessionLock } from '../index.ts'
import { assertTrue, uniqueSessionId } from './assert.ts'
import type { ConformanceCase } from './types.ts'

/** What the factory of {@link lockConformance} returns. */
export interface LockUnderTest {
  /** A fresh lock with nothing held. */
  lock: SessionLock
  /**
   * A second handle on the SAME lock space (another instance: another connection, another process
   * object). Enables the cross-instance cases; for a lock shared in memory return the same view.
   */
  peer?: () => SessionLock
  /**
   * Simulate the crash of the holder of `sessionId`: make its lease expire without calling the
   * release function (e.g. set the lease's `until` to the past, or drop the row). Enables the
   * lease cases. Locks without a lease (advisory locks tied to a connection) omit it.
   */
  expire?: (sessionId: string) => void | Promise<void>
}

/** Options of {@link lockConformance}. */
export interface LockConformanceOptions {
  /** Parallel acquires of the concurrency case. Default 10. */
  concurrency?: number
  /** Longest an `acquire` may take to resolve or reject (ms); it must not block. Default 2 000. */
  maxAcquireMs?: number
}

type Outcome = { ok: true; release: () => Promise<void> } | { ok: false; error: unknown }

/**
 * Conformance cases for a {@link SessionLock} (spec 05 §8): acquire resolves with a release
 * function; a second acquire of a held session rejects promptly (never blocks); release frees the
 * session; a release is idempotent and a stale release never frees a newer holder; sessions are
 * independent; exactly one of many parallel acquires wins; with `peer`, a lock held through one
 * handle is held for the other; with `expire`, a holder that died (lease expired) is taken over
 * and its late release is a no-op.
 *
 * @example
 * ```ts
 * for (const c of lockConformance(() => ({ lock: myLock(db), peer: () => myLock(db) }))) test(c.name, c.run)
 * ```
 * @see docs/specs/05-session-and-storage.md#8-concurrency-and-locking
 */
export function lockConformance(
  factory: (() => LockUnderTest | Promise<LockUnderTest>) | (() => SessionLock),
  options: LockConformanceOptions = {},
): ConformanceCase[] {
  const parallel = options.concurrency ?? 10
  const maxMs = options.maxAcquireMs ?? 2_000
  const signal = (): AbortSignal => new AbortController().signal
  const make = async (): Promise<LockUnderTest> => {
    const made = await factory()
    return 'acquire' in made ? { lock: made } : made
  }
  /** Acquire, mapping a rejection to `{ ok: false }` and failing when it takes too long. */
  const attempt = async (lock: SessionLock, sessionId: string): Promise<Outcome> => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`acquire did not settle within ${maxMs} ms (it must not block)`)),
        maxMs,
      )
    })
    try {
      const release = await Promise.race([lock.acquire(sessionId, { signal: signal() }), timeout])
      assertTrue(typeof release === 'function', 'acquire resolves with a release function')
      return { ok: true, release }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('acquire did not settle')) throw error
      return { ok: false, error }
    } finally {
      clearTimeout(timer)
    }
  }
  const mustAcquire = async (lock: SessionLock, id: string, what: string) => {
    const got = await attempt(lock, id)
    if (!got.ok) throw new Error(`${what}: the acquire must succeed`)
    return got.release
  }
  const mustReject = async (lock: SessionLock, id: string, what: string): Promise<void> => {
    const got = await attempt(lock, id)
    if (got.ok) {
      await got.release()
      throw new Error(`${what}: the acquire must be rejected`)
    }
    // contention is EH_SESSION_BUSY; anything else reads as a failing lock service (spec 05 §8)
    assertTrue(
      isHarnessError(got.error, 'EH_SESSION_BUSY'),
      `${what}: a held session rejects with HarnessError('EH_SESSION_BUSY')`,
    )
  }

  return [
    {
      name: 'acquire resolves with a release function and release frees the session',
      run: async () => {
        const { lock } = await make()
        const id = uniqueSessionId('lock')
        const release = await mustAcquire(lock, id, 'free session')
        await release()
        const again = await mustAcquire(lock, id, 're-acquire after release')
        await again()
      },
    },
    {
      name: 'a held session rejects a second acquire promptly',
      run: async () => {
        const { lock } = await make()
        const id = uniqueSessionId('lock')
        const release = await mustAcquire(lock, id, 'first')
        await mustReject(lock, id, 'second while held')
        await mustReject(lock, id, 'third while held')
        await release()
      },
    },
    {
      name: 'sessions are independent',
      run: async () => {
        const { lock } = await make()
        const a = await mustAcquire(lock, uniqueSessionId('lock-a'), 'session a')
        const b = await mustAcquire(lock, uniqueSessionId('lock-b'), 'session b')
        await a()
        await b()
      },
    },
    {
      name: 'release is idempotent and a stale release does not free a newer holder',
      run: async () => {
        const { lock } = await make()
        const id = uniqueSessionId('lock')
        const first = await mustAcquire(lock, id, 'first')
        await first()
        await first() // second call: no-op, must not throw
        const second = await mustAcquire(lock, id, 'second holder')
        await first() // not the owner any more: must not release `second`
        await mustReject(lock, id, 'while the second holder still holds it')
        await second()
        const third = await mustAcquire(lock, id, 'after the real release')
        await third()
      },
    },
    {
      name: `exactly one of ${parallel} parallel acquires wins`,
      run: async () => {
        const { lock } = await make()
        const id = uniqueSessionId('lock')
        const results = await Promise.all(Array.from({ length: parallel }, () => attempt(lock, id)))
        const winners = results.filter((r): r is Extract<Outcome, { ok: true }> => r.ok)
        assertTrue(winners.length === 1, `exactly one acquire wins, got ${winners.length}`)
        for (const w of winners) await w.release()
      },
    },
    {
      name: 'a lock held through one handle is held for its peer (another instance)',
      run: async () => {
        const { lock, peer } = await make()
        if (peer === undefined) return
        const other = peer()
        const id = uniqueSessionId('lock')
        const release = await mustAcquire(lock, id, 'first handle')
        await mustReject(other, id, 'peer while held')
        await release()
        const taken = await mustAcquire(other, id, 'peer after release')
        await mustReject(lock, id, 'first handle while the peer holds it')
        await taken()
      },
    },
    {
      name: 'a stale release of one handle does not free the lock a peer now holds',
      run: async () => {
        const { lock, peer } = await make()
        if (peer === undefined) return
        const other = peer()
        const id = uniqueSessionId('lock')
        const first = await mustAcquire(lock, id, 'first handle')
        await first()
        const second = await mustAcquire(other, id, 'peer')
        await first() // no-op: not the owner
        await mustReject(lock, id, 'peer still holds it')
        await second()
      },
    },
    {
      name: 'an expired lease (crashed holder) is taken over; the late release is a no-op',
      run: async () => {
        const { lock, peer, expire } = await make()
        if (expire === undefined) return
        const other = peer?.() ?? lock
        const id = uniqueSessionId('lock')
        const dead = await mustAcquire(lock, id, 'holder that will crash')
        await expire(id)
        const taken = await mustAcquire(other, id, 'takeover after expiry')
        await dead() // the crashed holder wakes up: must not free the new holder's lock
        await mustReject(lock, id, 'the new holder still holds it')
        await taken()
      },
    },
  ]
}
