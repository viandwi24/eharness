/**
 * Import and export of table rows (ADR-0065): CSV (RFC 4180: quoted fields, doubled quotes,
 * newlines inside quotes), a JSON array of objects, or NDJSON (one object per line). Pure.
 */
import type { Column, ColumnType, TableSchema } from './tables.ts'

export type RowFormat = 'csv' | 'json' | 'ndjson'

/** The format of a library path by its extension, or undefined. */
export function formatOfPath(path: string): RowFormat | undefined {
  const ext = path.toLowerCase().split('.').pop()
  if (ext === 'csv') return 'csv'
  if (ext === 'json') return 'json'
  if (ext === 'ndjson' || ext === 'jsonl') return 'ndjson'
  return undefined
}

/** CSV text as records of strings (the first line is the header). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  let i = 0
  const s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  while (i < s.length) {
    const ch = s[i] as string
    if (quoted) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          field += '"'
          i += 2
          continue
        }
        quoted = false
        i++
        continue
      }
      field += ch
      i++
      continue
    }
    if (ch === '"' && field === '') {
      quoted = true
      i++
    } else if (ch === ',') {
      row.push(field)
      field = ''
      i++
    } else if (ch === '\n' || ch === '\r') {
      row.push(field)
      field = ''
      if (row.length > 1 || row[0] !== '') rows.push(row)
      row = []
      i += ch === '\r' && s[i + 1] === '\n' ? 2 : 1
    } else {
      field += ch
      i++
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field)
    if (row.length > 1 || row[0] !== '') rows.push(row)
  }
  return rows
}

/** A CSV cell as the column's type (text stays text when it does not read as that type). */
function cell(type: ColumnType | undefined, raw: string): unknown {
  if (type === 'number') {
    const n = Number(raw.replace(/,(?=\d{3}\b)/g, ''))
    return Number.isFinite(n) ? n : raw
  }
  if (type === 'boolean') {
    const v = raw.trim().toLowerCase()
    if (['true', 'yes', 'y', '1'].includes(v)) return true
    if (['false', 'no', 'n', '0'].includes(v)) return false
    return raw
  }
  if (type === 'json') {
    try {
      return JSON.parse(raw)
    } catch {
      return raw
    }
  }
  return raw
}

/** Records from text in a format; empty CSV cells are left out (defaults apply). */
export function recordsFrom(
  text: string,
  format: RowFormat,
  schema: TableSchema,
): { records: Record<string, unknown>[] } | { error: string } {
  if (format === 'csv') {
    const rows = parseCsv(text)
    if (rows.length === 0) return { records: [] }
    const header = (rows[0] as string[]).map((h) => h.trim())
    if (header.some((h) => h === '')) return { error: 'the CSV header has an empty column name' }
    const types = new Map<string, ColumnType>(schema.columns.map((c: Column) => [c.name, c.type]))
    const records = rows.slice(1).map((r) => {
      const out: Record<string, unknown> = {}
      header.forEach((h, i) => {
        const raw = r[i] ?? ''
        if (raw !== '' && h !== '_id') out[h] = cell(types.get(h), raw)
      })
      return out
    })
    return { records }
  }
  try {
    if (format === 'json') {
      const v = JSON.parse(text) as unknown
      if (!Array.isArray(v)) return { error: 'a JSON import is an array of objects' }
      return { records: v as Record<string, unknown>[] }
    }
    const records: Record<string, unknown>[] = []
    for (const [n, line] of text.split(/\r?\n/).entries()) {
      if (line.trim() === '') continue
      try {
        records.push(JSON.parse(line) as Record<string, unknown>)
      } catch {
        return { error: `line ${n + 1} is not JSON` }
      }
    }
    return { records }
  } catch {
    return { error: 'the file is not valid JSON' }
  }
}

/** The CSV columns of an export: `_id`, the schema columns, then other fields in first-seen order. */
export function csvColumns(
  schema: TableSchema,
  sample: readonly Record<string, unknown>[],
): string[] {
  const cols = ['_id', ...schema.columns.map((c) => c.name)]
  const seen = new Set(cols)
  for (const r of sample) {
    for (const k of Object.keys(r)) {
      if (!seen.has(k)) {
        seen.add(k)
        cols.push(k)
      }
    }
  }
  return cols
}

/** A value as CSV cell text (objects and lists as JSON). */
export const cellText = (v: unknown): string | number | undefined =>
  v === undefined || v === null
    ? undefined
    : typeof v === 'number'
      ? v
      : typeof v === 'string'
        ? v
        : typeof v === 'boolean'
          ? String(v)
          : JSON.stringify(v)
