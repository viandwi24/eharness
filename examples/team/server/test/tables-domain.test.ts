/**
 * Tables (ADR-0065), the pure parts and the store: schema and row validation, the filter / sort /
 * aggregate compiler run against a real SQLite (every operator, injection attempts), the counters,
 * compare-and-set replaces, and the CSV parser.
 */
import { describe, expect, test } from 'bun:test'
import {
  applyChange,
  checkRow,
  compileAggregate,
  compileFilter,
  compileSort,
  FilterError,
  fieldSql,
  parseSchema,
  type TableSchema,
  tableNameProblem,
} from '../src/domain/tables.ts'
import { csvColumns, parseCsv, recordsFrom } from '../src/domain/tables-io.ts'
import { openDatabase } from '../src/infra/db/client.ts'
import { sqliteTableStore } from '../src/infra/db/tables-repo.ts'

function storeWith(docs: Array<Record<string, unknown>>) {
  const conn = openDatabase(':memory:')
  const store = sqliteTableStore(conn.sqlite)
  const t = store.create({
    id: 't1',
    name: 'items',
    description: '',
    schema: { columns: [] },
    createdBy: 'test',
    now: 1,
  })
  store.insert(
    t.id,
    docs.map((data, i) => ({ id: `0000000${i}`.slice(-8), data })),
    'test',
    2,
  )
  const ids = (filter: unknown, sort?: unknown): string[] =>
    store
      .query(t.id, { where: compileFilter(filter), orderBy: compileSort(sort), limit: 100 })
      .map((r) => String(r.data.name))
  return { conn, store, t, ids }
}

const DOCS = [
  { name: 'a', price: 10, city: 'Jakarta', tags: ['x', 'y'], active: true, meta: { level: 1 } },
  { name: 'b', price: 25, city: 'Bandung', tags: ['y'], active: false, meta: { level: 2 } },
  { name: 'c', price: 5, city: 'jakarta selatan', tags: [], active: true },
  { name: 'd', city: null, active: true },
]

describe('names, schemas and rows', () => {
  test('table names and field paths are strict', () => {
    expect(tableNameProblem('members')).toBeUndefined()
    expect(tableNameProblem('Members')).toContain('not a table name')
    expect(tableNameProblem('a-b')).toContain('not a table name')
    expect(fieldSql('customer.city')).toEqual({ sql: "json_extract(data, '$.customer.city')" })
    expect(fieldSql('_id')).toEqual({ sql: 'id' })
    for (const bad of ["x') OR 1=1 --", 'a"b', 'a.b.c.d.e.f', '1abc', 'a b', ''])
      expect('error' in fieldSql(bad)).toBe(true)
  })

  test('a schema validates types, names and defaults', () => {
    const ok = parseSchema({
      columns: [
        { name: 'email', type: 'string', required: true, indexed: true },
        { name: 'score', type: 'number', default: 0 },
        { name: 'joined', type: 'date' },
      ],
      strict: true,
    })
    expect(ok.ok).toBe(true)
    const bad = parseSchema({
      columns: [
        { name: 'x y', type: 'string' },
        { name: 'n', type: 'money' },
        { name: 'd', type: 'number', default: 'zero' },
      ],
    })
    expect(bad.ok).toBe(false)
    if (!bad.ok)
      expect(bad.errors.join(' ')).toMatch(
        /not a column name.*type must be one of.*default must be a number/,
      )
  })

  test('rows: defaults, required, types, dates, strict, reserved fields, size', () => {
    const schema = (
      parseSchema({
        columns: [
          { name: 'email', type: 'string', required: true },
          { name: 'score', type: 'number', default: 0 },
          { name: 'joined', type: 'date' },
        ],
        strict: true,
      }) as { schema: TableSchema }
    ).schema
    const good = checkRow(schema, { email: 'a@b.c', joined: '2026-10-26' }, 'insert')
    expect(good).toEqual({
      ok: true,
      data: { email: 'a@b.c', score: 0, joined: '2026-10-26T00:00:00.000Z' },
    })
    const bad = checkRow(schema, { score: 'x', extra: 1, _id: 'no' }, 'insert')
    expect(bad.ok).toBe(false)
    if (!bad.ok) {
      const text = bad.errors.join(' | ')
      expect(text).toContain('"email" is required')
      expect(text).toContain('"score" must be a number')
      expect(text).toContain('"extra" is not a column')
      expect(text).toContain('reserved')
    }
    expect(checkRow(schema, { score: 3 }, 'patch').ok).toBe(true)
    const big = checkRow({ columns: [] }, { blob: 'x'.repeat(300 * 1024) }, 'insert')
    expect(big.ok).toBe(false)
  })

  test('changes: set, unset, inc', () => {
    expect(
      applyChange({ a: 1, b: 2 }, { set: { c: 3 }, unset: ['b'], inc: { a: 5, n: 1 } }),
    ).toEqual({ a: 6, c: 3, n: 1 })
    expect(() => applyChange({ a: 'x' }, { inc: { a: 1 } })).toThrow(FilterError)
    expect(() => applyChange({}, {})).toThrow('set, unset or inc')
  })
})

describe('the filter compiler on SQLite', () => {
  test('equality, comparisons, null, booleans and nested fields', () => {
    const { ids } = storeWith(DOCS)
    expect(ids({ city: 'Jakarta' })).toEqual(['a'])
    expect(ids({ price: { $gt: 5 } })).toEqual(['a', 'b'])
    expect(ids({ price: { $gte: 5, $lt: 25 } })).toEqual(['a', 'c'])
    expect(ids({ city: null })).toEqual(['d'])
    expect(ids({ city: { $ne: null } })).toEqual(['a', 'b', 'c'])
    expect(ids({ price: { $ne: 10 } })).toEqual(['b', 'c', 'd'])
    expect(ids({ active: false })).toEqual(['b'])
    expect(ids({ 'meta.level': 2 })).toEqual(['b'])
  })

  test('$in, $nin, $contains, $startsWith, $exists, $has', () => {
    const { ids } = storeWith(DOCS)
    expect(ids({ name: { $in: ['a', 'c'] } })).toEqual(['a', 'c'])
    expect(ids({ name: { $nin: ['a', 'c'] } })).toEqual(['b', 'd'])
    expect(ids({ name: { $in: [] } })).toEqual([])
    expect(ids({ city: { $contains: 'JAKARTA' } })).toEqual(['a', 'c'])
    expect(ids({ city: { $startsWith: 'Ban' } })).toEqual(['b'])
    expect(ids({ price: { $exists: false } })).toEqual(['d'])
    expect(ids({ meta: { $exists: true } })).toEqual(['a', 'b'])
    expect(ids({ tags: { $has: 'y' } })).toEqual(['a', 'b'])
  })

  test('$and, $or, $not and sort', () => {
    const { ids } = storeWith(DOCS)
    expect(ids({ $or: [{ city: 'Bandung' }, { price: { $lt: 6 } }] })).toEqual(['b', 'c'])
    expect(ids({ $and: [{ active: true }, { price: { $exists: true } }] })).toEqual(['a', 'c'])
    expect(ids({ $not: { active: true } })).toEqual(['b'])
    expect(ids({ price: { $exists: true } }, { price: -1 })).toEqual(['b', 'a', 'c'])
    expect(ids({}, [{ field: 'name', dir: 'desc' }])).toEqual(['d', 'c', 'b', 'a'])
  })

  test('bad filters are readable errors, and values never become SQL', () => {
    const { ids, store, t } = storeWith(DOCS)
    expect(() => compileFilter({ "x') OR 1=1 --": 1 })).toThrow('is not a field')
    expect(() => compileFilter({ price: { $regex: '.*' } })).toThrow('unknown operator $regex')
    expect(() => compileFilter({ $where: 'true' })).toThrow('unknown operator')
    expect(() => compileFilter({ price: { $gt: { a: 1 } } })).toThrow('compare with')
    expect(() => compileFilter({ name: ['a'] })).toThrow('$in')
    // a value that looks like SQL is only a value
    expect(ids({ name: "a' OR '1'='1" })).toEqual([])
    expect(ids({ city: { $contains: "%' OR 1=1 --" } })).toEqual([])
    // the table is intact
    expect(store.count(t.id, compileFilter({}))).toBe(4)
  })

  test('aggregates with groups, metrics and sort', () => {
    const { store, t } = storeWith([
      { city: 'A', amount: 10 },
      { city: 'A', amount: 5 },
      { city: 'B', amount: 7 },
    ])
    const agg = compileAggregate({
      groupBy: ['city'],
      metrics: {
        n: { op: 'count' },
        total: { op: 'sum', field: 'amount' },
        top: { op: 'max', field: 'amount' },
      },
      sort: { by: 'total', dir: 'desc' },
    })
    expect(store.aggregate(t.id, agg)).toEqual([
      { g0: 'A', m0: 2, m1: 15, m2: 10 },
      { g0: 'B', m0: 1, m1: 7, m2: 7 },
    ])
    expect(() => compileAggregate({ metrics: { x: { op: 'median', field: 'a' } } })).toThrow(
      'op is count',
    )
  })
})

describe('the store', () => {
  test('counters follow inserts, replaces and deletes; replace is compare-and-set', () => {
    const { store, t } = storeWith([{ n: 1 }, { n: 2 }])
    const after = store.get('items')
    expect(after?.rowCount).toBe(2)
    expect(after?.bytes).toBe(JSON.stringify({ n: 1 }).length * 2)
    const res = store.replace(
      t.id,
      [
        { id: '00000000', data: { n: 100 }, ifVersion: 1 },
        { id: '00000001', data: { n: 3 }, ifVersion: 9 },
      ],
      'x',
      3,
    )
    expect(res).toEqual({ written: ['00000000'], conflicts: ['00000001'] })
    expect(store.getRow(t.id, '00000000')).toMatchObject({
      data: { n: 100 },
      version: 2,
      updatedBy: 'x',
    })
    expect(store.get('items')?.bytes).toBe(
      JSON.stringify({ n: 100 }).length + JSON.stringify({ n: 2 }).length,
    )
    expect(store.delete(t.id, ['00000000', 'missing'])).toBe(1)
    expect(store.get('items')).toMatchObject({
      rowCount: 1,
      bytes: JSON.stringify({ n: 2 }).length,
    })
    expect(store.totals()).toEqual({ rows: 1, bytes: JSON.stringify({ n: 2 }).length })
  })

  test('an indexed column gets an expression index the queries use', () => {
    const { conn, store, t } = storeWith([{ email: 'a@b.c' }])
    store.ensureIndex('email')
    const plan = conn.sqlite
      .query<{ detail: string }, [string, string]>(
        `EXPLAIN QUERY PLAN SELECT id FROM data_rows WHERE table_id = ? AND (${compileFilter({ email: 'x' }).sql})`,
      )
      .all(t.id, 'x')
      .map((r) => r.detail)
      .join(' ')
    expect(plan).toContain('data_rows_x_email')
  })

  test('dropping a table removes its rows', () => {
    const { conn, store, t } = storeWith([{ n: 1 }])
    expect(store.drop(t.id)).toBe(true)
    expect(
      conn.sqlite.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM data_rows').get()?.n,
    ).toBe(0)
  })
})

describe('import formats', () => {
  test('CSV: quotes, doubled quotes, newlines in a field, BOM, CRLF', () => {
    const text = '﻿name,note\r\n"Ana, A.","said ""hi""\nthen left"\r\nBudi,\r\n'
    expect(parseCsv(text)).toEqual([
      ['name', 'note'],
      ['Ana, A.', 'said "hi"\nthen left'],
      ['Budi', ''],
    ])
  })

  test('CSV cells take the column types; empty cells are left out', () => {
    const schema: TableSchema = {
      columns: [
        { name: 'n', type: 'number' },
        { name: 'ok', type: 'boolean' },
      ],
    }
    expect(recordsFrom('n,ok,city\n1.5,yes,Jakarta\n,no,\n', 'csv', schema)).toEqual({
      records: [{ n: 1.5, ok: true, city: 'Jakarta' }, { ok: false }],
    })
    expect(recordsFrom('{"a":1}\n\n{"a":2}\n', 'ndjson', schema)).toEqual({
      records: [{ a: 1 }, { a: 2 }],
    })
    expect(recordsFrom('{"a":1}', 'json', schema)).toEqual({
      error: 'a JSON import is an array of objects',
    })
    expect(csvColumns(schema, [{ city: 'x', n: 1 }])).toEqual(['_id', 'n', 'ok', 'city'])
  })
})

test('a CSV import undoes the formula guard of the export', () => {
  const r = recordsFrom("phone,name\n'+6281,'=x\n", 'csv', { columns: [] })
  expect(r).toEqual({ records: [{ phone: '+6281', name: '=x' }] })
})
