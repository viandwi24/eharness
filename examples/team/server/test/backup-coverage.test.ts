/**
 * The backup coverage map (docs/plans/P58-backup-coverage.md): every table of the database is
 * classified as restorable through the workspace zip, covered only by the database snapshot, or
 * derived/ephemeral. A table added without an answer fails here, with its name.
 */
import type { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { is } from 'drizzle-orm'
import { getTableConfig, SQLiteTable } from 'drizzle-orm/sqlite-core'
import { COVERAGE, COVERAGE_BY_TABLE, coverageCounts } from '../src/domain/backup-coverage.ts'
import { DATASETS, SECTIONS } from '../src/domain/workspace-data.ts'
import { openDatabase } from '../src/infra/db/client.ts'
import * as schema from '../src/infra/db/schema.ts'

const migrated = openDatabase(':memory:')
const liveTables = migrated.sqlite
  .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
  .all()
  .map((r) => r.name)

const columnsOf = (
  db: Database,
  table: string,
): Array<{ name: string; pk: number; type: string }> =>
  db.query<{ name: string; pk: number; type: string }, []>(`PRAGMA table_info("${table}")`).all()

/** Tables of class `zip` that travel as an entity document, a secrets record or library files, not as rows. */
const NOT_DATASETS = [
  'agents',
  'agent_connectors',
  'programs',
  'people',
  'library_files',
  'config_profiles',
  'api_keys',
  'routines',
  'settings',
]

describe('coverage map', () => {
  test('every table of the migrated database is classified', () => {
    const missing = liveTables.filter((t) => !COVERAGE_BY_TABLE.has(t))
    expect(
      missing,
      `Unclassified table(s): ${missing.join(', ')}. Add them to src/domain/backup-coverage.ts (zip, snapshot or derived) and docs/plans/P58-backup-coverage.md.`,
    ).toEqual([])
  })

  test('every drizzle table of the schema is classified, and nothing classified is gone', () => {
    const fromSchema = Object.values(schema)
      .filter((v) => is(v, SQLiteTable))
      .map((v) => getTableConfig(v as SQLiteTable).name)
    expect(fromSchema.length).toBeGreaterThan(80)
    expect(fromSchema.filter((t) => !COVERAGE_BY_TABLE.has(t))).toEqual([])
    const stale = COVERAGE.map((e) => e.table).filter((t) => !liveTables.includes(t))
    expect(stale, `classified but not in the database: ${stale.join(', ')}`).toEqual([])
    expect(new Set(COVERAGE.map((e) => e.table)).size).toBe(COVERAGE.length)
  })

  test('every entry says why or where, and the classes add up', () => {
    for (const e of COVERAGE) {
      expect(e.note.trim().length, e.table).toBeGreaterThan(8)
      expect(e.feature.trim().length, e.table).toBeGreaterThan(2)
      if (e.class === 'zip') {
        expect(
          e.sections?.length ?? 0,
          `${e.table} names the sections that restore it`,
        ).toBeGreaterThan(0)
        for (const s of e.sections ?? []) expect(SECTIONS as readonly string[]).toContain(s)
      }
    }
    const counts = coverageCounts()
    expect(counts.zip + counts.snapshot + counts.derived).toBe(COVERAGE.length)
    expect(COVERAGE.length).toBe(liveTables.length)
  })

  test('every table restorable through the zip has an entity document, a secrets record or a dataset', () => {
    for (const e of COVERAGE.filter((c) => c.class === 'zip')) {
      const inDatasets = DATASETS.some((d) => d.table === e.table)
      const other = NOT_DATASETS.includes(e.table)
      expect(
        inDatasets || other,
        `${e.table} is zip class: a dataset, or listed as a document`,
      ).toBe(true)
    }
    for (const d of DATASETS) {
      expect(COVERAGE_BY_TABLE.get(d.table)?.class, `${d.table} dataset`).toBe('zip')
    }
  })

  test('a dataset names columns that exist and a key the database enforces', () => {
    for (const d of DATASETS) {
      const cols = columnsOf(migrated.sqlite, d.table)
      const names = cols.map((c) => c.name)
      for (const c of [...d.key, ...(d.skip ?? []), ...(d.strip ?? []), ...(d.blobs ?? [])]) {
        expect(names, `${d.table}.${c}`).toContain(c)
      }
      if (d.seq !== undefined) {
        expect(names).toContain(d.seq)
        expect(d.key).toEqual([])
        continue
      }
      expect(d.key.length, `${d.table} has a key`).toBeGreaterThan(0)
      if (d.logicalKey === true) continue
      const pk = cols.filter((c) => c.pk > 0).map((c) => c.name)
      const unique = migrated.sqlite
        .query<{ name: string; unique: number }, []>(`PRAGMA index_list("${d.table}")`)
        .all()
        .filter((i) => i.unique === 1)
        .map((i) =>
          migrated.sqlite
            .query<{ name: string }, []>(`PRAGMA index_info("${i.name}")`)
            .all()
            .map((c) => c.name)
            .sort()
            .join(','),
        )
      const key = [...d.key].sort().join(',')
      expect(
        key === [...pk].sort().join(',') || unique.includes(key),
        `${d.table}: key (${d.key.join(', ')}) is the primary key (${pk.join(', ')}) or a unique index`,
      ).toBe(true)
      // the order clause is valid SQL
      migrated.sqlite.query(`SELECT 1 FROM "${d.table}" ORDER BY ${d.order} LIMIT 1`).all()
      if (d.where !== undefined) {
        migrated.sqlite.query(`SELECT 1 FROM "${d.table}" WHERE ${d.where} LIMIT 1`).all()
      }
    }
  })

  test('the plan document lists every table', () => {
    const doc = readFileSync(
      join(import.meta.dir, '../../../../docs/plans/P58-backup-coverage.md'),
      'utf8',
    )
    const missing = COVERAGE.map((e) => e.table).filter((t) => !doc.includes(`\`${t}\``))
    expect(
      missing,
      `docs/plans/P58-backup-coverage.md does not mention: ${missing.join(', ')}`,
    ).toEqual([])
  })
})
