/**
 * eharness storage ports on `bun:sqlite` (docs/plans/P32-team-example.md §4, M2): messages, state
 * (with compare-and-set), a lease-based session lock, the durable inbox and the budget ledger.
 *
 * The adapters are the ones of `eharness/sqlite` (spec 36, P62): this file only binds them to the
 * `bun:sqlite` handle of the app and keeps the three behaviours the team had before:
 *
 * - `sqliteMessages` stamps the instruction mark (`instruction-marks.ts`) into the stored metadata;
 * - `sqliteLock({ takeOver: true })` takes over a stale lease of the same `owner` (the package does
 *   it when `acquire` receives the owner, which `recovery.instanceId` supplies; here the lock
 *   passes its own owner so a caller without `recovery.instanceId` keeps the old behaviour);
 * - `sqliteInbox` has no `notify`/`subscribe`: the holder of a session polls (`inbox.pollMs`).
 *
 * The tables are created by the drizzle migrations (`infra/db/schema.ts`), never here: their DDL
 * matches `schemaSql()` of the package for these five ports (see docs/storage-adapters.md).
 * Stream log, activity, schedules and profiles stay app-owned (their tables differ).
 */
import type { Database } from 'bun:sqlite'
import type { UIMessage } from 'ai'
import type {
  BudgetLedger,
  InboxAdapter,
  MessageAdapter,
  SessionLock,
  StateAdapter,
} from 'eharness'
import {
  sqliteBudgetLedger as packageBudgetLedger,
  sqliteInbox as packageInbox,
  sqliteLock as packageLock,
  sqliteMessages as packageMessages,
  setBudgetLimit as packageSetBudgetLimit,
  sqliteState as packageState,
  type SqlDriver,
  type SqliteInboxOptions,
} from 'eharness/sqlite'
import { bunSqlite } from 'eharness/sqlite/bun'

import { INSTRUCTION_METADATA, isInstruction, takeInstruction } from './instruction-marks.ts'

export type { SqliteInboxOptions }

/** One driver per handle: nested transactions join only inside the same driver object. */
const drivers = new WeakMap<Database, SqlDriver>()
function driverOf(sqlite: Database): SqlDriver {
  let driver = drivers.get(sqlite)
  if (driver === undefined) {
    // `openDatabase` already set WAL, busy_timeout and foreign_keys on the handle
    driver = bunSqlite(sqlite, { onWarn: () => {} })
    drivers.set(sqlite, driver)
  }
  return driver
}

/**
 * `MessageAdapter` on `eh_messages`. The user message a task, program, rehearsal or heartbeat
 * prompt became carries `metadata.app.instruction`; a later save of the same message (the in-memory
 * copy has no flag) keeps it.
 */
export function sqliteMessages(sqlite: Database): MessageAdapter {
  const inner = packageMessages(driverOf(sqlite))
  const storedMeta = sqlite.query<{ metadata: string | null }, [string, string]>(
    'SELECT metadata FROM eh_messages WHERE session_id = ? AND id = ?',
  )
  const stampInstruction = (sessionId: string, m: UIMessage): UIMessage => {
    if (
      m.role !== 'user' ||
      (m.metadata as { eharness?: { kind?: string } } | undefined)?.eharness?.kind !== undefined
    ) {
      return m
    }
    let flagged = isInstruction(m.metadata)
    if (!flagged) flagged = takeInstruction(sessionId)
    if (!flagged) {
      const row = storedMeta.get(sessionId, m.id)
      flagged = row?.metadata != null && isInstruction(JSON.parse(row.metadata))
    }
    if (!flagged) return m
    const base = (m.metadata ?? {}) as { app?: Record<string, unknown> }
    return { ...m, metadata: { ...base, app: { ...base.app, ...INSTRUCTION_METADATA } } }
  }
  return {
    ...inner,
    save: (sessionId, batch) =>
      inner.save(
        sessionId,
        batch.map((m) => stampInstruction(sessionId, m)),
      ),
  }
}

/** `StateAdapter` on `eh_state`; `setIf` is one conditional statement (compare-and-set on `rev`). */
export function sqliteState(sqlite: Database): StateAdapter {
  return packageState(driverOf(sqlite))
}

export interface SqliteLockOptions {
  /** Lease length (ms). The holder renews it every third of it. Default 30 000. */
  leaseMs?: number
  /** Owner string of this instance. Default a random id. */
  owner?: string
  /**
   * The owner string is stable across restarts: a lease whose holder carries it (and is not held
   * by this process) belongs to a previous run of this instance and is taken over at once.
   */
  takeOver?: boolean
}

/** Cross-process turn exclusion (spec 05 §8): a row per session with a lease. */
export function sqliteLock(sqlite: Database, options: SqliteLockOptions = {}): SessionLock {
  const inner = packageLock(driverOf(sqlite), {
    ...(options.leaseMs !== undefined ? { ms: options.leaseMs } : {}),
    ...(options.owner !== undefined ? { owner: options.owner } : {}),
  })
  const takeOverAs = options.takeOver === true ? options.owner : undefined
  return {
    acquire: (sessionId, opts) =>
      inner.acquire(
        sessionId,
        takeOverAs !== undefined && opts.owner === undefined
          ? { ...opts, owner: takeOverAs }
          : opts,
      ),
  }
}

/** `InboxAdapter` on `eh_inbox` (spec 05 §12), polled by the holder of a session. */
export function sqliteInbox(sqlite: Database, options: SqliteInboxOptions = {}): InboxAdapter {
  const {
    notify: _notify,
    subscribe: _subscribe,
    ...inbox
  } = packageInbox(driverOf(sqlite), options)
  return inbox
}

/** Set (or clear with `null`) the limit of a scope from the current month on. */
export function setBudgetLimit(sqlite: Database, scope: string, limitUsd: number | null): void {
  packageSetBudgetLimit(driverOf(sqlite), scope, limitUsd)
}

/** `BudgetLedger` (spec 12 §4.1): limits per scope and calendar month (UTC). */
export function sqliteBudgetLedger(sqlite: Database): BudgetLedger {
  return packageBudgetLedger(driverOf(sqlite))
}
