/**
 * Storage monitoring (Settings > Storage): what the data directory holds, how big it is and when
 * the owner should worry. Pure: the scan itself (file system, SQLite) is `infra/storage`.
 */

export const GB = 1024 ** 3

/** The volume is low when less than this share of it is free ... */
export const LOW_DISK_FRACTION = 0.1
/** ... or less than this many bytes. */
export const LOW_DISK_BYTES = 2 * GB

/** How long a scan is reused. */
export const SCAN_CACHE_MS = 60_000

export interface VolumeInfo {
  totalBytes: number
  usedBytes: number
  freeBytes: number
}

export const TABLE_GROUPS = [
  'chats',
  'library',
  'model-calls',
  'events',
  'channels',
  'tasks',
  'backups',
  'other',
] as const
export type TableGroup = (typeof TABLE_GROUPS)[number]

export const TABLE_GROUP_LABEL: Record<TableGroup, string> = {
  chats: 'Chats and messages',
  library: 'Library',
  'model-calls': 'Model call log',
  events: 'Events',
  channels: 'Channels log',
  tasks: 'Tasks and runs',
  backups: 'Backups metadata',
  other: 'Other',
}

const CHAT_TABLES = new Set([
  'chats',
  'chat_threads',
  'chat_tool_overrides',
  'session_modes',
  'turn_retries',
])

/** The feature a table belongs to. */
export function groupOfTable(name: string): TableGroup {
  if (name === 'model_calls') return 'model-calls'
  if (name === 'events') return 'events'
  if (name === 'library_files' || name === 'library_history') return 'library'
  if (name.startsWith('backup')) return 'backups'
  if (
    name.startsWith('channel_') ||
    name.startsWith('ch_') ||
    name.startsWith('tgu_') ||
    name.startsWith('people')
  )
    return 'channels'
  if (CHAT_TABLES.has(name) || name.startsWith('eh_messages') || name.startsWith('eh_inbox'))
    return 'chats'
  if (name === 'eh_stream_log' || name === 'eh_stream_chunks') return 'chats'
  if (
    name === 'tasks' ||
    name === 'routine_runs' ||
    name === 'routines' ||
    name === 'programs' ||
    name === 'rehearsals' ||
    name === 'program_tests'
  )
    return 'tasks'
  return 'other'
}

/**
 * The folder a library path is counted under: `/library/<top>`, `/memories/agents/<agent>`,
 * `/uploads`, `/.eharness/tool-media`, `/skills`, anything else `other`.
 */
export function folderOfLibraryPath(path: string): string {
  const parts = path.split('/').filter((p) => p !== '')
  const [a, b, c] = parts
  if (a === 'library') return parts.length > 2 && b !== undefined ? `/library/${b}` : '/library'
  if (a === 'memories') {
    if (b === 'agents' && c !== undefined && parts.length > 3) return `/memories/agents/${c}`
    return '/memories'
  }
  if (a === 'uploads') return '/uploads'
  if (a === '.eharness' && b === 'tool-media') return '/.eharness/tool-media'
  if (a === 'skills') return '/skills'
  return 'other'
}

/** Less than 10% or less than 2 GB free. */
export function isLowDisk(v: Pick<VolumeInfo, 'totalBytes' | 'freeBytes'>): boolean {
  if (v.totalBytes <= 0) return false
  return v.freeBytes < v.totalBytes * LOW_DISK_FRACTION || v.freeBytes < LOW_DISK_BYTES
}

/** Human size for texts (the web has its own formatter). */
export function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let n = bytes / 1024
  let i = 0
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i++
  }
  return `${n >= 100 ? n.toFixed(0) : n.toFixed(1)} ${units[i]}`
}

/** What the owner is told when the volume is low. */
export function lowDiskText(v: VolumeInfo, dir: string): string {
  const pct = v.totalBytes > 0 ? Math.round((v.freeBytes / v.totalBytes) * 100) : 0
  return `The disk holding the data directory (${dir}) is nearly full: ${sizeText(v.freeBytes)} free of ${sizeText(v.totalBytes)} (${pct}%). Next: open Settings > Storage, apply retention or clear old media, or grow the volume; the database stops accepting writes when the disk is full.`
}

/** VACUUM writes a full copy of the database: it needs about that much free space (plus a margin). */
export function compactNeeds(dbBytes: number): number {
  return Math.ceil(dbBytes * 1.1)
}

export interface TableUsage {
  name: string
  group: TableGroup
  rows: number | null
  /** Table plus its indexes; null when `dbstat` is not available. */
  bytes: number | null
}

export interface GroupUsage {
  group: TableGroup
  label: string
  rows: number
  bytes: number | null
}

/** Sum tables per feature, biggest first (groups without tables are left out). */
export function groupUsage(tables: readonly TableUsage[]): GroupUsage[] {
  const sums = new Map<TableGroup, { rows: number; bytes: number | null }>()
  for (const t of tables) {
    const s = sums.get(t.group) ?? { rows: 0, bytes: 0 }
    s.rows += t.rows ?? 0
    s.bytes = s.bytes === null || t.bytes === null ? null : s.bytes + t.bytes
    sums.set(t.group, s)
  }
  return [...sums.entries()]
    .map(([group, s]) => ({ group, label: TABLE_GROUP_LABEL[group], ...s }))
    .sort((a, b) => (b.bytes ?? b.rows) - (a.bytes ?? a.rows))
}

export interface FolderUsage {
  folder: string
  files: number
  bytes: number
}

export interface DirUsage {
  /** `code-scratch`, `code-env` or `browser`. */
  id: string
  label: string
  path: string
  exists: boolean
  bytes: number
  files: number
  /** The walk stopped at its entry or time cap: the numbers are lower bounds. */
  approximate: boolean
  /** Biggest first-level entries (profiles, runtimes, ...). */
  children: Array<{ name: string; bytes: number }>
}

export interface KeyFileInfo {
  /** `secret.key` or `channel.key`. */
  file: string
  /** The environment variable that replaces it. */
  env: string
  present: boolean
  envSet: boolean
}

export interface StorageReport {
  scannedAt: number
  /** Scan duration in ms (the cached report keeps the one of its scan). */
  tookMs: number
  dataDir: string
  volume: (VolumeInfo & { path: string }) | null
  database: {
    file: string
    dbBytes: number
    walBytes: number
    shmBytes: number
    totalBytes: number
    pageSize: number
    pageCount: number
    freelistPages: number
    reclaimableBytes: number
    autoVacuum: 'none' | 'full' | 'incremental'
    /** Per-table sizes come from `dbstat`; without it only row counts are known. */
    perTableBytes: boolean
    tables: TableUsage[]
    groups: GroupUsage[]
  }
  library: {
    files: number
    bytes: number
    folders: FolderUsage[]
    history: { versions: number; bytes: number | null }
  }
  backups: {
    path: string
    exists: boolean
    files: number
    snapshots: number
    totalBytes: number
    newestAt: number | null
    oldestAt: number | null
    /** Same file system as the database: a disk loss takes both. Null when unknown. */
    sameVolume: boolean | null
  } | null
  others: DirUsage[]
  keys: KeyFileInfo[]
}

export interface StorageWarning {
  code: 'low-disk' | 'backups-same-disk' | 'key-file' | 'approximate' | 'reclaimable'
  text: string
}

/** Everything the owner should look at, in order of importance. */
export function storageWarnings(report: StorageReport): StorageWarning[] {
  const out: StorageWarning[] = []
  const v = report.volume
  if (v !== null && isLowDisk(v)) {
    out.push({
      code: 'low-disk',
      text: `Only ${sizeText(v.freeBytes)} free of ${sizeText(v.totalBytes)} on the data volume. Free space (retention, clear media) or grow the volume.`,
    })
  }
  const b = report.backups
  if (b !== null && b.sameVolume === true && b.files > 0) {
    out.push({
      code: 'backups-same-disk',
      text: 'Backups are on the same disk as the database: copies there do not survive a disk loss. Mount TEAM_BACKUP_DIR on another volume or copy the backups off the server.',
    })
  }
  if (b !== null && b.sameVolume === true && b.files === 0) {
    out.push({
      code: 'backups-same-disk',
      text: 'The backup directory is on the same disk as the database: copies there do not survive a disk loss.',
    })
  }
  for (const k of report.keys) {
    if (k.present && !k.envSet) {
      out.push({
        code: 'key-file',
        text: `${k.env} is not set: a development key in ${k.file} next to the database encrypts the data. Set ${k.env} (openssl rand -base64 32) and keep it apart from the data.`,
      })
    }
  }
  if (report.database.reclaimableBytes >= 64 * 1024 * 1024) {
    out.push({
      code: 'reclaimable',
      text: `${sizeText(report.database.reclaimableBytes)} of the database file is free pages: "Compact database" gives it back to the disk.`,
    })
  }
  for (const d of report.others) {
    if (d.approximate)
      out.push({
        code: 'approximate',
        text: `${d.label} is large: its size is approximate (the scan stopped early).`,
      })
  }
  return out
}

export const STORAGE_ACTIONS = ['compact', 'checkpoint', 'retention', 'clear-media'] as const
export type StorageAction = (typeof STORAGE_ACTIONS)[number]

export interface StorageSizes {
  /** The database files together: `.db`, `-wal`, `-shm`. */
  dbBytes: number
  walBytes: number
  /** Free bytes of the data volume (null when unknown). */
  freeBytes: number | null
}

export interface StorageActionResult {
  action: StorageAction
  message: string
  before: StorageSizes
  after: StorageSizes
  /** What the action counted (rows removed per table, pages, ...). */
  detail: Record<string, number>
}

/** Days accepted by "clear media older than N days". */
export const CLEAR_MEDIA_DAYS = { min: 1, max: 3650, default: 3 } as const
