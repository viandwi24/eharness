/**
 * Tables use cases (docs/plans/P59-scripts-and-tables.md, ADR-0065): define tables, write and read
 * rows, query and aggregate with MongoDB-like filters, import from and export to the library.
 * Bad input is a `DomainError` with a sentence (the HTTP layer turns it into a 400/404/409; agent
 * tools turn it into an `ERROR:` line); caps from Settings refuse a write that would pass them.
 */
import { conflict, DomainError, invalid, notFound } from '../domain/errors.ts'
import {
  applyChange,
  checkRow,
  compileAggregate,
  compileFilter,
  compileSort,
  type DataTable,
  FilterError,
  LIMITS,
  pageSize,
  parseCursor,
  parseSchema,
  type RowDiff,
  SYSTEM_FIELDS,
  type TableRecord,
  type TableRowsChange,
  type TableSchema,
  tableNameProblem,
  UniqueViolation,
  uniqueColumns,
} from '../domain/tables.ts'
import {
  cellText,
  csvColumns,
  formatOfPath,
  type RowFormat,
  recordsFrom,
} from '../domain/tables-io.ts'
import { csvField } from './audit.ts'
import type { Deps } from './ports.ts'

/** Who changes a table: the web owner, an agent's name or a script's name (kept on the rows). */
export type TableActor = string

const MB = 1024 * 1024
const encoder = new TextEncoder()

/** A `FilterError` from the compiler as a 400 the caller can read. */
function compiled<T>(fn: () => T): T {
  try {
    return fn()
  } catch (error) {
    if (error instanceof FilterError) throw invalid(error.message, 'INVALID_QUERY')
    throw error
  }
}

export function listTables(deps: Deps): DataTable[] {
  return deps.tables.list()
}

export function getTable(deps: Deps, ref: string): DataTable {
  const t = deps.tables.get(ref)
  if (t === undefined) throw notFound('Table', ref)
  return t
}

/** The activity feed entry of a change, and the row hook scripts listen on. */
function tableChanged(
  deps: Deps,
  t: DataTable,
  change: string,
  by: TableActor,
  count?: number,
): void {
  deps.events.append({
    type: 'tables-changed',
    payload: {
      table: t.name,
      tableId: t.id,
      change,
      by,
      ...(count === undefined ? {} : { count }),
    },
  })
}
function rowsChanged(
  deps: Deps,
  t: DataTable,
  kind: TableRowsChange['kind'],
  rowIds: readonly string[],
  by: TableActor,
  changes?: readonly RowDiff[],
): void {
  if (rowIds.length === 0) return
  tableChanged(deps, t, kind, by, rowIds.length)
  const ids = new Set(rowIds)
  deps.onTableRows?.({
    tableId: t.id,
    table: t.name,
    kind,
    rowIds: [...rowIds],
    by,
    ...(changes === undefined ? {} : { changes: changes.filter((c) => ids.has(c.id)) }),
  })
}

/** A write that repeats a unique value, as a 409 the caller can read. */
function uniquely<T>(fn: () => T): T {
  try {
    return fn()
  } catch (error) {
    if (error instanceof UniqueViolation)
      throw conflict(error.message, 'DUPLICATE_KEY', {
        column: error.column,
        ...(error.existingId === undefined ? {} : { rowId: error.existingId }),
      })
    throw error
  }
}

function schemaOf(input: unknown): TableSchema {
  const parsed = parseSchema(input)
  if (!parsed.ok) throw invalid(parsed.errors.join('; '), 'INVALID_SCHEMA')
  return parsed.schema
}

function indexColumns(deps: Deps, schema: TableSchema): void {
  for (const c of schema.columns) if (c.indexed) deps.tables.ensureIndex(c.name)
}

export function createTable(
  deps: Deps,
  by: TableActor,
  input: { name: string; description?: string | undefined; schema?: unknown },
): DataTable {
  const problem = tableNameProblem(input.name)
  if (problem !== undefined) throw invalid(problem, 'INVALID_TABLE_NAME')
  if (deps.tables.get(input.name) !== undefined)
    throw conflict(`a table named "${input.name}" exists already`, 'TABLE_EXISTS')
  const schema = schemaOf(input.schema)
  indexColumns(deps, schema)
  const t = deps.tables.create({
    id: deps.ids.next(),
    name: input.name,
    description: (input.description ?? '').slice(0, 2000),
    schema,
    createdBy: by,
    now: deps.clock.now(),
  })
  tableChanged(deps, t, 'created', by)
  return t
}

/**
 * Rename, describe or change the schema. Existing rows are not rewritten: a new type or a new
 * required column applies to writes from now on (the answer says so through `note`).
 */
export function updateTable(
  deps: Deps,
  by: TableActor,
  ref: string,
  patch: { name?: string | undefined; description?: string | undefined; schema?: unknown },
): DataTable {
  const t = getTable(deps, ref)
  if (patch.name !== undefined && patch.name !== t.name) {
    const problem = tableNameProblem(patch.name)
    if (problem !== undefined) throw invalid(problem, 'INVALID_TABLE_NAME')
    if (deps.tables.get(patch.name) !== undefined)
      throw conflict(`a table named "${patch.name}" exists already`, 'TABLE_EXISTS')
  }
  const schema = patch.schema === undefined ? undefined : schemaOf(patch.schema)
  if (schema !== undefined) {
    // a column turns unique only when the stored rows already agree
    const was = new Set(uniqueColumns(t.schema))
    for (const column of uniqueColumns(schema)) {
      if (was.has(column)) continue
      const dup = deps.tables.duplicate(t.id, column)
      if (dup !== undefined)
        throw conflict(
          `"${column}" cannot be unique: ${dup.count} rows hold ${JSON.stringify(dup.value)}; fix them first`,
          'DUPLICATE_KEY',
          { column },
        )
    }
    indexColumns(deps, schema)
  }
  const next = deps.tables.update(
    t.id,
    {
      ...(patch.name === undefined ? {} : { name: patch.name }),
      ...(patch.description === undefined ? {} : { description: patch.description.slice(0, 2000) }),
      ...(schema === undefined ? {} : { schema }),
    },
    deps.clock.now(),
  ) as DataTable
  tableChanged(deps, next, 'altered', by)
  return next
}

export function dropTable(deps: Deps, by: TableActor, ref: string): DataTable {
  const t = getTable(deps, ref)
  deps.tables.drop(t.id)
  tableChanged(deps, t, 'dropped', by, t.rowCount)
  return t
}

// --- caps --------------------------------------------------------------------------------------

function checkCaps(deps: Deps, t: DataTable, addRows: number, addBytes: number): void {
  const s = deps.settings.get()
  if (t.rowCount + addRows > s.tableMaxRows)
    throw conflict(
      `table "${t.name}" holds ${t.rowCount} rows; adding ${addRows} passes the limit of ${s.tableMaxRows} (Settings > Limits)`,
      'TABLE_FULL',
    )
  const total = deps.tables.totals().bytes
  if (total + addBytes > s.tablesMaxMb * MB)
    throw conflict(
      `the tables hold ${(total / MB).toFixed(1)} MB; this write passes the limit of ${s.tablesMaxMb} MB (Settings > Limits)`,
      'TABLES_FULL',
    )
}

// --- rows --------------------------------------------------------------------------------------

/** Validates every row first; nothing is written when one is wrong. */
export function insertRows(
  deps: Deps,
  by: TableActor,
  ref: string,
  rows: readonly unknown[],
): { inserted: string[] } {
  const t = getTable(deps, ref)
  if (rows.length === 0) return { inserted: [] }
  if (rows.length > LIMITS.insertBatch)
    throw invalid(
      `insert at most ${LIMITS.insertBatch} rows at a time (or import a file)`,
      'TOO_MANY_ROWS',
    )
  const docs: Record<string, unknown>[] = []
  const errors: string[] = []
  rows.forEach((r, i) => {
    const c = checkRow(t.schema, r, 'insert')
    if (c.ok) docs.push(c.data)
    else errors.push(`row ${i + 1}: ${c.errors.join('; ')}`)
  })
  if (errors.length > 0) throw invalid(errors.slice(0, 20).join(' | '), 'INVALID_ROW')
  const bytes = docs.reduce((n, d) => n + encoder.encode(JSON.stringify(d)).length, 0)
  checkCaps(deps, t, docs.length, bytes)
  const writes = docs.map((data) => ({ id: deps.ids.next(), data }))
  uniquely(() => deps.tables.insert(t.id, writes, by, deps.clock.now(), uniqueColumns(t.schema)))
  const inserted = writes.map((w) => w.id)
  rowsChanged(
    deps,
    t,
    'row.created',
    inserted,
    by,
    writes.map((w) => ({ id: w.id, after: w.data })),
  )
  return { inserted }
}

/**
 * Insert or update by a key column (`key`: one column; a unique one keeps it to one row per value).
 * A row whose key is stored gets the given fields merged into it; the rest are inserted. One
 * transaction: two writers never insert the same key twice when the column is unique.
 */
export function upsertRows(
  deps: Deps,
  by: TableActor,
  ref: string,
  key: string,
  rows: readonly unknown[],
): { inserted: string[]; updated: string[] } {
  const t = getTable(deps, ref)
  if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key))
    throw invalid(`"${key}" is not a column name`, 'INVALID_QUERY')
  if (rows.length === 0) return { inserted: [], updated: [] }
  if (rows.length > LIMITS.insertBatch)
    throw invalid(`upsert at most ${LIMITS.insertBatch} rows at a time`, 'TOO_MANY_ROWS')
  const items = rows.map((raw, i) => {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
      throw invalid(`row ${i + 1}: a row must be an object of field: value`, 'INVALID_ROW')
    const rec = raw as Record<string, unknown>
    const k = rec[key]
    if (k === undefined || k === null)
      throw invalid(`row ${i + 1}: "${key}" (the key) is needed`, 'INVALID_ROW')
    return {
      key: k,
      build(cur: TableRecord | undefined): Record<string, unknown> {
        const c = checkRow(t.schema, cur === undefined ? rec : { ...cur.data, ...rec }, 'insert')
        if (!c.ok) throw invalid(`row ${i + 1}: ${c.errors.join('; ')}`, 'INVALID_ROW')
        return c.data
      },
    }
  })
  const bytes = rows.reduce<number>((n, d) => n + encoder.encode(JSON.stringify(d)).length, 0)
  checkCaps(deps, t, rows.length, bytes)
  const res = uniquely(() =>
    deps.tables.upsert(t.id, key, items, by, deps.clock.now(), uniqueColumns(t.schema), () =>
      deps.ids.next(),
    ),
  )
  const inserted = res.inserted.map((x) => x.id)
  const updated = res.updated.map((x) => x.id)
  rowsChanged(deps, t, 'row.created', inserted, by, res.inserted)
  rowsChanged(deps, t, 'row.updated', updated, by, res.updated)
  return { inserted, updated }
}

export function getRow(deps: Deps, ref: string, rowId: string): TableRecord {
  const t = getTable(deps, ref)
  const r = deps.tables.getRow(t.id, rowId)
  if (r === undefined) throw notFound(`Row of table ${t.name}`, rowId)
  return r
}

/** One row by id: `{ set, unset, inc }`, checked against the schema, compare-and-set on `ifVersion`. */
export function updateRow(
  deps: Deps,
  by: TableActor,
  ref: string,
  rowId: string,
  change: unknown,
  ifVersion?: number,
): TableRecord {
  const t = getTable(deps, ref)
  const cur = getRow(deps, ref, rowId)
  if (ifVersion !== undefined && ifVersion !== cur.version)
    throw conflict(
      `row ${rowId} is at version ${cur.version}, not ${ifVersion}: read it again`,
      'STALE_ROW',
      { version: cur.version },
    )
  const next = compiled(() => applyChange(cur.data, change))
  const checked = checkRow(t.schema, next, 'insert')
  if (!checked.ok) throw invalid(checked.errors.join('; '), 'INVALID_ROW')
  const grow =
    encoder.encode(JSON.stringify(checked.data)).length -
    encoder.encode(JSON.stringify(cur.data)).length
  if (grow > 0) checkCaps(deps, t, 0, grow)
  const res = uniquely(() =>
    deps.tables.replace(
      t.id,
      [{ id: rowId, data: checked.data, ifVersion: cur.version }],
      by,
      deps.clock.now(),
      uniqueColumns(t.schema),
    ),
  )
  if (res.conflicts.length > 0)
    throw conflict(`row ${rowId} changed meanwhile: read it again`, 'STALE_ROW')
  rowsChanged(deps, t, 'row.updated', [rowId], by, [
    { id: rowId, before: cur.data, after: checked.data },
  ])
  return getRow(deps, ref, rowId)
}

export function deleteRow(
  deps: Deps,
  by: TableActor,
  ref: string,
  rowId: string,
): { deleted: number } {
  const t = getTable(deps, ref)
  const before = deps.tables.getRow(t.id, rowId)
  const n = deps.tables.delete(t.id, [rowId])
  if (n === 0) throw notFound(`Row of table ${t.name}`, rowId)
  rowsChanged(
    deps,
    t,
    'row.deleted',
    [rowId],
    by,
    before === undefined ? undefined : [{ id: rowId, before: before.data }],
  )
  return { deleted: n }
}

export interface RowQuery {
  filter?: unknown
  sort?: unknown
  /** Top-level fields to return (default all). */
  fields?: readonly string[] | undefined
  limit?: number | undefined
  cursor?: string | undefined
}

const project = (r: TableRecord, fields: readonly string[] | undefined): TableRecord =>
  fields === undefined || fields.length === 0
    ? r
    : {
        ...r,
        data: Object.fromEntries(
          fields.filter((f) => Object.hasOwn(r.data, f)).map((f) => [f, r.data[f]]),
        ),
      }

/**
 * A page of rows. Without a sort the order is creation order and the cursor is the last row id
 * (stable while rows are added); with a sort the cursor is an offset.
 */
export function queryRows(
  deps: Deps,
  ref: string,
  q: RowQuery,
): { rows: TableRecord[]; next: string | null; total: number } {
  const t = getTable(deps, ref)
  const where = compiled(() => compileFilter(q.filter))
  const orderBy = compiled(() => compileSort(q.sort))
  const limit = pageSize(q.limit)
  const cursor = parseCursor(q.cursor)
  if (q.cursor !== undefined && cursor === undefined)
    throw invalid('that cursor is not valid', 'INVALID_CURSOR')
  const sorted = q.sort !== undefined && q.sort !== null
  const offset = cursor !== undefined && 'offset' in cursor ? cursor.offset : 0
  const afterId =
    !sorted && cursor !== undefined && 'afterId' in cursor ? cursor.afterId : undefined
  const rows = deps.tables.query(t.id, {
    where,
    orderBy,
    limit,
    ...(sorted ? { offset } : {}),
    ...(afterId === undefined ? {} : { afterId }),
  })
  const next =
    rows.length < limit
      ? null
      : sorted
        ? `o:${offset + rows.length}`
        : (rows.at(-1) as TableRecord).id
  return {
    rows: rows.map((r) => project(r, q.fields)),
    next,
    total: deps.tables.count(t.id, where),
  }
}

export function aggregateRows(
  deps: Deps,
  ref: string,
  spec: unknown,
): { groups: Array<Record<string, unknown>> } {
  const t = getTable(deps, ref)
  const agg = compiled(() => compileAggregate(spec))
  const raw = deps.tables.aggregate(t.id, agg)
  return {
    groups: raw.map((r) => {
      const out: Record<string, unknown> = {}
      agg.groupNames.forEach((g, i) => {
        out[g] = r[`g${i}`] ?? null
      })
      agg.metricNames.forEach((m, i) => {
        out[m] = r[`m${i}`] ?? null
      })
      return out
    }),
  }
}

/** Rows matching a filter (at most `LIMITS.bulkChange`), one change each, compare-and-set per row. */
export function updateRows(
  deps: Deps,
  by: TableActor,
  ref: string,
  filter: unknown,
  change: unknown,
): { matched: number; updated: number; conflicts: number } {
  const t = getTable(deps, ref)
  const where = compiled(() => compileFilter(filter))
  const matched = deps.tables.count(t.id, where)
  if (matched > LIMITS.bulkChange)
    throw invalid(
      `${matched} rows match; change at most ${LIMITS.bulkChange} at a time (narrow the filter)`,
      'TOO_MANY_ROWS',
    )
  const rows = deps.tables.query(t.id, { where, orderBy: 'id ASC', limit: LIMITS.bulkChange })
  const writes: Array<{ id: string; data: Record<string, unknown>; ifVersion: number }> = []
  const errors: string[] = []
  let grow = 0
  for (const r of rows) {
    const next = compiled(() => applyChange(r.data, change))
    const checked = checkRow(t.schema, next, 'insert')
    if (!checked.ok) {
      errors.push(`row ${r.id}: ${checked.errors.join('; ')}`)
      continue
    }
    grow +=
      encoder.encode(JSON.stringify(checked.data)).length -
      encoder.encode(JSON.stringify(r.data)).length
    writes.push({ id: r.id, data: checked.data, ifVersion: r.version })
  }
  if (errors.length > 0) throw invalid(errors.slice(0, 20).join(' | '), 'INVALID_ROW')
  if (grow > 0) checkCaps(deps, t, 0, grow)
  const res = uniquely(() =>
    deps.tables.replace(t.id, writes, by, deps.clock.now(), uniqueColumns(t.schema)),
  )
  const old = new Map(rows.map((x) => [x.id, x.data]))
  rowsChanged(
    deps,
    t,
    'row.updated',
    res.written,
    by,
    writes.map((w) => ({ id: w.id, before: old.get(w.id) ?? {}, after: w.data })),
  )
  return { matched, updated: res.written.length, conflicts: res.conflicts.length }
}

export function deleteRows(
  deps: Deps,
  by: TableActor,
  ref: string,
  filter: unknown,
): { deleted: number } {
  const t = getTable(deps, ref)
  if (
    filter === undefined ||
    filter === null ||
    (typeof filter === 'object' && Object.keys(filter).length === 0)
  )
    throw invalid(
      'give a filter; to remove every row, drop the table or use { "_id": { "$exists": true } }',
      'FILTER_REQUIRED',
    )
  const where = compiled(() => compileFilter(filter))
  const matched = deps.tables.count(t.id, where)
  if (matched > LIMITS.bulkChange)
    throw invalid(
      `${matched} rows match; delete at most ${LIMITS.bulkChange} at a time`,
      'TOO_MANY_ROWS',
    )
  const gone = deps.tables.query(t.id, { where, orderBy: 'id ASC', limit: LIMITS.bulkChange })
  const ids = gone.map((r) => r.id)
  const deleted = deps.tables.delete(t.id, ids)
  rowsChanged(
    deps,
    t,
    'row.deleted',
    ids,
    by,
    gone.map((r) => ({ id: r.id, before: r.data })),
  )
  return { deleted }
}

// --- import / export ---------------------------------------------------------------------------

function formatFor(path: string, format: RowFormat | undefined): RowFormat {
  const f = format ?? formatOfPath(path)
  if (f === undefined)
    throw invalid(
      `say the format (csv, json or ndjson): "${path}" has no known extension`,
      'INVALID_FORMAT',
    )
  return f
}

/**
 * Rows from a library file. With `upsertKey`, a row whose key matches an existing row replaces
 * that row's fields; otherwise every record is a new row. Bad records are skipped and reported.
 */
export async function importRows(
  deps: Deps,
  by: TableActor,
  ref: string,
  input: { path: string; format?: RowFormat | undefined; upsertKey?: string | undefined },
): Promise<{ inserted: number; updated: number; skipped: number; errors: string[] }> {
  const t = getTable(deps, ref)
  const file = await deps.library.read(input.path)
  if (file === undefined) throw notFound('Library file', input.path)
  if (file.text === null) throw invalid(`${input.path} is not a text file`, 'INVALID_FORMAT')
  const parsed = recordsFrom(file.text, formatFor(input.path, input.format), t.schema)
  if ('error' in parsed) throw invalid(parsed.error, 'INVALID_FORMAT')
  const key = input.upsertKey
  if (key !== undefined && !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key))
    throw invalid(`"${key}" is not a column name`, 'INVALID_QUERY')
  // existing keys, read once
  const existing = new Map<string, TableRecord>()
  if (key !== undefined) {
    let after: string | undefined
    for (;;) {
      const page = deps.tables.query(t.id, {
        where: { sql: '1', params: [] },
        orderBy: 'id ASC',
        limit: 1000,
        ...(after === undefined ? {} : { afterId: after }),
      })
      for (const r of page) {
        const k = r.data[key]
        if (k !== undefined && k !== null) existing.set(String(k), r)
      }
      if (page.length < 1000) break
      after = (page.at(-1) as TableRecord).id
    }
  }
  const errors: string[] = []
  const inserts: Record<string, unknown>[] = []
  const replaces: Array<{ id: string; data: Record<string, unknown>; ifVersion: number }> = []
  parsed.records.forEach((raw, i) => {
    // an exported file carries `_id` (and maybe other system fields): they are not row data
    const rec =
      typeof raw === 'object' && raw !== null && !Array.isArray(raw)
        ? Object.fromEntries(Object.entries(raw).filter(([f]) => !(f in SYSTEM_FIELDS)))
        : raw
    const k = key === undefined ? undefined : rec?.[key]
    const cur = k === undefined || k === null ? undefined : existing.get(String(k))
    const c = checkRow(t.schema, cur === undefined ? rec : { ...cur.data, ...rec }, 'insert')
    if (!c.ok) {
      if (errors.length < 20) errors.push(`record ${i + 1}: ${c.errors.join('; ')}`)
      return
    }
    if (cur !== undefined) replaces.push({ id: cur.id, data: c.data, ifVersion: cur.version })
    else inserts.push(c.data)
  })
  const bytes = inserts.reduce((n, d) => n + encoder.encode(JSON.stringify(d)).length, 0)
  checkCaps(deps, t, inserts.length, bytes)
  const now = deps.clock.now()
  const insertedIds: string[] = []
  const diffs: RowDiff[] = []
  const existingById = new Map([...existing.values()].map((r) => [r.id, r.data]))
  for (let i = 0; i < inserts.length; i += LIMITS.insertBatch) {
    const batch = inserts
      .slice(i, i + LIMITS.insertBatch)
      .map((data) => ({ id: deps.ids.next(), data }))
    uniquely(() => deps.tables.insert(t.id, batch, by, now, uniqueColumns(t.schema)))
    insertedIds.push(...batch.map((b) => b.id))
    for (const b of batch) diffs.push({ id: b.id, after: b.data })
  }
  const res =
    replaces.length > 0
      ? uniquely(() => deps.tables.replace(t.id, replaces, by, now, uniqueColumns(t.schema)))
      : { written: [] }
  for (const x of replaces)
    diffs.push({ id: x.id, before: existingById.get(x.id) ?? {}, after: x.data })
  rowsChanged(deps, t, 'row.created', insertedIds, by, diffs)
  rowsChanged(deps, t, 'row.updated', res.written, by, diffs)
  const skipped = parsed.records.length - inserts.length - replaces.length
  return { inserted: inserts.length, updated: res.written.length, skipped, errors }
}

/** Rows (optionally filtered and sorted) written to a library file as CSV, JSON or NDJSON. */
export async function exportRows(
  deps: Deps,
  ref: string,
  input: { path: string; format?: RowFormat | undefined; filter?: unknown; sort?: unknown },
): Promise<{ path: string; rows: number }> {
  const t = getTable(deps, ref)
  const format = formatFor(input.path, input.format)
  const where = compiled(() => compileFilter(input.filter))
  const orderBy = compiled(() => compileSort(input.sort))
  const max = deps.settings.get().tableMaxRows
  const rows: TableRecord[] = []
  for (let offset = 0; rows.length < max; offset += 1000) {
    const page = deps.tables.query(t.id, { where, orderBy, limit: 1000, offset })
    rows.push(...page)
    if (page.length < 1000) break
  }
  let text: string
  if (format === 'csv') {
    const cols = csvColumns(
      t.schema,
      rows.slice(0, 1000).map((r) => r.data),
    )
    const lines = [cols.map((c) => csvField(c)).join(',')]
    for (const r of rows)
      lines.push(cols.map((c) => csvField(c === '_id' ? r.id : cellText(r.data[c]))).join(','))
    text = `${lines.join('\n')}\n`
  } else if (format === 'json') {
    text = JSON.stringify(
      rows.map((r) => ({ _id: r.id, ...r.data })),
      null,
      2,
    )
  } else {
    text = `${rows.map((r) => JSON.stringify({ _id: r.id, ...r.data })).join('\n')}\n`
  }
  try {
    await deps.library.writeText(input.path, text)
  } catch (error) {
    if (error instanceof DomainError) throw error
    throw invalid(
      `could not write ${input.path}: ${error instanceof Error ? error.message : String(error)}`,
      'EXPORT_FAILED',
    )
  }
  return { path: input.path, rows: rows.length }
}
