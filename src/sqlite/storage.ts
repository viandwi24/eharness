/** `createSqliteStorage`: every adapter on one driver (spec 36 §3). */

import type { ActivityStore } from '../activity/index.ts'
import type { OutboxStore } from '../channels/index.ts'
import type { HandoffStore } from '../handoff/index.ts'
import type { PersonStore } from '../identity/index.ts'
import type {
  BudgetLedger,
  InboxAdapter,
  MessageAdapter,
  SessionLock,
  StateAdapter,
  StreamLogAdapter,
} from '../index.ts'
import type { ProfileStore, SecretVault } from '../providers/index.ts'
import type { ScheduleStore } from '../scheduler/index.ts'
import { sqliteActivityStore } from './activity.ts'
import { sqliteBudgetLedger } from './budget.ts'
import type { SqlDriver } from './driver.ts'
import { sqliteHandoffStore } from './handoffs.ts'
import { sqliteInbox } from './inbox.ts'
import { sqliteLock } from './lock.ts'
import { sqliteMessages, sqliteState } from './messages.ts'
import { sqliteOutboxStore } from './outbox.ts'
import { sqlitePersonStore } from './people.ts'
import { sqliteProfileStore, sqliteSealedProfileStore } from './profiles.ts'
import { sqliteScheduleStore } from './schedules.ts'
import { sqliteStreamLog } from './stream-log.ts'
import { checkPrefix, DEFAULT_PREFIX } from './util.ts'

/** Options of {@link createSqliteStorage}. */
export interface SqliteStorageOptions {
  /** Table prefix (letters, digits and underscores). Default `eh_`. */
  prefix?: string
  /** `SessionLock` lease: length in ms (default 30 000) and the instance owner string. */
  lease?: { ms?: number; owner?: string }
  /** Inbox de-duplication window after an ack in ms (default 24 hours). */
  inbox?: { dedupeWindowMs?: number }
  /** Cross-process wake-up polling of `subscribe` in ms (default 250). */
  pollMs?: number
  /** Clock in epoch ms (tests). Default `Date.now`. */
  now?: () => number
  /** Seals the `profiles` store at rest with this vault (`SealedProfileStore`). Default: not sealed. */
  vault?: SecretVault
}

/** The storage bundle: the fields `createAgent` takes plus the other stores. */
export interface SqliteStorage {
  messages: MessageAdapter
  state: StateAdapter
  lock: SessionLock
  inbox: InboxAdapter
  streams: StreamLogAdapter
  budget: BudgetLedger
  activity: ActivityStore
  schedules: ScheduleStore
  outbox: OutboxStore
  handoffs: HandoffStore
  people: PersonStore
  /** A `SealedProfileStore` when `options.vault` is set, else a plain `ProfileStore`. */
  profiles: ProfileStore
}

/**
 * Every storage port on one SQLite driver. The tables must exist: call `migrate(driver, { prefix })`
 * first (or run `schemaSql({ prefix })` with your own migrations).
 *
 * @example
 * ```ts
 * const driver = bunSqlite(new Database('app.db'), { owned: true })
 * migrate(driver)
 * const storage = createSqliteStorage(driver)
 * const agent = createAgent({ ..., messages: storage.messages, state: storage.state,
 *   lock: storage.lock, inbox: storage.inbox, streams: storage.streams })
 * ```
 */
export function createSqliteStorage(
  driver: SqlDriver,
  options: SqliteStorageOptions = {},
): SqliteStorage {
  const prefix = checkPrefix(options.prefix ?? DEFAULT_PREFIX)
  const base = { prefix, ...(options.now === undefined ? {} : { now: options.now }) }
  const poll = options.pollMs === undefined ? {} : { pollMs: options.pollMs }
  return {
    messages: sqliteMessages(driver, base),
    state: sqliteState(driver, base),
    lock: sqliteLock(driver, {
      ...base,
      ...(options.lease?.ms === undefined ? {} : { ms: options.lease.ms }),
      ...(options.lease?.owner === undefined ? {} : { owner: options.lease.owner }),
    }),
    inbox: sqliteInbox(driver, {
      ...base,
      ...poll,
      ...(options.inbox?.dedupeWindowMs === undefined
        ? {}
        : { dedupeWindowMs: options.inbox.dedupeWindowMs }),
    }),
    streams: sqliteStreamLog(driver, { ...base, ...poll }),
    budget: sqliteBudgetLedger(driver, base),
    activity: sqliteActivityStore(driver, base),
    schedules: sqliteScheduleStore(driver, base),
    outbox: sqliteOutboxStore(driver, base),
    handoffs: sqliteHandoffStore(driver, base),
    people: sqlitePersonStore(driver, base),
    profiles:
      options.vault === undefined
        ? sqliteProfileStore(driver, { ...base, ...poll })
        : sqliteSealedProfileStore(driver, { ...base, ...poll, vault: options.vault }),
  }
}
