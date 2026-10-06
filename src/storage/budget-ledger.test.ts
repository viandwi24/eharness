import { describe, expect, test } from 'bun:test'
import { budgetLedgerConformance } from '../testing/budget-ledger.conformance.ts'
import { memoryBudgetLedger } from './memory.ts'

describe('memoryBudgetLedger() conformance', () => {
  for (const c of budgetLedgerConformance((limits) => memoryBudgetLedger({ limits }))) {
    test(c.name, c.run)
  }
})

describe('memoryBudgetLedger()', () => {
  test('expiry follows the injected clock', async () => {
    let now = 1_000
    const ledger = memoryBudgetLedger({ limits: { a: 1 }, now: () => now })
    const r = await ledger.reserve({ scopes: ['a'], amountUsd: 1, ttlMs: 100, key: 'k' })
    expect(r.ok).toBe(true)
    expect(
      (await ledger.reserve({ scopes: ['a'], amountUsd: 0.1, ttlMs: 100, key: 'k2' })).ok,
    ).toBe(false)
    now += 100
    expect((await ledger.check(['a'])).scopes[0]?.reservedUsd).toBe(0)
    expect(
      (await ledger.reserve({ scopes: ['a'], amountUsd: 0.1, ttlMs: 100, key: 'k2' })).ok,
    ).toBe(true)
  })

  test('a scope listed twice is charged once', async () => {
    const ledger = memoryBudgetLedger()
    await ledger.record({ scopes: ['a', 'a'], amountUsd: 1, key: 'k' })
    expect((await ledger.check(['a'])).scopes).toEqual([
      { scope: 'a', spentUsd: 1, reservedUsd: 0 },
    ])
  })
})
