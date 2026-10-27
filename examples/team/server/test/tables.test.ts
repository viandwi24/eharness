/**
 * Tables (ADR-0065, P59 W1) through the HTTP API of the composed server: define, write, query,
 * page, aggregate, change by filter, compare-and-set, the caps of Settings, import from and export
 * to the library, and an upgrade from the database before the tables existed.
 */
import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'
import { scriptedModel } from 'eharness/testing'
import { openDatabase } from '../src/infra/db/client.ts'
import { compose, type Server } from '../src/main.ts'

// biome-ignore lint/suspicious/noExplicitAny: loosely typed JSON of the API under test
type Json = Record<string, any>

const servers: Server[] = []
const dirs: string[] = []
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function instance(dbFile = ':memory:') {
  const server = compose({
    dbFile,
    seed: false,
    env: {},
    models: {
      provider: 'scripted',
      defaultModel: 'none',
      resolve: () => scriptedModel([]) as never,
    },
    tuning: { streams: { flushMs: 5, pollMs: 20 }, inbox: { pollMs: 30 }, abortPollMs: 40 },
    eventsPollMs: 30,
    reconcile: { onBoot: false, everyMs: 0 },
    routines: { tickMs: 0 },
    turnRetry: { tickMs: 0, retryUnknown: false },
  })
  servers.push(server)
  const api = async (
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; json: Json }> => {
    const res = await server.app.request(path, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const text = await res.text()
    return { status: res.status, json: (text ? JSON.parse(text) : undefined) as Json }
  }
  return { server, api }
}

const MEMBERS = {
  name: 'members',
  description: 'Community members',
  schema: {
    columns: [
      { name: 'name', type: 'string', required: true },
      { name: 'city', type: 'string', indexed: true },
      { name: 'points', type: 'number', default: 0 },
      { name: 'joined', type: 'date' },
    ],
  },
}

describe('tables over HTTP', () => {
  test('define, insert, read, query with filters, page, aggregate', async () => {
    const { api } = instance()
    const created = await api('POST', '/tables', MEMBERS)
    expect(created.status).toBe(201)
    expect(created.json).toMatchObject({ name: 'members', rowCount: 0, createdBy: 'web owner' })
    expect((await api('POST', '/tables', MEMBERS)).json.error.code).toBe('TABLE_EXISTS')

    const rows = Array.from({ length: 25 }, (_, i) => ({
      name: `m${String(i).padStart(2, '0')}`,
      city: i % 3 === 0 ? 'Jakarta' : 'Bandung',
      points: i,
      joined: `2026-10-${String(1 + (i % 28)).padStart(2, '0')}`,
    }))
    const ins = await api('POST', '/tables/members/rows', { rows })
    expect(ins.status).toBe(201)
    expect(ins.json.inserted).toHaveLength(25)

    const one = await api('GET', `/tables/members/rows/${ins.json.inserted[0]}`)
    expect(one.json).toMatchObject({
      data: { name: 'm00', points: 0, joined: '2026-10-01T00:00:00.000Z' },
      version: 1,
    })

    const q = await api('POST', '/tables/members/query', {
      filter: { city: 'Jakarta', points: { $gte: 6 } },
      sort: { points: -1 },
      fields: ['name', 'points'],
      limit: 2,
    })
    expect(q.json.total).toBe(7)
    expect(q.json.rows.map((r: Json) => r.data)).toEqual([
      { name: 'm24', points: 24 },
      { name: 'm21', points: 21 },
    ])
    expect(q.json.next).toBe('o:2')
    const q2 = await api('POST', '/tables/members/query', {
      filter: { city: 'Jakarta', points: { $gte: 6 } },
      sort: { points: -1 },
      limit: 2,
      cursor: q.json.next,
    })
    expect(q2.json.rows.map((r: Json) => r.data.name)).toEqual(['m18', 'm15'])

    // creation-order paging with the id cursor sees every row exactly once
    const seen: string[] = []
    let cursor: string | undefined
    for (;;) {
      const page = await api('POST', '/tables/members/query', {
        limit: 10,
        ...(cursor ? { cursor } : {}),
      })
      seen.push(...page.json.rows.map((r: Json) => r.data.name))
      if (page.json.next === null) break
      cursor = page.json.next
    }
    expect(seen).toEqual(rows.map((r) => r.name))

    const agg = await api('POST', '/tables/members/aggregate', {
      groupBy: ['city'],
      metrics: { members: { op: 'count' }, points: { op: 'sum', field: 'points' } },
      sort: { by: 'members', dir: 'desc' },
    })
    expect(agg.json.groups).toEqual([
      { city: 'Bandung', members: 16, points: 300 - 108 },
      { city: 'Jakarta', members: 9, points: 108 },
    ])

    const bad = await api('POST', '/tables/members/query', { filter: { "x') OR 1=1": 1 } })
    expect(bad.status).toBe(400)
    expect(bad.json.error.code).toBe('INVALID_QUERY')
    expect((await api('GET', '/tables/nope')).status).toBe(404)
  })

  test('rows are validated; a change is compare-and-set; bulk change and delete by filter', async () => {
    const { api } = instance()
    await api('POST', '/tables', MEMBERS)
    const wrong = await api('POST', '/tables/members/rows', {
      rows: [{ city: 'X' }, { name: 'ok', points: 'many' }],
    })
    expect(wrong.status).toBe(400)
    expect(wrong.json.error.message).toMatch(
      /row 1: "name" is required.*row 2: "points" must be a number/,
    )
    expect((await api('GET', '/tables/members')).json.rowCount).toBe(0)

    const ins = await api('POST', '/tables/members/rows', {
      rows: [
        { name: 'a', city: 'Jakarta' },
        { name: 'b', city: 'Jakarta' },
        { name: 'c', city: 'Bandung' },
      ],
    })
    const [a] = ins.json.inserted
    const changed = await api('PATCH', `/tables/members/rows/${a}`, {
      change: { inc: { points: 5 }, set: { vip: true } },
      ifVersion: 1,
    })
    expect(changed.json).toMatchObject({ data: { name: 'a', points: 5, vip: true }, version: 2 })
    const stale = await api('PATCH', `/tables/members/rows/${a}`, {
      change: { set: { vip: false } },
      ifVersion: 1,
    })
    expect(stale.status).toBe(409)
    expect(stale.json.error.code).toBe('STALE_ROW')

    const bulk = await api('POST', '/tables/members/update', {
      filter: { city: 'Jakarta' },
      change: { inc: { points: 1 } },
    })
    expect(bulk.json).toEqual({ matched: 2, updated: 2, conflicts: 0 })
    const all = await api('POST', '/tables/members/query', { sort: { name: 1 } })
    expect(all.json.rows.map((r: Json) => [r.data.name, r.data.points])).toEqual([
      ['a', 6],
      ['b', 1],
      ['c', 0],
    ])
    expect((await api('POST', '/tables/members/delete', { filter: {} })).json.error.code).toBe(
      'FILTER_REQUIRED',
    )
    expect(
      (await api('POST', '/tables/members/delete', { filter: { city: 'Jakarta' } })).json,
    ).toEqual({ deleted: 2 })
    expect((await api('GET', '/tables/members')).json.rowCount).toBe(1)
    expect((await api('DELETE', '/tables/members')).status).toBe(200)
    expect((await api('GET', '/tables')).json.tables).toEqual([])
  })

  test('the caps of Settings refuse writes that pass them', async () => {
    const { api } = instance()
    await api('POST', '/tables', { name: 'small' })
    await api('PATCH', '/settings', { tableMaxRows: 100 })
    const rows = Array.from({ length: 100 }, (_, i) => ({ i }))
    expect((await api('POST', '/tables/small/rows', { rows })).status).toBe(201)
    const over = await api('POST', '/tables/small/rows', { rows: [{ i: 101 }] })
    expect(over.status).toBe(409)
    expect(over.json.error).toMatchObject({ code: 'TABLE_FULL' })
    expect(over.json.error.message).toContain('Settings > Limits')

    await api('PATCH', '/settings', { tableMaxRows: 1000, tablesMaxMb: 1 })
    await api('POST', '/tables', { name: 'blobs' })
    const blob = 'x'.repeat(250 * 1024)
    const fits = await api('POST', '/tables/blobs/rows', {
      rows: [{ blob }, { blob }, { blob }, { blob }],
    })
    expect(fits.status).toBe(201)
    const full = await api('POST', '/tables/blobs/rows', { rows: [{ blob }] })
    expect(full.json.error.code).toBe('TABLES_FULL')
  })

  test('import from a library file (with upsert) and export back', async () => {
    const { server, api } = instance()
    await api('POST', '/tables', MEMBERS)
    const lines = [
      'name,city,points',
      ...Array.from({ length: 5000 }, (_, i) => `m${i},${i % 2 ? 'Jakarta' : 'Bandung'},${i}`),
    ]
    await server.deps.library.writeText('/library/data/members.csv', `${lines.join('\n')}\n`)
    const started = Date.now()
    const imported = await api('POST', '/tables/members/import', {
      path: '/library/data/members.csv',
    })
    expect(imported.json).toEqual({ inserted: 5000, updated: 0, skipped: 0, errors: [] })
    expect(Date.now() - started).toBeLessThan(10_000)

    // an update file: one existing key, one new row, one bad row
    await server.deps.library.writeText(
      '/library/data/update.json',
      JSON.stringify([
        { name: 'm1', points: 999 },
        { name: 'new', city: 'Bogor' },
        { city: 'no name' },
      ]),
    )
    const upsert = await api('POST', '/tables/members/import', {
      path: '/library/data/update.json',
      upsertKey: 'name',
    })
    expect(upsert.json).toMatchObject({ inserted: 1, updated: 1, skipped: 1 })
    expect(upsert.json.errors[0]).toContain('"name" is required')
    const m1 = await api('POST', '/tables/members/query', { filter: { name: 'm1' } })
    expect(m1.json.rows[0].data).toMatchObject({ name: 'm1', city: 'Jakarta', points: 999 })

    const exp = await api('POST', '/tables/members/export', {
      path: '/library/reports/jakarta.csv',
      filter: { city: 'Jakarta', points: { $lt: 10 } },
      sort: { points: 1 },
    })
    // odd i is Jakarta: m3, m5, m7, m9 (m1 now has 999 points)
    expect(exp.json).toEqual({ path: '/library/reports/jakarta.csv', rows: 4 })
    const file = await server.deps.library.read('/library/reports/jakarta.csv')
    const csv = (file?.text ?? '').trim().split('\n')
    expect(csv[0]).toBe('_id,name,city,points,joined')
    expect(csv.slice(1).map((l) => l.split(',').slice(1, 4).join(','))).toEqual([
      'm3,Jakarta,3',
      'm5,Jakarta,5',
      'm7,Jakarta,7',
      'm9,Jakarta,9',
    ])
    // the exported file imports back into another table (the _id column is ignored)
    await api('POST', '/tables', { name: 'copy' })
    const back = await api('POST', '/tables/copy/import', { path: '/library/reports/jakarta.csv' })
    expect(back.json).toMatchObject({ inserted: 4, errors: [] })
  })
})

describe('unique keys and upsert', () => {
  test('a unique column refuses repeats (in one write and against stored rows); upsert inserts or merges', async () => {
    const { api } = instance()
    await api('POST', '/tables', {
      name: 'signals',
      schema: {
        columns: [
          { name: 'ref', type: 'string', unique: true },
          { name: 'pair', type: 'string' },
          { name: 'status', type: 'string', default: 'open' },
        ],
      },
    })
    const ins = await api('POST', '/tables/signals/rows', { rows: [{ ref: 'S1', pair: 'BTC' }] })
    expect(ins.status).toBe(201)
    const dup = await api('POST', '/tables/signals/rows', { rows: [{ ref: 'S1', pair: 'ETH' }] })
    expect(dup.status).toBe(409)
    expect(dup.json.error.code).toBe('DUPLICATE_KEY')
    expect(dup.json.error.message).toContain('"ref" must be unique')
    const twice = await api('POST', '/tables/signals/rows', {
      rows: [
        { ref: 'S2', pair: 'SOL' },
        { ref: 'S2', pair: 'XRP' },
      ],
    })
    expect(twice.status).toBe(409)
    // nothing of a refused write is kept
    expect((await api('GET', '/tables/signals')).json.rowCount).toBe(1)
    // an update to a taken value is refused too
    await api('POST', '/tables/signals/rows', { rows: [{ ref: 'S3', pair: 'ADA' }] })
    const s3 = (await api('POST', '/tables/signals/query', { filter: { ref: 'S3' } })).json.rows[0]
    const clash = await api('PATCH', `/tables/signals/rows/${s3.id}`, {
      change: { set: { ref: 'S1' } },
    })
    expect(clash.status).toBe(409)

    const up = await api('POST', '/tables/signals/upsert', {
      key: 'ref',
      rows: [
        { ref: 'S1', status: 'tp1' },
        { ref: 'S9', pair: 'DOGE' },
      ],
    })
    expect(up.status).toBe(200)
    expect(up.json.inserted).toHaveLength(1)
    expect(up.json.updated).toHaveLength(1)
    const s1 = (await api('POST', '/tables/signals/query', { filter: { ref: 'S1' } })).json.rows[0]
    expect(s1.data).toEqual({ ref: 'S1', pair: 'BTC', status: 'tp1' })
    expect(s1.version).toBe(2)
    const s9 = (await api('POST', '/tables/signals/query', { filter: { ref: 'S9' } })).json.rows[0]
    expect(s9.data).toEqual({ ref: 'S9', pair: 'DOGE', status: 'open' })
    const missing = await api('POST', '/tables/signals/upsert', {
      key: 'ref',
      rows: [{ pair: 'X' }],
    })
    expect(missing.status).toBe(400)
  })

  test('a column becomes unique only when the stored rows agree; unique needs text, number or date', async () => {
    const { api } = instance()
    await api('POST', '/tables', {
      name: 'm',
      schema: { columns: [{ name: 'email', type: 'string' }] },
    })
    await api('POST', '/tables/m/rows', { rows: [{ email: 'a@x' }, { email: 'a@x' }, {}] })
    const r = await api('PATCH', '/tables/m', {
      schema: { columns: [{ name: 'email', type: 'string', unique: true }] },
    })
    expect(r.status).toBe(409)
    expect(r.json.error.message).toContain('2 rows hold "a@x"')
    const bad = await api('POST', '/tables', {
      name: 'n',
      schema: { columns: [{ name: 'tags', type: 'json', unique: true }] },
    })
    expect(bad.status).toBe(400)
  })
})

describe('upgrading an older database', () => {
  test('a database at migration 0046 keeps every row and gains the tables', async () => {
    const DRIZZLE = new URL('../drizzle', import.meta.url).pathname
    const journal = JSON.parse(readFileSync(join(DRIZZLE, 'meta/_journal.json'), 'utf8')) as {
      entries: Array<{ idx: number; tag: string }>
      [k: string]: unknown
    }
    expect(journal.entries.some((e) => e.tag === '0047_data_tables')).toBe(true)
    const before = journal.entries.filter((e) => e.idx <= 46)
    const tmp = mkdtempSync(join(tmpdir(), 'team-oldmig-'))
    dirs.push(tmp)
    mkdirSync(join(tmp, 'meta'))
    for (const e of before) cpSync(join(DRIZZLE, `${e.tag}.sql`), join(tmp, `${e.tag}.sql`))
    writeFileSync(join(tmp, 'meta/_journal.json'), JSON.stringify({ ...journal, entries: before }))
    const dir = mkdtempSync(join(tmpdir(), 'team-upgrade-'))
    dirs.push(dir)
    const file = join(dir, 'team.db')
    const old = new Database(file, { create: true, strict: true })
    old.run('PRAGMA journal_mode = WAL')
    migrate(drizzle({ client: old }), { migrationsFolder: tmp })
    old
      .query("INSERT INTO settings (key, value, updated_at) VALUES ('workspace', ?, 1)")
      .run(JSON.stringify({ teamName: 'Keep me' }))
    old
      .query('INSERT INTO events (type, payload, created_at) VALUES (?, ?, ?)')
      .run('settings-changed', '{"keys":["teamName"]}', 1)
    const tables = (db: Database): string[] =>
      db
        .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((t) => t.name)
    expect(tables(old)).not.toContain('data_rows')
    const count = (db: Database, t: string) =>
      db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${t}`).get()?.n
    const was = { settings: count(old, 'settings'), events: count(old, 'events') }
    old.close()

    const conn = openDatabase(file)
    expect({
      settings: count(conn.sqlite, 'settings'),
      events: count(conn.sqlite, 'events'),
    }).toEqual(was)
    expect(tables(conn.sqlite)).toEqual(expect.arrayContaining(['data_tables', 'data_rows']))
    conn.close()

    const { server, api } = instance(file)
    expect(server.deps.settings.get().teamName).toBe('Keep me')
    expect((await api('POST', '/tables', MEMBERS)).status).toBe(201)
    expect((await api('POST', '/tables/members/rows', { rows: [{ name: 'a' }] })).status).toBe(201)
  })
})
