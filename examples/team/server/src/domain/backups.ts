/**
 * Backups of the database (snapshot = a verified copy plus a readable export of every library and
 * memory file). The rules here are pure: what the kinds are, which snapshots a retention keeps,
 * when the next automatic one is due. Files, SQLite and zip live in `infra/backup`.
 */
import { invalid } from './errors.ts'
import { isClock, localDay, localMinutes } from './heartbeat.ts'

/** `daily` scheduled, `startup` at boot, `manual` the button, `before` ahead of a risky operation. */
export const BACKUP_KINDS = ['daily', 'startup', 'manual', 'before'] as const
export type BackupKind = (typeof BACKUP_KINDS)[number]

/** Reason texts the automatic and manual snapshots use; anything else is a `before` snapshot. */
export const REASON_DAILY = 'daily'
export const REASON_STARTUP = 'startup'
export const REASON_MANUAL = 'manual'
export const beforeReason = (reason: string): string => `before: ${reason.trim() || 'operation'}`

export function kindOfReason(reason: string): BackupKind {
  if (reason === REASON_DAILY) return 'daily'
  if (reason === REASON_STARTUP) return 'startup'
  if (reason === REASON_MANUAL) return 'manual'
  return 'before'
}

/** A snapshot as listed: the sidecar of its files. */
export interface BackupRecord {
  id: string
  createdAt: number
  reason: string
  kind: BackupKind
  /** Size of the database copy in bytes. */
  dbBytes: number
  /** Size of the files export (zip); null = none was written. */
  filesBytes: number | null
  /** Library and memory files in the snapshot. */
  fileCount: number
  agentCount: number
  /** The copy passed `PRAGMA integrity_check` and its row counts matched the live database. */
  verified: boolean
  /** Why verification failed (null when it passed). */
  error: string | null
  /** Why the files export is missing (null when it exists). */
  exportError: string | null
}

/** A `before` snapshot is never pruned younger than this. */
export const BACKUP_PROTECT_DAYS = 30
/** The newest verified snapshot older than this is a stale backup (an alarm, a red banner). */
export const BACKUP_STALE_HOURS = 36
export const BACKUP_KEEP_DAILY_MAX = 365
export const BACKUP_KEEP_WEEKLY_MAX = 520

export interface BackupSettings {
  backupEnabled: boolean
  /** Local clock time (team timezone) of the daily snapshot, `HH:MM`. */
  backupTime: string
  backupKeepDaily: number
  backupKeepWeekly: number
  timezone: string
}

export function checkBackupPatch(patch: {
  backupTime?: string
  backupKeepDaily?: number
  backupKeepWeekly?: number
}): void {
  if (patch.backupTime !== undefined && !isClock(patch.backupTime)) {
    throw invalid('backupTime must be HH:MM (24 hours)', 'INVALID_SETTINGS')
  }
  const int = (name: string, v: number | undefined, min: number, max: number): void => {
    if (v === undefined) return
    if (!(Number.isInteger(v) && v >= min && v <= max)) {
      throw invalid(`${name} must be an integer from ${min} to ${max}`, 'INVALID_SETTINGS')
    }
  }
  int('backupKeepDaily', patch.backupKeepDaily, 1, BACKUP_KEEP_DAILY_MAX)
  int('backupKeepWeekly', patch.backupKeepWeekly, 0, BACKUP_KEEP_WEEKLY_MAX)
}

/** The Monday (`YYYY-MM-DD`) of the week a local day belongs to. */
export function weekOf(day: string): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number]
  const t = new Date(Date.UTC(y, m - 1, d))
  const back = (t.getUTCDay() + 6) % 7
  t.setUTCDate(t.getUTCDate() - back)
  return t.toISOString().slice(0, 10)
}

export interface RetentionPlan {
  keep: string[]
  remove: string[]
}

/**
 * Which snapshots a retention keeps. Only verified snapshots take part (a failed one is never
 * deleted by a rule: the owner sees it and decides). Kept: the newest of each of the last
 * `keepDaily` days that have a snapshot, the newest of each of the last `keepWeekly` weeks, the
 * newest snapshot of all, and every `before` snapshot younger than `BACKUP_PROTECT_DAYS`.
 */
export function planRetention(
  backups: readonly BackupRecord[],
  opts: { now: number; timezone: string; keepDaily: number; keepWeekly: number },
): RetentionPlan {
  const verified = backups.filter((b) => b.verified).sort((a, b) => b.createdAt - a.createdAt)
  const keep = new Set<string>()
  const newest = verified[0]
  if (newest !== undefined) keep.add(newest.id)
  const days = new Set<string>()
  const weeks = new Set<string>()
  for (const b of verified) {
    const day = localDay(b.createdAt, opts.timezone)
    if (!days.has(day) && days.size < opts.keepDaily) {
      days.add(day)
      keep.add(b.id)
    }
    const week = weekOf(day)
    if (!weeks.has(week) && weeks.size < opts.keepWeekly) {
      weeks.add(week)
      keep.add(b.id)
    }
    if (b.kind === 'before' && opts.now - b.createdAt < BACKUP_PROTECT_DAYS * 86_400_000) {
      keep.add(b.id)
    }
  }
  return {
    keep: verified.filter((b) => keep.has(b.id)).map((b) => b.id),
    remove: verified.filter((b) => !keep.has(b.id)).map((b) => b.id),
  }
}

const minutesOf = (clock: string): number => {
  const [h, m] = clock.split(':').map(Number) as [number, number]
  return h * 60 + m
}

/**
 * The automatic snapshot that is due now, or null. One verified `daily` or `startup` snapshot per
 * local day is enough; a start-up counts as due at once, the scheduled one from `backupTime` on.
 */
export function dueReason(
  backups: readonly BackupRecord[],
  opts: { now: number; startup: boolean; s: BackupSettings },
): 'daily' | 'startup' | null {
  if (!opts.s.backupEnabled) return null
  const today = localDay(opts.now, opts.s.timezone)
  const have = backups.some(
    (b) =>
      b.verified &&
      (b.kind === 'daily' || b.kind === 'startup') &&
      localDay(b.createdAt, opts.s.timezone) === today,
  )
  if (have) return null
  if (opts.startup) return 'startup'
  return localMinutes(opts.now, opts.s.timezone) >= minutesOf(opts.s.backupTime) ? 'daily' : null
}

/** The newest verified snapshot and whether it is too old (or there is none). */
export function backupFreshness(
  backups: readonly BackupRecord[],
  now: number,
): { lastVerifiedAt: number | null; stale: boolean } {
  const last = backups
    .filter((b) => b.verified)
    .reduce<number | null>((m, b) => (m === null || b.createdAt > m ? b.createdAt : m), null)
  return {
    lastVerifiedAt: last,
    stale: last === null || now - last > BACKUP_STALE_HOURS * 3_600_000,
  }
}

// --- restore -----------------------------------------------------------------------------------

/** `missing`: restore only files that are gone; `all`: also replace files that differ. */
export const RESTORE_MODES = ['missing', 'all'] as const
export type RestoreMode = (typeof RESTORE_MODES)[number]

/** `create` absent now, `replace` differs (and is replaced), `keep` differs (left alone), `same`. */
export type RestoreAction = 'create' | 'replace' | 'keep' | 'same'

export interface RestoreEntry {
  path: string
  action: RestoreAction
  snapshotSize: number
  snapshotUpdatedAt: number
  liveSize: number | null
  liveUpdatedAt: number | null
  /** The live file changed after the snapshot was taken (replacing it loses that newer text). */
  liveIsNewer: boolean
}

export interface RestorePlan {
  /** The scope as normalized (`/` = everything). */
  path: string
  mode: RestoreMode
  counts: Record<RestoreAction, number>
  /** At most `RESTORE_LIST_MAX` entries, changes first. */
  entries: RestoreEntry[]
  truncated: boolean
}

export const RESTORE_LIST_MAX = 500

/** A restore scope: `/` (everything), a folder or one file; trailing slashes do not matter. */
export function normalizeScope(raw: string): string {
  const p = raw.trim()
  if (!p.startsWith('/') || p.length > 512 || p.includes('\0') || p.split('/').includes('..')) {
    throw invalid('path must be an absolute library or memory path, or /', 'INVALID_PATH')
  }
  return p === '/' ? '/' : p.replace(/\/+$/, '')
}

export interface RestoreResult {
  created: number
  replaced: number
  unchanged: number
  kept: number
  failed: Array<{ path: string; error: string }>
}

// --- restore points ----------------------------------------------------------------------------

/**
 * `import` a zip applied, `files-restore` files put back from a snapshot, `undo` a restore point
 * undone, `memory-reorganization` an agent's memory moved into the library (P57).
 */
export const RESTORE_POINT_KINDS = [
  'import',
  'files-restore',
  'undo',
  'memory-reorganization',
] as const
export type RestorePointKind = (typeof RESTORE_POINT_KINDS)[number]

export interface RestorePointItem {
  key: string
  action: 'added' | 'changed' | 'removed' | 'failed'
  note?: string
}

/**
 * The record of one import or restore: what was applied, from where, by whom, when, and the verified
 * safety backup taken right before. Undo = restore from that safety backup (and it is a restore
 * point itself, so an undo can be undone).
 */
export interface RestorePoint {
  id: string
  at: number
  /** Who applied it (the web owner). */
  by: string
  kind: RestorePointKind
  /** What was applied: a backup of the server, or an uploaded zip. */
  source: { kind: 'backup'; backupId: string; label: string } | { kind: 'upload'; label: string }
  /** The `before:` backup taken first; undo restores from it. */
  safetyBackupId: string
  /** The sections the apply touched. */
  sections: string[]
  /** The sections where items only in the workspace were removed. */
  removedSections: string[]
  counts: { added: number; changed: number; removed: number; failed: number }
  /** At most `RESTORE_POINT_ITEMS_MAX` items, failures first. */
  items: RestorePointItem[]
  /** The restore point this undoes. */
  undoOf: string | null
  /** The restore point that undid this one. */
  undoneBy: string | null
}

export const RESTORE_POINT_ITEMS_MAX = 500

/** `rp-<time>-<4 hex>`: sorts by time, like the backup ids. */
export function restorePointId(at: number): string {
  const stamp = new Date(at)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.(\d{3})Z$/, '$1Z')
  const hex = crypto
    .randomUUID()
    .slice(0, 4)
    .replace(/[^0-9a-f]/g, '0')
  return `rp-${stamp}-${hex}`
}
