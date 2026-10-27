/**
 * Tables (docs/plans/P59-scripts-and-tables.md, ADR-0065): document tables with an optional schema
 * and MongoDB-like queries. Pure: validation of names, schemas and rows, and the compiler that turns
 * a filter, a sort or an aggregate into parameterised SQL over `data_rows`. No raw SQL ever comes
 * from a caller: field paths are checked against a strict pattern before they reach a SQL string,
 * and every value is a bound parameter.
 */

export type ColumnType = 'string' | 'number' | 'boolean' | 'date' | 'json'
export const COLUMN_TYPES: readonly ColumnType[] = ['string', 'number', 'boolean', 'date', 'json']

export interface Column {
  name: string
  type: ColumnType
  /** Insert refuses a row without it (after defaults). */
  required?: boolean
  /** Filled in on insert when the row does not give the field. */
  default?: unknown
  /** Queries on this column use an index. */
  indexed?: boolean
  /** No two rows share a value (absent and null are not counted); implies `indexed`. Text, number or date. */
  unique?: boolean
  description?: string
}

export interface TableSchema {
  columns: Column[]
  /** Refuse fields that are not columns. Default false: any extra field is kept. */
  strict?: boolean
}

export interface DataTable {
  id: string
  name: string
  description: string
  schema: TableSchema
  createdBy: string
  createdAt: number
  updatedAt: number
  version: number
  rowCount: number
  bytes: number
}

export interface TableRecord {
  id: string
  data: Record<string, unknown>
  version: number
  createdAt: number
  updatedAt: number
  createdBy: string
  updatedBy: string
}

/** Rows of a table changed (the in-process hook scripts listen on, W7). */
export interface TableRowsChange {
  tableId: string
  table: string
  kind: 'row.created' | 'row.updated' | 'row.deleted'
  rowIds: string[]
  /** Who changed them (an agent's or a script's name, `web owner`). */
  by: string
  /** The documents before and after, per row (created: after only; deleted: before only). */
  changes?: RowDiff[]
}

export interface RowDiff {
  id: string
  before?: Record<string, unknown>
  after?: Record<string, unknown>
}

/** A write would give two rows the same value of a unique column. */
export class UniqueViolation extends Error {
  constructor(
    readonly column: string,
    readonly value: unknown,
    readonly existingId: string | undefined,
  ) {
    super(
      `"${column}" must be unique: ${JSON.stringify(value)} is taken${existingId === undefined ? ' twice in this write' : ` by row ${existingId}`}`,
    )
  }
}

/** The unique columns of a schema. */
export const uniqueColumns = (schema: TableSchema): string[] =>
  schema.columns.filter((c) => c.unique === true).map((c) => c.name)

/** Fields whose values differ between two documents (top level, compared as JSON). */
export function changedFields(
  before: Record<string, unknown> | undefined,
  after: Record<string, unknown> | undefined,
): string[] {
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])
  return [...keys].filter(
    (k) => JSON.stringify((before ?? {})[k] ?? null) !== JSON.stringify((after ?? {})[k] ?? null),
  )
}

// --- limits ------------------------------------------------------------------------------------

export const LIMITS = {
  columns: 200,
  rowBytes: 256 * 1024,
  filterNodes: 100,
  filterDepth: 8,
  inValues: 500,
  pageDefault: 50,
  pageMax: 1000,
  groupBy: 3,
  metrics: 10,
  insertBatch: 1000,
  /** Rows one update or delete by filter may change. */
  bulkChange: 10_000,
  sortKeys: 3,
} as const

// --- names and paths ---------------------------------------------------------------------------

const TABLE_NAME = /^[a-z][a-z0-9_]{0,62}$/
const COLUMN_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/
const SEGMENT = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/
const METRIC_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/

/** Fields every row has, outside its document. */
export const SYSTEM_FIELDS: Readonly<Record<string, string>> = {
  _id: 'id',
  _createdAt: 'created_at',
  _updatedAt: 'updated_at',
  _version: 'version',
}

/** Why a table name is not usable, or undefined. */
export function tableNameProblem(name: string): string | undefined {
  return TABLE_NAME.test(name)
    ? undefined
    : `"${name.slice(0, 80)}" is not a table name: use lowercase letters, digits and _, starting with a letter (at most 63 characters)`
}

/** A dotted field path (`price`, `customer.city`) as SQL, or the reason it is refused. */
export function fieldSql(path: string): { sql: string } | { error: string } {
  if (path in SYSTEM_FIELDS) return { sql: SYSTEM_FIELDS[path] as string }
  const parts = path.split('.')
  if (parts.length > 5 || parts.some((p) => !SEGMENT.test(p)))
    return {
      error: `"${path.slice(0, 80)}" is not a field: use names of letters, digits and _ joined by dots (at most 5 levels), or _id, _createdAt, _updatedAt, _version`,
    }
  // the path matched the pattern above, so it holds no quote and can be a literal: the same text
  // as the expression indexes, which lets SQLite use them
  return { sql: `json_extract(data, '$.${parts.join('.')}')` }
}

// --- schema ------------------------------------------------------------------------------------

/** A schema from untrusted input, or the problems as sentences. */
export function parseSchema(
  input: unknown,
): { ok: true; schema: TableSchema } | { ok: false; errors: string[] } {
  if (input === undefined || input === null) return { ok: true, schema: { columns: [] } }
  if (typeof input !== 'object' || Array.isArray(input))
    return { ok: false, errors: ['schema must be an object with "columns"'] }
  const raw = input as { columns?: unknown; strict?: unknown }
  const errors: string[] = []
  const columns: Column[] = []
  const list = raw.columns ?? []
  if (!Array.isArray(list)) return { ok: false, errors: ['schema.columns must be a list'] }
  if (list.length > LIMITS.columns) errors.push(`at most ${LIMITS.columns} columns`)
  const seen = new Set<string>()
  for (const [i, c] of list.entries()) {
    if (typeof c !== 'object' || c === null) {
      errors.push(`column ${i + 1} must be an object`)
      continue
    }
    const col = c as Record<string, unknown>
    const name = String(col.name ?? '')
    if (!COLUMN_NAME.test(name)) {
      errors.push(
        `column ${i + 1}: "${name.slice(0, 64)}" is not a column name (letters, digits and _, starting with a letter)`,
      )
      continue
    }
    if (seen.has(name)) errors.push(`column "${name}" is listed twice`)
    seen.add(name)
    const type = col.type as ColumnType
    if (!COLUMN_TYPES.includes(type)) {
      errors.push(`column "${name}": type must be one of ${COLUMN_TYPES.join(', ')}`)
      continue
    }
    const out: Column = { name, type }
    if (col.required === true) out.required = true
    if (col.indexed === true) out.indexed = true
    if (col.unique === true) {
      if (type !== 'string' && type !== 'number' && type !== 'date')
        errors.push(`column "${name}": only text, number and date columns can be unique`)
      out.unique = true
      out.indexed = true
    }
    if (typeof col.description === 'string' && col.description !== '')
      out.description = col.description.slice(0, 500)
    if (col.default !== undefined) {
      const v = coerce(type, col.default)
      if (!v.ok) errors.push(`column "${name}": default ${v.error}`)
      else out.default = v.value
    }
    columns.push(out)
  }
  const schema: TableSchema = { columns }
  if (raw.strict === true) schema.strict = true
  return errors.length > 0 ? { ok: false, errors } : { ok: true, schema }
}

/** A value checked against a column type; dates become ISO strings. */
function coerce(
  type: ColumnType,
  v: unknown,
): { ok: true; value: unknown } | { ok: false; error: string } {
  if (v === null) return { ok: true, value: null }
  switch (type) {
    case 'string':
      return typeof v === 'string' ? { ok: true, value: v } : { ok: false, error: 'must be text' }
    case 'number':
      return typeof v === 'number' && Number.isFinite(v)
        ? { ok: true, value: v }
        : { ok: false, error: 'must be a number' }
    case 'boolean':
      return typeof v === 'boolean'
        ? { ok: true, value: v }
        : { ok: false, error: 'must be true or false' }
    case 'date': {
      if (typeof v !== 'string' && typeof v !== 'number')
        return { ok: false, error: 'must be a date' }
      const d = new Date(v)
      return Number.isNaN(d.getTime())
        ? { ok: false, error: 'must be a date (ISO 8601, e.g. 2026-10-26 or 2026-10-26T14:00:00Z)' }
        : { ok: true, value: d.toISOString() }
    }
    case 'json':
      return { ok: true, value: v }
  }
}

/**
 * A row document checked against the schema. `insert` applies defaults and required columns;
 * `patch` checks only the fields given. Problems are sentences the model can act on.
 */
export function checkRow(
  schema: TableSchema,
  data: unknown,
  mode: 'insert' | 'patch',
): { ok: true; data: Record<string, unknown> } | { ok: false; errors: string[] } {
  if (typeof data !== 'object' || data === null || Array.isArray(data))
    return { ok: false, errors: ['a row must be an object of field: value'] }
  const out: Record<string, unknown> = { ...(data as Record<string, unknown>) }
  const errors: string[] = []
  for (const key of Object.keys(out)) {
    if (key.startsWith('_')) errors.push(`"${key}": fields starting with _ are reserved`)
  }
  const byName = new Map(schema.columns.map((c) => [c.name, c]))
  if (schema.strict) {
    for (const key of Object.keys(out)) {
      if (!key.startsWith('_') && !byName.has(key))
        errors.push(`"${key}" is not a column of this table (it is strict)`)
    }
  }
  for (const col of schema.columns) {
    const given = Object.hasOwn(out, col.name)
    if (!given) {
      if (mode === 'insert') {
        if (col.default !== undefined) out[col.name] = col.default
        else if (col.required) errors.push(`"${col.name}" is required`)
      }
      continue
    }
    const v = coerce(col.type, out[col.name])
    if (!v.ok) errors.push(`"${col.name}" ${v.error}`)
    else if (v.value === null && col.required) errors.push(`"${col.name}" is required`)
    else out[col.name] = v.value
  }
  if (errors.length === 0) {
    const bytes = new TextEncoder().encode(JSON.stringify(out)).length
    if (bytes > LIMITS.rowBytes)
      errors.push(`the row is ${bytes} bytes; at most ${LIMITS.rowBytes} bytes per row`)
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, data: out }
}

// --- filters -----------------------------------------------------------------------------------

export type Filter = Record<string, unknown>
export type SqlParam = string | number | null

export interface Compiled {
  sql: string
  params: SqlParam[]
}

const OPS = new Set([
  '$eq',
  '$ne',
  '$gt',
  '$gte',
  '$lt',
  '$lte',
  '$in',
  '$nin',
  '$contains',
  '$startsWith',
  '$exists',
  '$has',
])

/** A comparable scalar as a bound parameter (booleans are stored by SQLite JSON as 1/0). */
function scalar(v: unknown, where: string): SqlParam {
  if (v === null) return null
  if (typeof v === 'boolean') return v ? 1 : 0
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string') return v
  throw new FilterError(`${where}: compare with text, a number, true/false or null`)
}

export class FilterError extends Error {}

/**
 * A MongoDB-like filter as a SQL condition over `data_rows`:
 * `{ status: 'open', price: { $gt: 10 }, $or: [{ city: 'Jakarta' }, { city: { $in: ['Bandung'] } }] }`.
 * Operators: $eq $ne $gt $gte $lt $lte $in $nin $contains (text, ignoring case) $startsWith
 * $exists $has (a list contains the value), and $and $or $not. Throws `FilterError` with a
 * sentence for bad input.
 */
export function compileFilter(filter: unknown): Compiled {
  if (filter === undefined || filter === null) return { sql: '1', params: [] }
  const params: SqlParam[] = []
  let nodes = 0
  const walk = (f: unknown, depth: number): string => {
    if (depth > LIMITS.filterDepth)
      throw new FilterError(`filters nest at most ${LIMITS.filterDepth} levels`)
    if (typeof f !== 'object' || f === null || Array.isArray(f))
      throw new FilterError('a filter is an object of field: condition')
    const parts: string[] = []
    for (const [key, value] of Object.entries(f as Record<string, unknown>)) {
      if (++nodes > LIMITS.filterNodes)
        throw new FilterError(`at most ${LIMITS.filterNodes} conditions in a filter`)
      if (key === '$and' || key === '$or') {
        if (!Array.isArray(value) || value.length === 0)
          throw new FilterError(`${key} takes a non-empty list of filters`)
        const inner = value.map((v) => walk(v, depth + 1))
        parts.push(`(${inner.join(key === '$and' ? ' AND ' : ' OR ')})`)
        continue
      }
      if (key === '$not') {
        parts.push(`NOT (${walk(value, depth + 1)})`)
        continue
      }
      if (key.startsWith('$'))
        throw new FilterError(`unknown operator ${key} at the top of a filter`)
      const field = fieldSql(key)
      if ('error' in field) throw new FilterError(field.error)
      parts.push(condition(field.sql, key, value))
    }
    return parts.length === 0 ? '1' : parts.join(' AND ')
  }
  const condition = (expr: string, key: string, value: unknown): string => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      if (Array.isArray(value))
        throw new FilterError(`"${key}": use { $in: [...] } to match one of several values`)
      return eq(expr, key, value)
    }
    const ops = Object.entries(value as Record<string, unknown>)
    if (ops.length === 0) throw new FilterError(`"${key}": an empty condition`)
    const out: string[] = []
    for (const [op, arg] of ops) {
      if (!OPS.has(op)) throw new FilterError(`"${key}": unknown operator ${op}`)
      const where = `"${key}" ${op}`
      switch (op) {
        case '$eq':
          out.push(eq(expr, key, arg))
          break
        case '$ne': {
          const p = scalar(arg, where)
          if (p === null) out.push(`${expr} IS NOT NULL`)
          else {
            params.push(p)
            out.push(`(${expr} IS NULL OR ${expr} <> ?)`)
          }
          break
        }
        case '$gt':
        case '$gte':
        case '$lt':
        case '$lte': {
          const p = scalar(arg, where)
          if (p === null) throw new FilterError(`${where}: compare with a value, not null`)
          params.push(p)
          out.push(`${expr} ${{ $gt: '>', $gte: '>=', $lt: '<', $lte: '<=' }[op]} ?`)
          break
        }
        case '$in':
        case '$nin': {
          if (!Array.isArray(arg)) throw new FilterError(`${where} takes a list`)
          if (arg.length > LIMITS.inValues)
            throw new FilterError(`${where}: at most ${LIMITS.inValues} values`)
          if (arg.length === 0) {
            out.push(op === '$in' ? '0' : '1')
            break
          }
          const values = arg.map((a) => scalar(a, where))
          const nonNull = values.filter((v) => v !== null)
          const hasNull = nonNull.length < values.length
          const list =
            nonNull.length > 0 ? `${expr} IN (${nonNull.map(() => '?').join(', ')})` : '0'
          params.push(...nonNull)
          const any = hasNull ? `(${list} OR ${expr} IS NULL)` : list
          out.push(op === '$in' ? any : `NOT ${any.startsWith('(') ? any : `(${any})`}`)
          break
        }
        case '$contains': {
          if (typeof arg !== 'string') throw new FilterError(`${where} takes text`)
          params.push(arg)
          out.push(`instr(lower(CAST(${expr} AS TEXT)), lower(?)) > 0`)
          break
        }
        case '$startsWith': {
          if (typeof arg !== 'string') throw new FilterError(`${where} takes text`)
          params.push(arg, arg)
          out.push(`substr(CAST(${expr} AS TEXT), 1, length(?)) = ?`)
          break
        }
        case '$exists': {
          if (typeof arg !== 'boolean') throw new FilterError(`${where} takes true or false`)
          if (key in SYSTEM_FIELDS) out.push(arg ? '1' : '0')
          else {
            const path = expr.slice(expr.indexOf("'"), expr.lastIndexOf("'") + 1)
            out.push(`json_type(data, ${path}) IS ${arg ? 'NOT ' : ''}NULL`)
          }
          break
        }
        case '$has': {
          if (key in SYSTEM_FIELDS) throw new FilterError(`${where}: _ fields are not lists`)
          const p = scalar(arg, where)
          const path = expr.slice(expr.indexOf("'"), expr.lastIndexOf("'") + 1)
          params.push(p)
          out.push(
            `EXISTS (SELECT 1 FROM json_each(data, ${path}) WHERE json_each.value ${p === null ? 'IS ?' : '= ?'})`,
          )
          break
        }
      }
    }
    return out.length === 1 ? (out[0] as string) : `(${out.join(' AND ')})`
  }
  const eq = (expr: string, key: string, v: unknown): string => {
    const p = scalar(v, `"${key}"`)
    if (p === null) return `${expr} IS NULL`
    params.push(p)
    return `${expr} = ?`
  }
  const sql = walk(filter, 0)
  return { sql, params }
}

// --- sort --------------------------------------------------------------------------------------

export type Sort =
  | Array<{ field: string; dir?: 'asc' | 'desc' }>
  | Record<string, 1 | -1 | 'asc' | 'desc'>

/** ORDER BY for a sort (`{ price: -1 }` or `[{ field: 'price', dir: 'desc' }]`); the row id breaks ties. */
export function compileSort(sort: unknown): string {
  if (sort === undefined || sort === null) return 'id ASC'
  const keys: Array<{ field: string; dir: 'ASC' | 'DESC' }> = []
  const push = (field: string, dir: unknown): void => {
    const f = fieldSql(field)
    if ('error' in f) throw new FilterError(f.error)
    const d =
      dir === -1 || dir === 'desc'
        ? 'DESC'
        : dir === 1 || dir === 'asc' || dir === undefined
          ? 'ASC'
          : null
    if (d === null) throw new FilterError(`sort "${field}": use 1/-1 or asc/desc`)
    keys.push({ field: f.sql, dir: d })
  }
  if (Array.isArray(sort)) {
    for (const s of sort) {
      if (typeof s !== 'object' || s === null)
        throw new FilterError('sort entries are { field, dir }')
      push(String((s as { field?: unknown }).field ?? ''), (s as { dir?: unknown }).dir)
    }
  } else if (typeof sort === 'object') {
    for (const [field, dir] of Object.entries(sort as Record<string, unknown>)) push(field, dir)
  } else throw new FilterError('sort is { field: 1 | -1 } or a list of { field, dir }')
  if (keys.length > LIMITS.sortKeys)
    throw new FilterError(`sort by at most ${LIMITS.sortKeys} fields`)
  return [...keys.map((k) => `${k.field} ${k.dir}`), 'id ASC'].join(', ')
}

// --- aggregates --------------------------------------------------------------------------------

export type MetricOp = 'count' | 'sum' | 'avg' | 'min' | 'max'

export interface AggregateSpec {
  filter?: Filter
  groupBy?: string[]
  /** `{ total: { op: 'count' }, revenue: { op: 'sum', field: 'price' } }` */
  metrics: Record<string, { op: MetricOp; field?: string }>
  /** Sort by a metric or a group field name. */
  sort?: { by: string; dir?: 'asc' | 'desc' }
  limit?: number
}

/** SELECT … GROUP BY for an aggregate (without the table condition, which the store adds). */
export function compileAggregate(spec: unknown): {
  select: string
  where: Compiled
  groupBy: string
  orderBy: string
  limit: number
  groupNames: string[]
  metricNames: string[]
} {
  if (typeof spec !== 'object' || spec === null)
    throw new FilterError('an aggregate is { metrics, groupBy?, filter? }')
  const s = spec as AggregateSpec
  const groupNames = s.groupBy ?? []
  if (!Array.isArray(groupNames)) throw new FilterError('groupBy is a list of fields')
  if (groupNames.length > LIMITS.groupBy)
    throw new FilterError(`group by at most ${LIMITS.groupBy} fields`)
  const metrics = s.metrics
  if (typeof metrics !== 'object' || metrics === null || Object.keys(metrics).length === 0)
    throw new FilterError('metrics is an object like { total: { op: "count" } }')
  const metricNames = Object.keys(metrics)
  if (metricNames.length > LIMITS.metrics)
    throw new FilterError(`at most ${LIMITS.metrics} metrics`)
  const cols: string[] = []
  groupNames.forEach((g, i) => {
    const f = fieldSql(g)
    if ('error' in f) throw new FilterError(f.error)
    cols.push(`${f.sql} AS g${i}`)
  })
  metricNames.forEach((name, i) => {
    if (!METRIC_NAME.test(name)) throw new FilterError(`"${name}" is not a metric name`)
    const m = metrics[name] as { op?: unknown; field?: unknown }
    const op = m?.op
    if (op === 'count') {
      cols.push(`COUNT(*) AS m${i}`)
      return
    }
    if (op !== 'sum' && op !== 'avg' && op !== 'min' && op !== 'max')
      throw new FilterError(`metric "${name}": op is count, sum, avg, min or max`)
    const f = fieldSql(String(m.field ?? ''))
    if ('error' in f) throw new FilterError(`metric "${name}": ${f.error}`)
    cols.push(`${op.toUpperCase()}(${f.sql}) AS m${i}`)
  })
  let orderBy = groupNames.length > 0 ? groupNames.map((_, i) => `g${i}`).join(', ') : ''
  if (s.sort !== undefined) {
    const by = s.sort.by
    const dir = s.sort.dir === 'desc' ? 'DESC' : 'ASC'
    const gi = groupNames.indexOf(by)
    const mi = metricNames.indexOf(by)
    if (gi === -1 && mi === -1)
      throw new FilterError(`sort.by "${by}" is not a group field or a metric`)
    orderBy = `${gi !== -1 ? `g${gi}` : `m${mi}`} ${dir}`
  }
  const limit = Math.min(Math.max(1, Math.floor(s.limit ?? 100)), LIMITS.pageMax)
  return {
    select: cols.join(', '),
    where: compileFilter(s.filter),
    groupBy: groupNames.map((_, i) => `g${i}`).join(', '),
    orderBy,
    limit,
    groupNames,
    metricNames,
  }
}

// --- changes -----------------------------------------------------------------------------------

export interface RowChange {
  /** Fields to set (top level). */
  set?: Record<string, unknown>
  /** Fields to remove. */
  unset?: string[]
  /** Numbers to add to (a missing field counts as 0). */
  inc?: Record<string, number>
}

/** A change applied to a document (pure); throws `FilterError` for a bad change. */
export function applyChange(
  data: Record<string, unknown>,
  change: unknown,
): Record<string, unknown> {
  if (typeof change !== 'object' || change === null)
    throw new FilterError('a change is { set?, unset?, inc? }')
  const c = change as RowChange
  const out = { ...data }
  const name = (k: string): void => {
    if (!COLUMN_NAME.test(k)) throw new FilterError(`"${k.slice(0, 64)}" is not a field name`)
  }
  if (c.set !== undefined) {
    if (typeof c.set !== 'object' || c.set === null) throw new FilterError('set is an object')
    for (const [k, v] of Object.entries(c.set)) {
      name(k)
      out[k] = v
    }
  }
  if (c.unset !== undefined) {
    if (!Array.isArray(c.unset)) throw new FilterError('unset is a list of fields')
    for (const k of c.unset) {
      name(String(k))
      delete out[String(k)]
    }
  }
  if (c.inc !== undefined) {
    if (typeof c.inc !== 'object' || c.inc === null) throw new FilterError('inc is an object')
    for (const [k, v] of Object.entries(c.inc)) {
      name(k)
      if (typeof v !== 'number' || !Number.isFinite(v))
        throw new FilterError(`inc "${k}" takes a number`)
      const cur = out[k] ?? 0
      if (typeof cur !== 'number') throw new FilterError(`inc "${k}": the field is not a number`)
      out[k] = cur + v
    }
  }
  if (c.set === undefined && c.unset === undefined && c.inc === undefined)
    throw new FilterError('a change needs set, unset or inc')
  return out
}

// --- paging ------------------------------------------------------------------------------------

/** The page size asked for, bounded. */
export const pageSize = (limit: unknown): number =>
  typeof limit === 'number' && Number.isFinite(limit)
    ? Math.min(Math.max(1, Math.floor(limit)), LIMITS.pageMax)
    : LIMITS.pageDefault

/** Cursor of an offset page (`o:<n>`); a plain row id is the cursor of the default id order. */
export function parseCursor(cursor: unknown): { offset: number } | { afterId: string } | undefined {
  if (typeof cursor !== 'string' || cursor === '') return undefined
  if (cursor.startsWith('o:')) {
    const n = Number(cursor.slice(2))
    return Number.isInteger(n) && n >= 0 ? { offset: n } : undefined
  }
  return /^[0-9a-f-]{8,64}$/i.test(cursor) ? { afterId: cursor } : undefined
}

/** Name of the expression index of an indexed column (shared by every table with that column). */
export const indexName = (column: string): string => `data_rows_x_${column}`
