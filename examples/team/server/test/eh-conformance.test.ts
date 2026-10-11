/** The library's conformance suites against the SQLite adapters (file database in a temp dir). */
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CONNECTION_KIND,
  CREDENTIALS_KIND,
  connectionStoreFromProfiles,
  credentialStoreFromProfiles,
} from 'eharness/connectors'
import { sealedProfileStore } from 'eharness/providers'
import {
  budgetLedgerConformance,
  connectionStoreConformance,
  credentialStoreConformance,
  enablementStoreConformance,
  fileSystemConformance,
  flowStoreConformance,
  inboxAdapterConformance,
  lockConformance,
  messageAdapterConformance,
  multiInstanceConformance,
  profileStoreConformance,
  stateAdapterConformance,
  streamLogConformance,
} from 'eharness/testing'
import { type Connection, openDatabase } from '../src/infra/db/client.ts'
import { sqliteEnablementStore, sqliteFlowStore } from '../src/infra/eh/connector-stores.ts'
import { libraryFs } from '../src/infra/eh/library-fs.ts'
import { sqliteProfileStore } from '../src/infra/eh/profile-store.ts'
import { generateSecretKey, parseSecretKey, teamVault } from '../src/infra/eh/secret-vault.ts'
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
  // `owner` names the process; a second lock over the same database is "another instance"
  const lockCases = lockConformance(() => {
    const file = join(dir, `lock-${crypto.randomUUID()}.db`)
    const own = openDatabase(file)
    peerConns.push(own)
    const lock = sqliteLock(own.sqlite, { leaseMs: 60_000 })
    return {
      lock,
      peer: () => {
        const other = openDatabase(file)
        peerConns.push(other)
        return sqliteLock(other.sqlite, { leaseMs: 60_000 })
      },
      // a crashed holder stops renewing: its lease runs out without a release
      expire: (sessionId) => {
        own.sqlite.query('UPDATE eh_locks SET until = 0 WHERE session_id = ?').run(sessionId)
      },
    }
  })
  const peerConns: Connection[] = []
  afterAll(() => {
    for (const c of peerConns) c.close()
  })
  for (const c of lockCases) test(c.name, c.run)

  test('takeOver frees the lease a previous run of this process left, never a live or foreign one', async () => {
    const own = openDatabase(join(dir, `takeover-${crypto.randomUUID()}.db`))
    try {
      const signal = new AbortController().signal
      const lock = sqliteLock(own.sqlite, { leaseMs: 60_000, owner: 'proc-1', takeOver: true })
      // a lease this process still holds is never taken over, not even by a sibling acquire
      const live = await lock.acquire('s1', { signal })
      const rejected = await lock.acquire('s1', { signal }).then(
        () => 'acquired',
        () => 'rejected',
      )
      expect(rejected).toBe('rejected')
      await live()
      // a lease row left by a previous run of the same process (crashed, not expired yet)
      own.sqlite
        .query('INSERT INTO eh_locks (session_id, owner, until) VALUES (?, ?, ?)')
        .run('s2', 'proc-1:old', Date.now() + 60_000)
      const taken = await lock.acquire('s2', { signal })
      await taken()
      // another owner's live lease is never taken over
      own.sqlite
        .query('INSERT INTO eh_locks (session_id, owner, until) VALUES (?, ?, ?)')
        .run('s3', 'proc-2:x', Date.now() + 60_000)
      const foreign = await lock.acquire('s3', { signal }).then(
        () => 'acquired',
        () => 'rejected',
      )
      expect(foreign).toBe('rejected')
    } finally {
      own.close()
    }
  })
})

describe('multi-instance conformance (SQLite, one connection per instance)', () => {
  interface Shared {
    messages: ReturnType<typeof sqliteMessages>
    state: ReturnType<typeof sqliteState>
    inbox: ReturnType<typeof sqliteInbox>
    lock: ReturnType<typeof sqliteLock>
    file: string
    conn: Connection
    extra: Connection[]
  }
  const view = (file: string, c: Connection, extra: Connection[]): Shared => {
    const v: Shared = {
      messages: sqliteMessages(c.sqlite),
      state: sqliteState(c.sqlite),
      inbox: sqliteInbox(c.sqlite),
      lock: sqliteLock(c.sqlite, { leaseMs: 60_000 }),
      file,
      conn: c,
      extra,
    }
    return v
  }
  const suite = multiInstanceConformance({
    makeStorage: () => {
      const file = join(dir, `mi-${crypto.randomUUID()}.db`)
      return view(file, openDatabase(file), [])
    },
    // another instance is another connection (and another lock object) on the same database file
    connect: (shared, index) => {
      if (index === 0) return shared
      const s = shared as Shared
      const other = openDatabase(s.file)
      s.extra.push(other)
      return view(s.file, other, s.extra)
    },
    cleanup: (shared) => {
      const s = shared as Shared
      for (const c of s.extra) c.close()
      s.conn.close()
    },
    latencyMs: 2,
  })
  for (const c of suite) test(c.name, c.run, 30_000)
})

describe('connector stores (SQLite)', () => {
  const sealedFor = (kinds: string[]) =>
    sealedProfileStore({
      inner: sqliteProfileStore(openDatabase(':memory:').sqlite),
      vault: teamVault([parseSecretKey(generateSecretKey())]),
      kinds,
    })
  suite(
    'ConnectionStore conformance (sealed profile rows)',
    connectionStoreConformance(() => connectionStoreFromProfiles(sealedFor([CONNECTION_KIND]))),
  )
  suite(
    'CredentialStore conformance (sealed profile rows)',
    credentialStoreConformance(() => credentialStoreFromProfiles(sealedFor([CREDENTIALS_KIND]))),
  )
  suite(
    'EnablementStore conformance (agent_connectors)',
    enablementStoreConformance(() => sqliteEnablementStore(openDatabase(':memory:').sqlite)),
  )
  suite(
    'FlowStore conformance (connector_flows)',
    flowStoreConformance(() => sqliteFlowStore(openDatabase(':memory:').sqlite)),
  )
})

suite(
  'ProfileStore conformance (SQLite, encrypted settings)',
  // every case gets an empty store: a fresh database and a fresh key
  profileStoreConformance(async () =>
    sealedProfileStore({
      inner: sqliteProfileStore(openDatabase(':memory:').sqlite),
      vault: teamVault([parseSecretKey(generateSecretKey())]),
    }),
  ),
)
