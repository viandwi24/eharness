/**
 * `BudgetLedger` (spec 12 §4.1) on `<prefix>budget_scope`, `<prefix>budget_reservation` and
 * `<prefix>budget_record`: limits per scope and period (a UTC calendar month by default), atomic
 * all-or-nothing reservations (one `BEGIN IMMEDIATE` transaction per call), reserved amounts summed
 * from open reservations (an expired one simply stops counting; a late commit still charges its
 * actual cost). A new period's row inherits the limit of the scope's latest row. Usage the app did
 * not price is not counted: callers pass `amountUsd` only for priced usage (spec 12).
 */
import { type BudgetLedger, uuidv7 } from '../index.ts'
import type { SqlDriver } from './driver.ts'
import { type AdapterOptions, clock, one, tables } from './util.ts'

/** Options of {@link sqliteBudgetLedger} and {@link setBudgetLimit}. */
export interface SqliteBudgetOptions extends AdapterOptions {
  /** First instant (epoch ms) of the period `now` falls in. Default: the UTC calendar month. */
  period?: (now: number) => number
}

/** First instant of the UTC calendar month of `now` (epoch ms). */
export function utcMonthStart(now: number): number {
  const d = new Date(now)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)
}

const usd = (value: number): number => (Number.isFinite(value) && value > 0 ? value : 0)

/** Set (or clear with `null`) the limit of a scope from the current period on. */
export function setBudgetLimit(
  driver: SqlDriver,
  scope: string,
  limitUsd: number | null,
  options: SqliteBudgetOptions = {},
): void {
  const t = tables(options.prefix).budgetScope
  const period = (options.period ?? utcMonthStart)(clock(options)())
  driver.run(
    `INSERT INTO ${t} (scope, period_start, limit_usd) VALUES (?, ?, ?)
     ON CONFLICT (scope, period_start) DO UPDATE SET limit_usd = excluded.limit_usd`,
    [scope, period, limitUsd === null ? null : String(limitUsd)],
  )
}

export function sqliteBudgetLedger(
  driver: SqlDriver,
  options: SqliteBudgetOptions = {},
): BudgetLedger {
  const names = tables(options.prefix)
  const scopeT = names.budgetScope
  const resT = names.budgetReservation
  const recT = names.budgetRecord
  const now = clock(options)
  const periodOf = options.period ?? utcMonthStart

  const ensure = (scopes: readonly string[], period: number): void => {
    for (const scope of new Set(scopes)) {
      driver.run(
        `INSERT INTO ${scopeT} (scope, period_start, limit_usd)
         SELECT ?, ?, (SELECT p.limit_usd FROM ${scopeT} AS p WHERE p.scope = ?
                       ORDER BY p.period_start DESC LIMIT 1)
         ON CONFLICT (scope, period_start) DO NOTHING`,
        [scope, period, scope],
      )
    }
  }
  const reserved = (scope: string, period: number, at: number): number =>
    Number(
      one<{ total: number }>(
        driver,
        `SELECT coalesce(sum(CAST(r.amount_usd AS REAL)), 0) AS total FROM ${resT} AS r
         WHERE r.state = 'open' AND r.expires_at > ? AND r.period_start = ?
           AND EXISTS (SELECT 1 FROM json_each(r.scopes) AS j WHERE j.value = ?)`,
        [at, period, scope],
      )?.total ?? 0,
    )
  const addSpent = (scopes: readonly string[], period: number, amount: number): void => {
    for (const scope of new Set(scopes)) {
      driver.run(
        `UPDATE ${scopeT} SET spent_usd = CAST(CAST(spent_usd AS REAL) + ? AS TEXT)
         WHERE scope = ? AND period_start = ?`,
        [amount, scope, period],
      )
    }
  }

  return {
    async reserve({ scopes, amountUsd, ttlMs, key }) {
      const amount = usd(amountUsd)
      return driver.transaction(() => {
        const at = now()
        const period = periodOf(at)
        ensure(scopes, period)
        const open = one<{ id: string }>(
          driver,
          `SELECT id FROM ${resT} WHERE key = ? AND state = 'open' AND expires_at > ? LIMIT 1`,
          [key, at],
        )
        if (open !== undefined) return { ok: true as const, reservationId: open.id }
        for (const scope of scopes) {
          const row = one<{ limit_usd: string | null; spent_usd: string }>(
            driver,
            `SELECT limit_usd, spent_usd FROM ${scopeT} WHERE scope = ? AND period_start = ?`,
            [scope, period],
          )
          if (row === undefined || row.limit_usd === null) continue
          const limit = Number(row.limit_usd)
          const used = Number(row.spent_usd) + reserved(scope, period, at)
          if (used >= limit || used + amount > limit) {
            return { ok: false as const, scope, limitUsd: limit, spentUsd: used }
          }
        }
        const id = uuidv7()
        driver.run(
          `INSERT INTO ${resT} (id, key, scopes, period_start, amount_usd, expires_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [
            id,
            key,
            JSON.stringify([...new Set(scopes)]),
            period,
            String(amount),
            at + Math.max(1, Math.round(ttlMs)),
          ],
        )
        return { ok: true as const, reservationId: id }
      })
    },

    async commit(reservationId, actualUsd) {
      driver.transaction(() => {
        const res = one<{ scopes: string; period_start: number }>(
          driver,
          `SELECT scopes, period_start FROM ${resT} WHERE id = ? AND state = 'open'`,
          [reservationId],
        )
        if (res === undefined) return
        addSpent(JSON.parse(res.scopes) as string[], res.period_start, usd(actualUsd))
        driver.run(`UPDATE ${resT} SET state = 'committed' WHERE id = ?`, [reservationId])
      })
    },

    async release(reservationId) {
      driver.run(`UPDATE ${resT} SET state = 'released' WHERE id = ? AND state = 'open'`, [
        reservationId,
      ])
    },

    async record({ scopes, amountUsd, key }) {
      driver.transaction(() => {
        const at = now()
        const inserted = driver.run(
          `INSERT INTO ${recT} (key, recorded_at) VALUES (?, ?) ON CONFLICT DO NOTHING`,
          [key, at],
        )
        if (inserted.changes === 0) return
        const period = periodOf(at)
        ensure(scopes, period)
        addSpent(scopes, period, usd(amountUsd))
      })
    },

    async check(scopes) {
      const at = now()
      const period = periodOf(at)
      let ok = true
      const out = [...new Set(scopes)].map((scope) => {
        const limitRow = one<{ limit_usd: string | null }>(
          driver,
          `SELECT limit_usd FROM ${scopeT} WHERE scope = ? ORDER BY period_start DESC LIMIT 1`,
          [scope],
        )
        const spentRow = one<{ spent_usd: string }>(
          driver,
          `SELECT spent_usd FROM ${scopeT} WHERE scope = ? AND period_start = ?`,
          [scope, period],
        )
        const spentUsd = Number(spentRow?.spent_usd ?? 0)
        const reservedUsd = reserved(scope, period, at)
        if (limitRow === undefined || limitRow.limit_usd === null) {
          return { scope, spentUsd, reservedUsd }
        }
        const limitUsd = Number(limitRow.limit_usd)
        if (spentUsd + reservedUsd >= limitUsd) ok = false
        return { scope, limitUsd, spentUsd, reservedUsd }
      })
      return { ok, scopes: out }
    },
  }
}
