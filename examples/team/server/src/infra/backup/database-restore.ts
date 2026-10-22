/**
 * Restoring the whole database from a backup, safely.
 *
 * A running server keeps the database file open in many places (prepared statements, the change
 * feed, the schedulers of every instance), so the file is never swapped under it. The restore is
 * STAGED: the verified copy is written next to the database as `<db>.restore` with a marker
 * `<db>.restore.json`, and the server restarts (see `Lifecycle`). At the next start,
 * `applyPendingRestore` runs BEFORE the database is opened: it verifies the staged copy again
 * (`PRAGMA integrity_check`), moves the old database aside as `<db>.replaced` (the previous
 * `.replaced` is overwritten; the verified safety backup is the real undo), deletes the old WAL and
 * shared-memory files so they are never paired with the new file, and renames the copy into place.
 * A staged copy that fails verification is kept as `<db>.restore.failed` and the server starts on
 * the database it had. The outcome is written to `<db>.restore.result.json` for the app to show.
 */
import { Database } from 'bun:sqlite'
import { copyFileSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'

export interface PendingRestore {
  backupId: string
  safetyBackupId: string
  restorePointId: string
  stagedAt: number
}

export interface RestoreResultFile {
  ok: boolean
  at: number
  backupId: string
  restorePointId: string
  error: string | null
}

const pendingFile = (dbFile: string): string => `${dbFile}.restore`
const markerFile = (dbFile: string): string => `${dbFile}.restore.json`
const resultFile = (dbFile: string): string => `${dbFile}.restore.result.json`

/** `PRAGMA integrity_check` of a file and its number of applied migrations. */
export function inspectDatabase(
  file: string,
): { ok: true; migrations: number } | { ok: false; error: string } {
  let db: Database | undefined
  try {
    db = new Database(file, { readonly: true, strict: true })
    const rows = db.query<Record<string, string>, []>('PRAGMA integrity_check').all()
    const answers = rows.map((r) => Object.values(r)[0])
    if (answers.length !== 1 || answers[0] !== 'ok') {
      return { ok: false, error: `integrity check failed: ${answers.slice(0, 3).join('; ')}` }
    }
    const migrations =
      db.query<{ n: number }, []>('SELECT count(*) AS n FROM __drizzle_migrations').get()?.n ?? 0
    return { ok: true, migrations }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  } finally {
    db?.close()
  }
}

/** Write the staged copy and its marker; the copy appears under its name only when complete. */
export function stageRestore(dbFile: string, source: string, info: PendingRestore): void {
  const tmp = `${pendingFile(dbFile)}.tmp`
  rmSync(tmp, { force: true })
  copyFileSync(source, tmp)
  renameSync(tmp, pendingFile(dbFile))
  writeFileSync(`${markerFile(dbFile)}.tmp`, JSON.stringify(info, null, 2))
  renameSync(`${markerFile(dbFile)}.tmp`, markerFile(dbFile))
}

export function readPendingRestore(dbFile: string): PendingRestore | undefined {
  if (!existsSync(pendingFile(dbFile)) || !existsSync(markerFile(dbFile))) return undefined
  try {
    return JSON.parse(readFileSync(markerFile(dbFile), 'utf8')) as PendingRestore
  } catch {
    return undefined
  }
}

export function cancelPendingRestore(dbFile: string): void {
  for (const f of [pendingFile(dbFile), markerFile(dbFile), `${pendingFile(dbFile)}.tmp`]) {
    rmSync(f, { force: true })
  }
}

export function readRestoreResult(dbFile: string): RestoreResultFile | undefined {
  try {
    return JSON.parse(readFileSync(resultFile(dbFile), 'utf8')) as RestoreResultFile
  } catch {
    return undefined
  }
}

/**
 * Called before the database is opened. Swaps in a staged restore; never throws (a failed swap
 * leaves the database as it was and says why in the result file).
 */
export function applyPendingRestore(
  dbFile: string,
  now: () => number = Date.now,
): RestoreResultFile | undefined {
  const info = readPendingRestore(dbFile)
  if (info === undefined) {
    // a copy without its marker was never completely staged: it is not applied
    if (existsSync(pendingFile(dbFile))) rmSync(pendingFile(dbFile), { force: true })
    return undefined
  }
  const done = (error: string | null): RestoreResultFile => {
    const result: RestoreResultFile = {
      ok: error === null,
      at: now(),
      backupId: info.backupId,
      restorePointId: info.restorePointId,
      error,
    }
    try {
      writeFileSync(resultFile(dbFile), JSON.stringify(result, null, 2))
    } catch {
      // the result file is a convenience
    }
    return result
  }
  const verdict = inspectDatabase(pendingFile(dbFile))
  if (!verdict.ok) {
    renameSync(pendingFile(dbFile), `${pendingFile(dbFile)}.failed`)
    rmSync(markerFile(dbFile), { force: true })
    return done(`the staged copy did not verify (${verdict.error}); the database was not changed`)
  }
  try {
    for (const suffix of ['-wal', '-shm']) rmSync(`${dbFile}${suffix}`, { force: true })
    if (existsSync(dbFile)) renameSync(dbFile, `${dbFile}.replaced`)
    renameSync(pendingFile(dbFile), dbFile)
    rmSync(markerFile(dbFile), { force: true })
    return done(null)
  } catch (error) {
    // put the old database back when the swap stopped half way
    try {
      if (!existsSync(dbFile) && existsSync(`${dbFile}.replaced`)) {
        renameSync(`${dbFile}.replaced`, dbFile)
      }
    } catch {
      // nothing more to do
    }
    return done(`the swap failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}
