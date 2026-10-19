/**
 * `chaosStorage`: a fault-injecting wrapper over the storage ports of one backend, so an adapter
 * (or an application) can run the multi-instance behaviour of the core against a store that
 * conflicts, lags and loses leases like a real database.
 *
 * Faults are deterministic for a `seed` (the same operation order draws the same faults), so a
 * failing run is reproducible. Every fault is one a real backend produces and the contracts allow:
 *
 * - `conflictRate`: `StateAdapter.setIf` answers `false` without writing (a rev conflict),
 *   `SessionLock.acquire` rejects with `EH_SESSION_BUSY` (contention), `InboxAdapter.claim`
 *   answers `[]` (another claimer won the race).
 * - `delayMs`: every call of every port resolves after a random delay in `0..delayMs`
 *   (slow writes, interleaved instances).
 * - `failRate`: `InboxAdapter.ack` / `release` / `notify` reject before they take effect (a
 *   dropped connection), so items are redelivered after their claim expires.
 * - `expireLease(sessionId)`: the lease of the holder of the session lock is lost; the lock is
 *   freed and the holder's late release is a no-op.
 *
 * Imports core only through `src/index.ts` (ADR-0008).
 *
 * @see docs/engineering/testing.md#chaos-storage
 */
import { HarnessError, type InboxAdapter, type SessionLock } from '../index.ts'
import type { MultiInstanceStorage } from './multi-instance.conformance.ts'

/** Options of {@link chaosStorage}. */
export interface ChaosStorageOptions {
  /** Seed of the deterministic fault sequence. Default 1. */
  seed?: number
  /** Probability (0..1) of a conflict on a port call that can conflict. Default 0. */
  conflictRate?: number
  /** Longest random delay (ms) added to every call. Default 0. */
  delayMs?: number
  /**
   * Ports `conflictRate` applies to. Default all three. Note a conflict at the commit point of a
   * turn legitimately ends the turn with `EH_SESSION_BUSY` (spec 05 §3), as does lock contention.
   */
  conflictPorts?: Array<'state' | 'lock' | 'inbox'>
  /** Probability (0..1) that an inbox `ack` / `release` / `notify` fails before taking effect. Default 0. */
  failRate?: number
}

/** The storage with faults injected, plus controls and counters. */
export interface ChaosStorage extends MultiInstanceStorage {
  /** The wrapped storage, untouched (read it to verify without faults). */
  inner: MultiInstanceStorage
  /** Faults injected so far. */
  faults: { conflicts: number; failures: number; delays: number; leasesExpired: number }
  /** Change the rates while running (e.g. `{ conflictRate: 0 }` to let the storage settle). */
  set(
    rates: Pick<ChaosStorageOptions, 'conflictRate' | 'delayMs' | 'failRate' | 'conflictPorts'>,
  ): void
  /** Lose the lease of the current holder of the session lock; false when nobody holds it. */
  expireLease(sessionId: string): Promise<boolean>
}

/** Deterministic PRNG (mulberry32). */
function mulberry32(seed: number): () => number {
  let a = seed | 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Wrap `inner` (the message, state, inbox and lock ports) with seeded faults.
 *
 * @example
 * ```ts
 * const storage = chaosStorage(
 *   { messages: myMessages(db), state: myState(db), inbox: myInbox(db) },
 *   { seed: 7, conflictRate: 0.2, delayMs: 5 },
 * )
 * const agent = defineHarnessAgent({ model, storage })
 * ```
 */
export function chaosStorage(
  inner: MultiInstanceStorage,
  options: ChaosStorageOptions = {},
): ChaosStorage {
  const random = mulberry32(options.seed ?? 1)
  const rates = {
    conflictRate: options.conflictRate ?? 0,
    delayMs: options.delayMs ?? 0,
    failRate: options.failRate ?? 0,
  }
  let ports = new Set(options.conflictPorts ?? ['state', 'lock', 'inbox'])
  const faults = { conflicts: 0, failures: 0, delays: 0, leasesExpired: 0 }
  const roll = (rate: number): boolean => rate > 0 && random() < rate
  const conflict = (port: 'state' | 'lock' | 'inbox'): boolean => {
    if (!ports.has(port)) return false
    const hit = roll(rates.conflictRate)
    if (hit) faults.conflicts++
    return hit
  }
  const fail = (what: string): void => {
    if (!roll(rates.failRate)) return
    faults.failures++
    throw new Error(`chaosStorage: injected failure of ${what}`)
  }
  const delay = async (): Promise<void> => {
    if (rates.delayMs <= 0) return
    faults.delays++
    await new Promise((resolve) => setTimeout(resolve, Math.floor(random() * (rates.delayMs + 1))))
  }

  const messages: ChaosStorage['messages'] = {
    async load(q) {
      await delay()
      return inner.messages.load(q)
    },
    async save(sessionId, batch) {
      await delay()
      return inner.messages.save(sessionId, batch)
    },
    ...(inner.messages.lastId === undefined
      ? {}
      : {
          async lastId(sessionId: string) {
            await delay()
            return (inner.messages.lastId as (id: string) => Promise<string | null>)(sessionId)
          },
        }),
  }

  const state: ChaosStorage['state'] = {
    async get(sessionId) {
      await delay()
      return inner.state.get(sessionId)
    },
    async set(sessionId, snapshot) {
      await delay()
      return inner.state.set(sessionId, snapshot)
    },
    ...(inner.state.setIf === undefined
      ? {}
      : {
          async setIf(
            sessionId: string,
            snapshot: Parameters<typeof inner.state.set>[1],
            rev: number | null,
          ) {
            await delay()
            if (conflict('state')) return false
            return (inner.state.setIf as NonNullable<typeof inner.state.setIf>)(
              sessionId,
              snapshot,
              rev,
            )
          },
        }),
  }

  let inbox: InboxAdapter | undefined
  if (inner.inbox !== undefined) {
    const real = inner.inbox
    inbox = {
      ...real,
      async enqueue(sessionId, item) {
        await delay()
        return real.enqueue(sessionId, item)
      },
      async claim(sessionId, owner, opts) {
        await delay()
        if (conflict('inbox')) return []
        return real.claim(sessionId, owner, opts)
      },
      async ack(ids) {
        await delay()
        fail('inbox.ack')
        return real.ack(ids)
      },
      async release(ids, opts) {
        await delay()
        fail('inbox.release')
        return real.release(ids, opts)
      },
      ...(real.enqueueOnce === undefined
        ? {}
        : {
            async enqueueOnce(
              sessionId: string,
              item: Parameters<NonNullable<InboxAdapter['enqueueOnce']>>[1],
            ) {
              await delay()
              return (real.enqueueOnce as NonNullable<InboxAdapter['enqueueOnce']>)(sessionId, item)
            },
          }),
      ...(real.notify === undefined
        ? {}
        : {
            async notify(sessionId: string) {
              await delay()
              fail('inbox.notify')
              return (real.notify as NonNullable<InboxAdapter['notify']>)(sessionId)
            },
          }),
    }
  }

  const leases = new Map<string, { live: boolean; release: () => Promise<void> }>()
  let lock: SessionLock | undefined
  if (inner.lock !== undefined) {
    const real = inner.lock
    lock = {
      async acquire(sessionId, opts) {
        await delay()
        if (conflict('lock')) {
          throw new HarnessError(
            'EH_SESSION_BUSY',
            `chaosStorage: injected lock contention on '${sessionId}'`,
          )
        }
        const release = await real.acquire(sessionId, opts)
        const lease = { live: true, release }
        leases.set(sessionId, lease)
        return async () => {
          if (!lease.live) return // the lease was lost: a late release must not free a newer holder
          lease.live = false
          if (leases.get(sessionId) === lease) leases.delete(sessionId)
          await release()
        }
      },
    }
  }

  return {
    messages,
    state,
    ...(inbox === undefined ? {} : { inbox }),
    ...(lock === undefined ? {} : { lock }),
    inner,
    faults,
    set(next) {
      if (next.conflictRate !== undefined) rates.conflictRate = next.conflictRate
      if (next.delayMs !== undefined) rates.delayMs = next.delayMs
      if (next.failRate !== undefined) rates.failRate = next.failRate
      if (next.conflictPorts !== undefined) ports = new Set(next.conflictPorts)
    },
    async expireLease(sessionId) {
      const lease = leases.get(sessionId)
      if (lease === undefined || !lease.live) return false
      lease.live = false
      leases.delete(sessionId)
      faults.leasesExpired++
      await lease.release()
      return true
    },
  }
}
