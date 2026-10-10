/** The library's conformance suites against the SQLite adapters (file database in a temp dir). */
import { afterAll, describe, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  budgetLedgerConformance,
  fileSystemConformance,
  inboxAdapterConformance,
  messageAdapterConformance,
  profileStoreConformance,
  stateAdapterConformance,
  streamLogConformance,
} from 'eharness/testing'
import { type Connection, openDatabase } from '../src/infra/db/client.ts'
import { libraryFs } from '../src/infra/eh/library-fs.ts'
import { sqliteProfileStore } from '../src/infra/eh/profile-store.ts'
import { createSecretBox, generateSecretKey, parseSecretKey } from '../src/infra/eh/secret-box.ts'
import {
  setBudgetLimit,
  sqliteBudgetLedger,
  sqliteInbox,
  sqliteLock,
  sqliteMessages,
  sqliteState,
} from '../src/infra/eh/storage.ts'
import { sqliteStreamLog } from '../src/infra/eh/stream-log.ts'

const dir = mkdtempSync(join(tmpdir(), 'team-conformance-'))
const conn: Connection = openDatabase(join(dir, 'team.db'))
afterAll(() => {
  conn.close()
  rmSync(dir, { recursive: true, force: true })
})

function suite(
  name: string,
  cases: Array<{ name: string; run: () => Promise<void> | void }>,
): void {
  describe(name, () => {
    for (const c of cases) test(c.name, c.run)
  })
}

suite(
  'MessageAdapter conformance (SQLite)',
  messageAdapterConformance(() => sqliteMessages(conn.sqlite), { requireLastId: true }),
)
suite(
  'StateAdapter conformance (SQLite)',
  stateAdapterConformance(() => sqliteState(conn.sqlite)),
)
suite(
  'InboxAdapter conformance (SQLite)',
  inboxAdapterConformance(() => sqliteInbox(conn.sqlite), {
    requirePending: true,
    requireRetry: true,
    requireDeadLetter: true,
    requireStats: true,
    requireDedupe: true,
    claimTtlMs: 200,
  }),
)
suite(
  'StreamLog conformance (SQLite)',
  streamLogConformance(() => sqliteStreamLog(conn.sqlite)),
)
suite(
  'BudgetLedger conformance (SQLite)',
  budgetLedgerConformance(
    async (limits) => {
      for (const [scope, limit] of Object.entries(limits)) setBudgetLimit(conn.sqlite, scope, limit)
      return sqliteBudgetLedger(conn.sqlite)
    },
    { ttlMs: 200 },
  ),
)
suite(
  'FileSystem conformance (library files on SQLite)',
  // every case gets an empty file store (the suite assumes an isolated adapter per call)
  fileSystemConformance(() => libraryFs(openDatabase(':memory:').sqlite), {
    requireStat: true,
    requireGrep: true,
    requireGlob: true,
    requireMove: true,
    requireBytes: true,
  }),
)

describe('SessionLock (SQLite)', () => {
  test('a second acquire is rejected until release', async () => {
    const lock = sqliteLock(conn.sqlite, { leaseMs: 60_000 })
    const signal = new AbortController().signal
    const release = await lock.acquire('s1', { signal })
    const second = await lock.acquire('s1', { signal }).then(
      () => 'acquired',
      () => 'rejected',
    )
    if (second !== 'rejected') throw new Error('second acquire must be rejected')
    await release()
    const again = await lock.acquire('s1', { signal })
    await again()
  })
})

suite(
  'ProfileStore conformance (SQLite, encrypted settings)',
  // every case gets an empty store: a fresh database and a fresh key
  profileStoreConformance(async () =>
    sqliteProfileStore(
      openDatabase(':memory:').sqlite,
      await createSecretBox([parseSecretKey(generateSecretKey())]),
    ),
  ),
)
