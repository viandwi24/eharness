import { Database } from 'bun:sqlite'
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isHarnessError, uuidv7 } from 'eharness'
import { webCryptoVault } from 'eharness/providers'
import { bunSqlite } from './bun.ts'
import type { SqlDriver } from './driver.ts'
import { isSqliteSchemaError, migrate, SCHEMA_VERSION, schemaSql } from './schema.ts'
import { createSqliteStorage } from './storage.ts'
import { tables } from './util.ts'

const dir = mkdtempSync(join(tmpdir(), 'eharness-sqlite-unit-'))
const opened: Database[] = []
let n = 0
const memory = (): SqlDriver => {
  const db = new Database(':memory:')
  opened.push(db)
  return bunSqlite(db, { owned: true })
}
const file = (path: string): SqlDriver => {
  const db = new Database(path)
  opened.push(db)
  const driver = bunSqlite(db, { owned: true })
  migrate(driver)
  return driver
}
const newPath = (): string => join(dir, `unit-${n++}.sqlite`)
afterAll(() => {
  for (const db of opened) db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('driver', () => {
  test('nested transactions join the outer one and a throw rolls everything back', () => {
    const d = memory()
    d.exec('CREATE TABLE t (v INTEGER)')
    expect(() =>
      d.transaction(() => {
        d.run('INSERT INTO t VALUES (?)', [1])
        d.transaction(() => d.run('INSERT INTO t VALUES (?)', [2]))
        throw new Error('boom')
      }),
    ).toThrow('boom')
    expect(d.query('SELECT * FROM t')).toEqual([])
    d.transaction(() => d.transaction(() => d.run('INSERT INTO t VALUES (?)', [3])))
    expect(d.query<{ v: number }>('SELECT v FROM t')).toEqual([{ v: 3 }])
  })

  test('a transaction function that returns a promise is rejected and rolled back', () => {
    const d = memory()
    d.exec('CREATE TABLE t (v INTEGER)')
    expect(() =>
      d.transaction(() => {
        d.run('INSERT INTO t VALUES (?)', [1])
        return Promise.resolve(1) as never
      }),
    ).toThrow(TypeError)
    expect(d.query('SELECT * FROM t')).toEqual([])
  })

  test('booleans bind as 0 and 1; blobs and bigint round-trip', () => {
    const d = memory()
    d.exec('CREATE TABLE t (a INTEGER, b BLOB, c INTEGER)')
    d.run('INSERT INTO t VALUES (?, ?, ?)', [true, new Uint8Array([1, 2, 3]), 2n ** 40n])
    const row = d.query<{ a: number; b: Uint8Array; c: number | bigint }>('SELECT * FROM t')[0]
    expect(row?.a).toBe(1)
    expect([...(row?.b ?? [])]).toEqual([1, 2, 3])
    expect(Number(row?.c)).toBe(2 ** 40)
  })

  test('a borrowed handle with a low busy_timeout is raised with a warning', () => {
    const db = new Database(':memory:')
    opened.push(db)
    const warnings: string[] = []
    const d = bunSqlite(db, { onWarn: (m) => warnings.push(m) })
    expect(warnings).toHaveLength(1)
    expect(d.query<{ timeout: number }>('PRAGMA busy_timeout')[0]?.timeout).toBe(1000)
    bunSqlite(db, { onWarn: (m) => warnings.push(m) })
    expect(warnings).toHaveLength(1) // already high enough
  })
})

describe('schema', () => {
  test('migrate is idempotent and records the version', () => {
    const d = memory()
    migrate(d)
    migrate(d)
    const t = tables('eh_')
    expect(d.query<{ v: number }>(`SELECT MAX(version) AS v FROM ${t.schemaVersion}`)[0]?.v).toBe(
      SCHEMA_VERSION,
    )
    expect(d.query(`SELECT * FROM ${t.schemaVersion}`)).toHaveLength(1)
  })

  test('a database written by a newer version is refused, never downgraded', () => {
    const d = memory()
    migrate(d)
    d.run('INSERT INTO eh_schema_version (version, applied_at) VALUES (?, ?)', [
      SCHEMA_VERSION + 1,
      Date.now(),
    ])
    let caught: unknown
    try {
      migrate(d)
    } catch (e) {
      caught = e
    }
    expect(isSqliteSchemaError(caught)).toBe(true)
    expect((caught as { code: string }).code).toBe('EH_SQLITE_SCHEMA_NEWER')
  })

  test('a custom prefix names every table; an unsafe prefix is a programmer error', () => {
    const d = memory()
    migrate(d, { prefix: 'app1_' })
    const names = d.query<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
    expect(names.length).toBeGreaterThan(10)
    expect(
      names.filter((r) => !r.name.startsWith('app1_') && r.name !== 'sqlite_sequence'),
    ).toEqual([])
    expect(() => migrate(d, { prefix: 'a;b' })).toThrow(TypeError)
  })

  test('schemaSql returns DDL an app can run itself', () => {
    const d = memory()
    for (const step of schemaSql({ prefix: 'own_' })) d.exec(step.sql)
    expect(d.query("SELECT name FROM sqlite_master WHERE name = 'own_messages'")).toHaveLength(1)
    expect(schemaSql().map((s) => s.version)).toEqual([1])
  })
})

describe('behavior beyond the suites', () => {
  test('lock: an owner lets a restarted instance take over its own stale lease at once', async () => {
    const path = newPath()
    const first = createSqliteStorage(file(path), { lease: { ms: 60_000 } })
    const second = createSqliteStorage(file(path), { lease: { ms: 60_000 } })
    type Acquire = (
      id: string,
      o: { signal: AbortSignal; owner?: string },
    ) => Promise<() => Promise<void>>
    const acquire = (s: typeof first): Acquire => s.lock.acquire as Acquire
    const signal = new AbortController().signal
    await acquire(first)('s1', { signal, owner: 'instance-a' })
    // another instance without the owner is refused; the same owner is taken over
    let refused: unknown
    try {
      await acquire(second)('s1', { signal })
    } catch (e) {
      refused = e
    }
    expect(isHarnessError(refused, 'EH_SESSION_BUSY')).toBe(true)
    const release = await acquire(second)('s1', { signal, owner: 'instance-a' })
    await release()
  })

  test('inbox: a caller id keeps de-duplicating after the ack, within the window only', async () => {
    let now = 1_000_000
    const storage = createSqliteStorage(file(newPath()), {
      now: () => now,
      inbox: { dedupeWindowMs: 1000 },
    })
    const item = { kind: 'wake' as const, messageId: 'm', at: now, dedupeKey: 'k' }
    const first = await storage.inbox.enqueueOnce?.('s', item)
    const [claimed] = await storage.inbox.claim('s', 'o')
    await storage.inbox.ack([claimed?.id as string])
    expect((await storage.inbox.enqueueOnce?.('s', item))?.duplicate).toBe(true)
    now += 1001
    const again = await storage.inbox.enqueueOnce?.('s', item)
    expect(again?.duplicate).toBe(false)
    expect(again?.id).not.toBe(first?.id)
  })

  test('inbox: a subscriber on one connection is woken by an enqueue on another', async () => {
    const path = newPath()
    const a = createSqliteStorage(file(path), { pollMs: 20 })
    const b = createSqliteStorage(file(path), { pollMs: 20 })
    let woken = 0
    const off = a.inbox.subscribe?.('s', () => woken++)
    await b.inbox.enqueue('s', { kind: 'wake', messageId: 'm', at: Date.now() })
    await Bun.sleep(120)
    off?.()
    expect(woken).toBeGreaterThan(0)
  })

  test('stream log: a reader on one connection follows appends of another', async () => {
    const path = newPath()
    const a = createSqliteStorage(file(path), { pollMs: 20 })
    const b = createSqliteStorage(file(path), { pollMs: 20 })
    const key = { sessionId: 's', turnId: uuidv7() }
    let woken = 0
    const off = a.streams.subscribe?.(key, () => woken++)
    await b.streams.append(key, [{ type: 'start' }])
    await Bun.sleep(100)
    off?.()
    expect(woken).toBeGreaterThan(0)
    expect((await a.streams.read(key, 0)).chunks).toHaveLength(1)
  })

  test('activity: seq is unique across two connections on one file', async () => {
    const path = newPath()
    const a = createSqliteStorage(file(path))
    const b = createSqliteStorage(file(path))
    const records = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        (i % 2 === 0 ? a : b).activity.append({ type: 'x', payload: { i } }),
      ),
    )
    const seqs = records.flatMap((r) => r.map((x) => x.seq))
    expect(new Set(seqs).size).toBe(20)
  })

  test('profiles: with a vault the table holds only ciphertext and reads return the plain value', async () => {
    const d = memory()
    migrate(d)
    const vault = webCryptoVault(crypto.getRandomValues(new Uint8Array(32)))
    const storage = createSqliteStorage(d, { vault })
    const secret = `value-${crypto.randomUUID()}`
    await storage.profiles.put({
      id: 'p',
      kind: 'provider',
      definitionId: 'x',
      label: 'P',
      settings: { apiKey: secret },
      enabled: true,
      updatedAt: 1,
    })
    expect(JSON.stringify(d.query('SELECT settings FROM eh_profiles'))).not.toContain(secret)
    expect((await storage.profiles.get('provider', 'p'))?.settings).toEqual({ apiKey: secret })
  })

  test('people: the events of a deleted person survive in their own table', async () => {
    const storage = createSqliteStorage(file(newPath()))
    const p = await storage.people.create({ displayName: 'Ana' }, null, 1)
    await storage.people.delete(p.id, 'owner', 2)
    expect((await storage.people.events(p.id)).map((e) => e.kind)).toEqual(['delete', 'create'])
  })

  test('budget: a custom period function decides which row is charged', async () => {
    const storage = createSqliteStorage(file(newPath()))
    expect(storage.budget).toBeDefined()
    // limits inherit into a new period, spending does not
    let now = Date.UTC(2026, 0, 15)
    const d = file(newPath())
    const { setBudgetLimit, sqliteBudgetLedger } = await import('./budget.ts')
    const clock = (): number => now
    setBudgetLimit(d, 'a', 1, { now: clock })
    const ledger = sqliteBudgetLedger(d, { now: clock })
    await ledger.record({ scopes: ['a'], amountUsd: 1, key: 'k1' })
    expect((await ledger.check(['a'])).ok).toBe(false)
    now = Date.UTC(2026, 1, 2)
    const next = await ledger.check(['a'])
    expect(next.ok).toBe(true)
    expect(next.scopes[0]).toEqual({ scope: 'a', limitUsd: 1, spentUsd: 0, reservedUsd: 0 })
  })
})
