/**
 * eharness storage ports on `bun:sqlite` (docs/plans/P32-team-example.md §4, M2): messages, state
 * (with compare-and-set), a lease-based session lock, the durable inbox and the budget ledger.
 *
 * Every read-modify-write runs inside `BEGIN IMMEDIATE` (`bun:sqlite` `transaction().immediate()`),
 * so two processes on one WAL database file serialize correctly: the second writer waits
 * (`busy_timeout`) and then sees the first one's commit. Within one process the driver is
 * synchronous, so a statement sequence without `await` in between is atomic anyway.
 *
 * The tables are created by the drizzle migrations (`infra/db/schema.ts`), never here.
 */
import type { Database } from 'bun:sqlite'
import type { UIMessage } from 'ai'
import {
  type BudgetLedger,
  type DeadInboxItem,
  type InboxAdapter,
  type InboxItem,
  type InboxItemInput,
  type InboxStats,
  type MessageAdapter,
  type SessionLock,
  type SessionStateSnapshot,
  type StateAdapter,
  uuidv7,
} from 'eharness'

type Sqlite = Database
type Param = string | number | bigint | boolean | null | Uint8Array

/** Run `fn` as one write transaction that takes the write lock up front. */
function immediate<T>(sqlite: Sqlite, fn: () => T): T {
  return sqlite.transaction(fn).immediate()
}

// --- messages --------------------------------------------------------------------------------

interface MessageRow {
  id: string
  role: string
  parts: string
  metadata: string | null
}

const toMessage = (row: MessageRow): UIMessage => ({
  id: row.id,
  role: row.role as UIMessage['role'],
  parts: JSON.parse(row.parts),
  ...(row.metadata === null ? {} : { metadata: JSON.parse(row.metadata) }),
})

/** `MessageAdapter` on `eh_messages`: every query is a range scan on the primary key. */
export function sqliteMessages(sqlite: Sqlite): MessageAdapter {
  const upsert = sqlite.prepare(
    `INSERT INTO eh_messages (session_id, id, role, parts, metadata, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (session_id, id) DO UPDATE
       SET role = excluded.role, parts = excluded.parts, metadata = excluded.metadata`,
  )
  const cols = 'id, role, parts, metadata'
  return {
    async load({ sessionId, fromId, beforeId, limit }) {
      if (fromId !== undefined && beforeId !== undefined) {
        throw new TypeError('load: pass either fromId or beforeId, not both')
      }
      if (fromId !== undefined) {
        return sqlite
          .query<MessageRow, [string, string]>(
            `SELECT ${cols} FROM eh_messages WHERE session_id = ? AND id >= ? ORDER BY id`,
          )
          .all(sessionId, fromId)
          .map(toMessage)
      }
      if (limit !== undefined && limit <= 0) return []
      const before = beforeId ?? null
      if (limit === undefined) {
        return sqlite
          .query<MessageRow, [string, string | null, string | null]>(
            `SELECT ${cols} FROM eh_messages
             WHERE session_id = ? AND (? IS NULL OR id < ?) ORDER BY id`,
          )
          .all(sessionId, before, before)
          .map(toMessage)
      }
      const rows = sqlite
        .query<MessageRow, [string, string | null, string | null, number]>(
          `SELECT ${cols} FROM eh_messages
           WHERE session_id = ? AND (? IS NULL OR id < ?) ORDER BY id DESC LIMIT ?`,
        )
        .all(sessionId, before, before, limit)
      return rows.reverse().map(toMessage) // newest `limit`, chronological
    },
    async save(sessionId, batch) {
      const now = Date.now()
      immediate(sqlite, () => {
        for (const m of batch) {
          upsert.run(
            sessionId,
            m.id,
            m.role,
            JSON.stringify(m.parts),
            m.metadata === undefined ? null : JSON.stringify(m.metadata),
            now,
          )
        }
      })
    },
    async lastId(sessionId) {
      const row = sqlite
        .query<{ id: string }, [string]>(
          'SELECT id FROM eh_messages WHERE session_id = ? ORDER BY id DESC LIMIT 1',
        )
        .get(sessionId)
      return row?.id ?? null
    },
  }
}

// --- state -----------------------------------------------------------------------------------

/** `StateAdapter` on `eh_state`; `setIf` is one conditional statement (compare-and-set on `rev`). */
export function sqliteState(sqlite: Sqlite): StateAdapter {
  return {
    async get(sessionId) {
      const row = sqlite
        .query<{ state: string }, [string]>('SELECT state FROM eh_state WHERE session_id = ?')
        .get(sessionId)
      return row === null ? null : (JSON.parse(row.state) as SessionStateSnapshot)
    },
    async set(sessionId, state) {
      sqlite
        .query(
          `INSERT INTO eh_state (session_id, state, rev, updated_at) VALUES (?, ?, ?, ?)
           ON CONFLICT (session_id) DO UPDATE
             SET state = excluded.state, rev = excluded.rev, updated_at = excluded.updated_at`,
        )
        .run(sessionId, JSON.stringify(state), state.rev, Date.now())
    },
    async setIf(sessionId, state, expectedRev) {
      const json = JSON.stringify(state)
      const now = Date.now()
      const result =
        expectedRev === null
          ? sqlite
              .query(
                `INSERT INTO eh_state (session_id, state, rev, updated_at) VALUES (?, ?, ?, ?)
                 ON CONFLICT (session_id) DO NOTHING`,
              )
              .run(sessionId, json, state.rev, now)
          : sqlite
              .query(
                `UPDATE eh_state SET state = ?, rev = ?, updated_at = ?
                 WHERE session_id = ? AND rev = ?`,
              )
              .run(json, state.rev, now, sessionId, expectedRev)
      return result.changes === 1
    },
  }
}

// --- lock ------------------------------------------------------------------------------------

export interface SqliteLockOptions {
  /** Lease length (ms). The holder renews it every third of it. Default 30 000. */
  leaseMs?: number
  /** Owner string of this instance. Default a random id. */
  owner?: string
}

/**
 * Cross-process turn exclusion (spec 05 §8): a row per session with a lease. Rejects at once
 * when another live holder has it; a holder that died stops renewing and the lease expires.
 */
export function sqliteLock(sqlite: Sqlite, options: SqliteLockOptions = {}): SessionLock {
  const leaseMs = options.leaseMs ?? 30_000
  const instance = options.owner ?? uuidv7()
  return {
    async acquire(sessionId, { signal }) {
      signal.throwIfAborted()
      const owner = `${instance}:${uuidv7()}`
      const taken = immediate(sqlite, () => {
        const now = Date.now()
        sqlite.query('DELETE FROM eh_locks WHERE session_id = ? AND until <= ?').run(sessionId, now)
        const result = sqlite
          .query(
            'INSERT INTO eh_locks (session_id, owner, until) VALUES (?, ?, ?) ON CONFLICT DO NOTHING',
          )
          .run(sessionId, owner, now + leaseMs)
        return result.changes === 1
      })
      if (!taken) throw new Error(`session ${sessionId} is locked elsewhere`)
      const timer = setInterval(
        () => {
          sqlite
            .query('UPDATE eh_locks SET until = ? WHERE session_id = ? AND owner = ?')
            .run(Date.now() + leaseMs, sessionId, owner)
        },
        Math.max(10, Math.floor(leaseMs / 3)),
      )
      timer.unref?.()
      let released = false
      return async () => {
        if (released) return
        released = true
        clearInterval(timer)
        sqlite
          .query('DELETE FROM eh_locks WHERE session_id = ? AND owner = ?')
          .run(sessionId, owner)
      }
    },
  }
}

// --- inbox -----------------------------------------------------------------------------------

interface InboxRow {
  id: string
  session_id: string
  item: string
  attempts: number
  last_error: string | null
  dead_at: number | null
  dead_reason: string | null
}

const toItem = (row: InboxRow): InboxItem => {
  const item: InboxItem = { ...JSON.parse(row.item), id: row.id, attempts: row.attempts }
  if (row.last_error !== null) item.lastError = row.last_error
  return item
}

const placeholders = (n: number): string => Array.from({ length: n }, () => '?').join(',')

/**
 * `InboxAdapter` on `eh_inbox` (spec 05 §12): head-of-line claims with leases, `availableAt`
 * timers, retry delays, dead-letter and stats. `claim` is one `BEGIN IMMEDIATE` transaction, so
 * claimers in several processes never take the same item. There is no `notify`/`subscribe`
 * (SQLite has no notification channel): the holder of a session polls (`inbox.pollMs`).
 */
export function sqliteInbox(sqlite: Sqlite): InboxAdapter {
  return {
    async enqueue(sessionId, item: InboxItemInput) {
      const id = uuidv7()
      sqlite
        .query(
          `INSERT INTO eh_inbox (id, session_id, kind, item, available_at) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(id, sessionId, item.kind, JSON.stringify(item), item.availableAt ?? null)
      return id
    },

    async claim(sessionId, owner, opts = {}) {
      const ttl = Math.max(1, Math.round(opts.claimTtlMs ?? 120_000))
      return immediate(sqlite, () => {
        const now = Date.now()
        const until = now + ttl
        // renew the claims the owner already holds (not returned again, attempts unchanged)
        sqlite
          .query(
            `UPDATE eh_inbox SET claimed_until = ?
             WHERE session_id = ? AND claimed_by = ? AND claimed_until > ? AND dead_at IS NULL`,
          )
          .run(until, sessionId, owner, now)
        // head of line: oldest row another owner still holds
        const head = sqlite
          .query<{ id: string }, [string, number, string]>(
            `SELECT id FROM eh_inbox
             WHERE session_id = ? AND dead_at IS NULL AND claimed_until > ? AND claimed_by IS NOT ?
             ORDER BY id LIMIT 1`,
          )
          .get(sessionId, now, owner)?.id
        // oldest delayed (retry backoff) row: holds back everything after it except aborts
        const delay = sqlite
          .query<{ id: string }, [string, number, number, number]>(
            `SELECT id FROM eh_inbox
             WHERE session_id = ? AND dead_at IS NULL AND delayed_until > ?
               AND (claimed_until IS NULL OR claimed_until <= ?)
               AND (available_at IS NULL OR available_at <= ?)
             ORDER BY id LIMIT 1`,
          )
          .get(sessionId, now, now, now)?.id
        const candidates = sqlite
          .query<InboxRow & { kind: string }, [string, number, number, number]>(
            `SELECT * FROM eh_inbox
             WHERE session_id = ? AND dead_at IS NULL
               AND (claimed_until IS NULL OR claimed_until <= ?)
               AND (available_at IS NULL OR available_at <= ?)
               AND (delayed_until IS NULL OR delayed_until <= ?)
             ORDER BY id`,
          )
          .all(sessionId, now, now, now)
        const limit = opts.limit ?? Number.POSITIVE_INFINITY
        const claimed: InboxItem[] = []
        for (const row of candidates) {
          if (claimed.length >= limit) break
          if (head !== undefined && row.id > head) continue
          if (delay !== undefined && row.id > delay && row.kind !== 'abort') continue
          sqlite
            .query(
              `UPDATE eh_inbox SET claimed_by = ?, claimed_until = ?, attempts = attempts + 1,
                 delayed_until = NULL WHERE id = ?`,
            )
            .run(owner, until, row.id)
          claimed.push(toItem({ ...row, attempts: row.attempts + 1 }))
        }
        return claimed
      })
    },

    async ack(ids) {
      if (ids.length === 0) return
      sqlite.query(`DELETE FROM eh_inbox WHERE id IN (${placeholders(ids.length)})`).run(...ids)
    },

    async release(ids, opts = {}) {
      if (ids.length === 0) return
      const delayUntil =
        opts.delayMs !== undefined && opts.delayMs > 0
          ? Date.now() + Math.round(opts.delayMs)
          : null
      const params: Param[] = [
        opts.uncount === true ? 1 : 0,
        delayUntil,
        delayUntil,
        opts.lastError ?? null,
        ...ids,
        opts.owner ?? null,
        opts.owner ?? null,
      ]
      sqlite
        .query(
          `UPDATE eh_inbox SET claimed_by = NULL, claimed_until = NULL,
             attempts = CASE WHEN ? = 1 THEN MAX(0, attempts - 1) ELSE attempts END,
             delayed_until = CASE WHEN ? IS NOT NULL THEN ? ELSE delayed_until END,
             last_error = COALESCE(?, last_error)
           WHERE id IN (${placeholders(ids.length)})
             AND dead_at IS NULL AND claimed_by IS NOT NULL
             AND (? IS NULL OR claimed_by = ?)`,
        )
        .run(...params)
    },

    async deadLetter(ids, info) {
      if (ids.length === 0) return
      sqlite
        .query(
          `UPDATE eh_inbox SET claimed_by = NULL, claimed_until = NULL, delayed_until = NULL,
             dead_at = ?, dead_reason = ?, last_error = COALESCE(?, last_error)
           WHERE id IN (${placeholders(ids.length)}) AND dead_at IS NULL`,
        )
        .run(Date.now(), info.reason, info.lastError ?? null, ...ids)
    },

    async redrive(ids) {
      if (ids.length === 0) return
      sqlite
        .query(
          `UPDATE eh_inbox SET dead_at = NULL, dead_reason = NULL, attempts = 0, last_error = NULL
           WHERE id IN (${placeholders(ids.length)}) AND dead_at IS NOT NULL`,
        )
        .run(...ids)
    },

    async listDead(opts = {}) {
      const rows = sqlite
        .query<InboxRow, [string | null, string | null, number]>(
          `SELECT * FROM eh_inbox WHERE dead_at IS NOT NULL AND (? IS NULL OR session_id = ?)
           ORDER BY id LIMIT ?`,
        )
        .all(opts.sessionId ?? null, opts.sessionId ?? null, opts.limit ?? -1)
      return rows.map(
        (row): DeadInboxItem => ({
          ...toItem(row),
          sessionId: row.session_id,
          deadAt: row.dead_at as number,
          reason: row.dead_reason as string,
        }),
      )
    },

    async stats(opts = {}): Promise<InboxStats> {
      const now = Date.now()
      const row = sqlite
        .query<
          { ready: number; claimed: number; delayed: number; dead: number },
          [number, number, number, number, number, number, number, string | null, string | null]
        >(
          `SELECT
             coalesce(sum(dead_at IS NOT NULL), 0) AS dead,
             coalesce(sum(dead_at IS NULL AND claimed_until > ?), 0) AS claimed,
             coalesce(sum(dead_at IS NULL AND (claimed_until IS NULL OR claimed_until <= ?)
               AND (delayed_until > ? OR available_at > ?)), 0) AS delayed,
             coalesce(sum(dead_at IS NULL AND (claimed_until IS NULL OR claimed_until <= ?)
               AND (delayed_until IS NULL OR delayed_until <= ?)
               AND (available_at IS NULL OR available_at <= ?)), 0) AS ready
           FROM eh_inbox WHERE (? IS NULL OR session_id = ?)`,
        )
        .get(now, now, now, now, now, now, now, opts.sessionId ?? null, opts.sessionId ?? null)
      return {
        ready: Number(row?.ready ?? 0),
        claimed: Number(row?.claimed ?? 0),
        delayed: Number(row?.delayed ?? 0),
        dead: Number(row?.dead ?? 0),
      }
    },

    async pending(opts = {}) {
      const now = Date.now()
      const rows = sqlite
        .query<{ session_id: string }, Param[]>(
          `SELECT DISTINCT c.session_id FROM eh_inbox AS c
           WHERE c.dead_at IS NULL
             AND (c.claimed_until IS NULL OR c.claimed_until <= ?)
             AND (c.available_at IS NULL OR c.available_at <= ?)
             AND (c.delayed_until IS NULL OR c.delayed_until <= ?)
             AND NOT EXISTS (SELECT 1 FROM eh_inbox AS h WHERE h.session_id = c.session_id
               AND h.id < c.id AND h.dead_at IS NULL AND h.claimed_until > ?)
             AND (c.kind = 'abort' OR NOT EXISTS (SELECT 1 FROM eh_inbox AS d
               WHERE d.session_id = c.session_id AND d.id < c.id AND d.dead_at IS NULL
                 AND d.delayed_until > ?
                 AND (d.claimed_until IS NULL OR d.claimed_until <= ?)
                 AND (d.available_at IS NULL OR d.available_at <= ?)))
           LIMIT ?`,
        )
        .all(now, now, now, now, now, now, now, opts.limit ?? -1)
      return rows.map((r) => r.session_id)
    },
  }
}

// --- budget ledger ---------------------------------------------------------------------------

/** First instant of the current calendar month in UTC (epoch ms). */
export function currentPeriod(now: number = Date.now()): number {
  const d = new Date(now)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)
}

const usd = (value: number): number => (Number.isFinite(value) && value > 0 ? value : 0)

/** Set (or clear with `null`) the limit of a scope from the current month on. */
export function setBudgetLimit(sqlite: Sqlite, scope: string, limitUsd: number | null): void {
  sqlite
    .query(
      `INSERT INTO eh_budget_scope (scope, period_start, limit_usd) VALUES (?, ?, ?)
       ON CONFLICT (scope, period_start) DO UPDATE SET limit_usd = excluded.limit_usd`,
    )
    .run(scope, currentPeriod(), limitUsd === null ? null : String(limitUsd))
}

/**
 * `BudgetLedger` (spec 12 §4.1): limits per scope and calendar month (UTC), atomic
 * all-or-nothing reservations (one `BEGIN IMMEDIATE` transaction per call), amounts reserved are
 * summed from open reservations (an expired one simply stops counting; a late commit still
 * charges its actual cost). A new month's row inherits the limit of the scope's latest row.
 */
export function sqliteBudgetLedger(sqlite: Sqlite): BudgetLedger {
  const ensure = (scopes: readonly string[], period: number): void => {
    for (const scope of new Set(scopes)) {
      sqlite
        .query(
          `INSERT INTO eh_budget_scope (scope, period_start, limit_usd)
           SELECT ?, ?, (SELECT p.limit_usd FROM eh_budget_scope AS p WHERE p.scope = ?
                         ORDER BY p.period_start DESC LIMIT 1)
           ON CONFLICT (scope, period_start) DO NOTHING`,
        )
        .run(scope, period, scope)
    }
  }
  const reserved = (scope: string, period: number, now: number): number =>
    Number(
      sqlite
        .query<{ total: number }, [number, number, string]>(
          `SELECT coalesce(sum(CAST(r.amount_usd AS REAL)), 0) AS total FROM eh_budget_reservation AS r
           WHERE r.state = 'open' AND r.expires_at > ? AND r.period_start = ?
             AND EXISTS (SELECT 1 FROM json_each(r.scopes) AS j WHERE j.value = ?)`,
        )
        .get(now, period, scope)?.total ?? 0,
    )
  const addSpent = (scopes: readonly string[], period: number, amount: number): void => {
    for (const scope of new Set(scopes)) {
      sqlite
        .query(
          `UPDATE eh_budget_scope SET spent_usd = CAST(CAST(spent_usd AS REAL) + ? AS TEXT)
           WHERE scope = ? AND period_start = ?`,
        )
        .run(amount, scope, period)
    }
  }
  return {
    async reserve({ scopes, amountUsd, ttlMs, key }) {
      const amount = usd(amountUsd)
      return immediate(sqlite, () => {
        const now = Date.now()
        const period = currentPeriod(now)
        ensure(scopes, period)
        const open = sqlite
          .query<{ id: string }, [string, number]>(
            `SELECT id FROM eh_budget_reservation
             WHERE key = ? AND state = 'open' AND expires_at > ? LIMIT 1`,
          )
          .get(key, now)
        if (open !== null) return { ok: true as const, reservationId: open.id }
        for (const scope of scopes) {
          const row = sqlite
            .query<{ limit_usd: string | null; spent_usd: string }, [string, number]>(
              'SELECT limit_usd, spent_usd FROM eh_budget_scope WHERE scope = ? AND period_start = ?',
            )
            .get(scope, period)
          if (row === null || row.limit_usd === null) continue
          const limit = Number(row.limit_usd)
          const used = Number(row.spent_usd) + reserved(scope, period, now)
          if (used >= limit || used + amount > limit) {
            return { ok: false as const, scope, limitUsd: limit, spentUsd: used }
          }
        }
        const id = uuidv7()
        sqlite
          .query(
            `INSERT INTO eh_budget_reservation (id, key, scopes, period_start, amount_usd, expires_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(
            id,
            key,
            JSON.stringify([...new Set(scopes)]),
            period,
            String(amount),
            now + Math.max(1, Math.round(ttlMs)),
          )
        return { ok: true as const, reservationId: id }
      })
    },

    async commit(reservationId, actualUsd) {
      immediate(sqlite, () => {
        const res = sqlite
          .query<{ scopes: string; period_start: number }, [string]>(
            `SELECT scopes, period_start FROM eh_budget_reservation WHERE id = ? AND state = 'open'`,
          )
          .get(reservationId)
        if (res === null) return
        addSpent(JSON.parse(res.scopes) as string[], res.period_start, usd(actualUsd))
        sqlite
          .query(`UPDATE eh_budget_reservation SET state = 'committed' WHERE id = ?`)
          .run(reservationId)
      })
    },

    async release(reservationId) {
      sqlite
        .query(
          `UPDATE eh_budget_reservation SET state = 'released' WHERE id = ? AND state = 'open'`,
        )
        .run(reservationId)
    },

    async record({ scopes, amountUsd, key }) {
      immediate(sqlite, () => {
        const inserted = sqlite
          .query(
            'INSERT INTO eh_budget_record (key, recorded_at) VALUES (?, ?) ON CONFLICT DO NOTHING',
          )
          .run(key, Date.now())
        if (inserted.changes === 0) return
        const period = currentPeriod()
        ensure(scopes, period)
        addSpent(scopes, period, usd(amountUsd))
      })
    },

    async check(scopes) {
      const now = Date.now()
      const period = currentPeriod(now)
      let ok = true
      const out = [...new Set(scopes)].map((scope) => {
        const limitRow = sqlite
          .query<{ limit_usd: string | null }, [string]>(
            'SELECT limit_usd FROM eh_budget_scope WHERE scope = ? ORDER BY period_start DESC LIMIT 1',
          )
          .get(scope)
        const spentRow = sqlite
          .query<{ spent_usd: string }, [string, number]>(
            'SELECT spent_usd FROM eh_budget_scope WHERE scope = ? AND period_start = ?',
          )
          .get(scope, period)
        const spentUsd = Number(spentRow?.spent_usd ?? 0)
        const reservedUsd = reserved(scope, period, now)
        if (limitRow === null || limitRow.limit_usd === null) {
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
