/**
 * The storage scan (what lives in the data directory and how big it is) and the maintenance
 * actions of Settings > Storage. File system and SQLite only; the report is `domain/storage.ts`.
 *
 * The scan is cached for 60 s and runs once at a time. The directory walks are asynchronous (they
 * yield between directories), bounded by an entry cap and a time cap, and report `approximate`
 * when they stop early. Nothing here ever returns the content of a key file.
 */
import type { Database } from 'bun:sqlite'
import { existsSync, statfsSync, statSync } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { StoragePort } from '../../app/ports.ts'
import { conflict, invalid } from '../../domain/errors.ts'
import {
  CLEAR_MEDIA_DAYS,
  compactNeeds,
  type DirUsage,
  type FolderUsage,
  folderOfLibraryPath,
  groupOfTable,
  groupUsage,
  type KeyFileInfo,
  SCAN_CACHE_MS,
  type StorageAction,
  type StorageActionResult,
  type StorageReport,
  type StorageSizes,
  sizeText,
  type TableUsage,
  type VolumeInfo,
} from '../../domain/storage.ts'
import { pruneTables, reclaimSpace } from '../db/retention.ts'

export interface FsStats {
  /** Bytes per block times blocks. */
  totalBytes: number
  /** Bytes not used by anyone (including the share reserved for root). */
  usedBytes: number
  /** Bytes a normal process can still write. */
  freeBytes: number
}

/** `fs.statfs` as numbers; a seam for tests. */
export function realStatfs(path: string): FsStats | null {
  try {
    const s = statfsSync(path)
    const bsize = Number(s.bsize)
    return {
      totalBytes: Number(s.blocks) * bsize,
      usedBytes: (Number(s.blocks) - Number(s.bfree)) * bsize,
      freeBytes: Number(s.bavail) * bsize,
    }
  } catch {
    return null
  }
}

export interface StorageServiceOptions {
  sqlite: Database
  /** The database file (`:memory:` is not supported: no storage service then). */
  dbFile: string
  /** Where backups are written (undefined: none). */
  backupDir?: string | undefined
  /** Other directories to measure. */
  dirs?: Array<{ id: string; label: string; path: string }>
  env?: Record<string, string | undefined>
  /** Runs the configured retention cleanups; returns what each removed. */
  retention?: () => Promise<Record<string, number>> | Record<string, number>
  now?: () => number
  statfs?: (path: string) => FsStats | null
  /** Walk caps: entries visited and milliseconds spent per directory. */
  walk?: { maxEntries?: number; maxMs?: number }
  cacheMs?: number
}

const TOP_TABLES = 15
const TOP_FOLDERS = 30

interface Walked {
  bytes: number
  files: number
  approximate: boolean
  children: Array<{ name: string; bytes: number }>
}

/** Size of a directory tree: lstat per entry, no symlink following, capped. */
export async function walkDir(
  root: string,
  caps: { maxEntries: number; maxMs: number },
  now: () => number = Date.now,
): Promise<Walked> {
  const out: Walked = { bytes: 0, files: 0, approximate: false, children: [] }
  const started = now()
  let entries = 0
  const childBytes = new Map<string, number>()
  const stack: Array<{ dir: string; top: string | undefined }> = [{ dir: root, top: undefined }]
  while (stack.length > 0) {
    const next = stack.pop()
    if (next === undefined) break
    let names: import('node:fs').Dirent[]
    try {
      names = await readdir(next.dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const d of names) {
      if (entries >= caps.maxEntries || now() - started > caps.maxMs) {
        out.approximate = true
        stack.length = 0
        break
      }
      entries++
      const full = join(next.dir, d.name)
      const top = next.top ?? d.name
      if (d.isDirectory()) {
        stack.push({ dir: full, top })
        if (next.top === undefined && !childBytes.has(top)) childBytes.set(top, 0)
        continue
      }
      if (!d.isFile()) continue
      try {
        const size = (await stat(full)).size
        out.bytes += size
        out.files++
        childBytes.set(top, (childBytes.get(top) ?? 0) + size)
      } catch {
        // vanished while walking
      }
    }
    // let the server answer requests between directories
    await new Promise<void>((r) => setImmediate(r))
  }
  out.children = [...childBytes.entries()]
    .map(([name, bytes]) => ({ name, bytes }))
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, 8)
  return out
}

const fileSize = (path: string): number => {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

export function createStorageService(options: StorageServiceOptions): StoragePort {
  const { sqlite } = options
  const now = options.now ?? Date.now
  const statfs = options.statfs ?? realStatfs
  const dbFile = resolve(options.dbFile)
  const dataDir = resolve(dbFile, '..')
  const env = options.env ?? process.env
  const caps = {
    maxEntries: options.walk?.maxEntries ?? 60_000,
    maxMs: options.walk?.maxMs ?? 2_500,
  }
  const cacheMs = options.cacheMs ?? SCAN_CACHE_MS

  const volume = (): (VolumeInfo & { path: string }) | null => {
    const s = statfs(dataDir)
    return s === null ? null : { ...s, path: dataDir }
  }

  const sizes = (): StorageSizes => ({
    dbBytes: fileSize(dbFile) + fileSize(`${dbFile}-wal`) + fileSize(`${dbFile}-shm`),
    walBytes: fileSize(`${dbFile}-wal`),
    freeBytes: statfs(dataDir)?.freeBytes ?? null,
  })

  // --- database ----------------------------------------------------------------------------------

  const pragma = (name: string): number =>
    Number(
      Object.values(sqlite.query<Record<string, number>, []>(`PRAGMA ${name}`).get() ?? {})[0] ?? 0,
    )

  function tableUsage(): { tables: TableUsage[]; perTableBytes: boolean } {
    const names = sqlite
      .query<{ name: string; tbl_name: string; type: string }, []>(
        "SELECT name, tbl_name, type FROM sqlite_schema WHERE type IN ('table', 'index') AND name NOT LIKE 'sqlite_%'",
      )
      .all()
    const tableOf = new Map(names.map((n) => [n.name, n.tbl_name]))
    const bytes = new Map<string, number>()
    let perTableBytes = true
    try {
      for (const r of sqlite
        .query<{ name: string; bytes: number }, []>(
          'SELECT name, SUM(pgsize) AS bytes FROM dbstat GROUP BY name',
        )
        .all()) {
        const table = tableOf.get(r.name) ?? (r.name.startsWith('sqlite_') ? undefined : r.name)
        if (table !== undefined) bytes.set(table, (bytes.get(table) ?? 0) + r.bytes)
      }
    } catch {
      perTableBytes = false
    }
    const tableNames = [...new Set(names.filter((n) => n.type === 'table').map((n) => n.name))]
    const rows = (name: string): number | null => {
      try {
        return (
          sqlite.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM "${name}"`).get()?.n ?? null
        )
      } catch {
        return null
      }
    }
    if (perTableBytes) {
      const top = tableNames
        .map((name) => ({ name, bytes: bytes.get(name) ?? 0 }))
        .sort((a, b) => b.bytes - a.bytes)
      const tables: TableUsage[] = top.map((t) => ({
        name: t.name,
        group: groupOfTable(t.name),
        bytes: t.bytes,
        rows: rows(t.name),
      }))
      return { tables, perTableBytes }
    }
    const tables: TableUsage[] = tableNames
      .map((name) => ({ name, group: groupOfTable(name), bytes: null, rows: rows(name) }))
      .sort((a, b) => (b.rows ?? 0) - (a.rows ?? 0))
    return { tables, perTableBytes }
  }

  function databaseReport(): StorageReport['database'] {
    const pageSize = pragma('page_size')
    const pageCount = pragma('page_count')
    const freelist = pragma('freelist_count')
    const av = pragma('auto_vacuum')
    const { tables, perTableBytes } = tableUsage()
    const walBytes = fileSize(`${dbFile}-wal`)
    const dbBytes = fileSize(dbFile)
    const shmBytes = fileSize(`${dbFile}-shm`)
    return {
      file: dbFile,
      dbBytes,
      walBytes,
      shmBytes,
      totalBytes: dbBytes + walBytes + shmBytes,
      pageSize,
      pageCount,
      freelistPages: freelist,
      reclaimableBytes: freelist * pageSize,
      autoVacuum: av === 2 ? 'incremental' : av === 1 ? 'full' : 'none',
      perTableBytes,
      // all tables feed the groups; the list shows the biggest
      tables,
      groups: groupUsage(tables),
    }
  }

  function libraryReport(tables: TableUsage[]): StorageReport['library'] {
    const folders = new Map<string, FolderUsage>()
    let files = 0
    let bytes = 0
    for (const r of sqlite
      .query<{ path: string; size: number }, []>('SELECT path, size FROM library_files')
      .iterate()) {
      const folder = folderOfLibraryPath(r.path)
      const f = folders.get(folder) ?? { folder, files: 0, bytes: 0 }
      f.files++
      f.bytes += r.size
      folders.set(folder, f)
      files++
      bytes += r.size
    }
    const versions =
      sqlite.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM library_history').get()?.n ?? 0
    const historyTable = tables.find((t) => t.name === 'library_history')
    return {
      files,
      bytes,
      folders: [...folders.values()].sort((a, b) => b.bytes - a.bytes).slice(0, TOP_FOLDERS),
      history: { versions, bytes: historyTable?.bytes ?? null },
    }
  }

  async function backupsReport(): Promise<StorageReport['backups']> {
    const dir = options.backupDir
    if (dir === undefined) return null
    const path = resolve(dir)
    if (!existsSync(path)) {
      return {
        path,
        exists: false,
        files: 0,
        snapshots: 0,
        totalBytes: 0,
        newestAt: null,
        oldestAt: null,
        sameVolume: null,
      }
    }
    let files = 0
    let snapshots = 0
    let totalBytes = 0
    let newestAt: number | null = null
    let oldestAt: number | null = null
    for (const d of await readdir(path, { withFileTypes: true }).catch(() => [])) {
      if (!d.isFile()) continue
      try {
        const s = await stat(join(path, d.name))
        files++
        totalBytes += s.size
        if (d.name.endsWith('.db') && !d.name.startsWith('.')) {
          snapshots++
          newestAt = newestAt === null ? s.mtimeMs : Math.max(newestAt, s.mtimeMs)
          oldestAt = oldestAt === null ? s.mtimeMs : Math.min(oldestAt, s.mtimeMs)
        }
      } catch {
        // gone
      }
    }
    let sameVolume: boolean | null = null
    try {
      sameVolume = statSync(path).dev === statSync(dataDir).dev
    } catch {
      // unknown
    }
    return { path, exists: true, files, snapshots, totalBytes, newestAt, oldestAt, sameVolume }
  }

  async function othersReport(): Promise<DirUsage[]> {
    const out: DirUsage[] = []
    for (const d of options.dirs ?? []) {
      const path = resolve(d.path)
      if (!existsSync(path)) continue
      const walked = await walkDir(path, caps, now)
      out.push({ id: d.id, label: d.label, path, exists: true, ...walked })
    }
    return out
  }

  function keysReport(): KeyFileInfo[] {
    const key = (file: string, name: string): KeyFileInfo => ({
      file,
      env: name,
      present: existsSync(join(dataDir, file)),
      envSet: (env[name] ?? '').trim() !== '',
    })
    return [key('secret.key', 'TEAM_SECRET_KEY'), key('channel.key', 'TEAM_CHANNEL_KEY')]
  }

  // --- the cached scan -----------------------------------------------------------------------------

  let cached: StorageReport | undefined
  let inflight: Promise<StorageReport> | undefined

  async function scan(): Promise<StorageReport> {
    const started = now()
    const database = databaseReport()
    const library = libraryReport(database.tables)
    const [backups, others] = await Promise.all([backupsReport(), othersReport()])
    // the list keeps the biggest tables; the groups were summed over all of them
    const shown = database.tables.slice(0, TOP_TABLES)
    return {
      scannedAt: now(),
      tookMs: now() - started,
      dataDir,
      volume: volume(),
      database: { ...database, tables: shown },
      library,
      backups,
      others,
      keys: keysReport(),
    }
  }

  const report: StoragePort['report'] = (opts) => {
    if (opts?.refresh !== true && cached !== undefined && now() - cached.scannedAt < cacheMs) {
      return Promise.resolve(cached)
    }
    inflight ??= scan()
      .then((r) => {
        cached = r
        return r
      })
      .finally(() => {
        inflight = undefined
      })
    return inflight
  }

  // --- actions -------------------------------------------------------------------------------------

  let busy: StorageAction | undefined

  async function runAction(
    action: StorageAction,
    opts?: { days?: number },
  ): Promise<StorageActionResult> {
    if (busy !== undefined) {
      throw conflict(`"${busy}" is still running: wait for it to finish`, 'STORAGE_BUSY')
    }
    busy = action
    try {
      const before = sizes()
      const detail: Record<string, number> = {}
      let message: string
      if (action === 'compact') {
        const need = compactNeeds(before.dbBytes)
        const free = before.freeBytes
        if (free !== null && free < need) {
          throw conflict(
            `Not enough free disk to compact: it needs about ${sizeText(need)} free (the size of the database), ${sizeText(free)} are free. Free space first (retention, clear media) or grow the volume.`,
            'STORAGE_LOW_SPACE',
            { needBytes: need, freeBytes: free },
          )
        }
        sqlite.run('VACUUM')
        sqlite.run('PRAGMA wal_checkpoint(TRUNCATE)')
        message = 'Database compacted'
      } else if (action === 'checkpoint') {
        const r = sqlite
          .query<{ busy: number; log: number; checkpointed: number }, []>(
            'PRAGMA wal_checkpoint(TRUNCATE)',
          )
          .get()
        detail.busy = r?.busy ?? 0
        detail.walPages = r?.log ?? 0
        detail.checkpointedPages = r?.checkpointed ?? 0
        message =
          r?.busy === 1
            ? 'Checkpoint could not finish: a reader or writer is active. Try again in a moment'
            : 'WAL checkpointed'
      } else if (action === 'retention') {
        const removed = options.retention === undefined ? {} : await options.retention()
        Object.assign(detail, removed)
        if (reclaimSpace(sqlite, 200_000)) detail.reclaimed = 1
        sqlite.run('PRAGMA wal_checkpoint(PASSIVE)')
        message = 'Retention applied'
      } else {
        const days = opts?.days ?? CLEAR_MEDIA_DAYS.default
        if (!Number.isInteger(days) || days < CLEAR_MEDIA_DAYS.min || days > CLEAR_MEDIA_DAYS.max) {
          throw invalid(
            `days must be a whole number from ${CLEAR_MEDIA_DAYS.min} to ${CLEAR_MEDIA_DAYS.max}`,
          )
        }
        const pruned = pruneTables(
          sqlite,
          { mediaDays: days, routineRunsDays: 0, tasksDays: 0, libraryHistoryDays: 0 },
          now(),
        )
        detail.media = pruned.media
        if (reclaimSpace(sqlite, 200_000)) detail.reclaimed = 1
        sqlite.run('PRAGMA wal_checkpoint(PASSIVE)')
        message = `Tool media older than ${days} days cleared (${pruned.media} files)`
      }
      cached = undefined
      return { action, message, before, after: sizes(), detail }
    } finally {
      busy = undefined
    }
  }

  return { report, volume, run: runAction }
}
