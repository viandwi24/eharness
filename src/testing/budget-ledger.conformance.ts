import type { BudgetLedger, BudgetScopeStatus } from '../index.ts'
import { assertTrue, uniqueSessionId } from './assert.ts'
import type { ConformanceCase } from './types.ts'

/** Options of {@link budgetLedgerConformance}. */
export interface BudgetLedgerConformanceOptions {
  /**
   * Reservation expiry used by the expiry case (ms). Default 50; raise it for adapters whose clock
   * resolution is coarse (e.g. a database `now()` on another host).
   */
  ttlMs?: number
  /** Parallel reservations of the concurrency case. Default 100. */
  concurrency?: number
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const LONG = 600_000

function near(actual: number | undefined, expected: number, what: string): void {
  assertTrue(
    typeof actual === 'number' && Math.abs(actual - expected) < 1e-9,
    `${what}: expected ${expected}, got ${String(actual)}`,
  )
}

async function status(ledger: BudgetLedger, scope: string): Promise<BudgetScopeStatus> {
  const result = await ledger.check([scope])
  const found = result.scopes.find((s) => s.scope === scope)
  assertTrue(found !== undefined, `check() must list scope ${scope}`)
  return found as BudgetScopeStatus
}

/**
 * Conformance cases for a {@link BudgetLedger} (spec 12 §4.1): limits and used-up scopes,
 * all-or-nothing reservations over several scopes, concurrent reservations that never exceed a
 * limit, commit replacing a reservation (higher and lower), idempotent commit / release / record,
 * reserve idempotent per key while open, reservation expiry (an expired reservation still
 * charges on commit), `check` sums, and unknown scopes without a limit.
 *
 * The factory gets the static limits of the case (fresh, unique scope names); a ledger with
 * periods applies them to the current period.
 *
 * @example
 * ```ts
 * for (const c of budgetLedgerConformance((limits) => memoryBudgetLedger({ limits }))) test(c.name, c.run)
 * ```
 * @see docs/specs/12-models-and-cost.md#41-budget-ledger-normative
 */
export function budgetLedgerConformance(
  factory: (limits: Record<string, number>) => BudgetLedger | Promise<BudgetLedger>,
  options: BudgetLedgerConformanceOptions = {},
): ConformanceCase[] {
  const ttl = options.ttlMs ?? 50
  const parallel = options.concurrency ?? 100
  const scope = (name: string) => uniqueSessionId(`scope-${name}`)
  return [
    {
      name: 'an unknown scope has no limit',
      run: async () => {
        const free = scope('free')
        const ledger = await factory({})
        const r = await ledger.reserve({ scopes: [free], amountUsd: 1_000, ttlMs: LONG, key: free })
        assertTrue(r.ok, 'a scope without a limit must take any amount')
        const s = await status(ledger, free)
        assertTrue(s.limitUsd === undefined, 'limitUsd must be absent for an unlimited scope')
        near(s.spentUsd, 0, 'spentUsd')
        near(s.reservedUsd, 1_000, 'reservedUsd')
        assertTrue((await ledger.check([free])).ok, 'an unlimited scope is never used up')
      },
    },
    {
      name: 'reserve takes an amount up to the limit and refuses beyond it',
      run: async () => {
        const a = scope('limit')
        const ledger = await factory({ [a]: 1 })
        const first = await ledger.reserve({
          scopes: [a],
          amountUsd: 0.75,
          ttlMs: LONG,
          key: `${a}:1`,
        })
        assertTrue(first.ok, 'first reservation within the limit')
        const refused = await ledger.reserve({
          scopes: [a],
          amountUsd: 0.5,
          ttlMs: LONG,
          key: `${a}:2`,
        })
        assertTrue(!refused.ok, 'a reservation beyond the limit must be refused')
        if (!refused.ok) {
          assertTrue(refused.scope === a, `refused scope: expected ${a}, got ${refused.scope}`)
          near(refused.limitUsd, 1, 'refused limitUsd')
          near(refused.spentUsd, 0.75, 'refused spentUsd (spent + reserved)')
        }
        const exact = await ledger.reserve({
          scopes: [a],
          amountUsd: 0.25,
          ttlMs: LONG,
          key: `${a}:3`,
        })
        assertTrue(exact.ok, 'a reservation that fills the limit exactly is taken')
        near((await status(ledger, a)).reservedUsd, 1, 'reservedUsd')
      },
    },
    {
      name: 'a used-up scope refuses even a zero reservation',
      run: async () => {
        const a = scope('used-up')
        const ledger = await factory({ [a]: 1 })
        await ledger.record({ scopes: [a], amountUsd: 1, key: `${a}:spent` })
        const r = await ledger.reserve({ scopes: [a], amountUsd: 0, ttlMs: LONG, key: `${a}:0` })
        assertTrue(!r.ok, 'spent ≥ limit must refuse')
        assertTrue(!(await ledger.check([a])).ok, 'check must report the scope used up')
      },
    },
    {
      name: 'reserve over several scopes is all or nothing',
      run: async () => {
        const wide = scope('wide')
        const narrow = scope('narrow')
        const ledger = await factory({ [wide]: 10, [narrow]: 1 })
        const r = await ledger.reserve({
          scopes: [wide, narrow],
          amountUsd: 2,
          ttlMs: LONG,
          key: `${wide}:1`,
        })
        assertTrue(!r.ok, 'one scope over its limit refuses the whole reservation')
        if (!r.ok)
          assertTrue(r.scope === narrow, `refused scope: expected ${narrow}, got ${r.scope}`)
        near((await status(ledger, wide)).reservedUsd, 0, 'nothing reserved on the other scope')
        const ok = await ledger.reserve({
          scopes: [wide, narrow],
          amountUsd: 0.5,
          ttlMs: LONG,
          key: `${wide}:2`,
        })
        assertTrue(ok.ok, 'a reservation that fits every scope is taken')
        near((await status(ledger, wide)).reservedUsd, 0.5, 'reserved on the first scope')
        near((await status(ledger, narrow)).reservedUsd, 0.5, 'reserved on the second scope')
      },
    },
    {
      name: `${parallel} concurrent reservations never exceed the limit`,
      run: async () => {
        const a = scope('race')
        const other = scope('race-free')
        const take = parallel * 0.25 * 0.4 // 40% of them fit
        const ledger = await factory({ [a]: take })
        const results = await Promise.all(
          Array.from({ length: parallel }, (_, i) =>
            ledger.reserve({ scopes: [other, a], amountUsd: 0.25, ttlMs: LONG, key: `${a}:${i}` }),
          ),
        )
        const granted = results.filter((r) => r.ok).length
        const expected = Math.round(take / 0.25)
        assertTrue(granted === expected, `expected ${expected} reservations, got ${granted}`)
        near((await status(ledger, a)).reservedUsd, take, 'reservedUsd at the limit')
        near((await status(ledger, other)).reservedUsd, take, 'refused ones reserved nothing')
      },
    },
    {
      name: 'commit replaces the reservation by the actual cost (lower and higher)',
      run: async () => {
        const a = scope('commit')
        const ledger = await factory({ [a]: 5 })
        const low = await ledger.reserve({ scopes: [a], amountUsd: 4, ttlMs: LONG, key: `${a}:1` })
        assertTrue(low.ok, 'reserve')
        if (!low.ok) return
        await ledger.commit(low.reservationId, 1)
        let s = await status(ledger, a)
        near(s.spentUsd, 1, 'spent after a lower commit')
        near(s.reservedUsd, 0, 'reserved after a lower commit')
        const high = await ledger.reserve({
          scopes: [a],
          amountUsd: 1,
          ttlMs: LONG,
          key: `${a}:2`,
        })
        assertTrue(high.ok, 'reserve')
        if (!high.ok) return
        await ledger.commit(high.reservationId, 6) // the step cost more than estimated
        s = await status(ledger, a)
        near(s.spentUsd, 7, 'spent after a higher commit (may exceed the limit)')
        near(s.reservedUsd, 0, 'reserved after a higher commit')
        assertTrue(!(await ledger.check([a])).ok, 'over the limit after the commit')
      },
    },
    {
      name: 'commit and release are idempotent; unknown ids are ignored',
      run: async () => {
        const a = scope('idem')
        const ledger = await factory({ [a]: 10 })
        const one = await ledger.reserve({ scopes: [a], amountUsd: 2, ttlMs: LONG, key: `${a}:1` })
        const two = await ledger.reserve({ scopes: [a], amountUsd: 2, ttlMs: LONG, key: `${a}:2` })
        assertTrue(one.ok && two.ok, 'reserve')
        if (!one.ok || !two.ok) return
        await ledger.commit(one.reservationId, 1.5)
        await ledger.commit(one.reservationId, 1.5)
        await ledger.release(one.reservationId) // after commit: no effect
        await ledger.release(two.reservationId)
        await ledger.release(two.reservationId)
        await ledger.commit(two.reservationId, 3) // after release: no effect
        await ledger.commit('00000000-0000-7000-8000-000000000000', 5)
        await ledger.release('00000000-0000-7000-8000-000000000000')
        const s = await status(ledger, a)
        near(s.spentUsd, 1.5, 'spent once')
        near(s.reservedUsd, 0, 'nothing reserved')
      },
    },
    {
      name: 'reserve with the key of an open reservation returns it (no second hold)',
      run: async () => {
        const a = scope('key')
        const ledger = await factory({ [a]: 10 })
        const first = await ledger.reserve({ scopes: [a], amountUsd: 3, ttlMs: LONG, key: a })
        const again = await ledger.reserve({ scopes: [a], amountUsd: 3, ttlMs: LONG, key: a })
        assertTrue(first.ok && again.ok, 'reserve')
        if (!first.ok || !again.ok) return
        assertTrue(first.reservationId === again.reservationId, 'same reservation for the key')
        near((await status(ledger, a)).reservedUsd, 3, 'reserved once')
      },
    },
    {
      name: 'record charges every scope once per key',
      run: async () => {
        const a = scope('rec-a')
        const b = scope('rec-b')
        const ledger = await factory({ [a]: 10 })
        await ledger.record({ scopes: [a, b], amountUsd: 0.5, key: `${a}:n1` })
        await ledger.record({ scopes: [a, b], amountUsd: 0.5, key: `${a}:n1` }) // a retried call
        await Promise.all([
          ledger.record({ scopes: [a, b], amountUsd: 0.25, key: `${a}:n2` }),
          ledger.record({ scopes: [a, b], amountUsd: 0.25, key: `${a}:n2` }),
        ])
        near((await status(ledger, a)).spentUsd, 0.75, 'spent on the first scope')
        near((await status(ledger, b)).spentUsd, 0.75, 'spent on the second scope')
      },
    },
    {
      name: 'a reservation expires after ttlMs; committing it later still charges',
      run: async () => {
        const a = scope('ttl')
        const ledger = await factory({ [a]: 1 })
        const r = await ledger.reserve({ scopes: [a], amountUsd: 1, ttlMs: ttl, key: `${a}:1` })
        assertTrue(r.ok, 'reserve')
        if (!r.ok) return
        const blocked = await ledger.reserve({
          scopes: [a],
          amountUsd: 0.5,
          ttlMs: LONG,
          key: `${a}:2`,
        })
        assertTrue(!blocked.ok, 'the limit is held by the open reservation')
        await sleep(ttl * 2 + 30)
        near((await status(ledger, a)).reservedUsd, 0, 'an expired reservation stops counting')
        const after = await ledger.reserve({
          scopes: [a],
          amountUsd: 0.5,
          ttlMs: LONG,
          key: `${a}:3`,
        })
        assertTrue(after.ok, 'the limit is free again after expiry')
        await ledger.commit(r.reservationId, 0.25) // the process was only slow
        const s = await status(ledger, a)
        near(s.spentUsd, 0.25, 'the late commit charges the actual cost')
        near(s.reservedUsd, 0.5, 'the later reservation is still open')
      },
    },
    {
      name: 'check sums spent and reserved per scope',
      run: async () => {
        const a = scope('sum')
        const free = scope('sum-free')
        const ledger = await factory({ [a]: 3 })
        await ledger.record({ scopes: [a], amountUsd: 1, key: `${a}:r` })
        await ledger.reserve({ scopes: [a, free], amountUsd: 0.5, ttlMs: LONG, key: `${a}:1` })
        await ledger.reserve({ scopes: [a], amountUsd: 0.25, ttlMs: LONG, key: `${a}:2` })
        const result = await ledger.check([a, free])
        assertTrue(result.ok, 'not used up')
        assertTrue(result.scopes.length === 2, 'one entry per scope')
        const s = result.scopes.find((x) => x.scope === a)
        near(s?.limitUsd, 3, 'limitUsd')
        near(s?.spentUsd, 1, 'spentUsd')
        near(s?.reservedUsd, 0.75, 'reservedUsd')
        const f = result.scopes.find((x) => x.scope === free)
        near(f?.spentUsd, 0, 'spentUsd of the unlimited scope')
        near(f?.reservedUsd, 0.5, 'reservedUsd of the unlimited scope')
      },
    },
  ]
}
