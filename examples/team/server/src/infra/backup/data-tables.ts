/**
 * The data tables of the workspace export on SQLite: read the rows of a table as JSON-safe values
 * (the dataset spec says which rows and columns), write rows back, remove rows. Plain SQL on the
 * shared connection; every write is one transaction per table.
 *
 * Writing: `ignore` adds rows whose key is not here yet and leaves the others alone; `replace` also
 * updates the rows that are here (the columns of `strip` keep their live value: they travel in the
 * encrypted secrets file). A write never touches a table that has no dataset spec.
 */
import type { Database, SQLQueryBindings } from 'bun:sqlite'
import {
  DATASET_BY_TABLE,
  type DataRow,
  type DatasetSpec,
  rowFingerprint,
} from '../../domain/workspace-data.ts'

const quote = (name: string): string => `"${name.replaceAll('"', '""')}"`

const encodeBlob = (bytes: Uint8Array): { $b64: string } => ({
  $b64: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64'),
})
const isBlob = (v: unknown): v is { $b64: string } =>
  v !== null && typeof v === 'object' && typeof (v as { $b64?: unknown }).$b64 === 'string'

export interface DataTables {
  /** Every row of the dataset of `table` (spec filter, columns and order). */
  rows(table: string): DataRow[]
  /** Write rows; `written` counts the rows added or updated. */
  put(
    table: string,
    rows: readonly DataRow[],
    mode: 'ignore' | 'replace',
  ): { added: number; updated: number }
  /** Delete the rows of `table` that match these rows by key; returns how many were deleted. */
  remove(table: string, rows: readonly DataRow[]): number
  /** Row count of every table. */
  counts(): Record<string, number>
}

function specOf(table: string): DatasetSpec {
  const spec = DATASET_BY_TABLE.get(table)
  if (spec === undefined) throw new Error(`${table} has no dataset`)
  return spec
}

export function tableCounts(sqlite: Database): Record<string, number> {
  const out: Record<string, number> = {}
  const names = sqlite
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all()
  for (const { name } of names) {
    out[name] =
      sqlite.query<{ n: number }, []>(`SELECT count(*) AS n FROM ${quote(name)}`).get()?.n ?? 0
  }
  return out
}

export function createDataTables(sqlite: Database): DataTables {
  const columnsOf = (table: string): string[] =>
    sqlite
      .query<{ name: string }, []>(`PRAGMA table_info(${quote(table)})`)
      .all()
      .map((c) => c.name)

  /** The columns the export carries and an import writes. */
  const dataColumns = (spec: DatasetSpec): string[] =>
    columnsOf(spec.table).filter((c) => c !== spec.seq && !(spec.skip ?? []).includes(c))

  const decode = (
    _spec: DatasetSpec,
    row: DataRow,
    columns: readonly string[],
  ): SQLQueryBindings[] =>
    columns.map((c) => {
      const v = row[c]
      if (v === undefined) return null
      if (isBlob(v)) return Buffer.from(v.$b64, 'base64')
      if (typeof v === 'object' && v !== null) return JSON.stringify(v)
      return v as SQLQueryBindings
    })

  return {
    rows(table) {
      const spec = specOf(table)
      const columns = dataColumns(spec)
      const where = spec.where === undefined ? '' : ` WHERE ${spec.where}`
      const raw = sqlite
        .query<Record<string, unknown>, []>(
          `SELECT ${columns.map(quote).join(', ')} FROM ${quote(table)}${where} ORDER BY ${spec.order}`,
        )
        .all()
      return raw.map((r) => {
        const out: DataRow = {}
        for (const c of columns) {
          const v = r[c]
          if ((spec.strip ?? []).includes(c)) out[c] = null
          else if (v instanceof Uint8Array) out[c] = encodeBlob(v)
          else out[c] = v ?? null
        }
        return out
      })
    },

    put(table, rows, mode) {
      const spec = specOf(table)
      const all = dataColumns(spec)
      const result = { added: 0, updated: 0 }
      if (rows.length === 0) return result
      sqlite
        .transaction(() => {
          for (const row of rows) {
            const columns = all.filter((c) => c in row)
            if (columns.length === 0) continue
            const values = decode(spec, row, columns)
            if (spec.seq !== undefined) {
              // an append-only table: a row that is already here (same columns) is not added again
              const same = sqlite
                .query<{ n: number }, SQLQueryBindings[]>(
                  `SELECT count(*) AS n FROM ${quote(table)} WHERE ${columns
                    .map((c) => `${quote(c)} IS ?`)
                    .join(' AND ')}`,
                )
                .get(...values)
              if ((same?.n ?? 0) > 0) continue
              sqlite
                .query(
                  `INSERT INTO ${quote(table)} (${columns.map(quote).join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
                )
                .run(...(values as never[]))
              result.added++
              continue
            }
            const keyValues = spec.key.map((k) => decode(spec, row, [k])[0] ?? null)
            const keyWhere = spec.key.map((k) => `${quote(k)} IS ?`).join(' AND ')
            const exists =
              (sqlite
                .query<{ n: number }, SQLQueryBindings[]>(
                  `SELECT count(*) AS n FROM ${quote(table)} WHERE ${keyWhere}`,
                )
                .get(...keyValues)?.n ?? 0) > 0
            if (exists) {
              if (mode === 'ignore') continue
              const set = columns.filter((c) => !(spec.strip ?? []).includes(c))
              if (set.length === 0) continue
              sqlite
                .query(
                  `UPDATE ${quote(table)} SET ${set.map((c) => `${quote(c)} = ?`).join(', ')} WHERE ${keyWhere}`,
                )
                .run(...([...decode(spec, row, set), ...keyValues] as never[]))
              result.updated++
              continue
            }
            // not here by key: a different row may still hold a unique column (a slug, a token)
            const verb = mode === 'replace' ? 'INSERT OR REPLACE' : 'INSERT OR IGNORE'
            const done = sqlite
              .query(
                `${verb} INTO ${quote(table)} (${columns.map(quote).join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
              )
              .run(...(values as never[]))
            if (done.changes > 0) result.added++
          }
        })
        .immediate()
      return result
    },

    remove(table, rows) {
      const spec = specOf(table)
      let deleted = 0
      sqlite
        .transaction(() => {
          for (const row of rows) {
            if (spec.seq !== undefined) {
              const columns = dataColumns(spec).filter((c) => c in row)
              const done = sqlite
                .query(
                  `DELETE FROM ${quote(table)} WHERE ${quote(spec.seq as string)} IN (SELECT ${quote(spec.seq as string)} FROM ${quote(table)} WHERE ${columns
                    .map((c) => `${quote(c)} IS ?`)
                    .join(' AND ')} LIMIT 1)`,
                )
                .run(...(decode(spec, row, columns) as never[]))
              deleted += done.changes
              continue
            }
            const done = sqlite
              .query(
                `DELETE FROM ${quote(table)} WHERE ${spec.key.map((k) => `${quote(k)} IS ?`).join(' AND ')}`,
              )
              .run(...(spec.key.map((k) => decode(spec, row, [k])[0] ?? null) as never[]))
            deleted += done.changes
          }
        })
        .immediate()
      return deleted
    },

    counts: () => tableCounts(sqlite),
  }
}

/** Test and diagnostic helper: a row as the comparable string the import compares. */
export const comparableRow = (row: DataRow): string => rowFingerprint(row)
