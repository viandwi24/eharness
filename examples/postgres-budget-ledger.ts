/**
 * Postgres `BudgetLedger` (spec 12 §4.1): spending limits per scope and calendar month, shared by
 * every session and instance, with atomic all-or-nothing reservations.
 *
 *   DATABASE_URL=postgres://… bun examples/postgres-budget-ledger.ts
 *
 * Without `DATABASE_URL` the script prints a notice and exits (the test suite skips it too).
 * With it, the script creates a throwaway schema, runs `budgetLedgerConformance`, runs two agent
 * instances that share one tenant limit, and drops the schema again.
 *
 * Tables:
 *
 * - `eh_budget_scope (scope, period_start, limit_usd, spent_usd)` — one row per scope and month.
 *   `limit_usd` NULL = no limit. A new month's row inherits the limit of the scope's latest row.
 * - `eh_budget_reservation (id, key, scopes, period_start, amount_usd, expires_at, state)` — open
 *   reservations count toward a scope until they expire or are committed / released. The reserved
 *   amount is summed from this table (no counter to repair after a crash: an expired reservation
 *   simply stops counting; a late commit still charges its actual cost).
 * - `eh_budget_record (key)` — idempotency keys of `record()`.
 *
 * Atomicity: `eh_budget_reserve` locks the scope rows of the request **in scope order** (`FOR
 * UPDATE`, so concurrent reservations on a scope run one at a time and never deadlock), checks
 * every scope in request order (`spent + reserved < limit` and `spent + reserved + amount <=
 * limit`), then inserts the reservation — all inside one function call, i.e. one transaction.
 * Under READ COMMITTED each statement of the function sees the rows committed before it, i.e.
 * after the lock (https://www.postgresql.org/docs/17/transaction-iso.html). `commit` and `record`
 * take the same scope locks before adding to `spent_usd`.
 *
 * Periods are calendar months in **UTC** (`date_trunc('month', now() AT TIME ZONE 'UTC')`). For
 * a tenant in another time zone, replace `'UTC'` in `eh_budget_period()` by the tenant's zone
 * (e.g. a per-scope column) — the core never sees periods, only scope strings.
 *
 * Housekeeping (not shown): delete `eh_budget_reservation` rows that are committed / released or
 * expired for longer than any commit can be late (e.g. a day), and old `eh_budget_record` keys.
 */
import { tool } from 'ai'
import { type BudgetLedger, defineHarnessAgent, uuidv7 } from 'eharness'
import { budgetLedgerConformance } from 'eharness/testing'
import { z } from 'zod/v4'
import { bunSqlPool, type PostgresOptions, type SqlClient } from './postgres-storage.ts'
import { exampleModel } from './shared/model.ts'
import { runCases } from './shared/run-cases.ts'

function budgetTables(options: PostgresOptions): {
  schema: string
  scope: string
  reservation: string
  record: string
} {
  const schema = options.schema ?? 'public'
  if (!/^[a-z_][a-z0-9_]*$/.test(schema)) throw new TypeError(`invalid schema name: ${schema}`)
  return {
    schema,
    scope: `${schema}.eh_budget_scope`,
    reservation: `${schema}.eh_budget_reservation`,
    record: `${schema}.eh_budget_record`,
  }
}

/** Create the ledger tables and functions if they do not exist. */
export async function migrateBudgetLedger(
  db: SqlClient,
  options: PostgresOptions = {},
): Promise<void> {
  const t = budgetTables(options)
  const s = t.schema
  await db.query(`CREATE TABLE IF NOT EXISTS ${t.scope} (
    scope         text        NOT NULL,
    period_start  timestamptz NOT NULL,           -- first instant of the month (UTC)
    limit_usd     numeric,                        -- NULL: no limit
    spent_usd     numeric     NOT NULL DEFAULT 0,
    PRIMARY KEY (scope, period_start)
  )`)
  await db.query(`CREATE TABLE IF NOT EXISTS ${t.reservation} (
    id            uuid        PRIMARY KEY,
    key           text        NOT NULL,
    scopes        text[]      NOT NULL,
    period_start  timestamptz NOT NULL,
    amount_usd    numeric     NOT NULL,
    expires_at    timestamptz NOT NULL,
    state         text        NOT NULL DEFAULT 'open'   -- open | committed | released
  )`)
  await db.query(
    `CREATE INDEX IF NOT EXISTS eh_budget_reservation_open ON ${t.reservation} (period_start, expires_at) WHERE state = 'open'`,
  )
  await db.query(
    `CREATE INDEX IF NOT EXISTS eh_budget_reservation_key ON ${t.reservation} (key) WHERE state = 'open'`,
  )
  await db.query(`CREATE TABLE IF NOT EXISTS ${t.record} (
    key           text        PRIMARY KEY,
    recorded_at   timestamptz NOT NULL DEFAULT now()
  )`)

  // the current period: the calendar month in UTC (change the zone here for local months)
  await db.query(`CREATE OR REPLACE FUNCTION ${s}.eh_budget_period() RETURNS timestamptz
    LANGUAGE sql STABLE AS
    $fn$ SELECT date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' $fn$`)

  // scope rows of a period exist; a new period inherits the latest limit of the scope
  await db.query(`CREATE OR REPLACE FUNCTION ${s}.eh_budget_ensure(p_scopes text[], p_period timestamptz)
    RETURNS void LANGUAGE sql AS
    $fn$
      INSERT INTO ${t.scope} (scope, period_start, limit_usd)
      SELECT n.scope, p_period,
        (SELECT p.limit_usd FROM ${t.scope} AS p WHERE p.scope = n.scope
         ORDER BY p.period_start DESC LIMIT 1)
      FROM (SELECT DISTINCT u AS scope FROM unnest(p_scopes) AS u ORDER BY 1) AS n
      ON CONFLICT (scope, period_start) DO NOTHING
    $fn$`)

  // open, unexpired reservations of a scope in a period
  await db.query(`CREATE OR REPLACE FUNCTION ${s}.eh_budget_reserved(p_scope text, p_period timestamptz)
    RETURNS numeric LANGUAGE sql VOLATILE AS
    $fn$
      SELECT COALESCE(SUM(r.amount_usd), 0) FROM ${t.reservation} AS r
      WHERE r.state = 'open' AND r.expires_at > clock_timestamp()
        AND r.period_start = p_period AND p_scope = ANY(r.scopes)
    $fn$`)

  await db.query(`CREATE OR REPLACE FUNCTION ${s}.eh_budget_reserve(
      p_id uuid, p_scopes text[], p_amount numeric, p_ttl_ms integer, p_key text)
    RETURNS TABLE (r_ok boolean, r_id text, r_scope text, r_limit float8, r_used float8)
    LANGUAGE plpgsql AS $fn$
    DECLARE
      v_period timestamptz := ${s}.eh_budget_period();
      v_scope text;
      v_limit numeric;
      v_used numeric;
      v_open uuid;
    BEGIN
      PERFORM ${s}.eh_budget_ensure(p_scopes, v_period);
      PERFORM 1 FROM ${t.scope} AS l
        WHERE l.scope = ANY(p_scopes) AND l.period_start = v_period
        ORDER BY l.scope FOR UPDATE;
      -- a retried call with the key of an open reservation gets that reservation
      SELECT r.id INTO v_open FROM ${t.reservation} AS r
        WHERE r.key = p_key AND r.state = 'open' AND r.expires_at > clock_timestamp() LIMIT 1;
      IF v_open IS NOT NULL THEN
        RETURN QUERY SELECT true, v_open::text, NULL::text, NULL::float8, NULL::float8;
        RETURN;
      END IF;
      FOREACH v_scope IN ARRAY p_scopes LOOP
        SELECT c.limit_usd, c.spent_usd + ${s}.eh_budget_reserved(v_scope, v_period)
          INTO v_limit, v_used
          FROM ${t.scope} AS c WHERE c.scope = v_scope AND c.period_start = v_period;
        IF v_limit IS NOT NULL AND (v_used >= v_limit OR v_used + p_amount > v_limit) THEN
          RETURN QUERY SELECT false, NULL::text, v_scope, v_limit::float8, v_used::float8;
          RETURN;
        END IF;
      END LOOP;
      INSERT INTO ${t.reservation} (id, key, scopes, period_start, amount_usd, expires_at)
        VALUES (p_id, p_key, ARRAY(SELECT DISTINCT u FROM unnest(p_scopes) AS u), v_period,
          p_amount, clock_timestamp() + p_ttl_ms * interval '1 millisecond');
      RETURN QUERY SELECT true, p_id::text, NULL::text, NULL::float8, NULL::float8;
    END
    $fn$`)

  // an expired reservation is still 'open': a late commit charges its actual cost
  await db.query(`CREATE OR REPLACE FUNCTION ${s}.eh_budget_commit(p_id text, p_actual numeric)
    RETURNS void LANGUAGE plpgsql AS $fn$
    DECLARE
      v_res record;
    BEGIN
      SELECT r.scopes, r.period_start INTO v_res FROM ${t.reservation} AS r
        WHERE r.id::text = p_id AND r.state = 'open' FOR UPDATE;
      IF NOT FOUND THEN RETURN; END IF;
      PERFORM 1 FROM ${t.scope} AS l
        WHERE l.scope = ANY(v_res.scopes) AND l.period_start = v_res.period_start
        ORDER BY l.scope FOR UPDATE;
      UPDATE ${t.scope} AS c SET spent_usd = c.spent_usd + p_actual
        WHERE c.scope = ANY(v_res.scopes) AND c.period_start = v_res.period_start;
      UPDATE ${t.reservation} AS r SET state = 'committed' WHERE r.id::text = p_id;
    END
    $fn$`)

  await db.query(`CREATE OR REPLACE FUNCTION ${s}.eh_budget_record(
      p_scopes text[], p_amount numeric, p_key text)
    RETURNS void LANGUAGE plpgsql AS $fn$
    DECLARE
      v_period timestamptz := ${s}.eh_budget_period();
      v_inserted integer;
    BEGIN
      INSERT INTO ${t.record} (key) VALUES (p_key) ON CONFLICT (key) DO NOTHING;
      GET DIAGNOSTICS v_inserted = ROW_COUNT;
      IF v_inserted = 0 THEN RETURN; END IF;
      PERFORM ${s}.eh_budget_ensure(p_scopes, v_period);
      PERFORM 1 FROM ${t.scope} AS l
        WHERE l.scope = ANY(p_scopes) AND l.period_start = v_period
        ORDER BY l.scope FOR UPDATE;
      UPDATE ${t.scope} AS c SET spent_usd = c.spent_usd + p_amount
        WHERE c.scope = ANY(p_scopes) AND c.period_start = v_period;
    END
    $fn$`)
}

/** Set (or clear with `null`) the limit of a scope from the current month on. */
export async function setBudgetLimit(
  db: SqlClient,
  scope: string,
  limitUsd: number | null,
  options: PostgresOptions = {},
): Promise<void> {
  const t = budgetTables(options)
  await db.query(
    `INSERT INTO ${t.scope} (scope, period_start, limit_usd)
     VALUES ($1, ${t.schema}.eh_budget_period(), $2::text::numeric)
     ON CONFLICT (scope, period_start) DO UPDATE SET limit_usd = EXCLUDED.limit_usd`,
    [scope, limitUsd === null ? null : String(limitUsd)],
  )
}

/** `scopes` as one JSON text parameter (no array binding needed; scopes may contain commas). */
const scopeArray = (index: number) =>
  `ARRAY(SELECT jsonb_array_elements_text($${index}::text::jsonb))`
const usd = (value: number) => String(Number.isFinite(value) && value > 0 ? value : 0)

/** `BudgetLedger` on the tables of {@link migrateBudgetLedger}. */
export function postgresBudgetLedger(db: SqlClient, options: PostgresOptions = {}): BudgetLedger {
  const t = budgetTables(options)
  const s = t.schema
  return {
    async reserve({ scopes, amountUsd, ttlMs, key }) {
      const rows = await db.query<{
        r_ok: boolean
        r_id: string | null
        r_scope: string | null
        r_limit: number | string | null
        r_used: number | string | null
      }>(
        `SELECT * FROM ${s}.eh_budget_reserve($1::uuid, ${scopeArray(2)}, $3::text::numeric,
           $4::integer, $5)`,
        [uuidv7(), JSON.stringify(scopes), usd(amountUsd), Math.max(1, Math.round(ttlMs)), key],
      )
      const row = rows[0]
      if (row === undefined) throw new Error('eh_budget_reserve returned no row')
      if (row.r_ok) return { ok: true, reservationId: String(row.r_id) }
      return {
        ok: false,
        scope: String(row.r_scope),
        limitUsd: Number(row.r_limit),
        spentUsd: Number(row.r_used),
      }
    },
    async commit(reservationId, actualUsd) {
      await db.query(`SELECT ${s}.eh_budget_commit($1, $2::text::numeric)`, [
        reservationId,
        usd(actualUsd),
      ])
    },
    async release(reservationId) {
      await db.query(
        `UPDATE ${t.reservation} SET state = 'released' WHERE id::text = $1 AND state = 'open'`,
        [reservationId],
      )
    },
    async record({ scopes, amountUsd, key }) {
      await db.query(`SELECT ${s}.eh_budget_record(${scopeArray(1)}, $2::text::numeric, $3)`, [
        JSON.stringify(scopes),
        usd(amountUsd),
        key,
      ])
    },
    async check(scopes) {
      const rows = await db.query<{
        scope: string
        limit_usd: number | string | null
        spent_usd: number | string
        reserved_usd: number | string
      }>(
        `SELECT q.scope,
           (SELECT p.limit_usd FROM ${t.scope} AS p WHERE p.scope = q.scope
            ORDER BY p.period_start DESC LIMIT 1)::float8 AS limit_usd,
           COALESCE((SELECT c.spent_usd FROM ${t.scope} AS c
             WHERE c.scope = q.scope AND c.period_start = ${s}.eh_budget_period()), 0)::float8 AS spent_usd,
           ${s}.eh_budget_reserved(q.scope, ${s}.eh_budget_period())::float8 AS reserved_usd
         FROM (SELECT DISTINCT ON (u.scope) u.scope, u.ord
               FROM jsonb_array_elements_text($1::text::jsonb) WITH ORDINALITY AS u(scope, ord)
               ORDER BY u.scope, u.ord) AS q
         ORDER BY q.ord`,
        [JSON.stringify(scopes)],
      )
      let ok = true
      const out = rows.map((row) => {
        const spentUsd = Number(row.spent_usd)
        const reservedUsd = Number(row.reserved_usd)
        if (row.limit_usd === null) return { scope: row.scope, spentUsd, reservedUsd }
        const limitUsd = Number(row.limit_usd)
        if (spentUsd + reservedUsd >= limitUsd) ok = false
        return { scope: row.scope, limitUsd, spentUsd, reservedUsd }
      })
      return { ok, scopes: out }
    },
  }
}

if (import.meta.main) {
  const url = process.env.DATABASE_URL
  if (url === undefined || url === '') {
    console.log('DATABASE_URL is not set: skipping the Postgres budget ledger example.')
  } else {
    const db = await bunSqlPool(url)
    const schema = `eharness_budget_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`
    try {
      await db.query(`CREATE SCHEMA ${schema}`)
      await migrateBudgetLedger(db, { schema })
      await runCases(
        'BudgetLedger conformance (Postgres, monthly periods, locked reservations)',
        budgetLedgerConformance(
          async (limits) => {
            for (const [scope, limit] of Object.entries(limits)) {
              await setBudgetLimit(db, scope, limit, { schema })
            }
            return postgresBudgetLedger(db, { schema })
          },
          { ttlMs: 200 },
        ),
      )

      // Two instances share the tenant's $0.02 this month: 4 steps of $0.005 in total.
      const ledger = postgresBudgetLedger(db, { schema })
      await setBudgetLimit(db, 'tenant:acme', 0.02, { schema })
      const work = tool({ inputSchema: z.object({ n: z.number() }), execute: async () => 'ok' })
      const looping = () =>
        exampleModel(
          Array.from({ length: 10 }, (_, n) => ({
            toolCalls: [{ toolName: 'work', input: { n } }],
          })),
        )
      const budget = {
        ledger: { adapter: ledger, scopes: () => ['tenant:acme'], estimate: () => 0.005 },
      }
      const models = () => ({ pricing: { input: 0, output: 1_000 } }) // $0.005 per scripted step
      const a = defineHarnessAgent({ model: looping(), models, budget, tools: { work } })
      const b = defineHarnessAgent({ model: looping(), models, budget, tools: { work } })
      const [ra, rb] = await Promise.all([
        a.session('a').send('Work').result,
        b.session('b').send('Work').result,
      ])
      const status = await ledger.check(['tenant:acme'])
      console.log(`\nA: ${ra.stop} after ${ra.steps} steps; B: ${rb.stop} after ${rb.steps} steps`)
      console.log(`tenant spent: $${status.scopes[0]?.spentUsd.toFixed(4)} of $0.02`)
      if (ra.steps + rb.steps !== 4) process.exitCode = 1
      await a.close()
      await b.close()
    } finally {
      await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
      await db.close()
    }
  }
}
