/**
 * Document tables on SQLite (ADR-0065): `data_tables` holds the definitions and the running row and
 * byte counters, `data_rows` the JSON documents. Every write that adds, replaces or removes rows
 * updates the counters in the same transaction, so the caps never need a scan. SQL fragments come
 * only from `domain/tables.ts` (checked field paths), values are always bound parameters.
 */
import type { Database, SQLQueryBindings } from 'bun:sqlite'
import type { TableRowWrite, TableStore } from '../../app/ports.ts'
import {
  type Compiled,
  type DataTable,
  fieldSql,
  indexName,
  type TableRecord,
  type TableSchema,
} from '../../domain/tables.ts'

interface TableRow {
  id: string
  name: string
  description: string
  schema: string
  created_by: string
  created_at: number
  updated_at: number
  version: number
  row_count: number
  bytes: number
}

interface DataRowRow {
  id: string
  data: string
  version: number
  created_at: number
  updated_at: number
  created_by: string
  updated_by: string
}

const toTable = (r: TableRow): DataTable => ({
  id: r.id,
  name: r.name,
  description: r.description,
  schema: JSON.parse(r.schema) as TableSchema,
  createdBy: r.created_by,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  version: r.version,
  rowCount: r.row_count,
  bytes: r.bytes,
})

const toRow = (r: DataRowRow): TableRecord => ({
  id: r.id,
  data: JSON.parse(r.data) as Record<string, unknown>,
  version: r.version,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  createdBy: r.created_by,
  updatedBy: r.updated_by,
})

const encoder = new TextEncoder()
const sizeOf = (text: string): number => encoder.encode(text).length
const bind = (params: Compiled['params']): SQLQueryBindings[] => params as SQLQueryBindings[]

const ROW_COLUMNS = 'id, data, version, created_at, updated_at, created_by, updated_by'

export function sqliteTableStore(sqlite: Database): TableStore {
  const get = (ref: string): DataTable | undefined => {
    const row = sqlite
      .query<TableRow, [string, string]>(
        'SELECT * FROM data_tables WHERE id = ? OR name = ? LIMIT 1',
      )
      .get(ref, ref)
    return row === null ? undefined : toTable(row)
  }
  const bump = (tableId: string, rows: number, bytes: number, now: number): void => {
    sqlite
      .query(
        'UPDATE data_tables SET row_count = row_count + ?, bytes = bytes + ?, updated_at = ? WHERE id = ?',
      )
      .run(rows, bytes, now, tableId)
  }

  return {
    list() {
      return sqlite
        .query<TableRow, []>('SELECT * FROM data_tables ORDER BY name')
        .all()
        .map(toTable)
    },

    get,

    create(t) {
      sqlite
        .query(
          `INSERT INTO data_tables (id, name, description, schema, created_by, created_at, updated_at, version, row_count, bytes)
           VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0, 0)`,
        )
        .run(t.id, t.name, t.description, JSON.stringify(t.schema), t.createdBy, t.now, t.now)
      return get(t.id) as DataTable
    },

    update(id, patch, now) {
      const cur = get(id)
      if (cur === undefined) return undefined
      sqlite
        .query(
          'UPDATE data_tables SET name = ?, description = ?, schema = ?, updated_at = ?, version = version + 1 WHERE id = ?',
        )
        .run(
          patch.name ?? cur.name,
          patch.description ?? cur.description,
          JSON.stringify(patch.schema ?? cur.schema),
          now,
          id,
        )
      return get(id)
    },

    drop(id) {
      return sqlite
        .transaction(() => {
          sqlite.query('DELETE FROM data_rows WHERE table_id = ?').run(id)
          return sqlite.query('DELETE FROM data_tables WHERE id = ?').run(id).changes > 0
        })
        .immediate()
    },

    totals() {
      const r = sqlite
        .query<{ rows: number | null; bytes: number | null }, []>(
          'SELECT SUM(row_count) AS rows, SUM(bytes) AS bytes FROM data_tables',
        )
        .get()
      return { rows: r?.rows ?? 0, bytes: r?.bytes ?? 0 }
    },

    insert(tableId, rows, by, now) {
      if (rows.length === 0) return
      const stmt = sqlite.query(
        `INSERT INTO data_rows (table_id, ${ROW_COLUMNS}) VALUES (?, ?, ?, 1, ?, ?, ?, ?)`,
      )
      sqlite
        .transaction(() => {
          let bytes = 0
          for (const r of rows) {
            const text = JSON.stringify(r.data)
            bytes += sizeOf(text)
            stmt.run(tableId, r.id, text, now, now, by, by)
          }
          bump(tableId, rows.length, bytes, now)
        })
        .immediate()
    },

    replace(tableId, rows: readonly TableRowWrite[], by, now) {
      const written: string[] = []
      const conflicts: string[] = []
      const read = sqlite.query<{ version: number; size: number }, [string, string]>(
        'SELECT version, length(CAST(data AS BLOB)) AS size FROM data_rows WHERE table_id = ? AND id = ?',
      )
      const write = sqlite.query(
        'UPDATE data_rows SET data = ?, version = version + 1, updated_at = ?, updated_by = ? WHERE table_id = ? AND id = ? AND version = ?',
      )
      sqlite
        .transaction(() => {
          let delta = 0
          for (const r of rows) {
            const cur = read.get(tableId, r.id)
            if (cur === null || (r.ifVersion !== undefined && r.ifVersion !== cur.version)) {
              conflicts.push(r.id)
              continue
            }
            const text = JSON.stringify(r.data)
            if (write.run(text, now, by, tableId, r.id, cur.version).changes === 0) {
              conflicts.push(r.id)
              continue
            }
            delta += sizeOf(text) - cur.size
            written.push(r.id)
          }
          if (written.length > 0) bump(tableId, 0, delta, now)
        })
        .immediate()
      return { written, conflicts }
    },

    delete(tableId, ids) {
      if (ids.length === 0) return 0
      const read = sqlite.query<{ size: number }, [string, string]>(
        'SELECT length(CAST(data AS BLOB)) AS size FROM data_rows WHERE table_id = ? AND id = ?',
      )
      const del = sqlite.query('DELETE FROM data_rows WHERE table_id = ? AND id = ?')
      return sqlite
        .transaction(() => {
          let n = 0
          let bytes = 0
          for (const id of ids) {
            const cur = read.get(tableId, id)
            if (cur === null) continue
            n += del.run(tableId, id).changes
            bytes += cur.size
          }
          if (n > 0) bump(tableId, -n, -bytes, Date.now())
          return n
        })
        .immediate()
    },

    getRow(tableId, rowId) {
      const r = sqlite
        .query<DataRowRow, [string, string]>(
          `SELECT ${ROW_COLUMNS} FROM data_rows WHERE table_id = ? AND id = ?`,
        )
        .get(tableId, rowId)
      return r === null ? undefined : toRow(r)
    },

    query(tableId, q) {
      const after = q.afterId === undefined ? '' : ' AND id > ?'
      const params: SQLQueryBindings[] = [
        tableId,
        ...bind(q.where.params),
        ...(q.afterId === undefined ? [] : [q.afterId]),
        q.limit,
        q.offset ?? 0,
      ]
      return sqlite
        .query<DataRowRow, SQLQueryBindings[]>(
          `SELECT ${ROW_COLUMNS} FROM data_rows WHERE table_id = ? AND (${q.where.sql})${after}
           ORDER BY ${q.orderBy} LIMIT ? OFFSET ?`,
        )
        .all(...params)
        .map(toRow)
    },

    count(tableId, where) {
      return (
        sqlite
          .query<{ n: number }, SQLQueryBindings[]>(
            `SELECT COUNT(*) AS n FROM data_rows WHERE table_id = ? AND (${where.sql})`,
          )
          .get(tableId, ...bind(where.params))?.n ?? 0
      )
    },

    aggregate(tableId, q) {
      const group = q.groupBy === '' ? '' : ` GROUP BY ${q.groupBy}`
      const order = q.orderBy === '' ? '' : ` ORDER BY ${q.orderBy}`
      return sqlite
        .query<Record<string, unknown>, SQLQueryBindings[]>(
          `SELECT ${q.select} FROM data_rows WHERE table_id = ? AND (${q.where.sql})${group}${order} LIMIT ?`,
        )
        .all(tableId, ...bind(q.where.params), q.limit)
    },

    ensureIndex(column) {
      const f = fieldSql(column)
      if ('error' in f) throw new Error(`not an indexable column: ${column}`)
      // `column` matched the field pattern (letters, digits, _), so the name and the expression
      // hold no quotes; the expression is the exact text the query compiler emits
      sqlite.run(
        `CREATE INDEX IF NOT EXISTS "${indexName(column)}" ON data_rows (table_id, ${f.sql})`,
      )
    },
  }
}
