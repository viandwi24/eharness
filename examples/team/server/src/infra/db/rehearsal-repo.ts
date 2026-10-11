/**
 * Rehearsals and program test cases on SQLite (plain SQL on the shared connection). A rehearsal is
 * one row with its whole result as JSON; a test case is one row with sample, expectations and the
 * last result as JSON (`domain/rehearsal.ts`).
 */
import type { Database } from 'bun:sqlite'
import type { ProgramTestStore, RehearsalStore } from '../../app/ports.ts'
import {
  normalizeExpect,
  normalizeSample,
  parseTestResult,
  type Rehearsal,
  type TestCase,
} from '../../domain/rehearsal.ts'

interface RehearsalRow {
  data: string
}

const parseRehearsal = (row: RehearsalRow): Rehearsal => JSON.parse(row.data) as Rehearsal

/** A list row: the produced files keep their names and sizes, not their content. */
const light = (r: Rehearsal): Rehearsal => ({
  ...r,
  files: r.files.map((f) => ({ ...f, text: null, base64: null })),
})

export function sqliteRehearsalStore(sqlite: Database): RehearsalStore {
  const write = (r: Rehearsal): void => {
    sqlite
      .query(
        `INSERT INTO rehearsals (id, program_id, session_id, test_id, status, started_at, data)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET status = excluded.status, data = excluded.data`,
      )
      .run(r.id, r.programId, r.sessionId, r.testId, r.status, r.startedAt, JSON.stringify(r))
  }
  const get = (id: string): Rehearsal | undefined => {
    const row = sqlite
      .query<RehearsalRow, [string]>('SELECT data FROM rehearsals WHERE id = ?')
      .get(id)
    return row === null ? undefined : parseRehearsal(row)
  }
  return {
    save: write,
    get,
    getBySession(sessionId) {
      const row = sqlite
        .query<RehearsalRow, [string]>('SELECT data FROM rehearsals WHERE session_id = ?')
        .get(sessionId)
      return row === null ? undefined : parseRehearsal(row)
    },
    list(programId, limit) {
      return sqlite
        .query<RehearsalRow, [string, number]>(
          'SELECT data FROM rehearsals WHERE program_id = ? ORDER BY started_at DESC, id DESC LIMIT ?',
        )
        .all(programId, limit)
        .map((row) => light(parseRehearsal(row)))
    },
    delete(id) {
      return sqlite.query('DELETE FROM rehearsals WHERE id = ?').run(id).changes > 0
    },
    deleteByProgram(programId) {
      sqlite.query('DELETE FROM rehearsals WHERE program_id = ?').run(programId)
    },
    prune(programId, keep) {
      sqlite
        .query(
          `DELETE FROM rehearsals WHERE program_id = ?1 AND status != 'running' AND id NOT IN
             (SELECT id FROM rehearsals WHERE program_id = ?1 ORDER BY started_at DESC, id DESC LIMIT ?2)`,
        )
        .run(programId, keep)
    },
    running() {
      return sqlite
        .query<RehearsalRow, []>("SELECT data FROM rehearsals WHERE status = 'running'")
        .all()
        .map(parseRehearsal)
    },
    spentBetween(from, to) {
      const row = sqlite
        .query<{ usd: number }, [number, number]>(
          `SELECT COALESCE(SUM(json_extract(data, '$.costUsd')), 0) AS usd
           FROM rehearsals WHERE started_at >= ? AND started_at <= ?`,
        )
        .get(from, to)
      return row?.usd ?? 0
    },
    failRunning(reason, now) {
      let n = 0
      for (const r of this.running()) {
        write({ ...r, status: 'failed', error: reason, endedAt: now })
        n++
      }
      return n
    },
  }
}

interface TestRow {
  id: string
  program_id: string
  name: string
  data: string
  created_at: number
  updated_at: number
}

function parseTest(row: TestRow): TestCase {
  const data = JSON.parse(row.data) as Record<string, unknown>
  return {
    id: row.id,
    programId: row.program_id,
    name: row.name,
    sample: normalizeSample(data.sample as never),
    expect: normalizeExpect(data.expect as never),
    lastResult: parseTestResult(data.lastResult),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

const dataOf = (t: TestCase): string =>
  JSON.stringify({ sample: t.sample, expect: t.expect, lastResult: t.lastResult })

export function sqliteProgramTestStore(sqlite: Database): ProgramTestStore {
  return {
    list(programId) {
      return sqlite
        .query<TestRow, [string]>(
          'SELECT * FROM program_tests WHERE program_id = ? ORDER BY created_at, id',
        )
        .all(programId)
        .map(parseTest)
    },
    get(id) {
      const row = sqlite
        .query<TestRow, [string]>('SELECT * FROM program_tests WHERE id = ?')
        .get(id)
      return row === null ? undefined : parseTest(row)
    },
    save(t) {
      sqlite
        .query(
          `INSERT INTO program_tests (id, program_id, name, data, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (id) DO UPDATE SET name = excluded.name, data = excluded.data, updated_at = excluded.updated_at`,
        )
        .run(t.id, t.programId, t.name, dataOf(t), t.createdAt, t.updatedAt)
    },
    /** Store a result without touching `updatedAt` (a run is not an edit of the case). */
    setResult(id, result) {
      const t = this.get(id)
      if (t === undefined) return
      sqlite
        .query('UPDATE program_tests SET data = ? WHERE id = ?')
        .run(dataOf({ ...t, lastResult: result }), id)
    },
    delete(id) {
      return sqlite.query('DELETE FROM program_tests WHERE id = ?').run(id).changes > 0
    },
    deleteByProgram(programId) {
      sqlite.query('DELETE FROM program_tests WHERE program_id = ?').run(programId)
    },
  }
}
