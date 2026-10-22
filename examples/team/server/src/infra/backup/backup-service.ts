/**
 * Snapshots of the SQLite database (`VACUUM INTO`: an online, consistent copy that is safe with
 * WAL and concurrent writers), verified after writing, plus the workspace export: one readable zip
 * (`workspace-zip.ts`) with the entity documents the app collected and every library and memory
 * file of the copy. Restore of files reads a snapshot and writes the files into the live database
 * as new versions through the same file system the agents use. The import reads a workspace zip
 * (a backup's, or an uploaded one kept as `import-<id>.zip` until used or six hours old). Restore
 * points (what an import applied and the safety backup to undo it) are `rp-<id>.json` files here,
 * so they survive a database restore.
 *
 * One snapshot is three files in the backup directory, written under temporary names and renamed
 * when complete, the sidecar last: `<id>.db`, `<id>.zip`, `<id>.json`.
 */
import { Database } from 'bun:sqlite'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import type { BackupPort } from '../../app/ports.ts'
import {
  type BackupRecord,
  kindOfReason,
  normalizeScope,
  RESTORE_LIST_MAX,
  type RestoreAction,
  type RestoreEntry,
  type RestoreMode,
  type RestorePlan,
  type RestorePoint,
  type RestoreResult,
} from '../../domain/backups.ts'
import { conflict, invalid, notFound } from '../../domain/errors.ts'
import {
  type EntityFile,
  IMPORT_LIMITS,
  type ImportSource,
  type ReminderRecord,
} from '../../domain/workspace-export.ts'
import { type LibraryChange, libraryFs } from '../eh/library-fs.ts'
import { addMoves, listMoves, removeMovesOf } from '../eh/library-moves.ts'
import { createDataTables, tableCounts } from './data-tables.ts'
import {
  cancelPendingRestore,
  inspectDatabase,
  readPendingRestore,
  readRestoreResult,
  stageRestore,
} from './database-restore.ts'
import { parseWorkspaceZip, writeWorkspaceZip } from './workspace-zip.ts'

export interface BackupServiceOptions {
  sqlite: Database
  dir: string
  /** The database file of `sqlite` (absent for an in-memory database: no whole-database restore). */
  dbFile?: string
  now?: () => number
  /** Reaches the event feed for every file a restore writes. */
  onChange?: (change: LibraryChange) => void
  /** Test seam: runs on the copy right after it is written, before it is verified. */
  afterCopy?: (file: string) => void
  /** The app version written into the manifest of every export. */
  appVersion?: string
}

const ID = /^team-\d{8}T\d{9}Z-[0-9a-f]{4}$/
const UPLOAD_ID = /^up-[0-9a-f]{16}$/
const POINT_ID = /^rp-\d{8}T\d{9}Z-[0-9a-f]{4}$/
/** A staged upload or a download built on demand is removed after this long. */
const TEMP_TTL_MS = 6 * 3_600_000
const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

const stampOf = (at: number): string =>
  new Date(at)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.(\d{3})Z$/, '$1Z')

interface Counts {
  files: number
  agents: number
}

const countsOf = (db: Database): Counts => ({
  files: db.query<{ n: number }, []>('SELECT count(*) AS n FROM library_files').get()?.n ?? 0,
  agents: db.query<{ n: number }, []>('SELECT count(*) AS n FROM agents').get()?.n ?? 0,
})

/**
 * Check a copy: `PRAGMA integrity_check` answers `ok`, and its row counts of library files and
 * agents lie between the live counts before and after the copy (writers may run meanwhile).
 */
export function verifyCopy(
  file: string,
  before: Counts,
  after: Counts,
): { ok: true; counts: Counts } | { ok: false; error: string } {
  let db: Database | undefined
  try {
    db = new Database(file, { readonly: true, strict: true })
    const rows = db.query<Record<string, string>, []>('PRAGMA integrity_check').all()
    const answers = rows.map((r) => Object.values(r)[0])
    if (answers.length !== 1 || answers[0] !== 'ok') {
      return { ok: false, error: `integrity check failed: ${answers.slice(0, 3).join('; ')}` }
    }
    const counts = countsOf(db)
    for (const key of ['files', 'agents'] as const) {
      const lo = Math.min(before[key], after[key])
      const hi = Math.max(before[key], after[key])
      if (counts[key] < lo || counts[key] > hi) {
        return {
          ok: false,
          error: `row count of ${key === 'files' ? 'library_files' : 'agents'} differs: copy ${counts[key]}, live ${before[key]}..${after[key]}`,
        }
      }
    }
    return { ok: true, counts }
  } catch (error) {
    return { ok: false, error: `the copy cannot be read: ${errorMessage(error)}` }
  } finally {
    db?.close()
  }
}

interface SnapRow {
  path: string
  version: string
  text: string | null
  bytes: Uint8Array | null
  media_type: string | null
  size: number
  updated_at: number
}

export function createBackupService(options: BackupServiceOptions): BackupPort {
  const { sqlite, dir } = options
  const now = options.now ?? Date.now
  const appVersion = options.appVersion ?? 'unknown'
  mkdirSync(dir, { recursive: true })
  const path = (id: string, ext: 'db' | 'zip' | 'json'): string => join(dir, `${id}.${ext}`)
  const known = (id: string): boolean => ID.test(id)

  // one snapshot at a time on this instance
  let chain: Promise<unknown> = Promise.resolve()
  const serial = <T>(job: () => Promise<T>): Promise<T> => {
    const next = chain.then(job, job)
    chain = next.catch(() => undefined)
    return next
  }

  const readRecord = (id: string): BackupRecord | undefined => {
    try {
      return JSON.parse(readFileSync(path(id, 'json'), 'utf8')) as BackupRecord
    } catch {
      return undefined
    }
  }

  const list = (): BackupRecord[] => {
    const names = readdirSync(dir)
    const ids = new Set<string>()
    for (const n of names) {
      const m = /^(.*)\.(db|json)$/.exec(n)
      if (m?.[1] !== undefined && known(m[1])) ids.add(m[1])
    }
    const out: BackupRecord[] = []
    for (const id of ids) {
      const rec = readRecord(id)
      if (rec !== undefined) {
        out.push(rec)
        continue
      }
      // a copy without its sidecar (a crash between the two renames): shown, never trusted
      if (existsSync(path(id, 'db'))) {
        out.push({
          id,
          createdAt: statSync(path(id, 'db')).mtimeMs,
          reason: 'unknown',
          kind: 'manual',
          dbBytes: statSync(path(id, 'db')).size,
          filesBytes: null,
          fileCount: 0,
          agentCount: 0,
          verified: false,
          error: 'incomplete: the record of this snapshot is missing',
          exportError: null,
        })
      }
    }
    return out.sort((a, b) => b.createdAt - a.createdAt)
  }

  const create = (reason: string, entities: readonly EntityFile[] = []): Promise<BackupRecord> =>
    serial(async () => {
      const at = now()
      const id = `team-${stampOf(at)}-${crypto
        .randomUUID()
        .slice(0, 4)
        .replace(/[^0-9a-f]/g, '0')}`
      const tmpDb = `${path(id, 'db')}.tmp`
      const tmpZip = `${path(id, 'zip')}.tmp`
      const before = countsOf(sqlite)
      // VACUUM INTO: a read transaction of its own, so writers carry on and the copy is one
      // consistent point in time (never half of a transaction)
      try {
        sqlite.run(`VACUUM INTO '${tmpDb.replaceAll("'", "''")}'`)
      } catch (error) {
        rmSync(tmpDb, { force: true })
        throw new Error(`the database copy could not be written: ${errorMessage(error)}`)
      }
      const after = countsOf(sqlite)
      options.afterCopy?.(tmpDb)
      const verdict = verifyCopy(tmpDb, before, after)
      let filesBytes: number | null = null
      let fileCount = 0
      let exportError: string | null = null
      if (verdict.ok) {
        const copy = new Database(tmpDb, { readonly: true, strict: true })
        try {
          const out = writeWorkspaceZip(copy, tmpZip, entities, { now: at, appVersion })
          filesBytes = out.bytes
          fileCount = out.files
        } catch (error) {
          exportError = errorMessage(error)
          rmSync(tmpZip, { force: true })
        } finally {
          copy.close()
        }
      }
      renameSync(tmpDb, path(id, 'db'))
      if (filesBytes !== null) renameSync(tmpZip, path(id, 'zip'))
      const record: BackupRecord = {
        id,
        createdAt: at,
        reason,
        kind: kindOfReason(reason),
        dbBytes: statSync(path(id, 'db')).size,
        filesBytes,
        fileCount,
        agentCount: verdict.ok ? verdict.counts.agents : 0,
        verified: verdict.ok,
        error: verdict.ok ? null : verdict.error,
        exportError,
      }
      writeFileSync(`${path(id, 'json')}.tmp`, JSON.stringify(record, null, 2))
      renameSync(`${path(id, 'json')}.tmp`, path(id, 'json'))
      return record
    })

  /** The snapshot as a read-only database (the caller closes it). */
  const open = (id: string): Database | undefined => {
    if (!known(id) || !existsSync(path(id, 'db'))) return undefined
    return new Database(path(id, 'db'), { readonly: true, strict: true })
  }

  const scopeWhere = (scope: string): { sql: string; params: Array<string | number> } =>
    scope === '/'
      ? { sql: '1 = 1', params: [] }
      : {
          sql: '(path = ? OR substr(path, 1, ?) = ?)',
          params: [scope, scope.length + 1, `${scope}/`],
        }

  const ORDER: Record<RestoreAction, number> = { create: 0, replace: 1, keep: 2, same: 3 }

  const plan = (db: Database, scope: string, mode: RestoreMode): RestorePlan => {
    const where = scopeWhere(scope)
    const rows = db
      .query<
        { path: string; version: string; size: number; updated_at: number },
        Array<string | number>
      >(
        `SELECT path, version, size, updated_at FROM library_files WHERE ${where.sql} ORDER BY path`,
      )
      .all(...where.params)
    const live = sqlite.query<{ version: string; size: number; updated_at: number }, [string]>(
      'SELECT version, size, updated_at FROM library_files WHERE path = ?',
    )
    const counts: Record<RestoreAction, number> = { create: 0, replace: 0, keep: 0, same: 0 }
    const entries: RestoreEntry[] = []
    for (const r of rows) {
      const cur = live.get(r.path)
      const action: RestoreAction =
        cur === null
          ? 'create'
          : cur.version === r.version
            ? 'same'
            : mode === 'all'
              ? 'replace'
              : 'keep'
      counts[action]++
      entries.push({
        path: r.path,
        action,
        snapshotSize: r.size,
        snapshotUpdatedAt: r.updated_at,
        liveSize: cur?.size ?? null,
        liveUpdatedAt: cur?.updated_at ?? null,
        liveIsNewer: cur !== null && cur.updated_at > r.updated_at,
      })
    }
    entries.sort((a, b) => ORDER[a.action] - ORDER[b.action])
    return {
      path: scope,
      mode,
      counts,
      entries: entries.slice(0, RESTORE_LIST_MAX),
      truncated: entries.length > RESTORE_LIST_MAX,
    }
  }

  // --- workspace zips: uploads, on-demand exports, restore points -----------------------------

  const tempFile = (name: string): string => join(dir, name)
  /** Staged uploads and on-demand exports older than the TTL (a crash or an abandoned import). */
  const sweepTemp = (): void => {
    const cutoff = now() - TEMP_TTL_MS
    for (const n of readdirSync(dir)) {
      if (!/^(import-up-[0-9a-f]{16}\.(zip|json)|export-.*\.zip)(\.tmp)?$/.test(n)) continue
      try {
        if (statSync(join(dir, n)).mtimeMs < cutoff) rmSync(join(dir, n), { force: true })
      } catch {
        // gone meanwhile
      }
    }
  }

  const readPoint = (id: string): RestorePoint | undefined => {
    try {
      return JSON.parse(readFileSync(tempFile(`${id}.json`), 'utf8')) as RestorePoint
    } catch {
      return undefined
    }
  }
  const writePoint = (point: RestorePoint): void => {
    const file = tempFile(`${point.id}.json`)
    writeFileSync(`${file}.tmp`, JSON.stringify(point, null, 2))
    renameSync(`${file}.tmp`, file)
  }

  const workspaceBytes = (source: ImportSource): Uint8Array => {
    if ('backupId' in source) {
      if (!known(source.backupId) || !existsSync(path(source.backupId, 'zip'))) {
        throw notFound('Backup export', source.backupId)
      }
      return readFileSync(path(source.backupId, 'zip'))
    }
    if (
      !UPLOAD_ID.test(source.uploadId) ||
      !existsSync(tempFile(`import-${source.uploadId}.zip`))
    ) {
      throw notFound('Uploaded zip', source.uploadId)
    }
    return readFileSync(tempFile(`import-${source.uploadId}.zip`))
  }

  const data = createDataTables(sqlite)
  const dbFile = options.dbFile

  const tmp = resolve(tmpdir())
  const abs = resolve(dir)
  return {
    dir,
    // under the OS temporary directory: cleared when the container restarts
    temporary: abs === tmp || abs.startsWith(`${tmp}${sep}`),
    create,
    data,
    database: {
      file: dbFile,
      counts(id) {
        const db = open(id)
        if (db === undefined) return undefined
        try {
          return tableCounts(db)
        } finally {
          db.close()
        }
      },
      stage(id, info) {
        if (dbFile === undefined) {
          throw conflict(
            'The whole database cannot be restored here: this server runs on an in-memory database',
            'RESTORE_UNAVAILABLE',
          )
        }
        if (!known(id) || !existsSync(path(id, 'db'))) throw notFound('Backup', id)
        const record = readRecord(id)
        if (record !== undefined && !record.verified) {
          throw conflict(
            'This backup did not verify, so it is not restored (pick a verified one)',
            'BACKUP_NOT_VERIFIED',
          )
        }
        const verdict = inspectDatabase(path(id, 'db'))
        if (!verdict.ok) {
          throw conflict(
            `This backup is damaged and is not restored (${verdict.error})`,
            'BACKUP_NOT_VERIFIED',
          )
        }
        const live =
          sqlite.query<{ n: number }, []>('SELECT count(*) AS n FROM __drizzle_migrations').get()
            ?.n ?? 0
        if (verdict.migrations > live) {
          throw conflict(
            'This backup was made by a newer version of the server than the one running: update the server first',
            'BACKUP_TOO_NEW',
          )
        }
        stageRestore(dbFile, path(id, 'db'), info)
      },
      pending: () => (dbFile === undefined ? undefined : readPendingRestore(dbFile)),
      cancel() {
        if (dbFile !== undefined) cancelPendingRestore(dbFile)
      },
      lastResult: () => (dbFile === undefined ? undefined : readRestoreResult(dbFile)),
    },
    async exportNow(entities) {
      sweepTemp()
      const at = now()
      const name = `export-${stampOf(at)}-${crypto.randomUUID().slice(0, 4)}.zip`
      const file = tempFile(name)
      writeWorkspaceZip(sqlite, `${file}.tmp`, entities, { now: at, appVersion })
      renameSync(`${file}.tmp`, file)
      return {
        stream: Bun.file(file).stream(),
        size: statSync(file).size,
        filename: `team-workspace-${stampOf(at)}.zip`,
        mediaType: 'application/zip',
      }
    },
    async readWorkspace(source) {
      return parseWorkspaceZip(workspaceBytes(source))
    },
    async stageUpload(bytes, name) {
      if (bytes.byteLength > IMPORT_LIMITS.zipBytes) {
        throw invalid(
          `The zip was refused: it is larger than ${IMPORT_LIMITS.zipBytes / 1048576} MB`,
          'IMPORT_REFUSED',
        )
      }
      sweepTemp()
      // verified before it is kept: a refused zip never reaches the preview
      await parseWorkspaceZip(bytes)
      const uploadId = `up-${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`
      const file = tempFile(`import-${uploadId}.zip`)
      writeFileSync(`${file}.tmp`, bytes)
      renameSync(`${file}.tmp`, file)
      return { uploadId, name: name.slice(0, 120) }
    },
    async writeFile(filePath, bytes, opts) {
      const fs = libraryFs(sqlite, options.onChange ? { onChange: options.onChange } : {})
      const written = await fs.writeBytes?.(filePath, bytes, {
        ifVersion: opts.ifVersion,
        ...(opts.mediaType === null ? {} : { mediaType: opts.mediaType }),
      })
      return written?.ok === true
    },
    async deleteFile(filePath, ifVersion) {
      const fs = libraryFs(sqlite, options.onChange ? { onChange: options.onChange } : {})
      return (await fs.delete(filePath, { ifVersion })).ok
    },
    async moveFile(from, to, ifVersion) {
      const fs = libraryFs(sqlite, options.onChange ? { onChange: options.onChange } : {})
      const moved = await (fs.move as NonNullable<typeof fs.move>)(
        from,
        to,
        ifVersion === null ? {} : { ifVersion },
      )
      return moved.ok ? 'ok' : moved.reason
    },
    moves: {
      list: () => listMoves(sqlite),
      add: (moves) => addMoves(sqlite, moves),
      removeOf: (restorePointId) => removeMovesOf(sqlite, restorePointId),
    },
    activeReminders() {
      return sqlite
        .query<
          {
            id: string
            agent_id: string
            connection_id: string
            node_id: string
            body: string
            mentions: string
            schedule: string
            when_text: string
            timezone: string
            created_at: number
            fire_count: number
          },
          []
        >(
          "SELECT id, agent_id, connection_id, node_id, body, mentions, schedule, when_text, timezone, created_at, fire_count FROM ch_reminders WHERE status = 'active' ORDER BY created_at, id",
        )
        .all()
        .map(
          (r): ReminderRecord => ({
            id: r.id,
            agentId: r.agent_id,
            connectionId: r.connection_id,
            nodeId: r.node_id,
            body: r.body,
            mentions: JSON.parse(r.mentions) as string[],
            schedule: JSON.parse(r.schedule) as unknown,
            whenText: r.when_text,
            timezone: r.timezone,
            createdAt: r.created_at,
            fireCount: r.fire_count,
          }),
        )
    },
    restorePoints: {
      list() {
        return readdirSync(dir)
          .flatMap((n) => {
            const m = /^(rp-.*)\.json$/.exec(n)
            return m?.[1] !== undefined && POINT_ID.test(m[1]) ? [m[1]] : []
          })
          .flatMap((id) => {
            const p = readPoint(id)
            return p === undefined ? [] : [p]
          })
          .sort((a, b) => b.at - a.at)
      },
      get: (id) => (POINT_ID.test(id) ? readPoint(id) : undefined),
      add: (point) => writePoint(point),
      markUndone(id, by) {
        const p = POINT_ID.test(id) ? readPoint(id) : undefined
        if (p !== undefined) writePoint({ ...p, undoneBy: by })
      },
    },
    list,
    get: (id) => (known(id) ? list().find((r) => r.id === id) : undefined),
    remove(id) {
      if (!known(id)) return false
      let removed = false
      for (const ext of ['json', 'db', 'zip'] as const) {
        if (existsSync(path(id, ext))) {
          rmSync(path(id, ext), { force: true })
          removed = true
        }
      }
      return removed
    },
    download(id, what) {
      if (!known(id)) return undefined
      const file = path(id, what === 'db' ? 'db' : 'zip')
      if (!existsSync(file)) return undefined
      return {
        stream: Bun.file(file).stream(),
        size: statSync(file).size,
        filename: `${id}.${what === 'db' ? 'db' : 'zip'}`,
        mediaType: what === 'db' ? 'application/vnd.sqlite3' : 'application/zip',
      }
    },
    entries(id, prefix, limit) {
      const db = open(id)
      if (db === undefined) return undefined
      try {
        const where = scopeWhere(normalizeScope(prefix))
        return db
          .query<{ path: string; size: number; updated_at: number }, Array<string | number>>(
            `SELECT path, size, updated_at FROM library_files WHERE ${where.sql} ORDER BY path LIMIT ${Math.max(1, Math.floor(limit))}`,
          )
          .all(...where.params)
          .map((r) => ({ path: r.path, size: r.size, updatedAt: r.updated_at }))
      } finally {
        db.close()
      }
    },
    restorePlan(id, scope, mode) {
      const db = open(id)
      if (db === undefined) return undefined
      try {
        return plan(db, normalizeScope(scope), mode)
      } finally {
        db.close()
      }
    },
    async restore(id, scope, mode) {
      const db = open(id)
      if (db === undefined) return undefined
      try {
        const clean = normalizeScope(scope)
        const where = scopeWhere(clean)
        const fs = libraryFs(sqlite, options.onChange ? { onChange: options.onChange } : {})
        const rows = db
          .query<SnapRow, Array<string | number>>(
            `SELECT path, version, text, bytes, media_type, size, updated_at FROM library_files WHERE ${where.sql} ORDER BY path`,
          )
          .all(...where.params)
        const result: RestoreResult = {
          created: 0,
          replaced: 0,
          unchanged: 0,
          kept: 0,
          failed: [],
        }
        for (const r of rows) {
          const cur = sqlite
            .query<{ version: string }, [string]>(
              'SELECT version FROM library_files WHERE path = ?',
            )
            .get(r.path)
          if (cur !== null && cur.version === r.version) {
            result.unchanged++
            continue
          }
          if (cur !== null && mode !== 'all') {
            result.kept++
            continue
          }
          // create only if still absent, replace only the version that was seen: a file that
          // changed meanwhile is never overwritten
          const ifVersion = cur === null ? null : cur.version
          try {
            const written =
              r.bytes !== null
                ? await fs.writeBytes?.(r.path, r.bytes, {
                    ifVersion,
                    ...(r.media_type === null ? {} : { mediaType: r.media_type }),
                  })
                : await fs.write(r.path, r.text ?? '', { ifVersion })
            if (written?.ok === true) {
              if (cur === null) result.created++
              else result.replaced++
            } else {
              result.failed.push({ path: r.path, error: 'changed while restoring: left as it is' })
            }
          } catch (error) {
            result.failed.push({ path: r.path, error: errorMessage(error) })
          }
        }
        return result
      } finally {
        db.close()
      }
    },
  }
}
