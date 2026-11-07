/**
 * Every conformance suite of `eharness/testing` against this package, runner-agnostic: the Bun
 * test file and the Node runner (`conformance.node.ts`) both register these groups. Each group's
 * adapters get a fresh database per case (`memory`) or two connections to one temp file (`pair`).
 * Test support, not part of the published package.
 */
import {
  activityStoreConformance,
  budgetLedgerConformance,
  type ConformanceCase,
  handoffStoreConformance,
  inboxAdapterConformance,
  lockConformance,
  messageAdapterConformance,
  multiInstanceConformance,
  outboxStoreConformance,
  personStoreConformance,
  profileStoreConformance,
  scheduleStoreConformance,
  stateAdapterConformance,
  streamLogConformance,
} from 'eharness/testing'
import { sqliteActivityStore } from './activity.ts'
import { setBudgetLimit, sqliteBudgetLedger } from './budget.ts'
import type { SqlDriver } from './driver.ts'
import { sqliteHandoffStore } from './handoffs.ts'
import { sqliteInbox } from './inbox.ts'
import { sqliteLock } from './lock.ts'
import { sqliteMessages, sqliteState } from './messages.ts'
import { sqliteOutboxStore } from './outbox.ts'
import { sqlitePersonStore } from './people.ts'
import { sqliteProfileStore } from './profiles.ts'
import { sqliteScheduleStore } from './schedules.ts'
import { migrate } from './schema.ts'
import { createSqliteStorage } from './storage.ts'
import { sqliteStreamLog } from './stream-log.ts'

/** What a runtime provides to the suites. */
export interface SuiteEnv {
  /** A new, migrated, empty in-memory database. */
  memory(): SqlDriver
  /** A new connection to the migrated database file at `path` (migrates it first). */
  file(path: string): SqlDriver
  /** A path for a database file nobody has used. */
  newPath(): string
}

/** A named list of cases. */
export interface SuiteGroup {
  name: string
  cases: ConformanceCase[]
}

/** All groups for `env`. */
export function suiteGroups(env: SuiteEnv): SuiteGroup[] {
  return [
    {
      name: 'MessageAdapter',
      cases: messageAdapterConformance(() => sqliteMessages(env.memory()), { requireLastId: true }),
    },
    {
      name: 'StateAdapter',
      cases: stateAdapterConformance(() => sqliteState(env.memory())),
    },
    {
      name: 'SessionLock',
      cases: lockConformance(() => {
        const path = env.newPath()
        const own = env.file(path)
        return {
          lock: sqliteLock(own, { ms: 60_000 }),
          peer: () => sqliteLock(env.file(path), { ms: 60_000 }),
          // a crashed holder stops renewing: its lease runs out without a release
          expire: (sessionId) => {
            own.run('UPDATE eh_locks SET until = 0 WHERE session_id = ?', [sessionId])
          },
        }
      }),
    },
    {
      name: 'InboxAdapter',
      cases: inboxAdapterConformance(() => sqliteInbox(env.memory()), {
        requirePending: true,
        requireRetry: true,
        requireDeadLetter: true,
        requireStats: true,
        requireDedupe: true,
        claimTtlMs: 200,
      }),
    },
    {
      name: 'StreamLogAdapter',
      cases: streamLogConformance(() => sqliteStreamLog(env.memory())),
    },
    {
      name: 'BudgetLedger',
      cases: budgetLedgerConformance((limits) => {
        const driver = env.memory()
        for (const [scope, usd] of Object.entries(limits)) setBudgetLimit(driver, scope, usd)
        return sqliteBudgetLedger(driver)
      }),
    },
    {
      name: 'ActivityStore',
      cases: activityStoreConformance(() => {
        const path = env.newPath()
        const own = env.file(path)
        return { store: sqliteActivityStore(own), peer: () => sqliteActivityStore(env.file(path)) }
      }),
    },
    {
      name: 'ScheduleStore',
      cases: scheduleStoreConformance(() => sqliteScheduleStore(env.memory())),
    },
    {
      name: 'OutboxStore',
      cases: outboxStoreConformance(() => {
        const path = env.newPath()
        const own = env.file(path)
        return { store: sqliteOutboxStore(own), peer: () => sqliteOutboxStore(env.file(path)) }
      }),
    },
    {
      name: 'HandoffStore',
      cases: handoffStoreConformance(() => sqliteHandoffStore(env.memory())),
    },
    {
      name: 'PersonStore',
      cases: personStoreConformance(() => sqlitePersonStore(env.memory())),
    },
    {
      name: 'ProfileStore',
      cases: profileStoreConformance(() => sqliteProfileStore(env.memory()), {
        requireSubscribe: true,
      }),
    },
    {
      name: 'multi-instance (two drivers, one file)',
      cases: multiInstanceConformance({
        makeStorage: () => {
          const path = env.newPath()
          const storage = createSqliteStorage(env.file(path), { pollMs: 20 })
          paths.set(storage.messages, path)
          return storage
        },
        connect: (shared, index) => {
          if (index === 0) return shared
          const path = paths.get(shared.messages) as string
          return createSqliteStorage(env.file(path), { pollMs: 20 })
        },
      }),
    },
  ]
}

const paths = new WeakMap<object, string>()

/** Migrate helper shared by the runtimes. */
export const prepare = (driver: SqlDriver): SqlDriver => {
  migrate(driver)
  return driver
}
