/**
 * Backups: a verified snapshot of the database plus a readable export of every library and memory
 * file (`infra/backup`). A missing or failed backup is never silent: it raises a `system` alarm.
 *
 * Other code that is about to do something risky (a bulk move of memory into the library, a mass
 * delete) calls `backupBefore(deps, reason)` first and stops when it answers `ok: false`.
 */
import {
  type BackupRecord,
  backupFreshness,
  beforeReason,
  dueReason,
  normalizeScope,
  planRetention,
  REASON_MANUAL,
  type RestoreMode,
  type RestorePlan,
  type RestoreResult,
} from '../domain/backups.ts'
import { conflict, DomainError, notFound } from '../domain/errors.ts'
import { raiseSystemAlarm } from './alarms.ts'
import type { BackupDownload, BackupPort, Deps } from './ports.ts'

export type BackupOutcome =
  | { ok: true; backup: BackupRecord }
  | { ok: false; error: string; backup?: BackupRecord }

const warn = (message: string): void => console.warn(`team: backups: ${message}`)

function port(deps: Deps): BackupPort {
  if (deps.backups === undefined) {
    throw new DomainError(
      'conflict',
      'BACKUPS_UNAVAILABLE',
      'Backups are not available: this server runs on an in-memory database without TEAM_BACKUP_DIR',
    )
  }
  return deps.backups
}

/** Remove the snapshots the retention settings no longer keep. Returns the removed ids. */
export function pruneBackups(deps: Deps): string[] {
  if (deps.backups === undefined) return []
  const s = deps.settings.get()
  const plan = planRetention(deps.backups.list(), {
    now: deps.clock.now(),
    timezone: s.timezone,
    keepDaily: s.backupKeepDaily,
    keepWeekly: s.backupKeepWeekly,
  })
  for (const id of plan.remove) deps.backups.remove(id)
  return plan.remove
}

/**
 * Take a snapshot. Never throws: a failure (no copy written, verification failed, no export) is an
 * alarm and `ok: false` (a failed verification still leaves the unverified copy listed).
 */
export async function createBackup(
  deps: Deps,
  reason: string,
  options: { prune?: boolean } = {},
): Promise<BackupOutcome> {
  if (deps.backups === undefined) {
    const error = 'backups are not available (in-memory database without TEAM_BACKUP_DIR)'
    return { ok: false, error }
  }
  let backup: BackupRecord
  try {
    backup = await deps.backups.create(reason)
  } catch (error) {
    raiseSystemAlarm(deps, 'backup', error)
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
  if (!backup.verified) {
    const error = backup.error ?? 'verification failed'
    raiseSystemAlarm(deps, 'backup', new Error(`the copy did not verify: ${error}`))
    return { ok: false, error, backup }
  }
  if (backup.exportError !== null) {
    raiseSystemAlarm(deps, 'backup-export', new Error(backup.exportError))
  }
  if (options.prune !== false) {
    try {
      pruneBackups(deps)
    } catch (error) {
      warn(`retention failed: ${String(error)}`)
    }
  }
  return { ok: true, backup }
}

/**
 * Snapshot right before a risky operation. Never throws; the caller must not go on when
 * `ok` is false (the alarm is already raised).
 */
export function backupBefore(deps: Deps, reason: string): Promise<BackupOutcome> {
  return createBackup(deps, beforeReason(reason))
}

export function backupNow(deps: Deps): Promise<BackupOutcome> {
  return createBackup(deps, REASON_MANUAL)
}

export interface BackupOverview {
  dir: string
  backups: BackupRecord[]
  lastVerifiedAt: number | null
  /** No verified snapshot, or the newest is older than 36 hours. */
  stale: boolean
  enabled: boolean
  time: string
}

export function listBackups(deps: Deps): BackupOverview {
  const p = port(deps)
  const backups = p.list()
  const s = deps.settings.get()
  return {
    dir: p.dir,
    backups,
    ...backupFreshness(backups, deps.clock.now()),
    enabled: s.backupEnabled,
    time: s.backupTime,
  }
}

/** The newest verified snapshot is never deleted by hand: there is always one to restore from. */
export function deleteBackup(deps: Deps, id: string): void {
  const p = port(deps)
  const all = p.list()
  const target = all.find((b) => b.id === id)
  if (target === undefined) throw notFound('Backup', id)
  const newest = all.find((b) => b.verified)
  if (newest?.id === id) {
    throw conflict(
      'The newest verified backup is kept: take a new one first, then delete this one',
      'BACKUP_NEWEST',
    )
  }
  p.remove(id)
}

export function downloadBackup(deps: Deps, id: string, what: 'db' | 'files'): BackupDownload {
  const found = port(deps).download(id, what)
  if (found === undefined) throw notFound(what === 'db' ? 'Backup' : 'Backup export', id)
  return found
}

export function backupEntries(
  deps: Deps,
  id: string,
  prefix: string,
  limit: number,
): Array<{ path: string; size: number; updatedAt: number }> {
  const found = port(deps).entries(id, prefix, limit)
  if (found === undefined) throw notFound('Backup', id)
  return found
}

export function previewRestore(
  deps: Deps,
  id: string,
  input: { path: string; mode: RestoreMode },
): RestorePlan {
  const plan = port(deps).restorePlan(id, normalizeScope(input.path), input.mode)
  if (plan === undefined) throw notFound('Backup', id)
  return plan
}

/**
 * Put files of a snapshot back into the live database as new versions: a file that is gone is
 * created, a changed one is replaced only in mode `all`, and nothing is ever deleted. A full
 * safety snapshot is taken first; when it fails nothing is restored.
 */
export async function restoreFiles(
  deps: Deps,
  id: string,
  input: { path: string; mode: RestoreMode },
): Promise<RestoreResult & { safetyBackupId: string | null }> {
  const p = port(deps)
  const plan = previewRestore(deps, id, input)
  if (plan.counts.create + plan.counts.replace === 0) {
    return {
      created: 0,
      replaced: 0,
      unchanged: plan.counts.same,
      kept: plan.counts.keep,
      failed: [],
      safetyBackupId: null,
    }
  }
  const safety = await createBackup(deps, beforeReason(`restore of ${plan.path} from ${id}`), {
    // the snapshot being restored from must survive this run
    prune: false,
  })
  if (!safety.ok) {
    throw conflict(
      `Nothing was restored: the safety backup failed (${safety.error})`,
      'BACKUP_FAILED',
    )
  }
  const result = await p.restore(id, plan.path, input.mode)
  if (result === undefined) throw notFound('Backup', id)
  return { ...result, safetyBackupId: safety.backup.id }
}

// --- the schedule -------------------------------------------------------------------------------

/** A failed automatic attempt is retried no sooner than this. */
export const BACKUP_RETRY_MS = 30 * 60_000

export interface BackupScheduler {
  /** Take the automatic snapshot that is due, if any; `startup` for the first call after boot. */
  tick(startup?: boolean): Promise<BackupOutcome | undefined>
}

export function createBackupScheduler(deps: Deps): BackupScheduler {
  let lastFailure = 0
  return {
    async tick(startup = false) {
      if (deps.backups === undefined) return undefined
      const now = deps.clock.now()
      const s = deps.settings.get()
      const backups = deps.backups.list()
      const reason = dueReason(backups, { now, startup, s })
      if (reason !== null && (startup || now - lastFailure >= BACKUP_RETRY_MS)) {
        const out = await createBackup(deps, reason)
        if (!out.ok) lastFailure = now
        return out
      }
      // nothing due: still, a backup that is missing for a day and a half must be seen
      const fresh = backupFreshness(backups, now)
      if (s.backupEnabled && fresh.stale && backups.length > 0) {
        const age =
          fresh.lastVerifiedAt === null
            ? 'no snapshot has verified'
            : `no verified backup for ${Math.floor((now - fresh.lastVerifiedAt) / 3_600_000)} hours`
        raiseSystemAlarm(deps, 'backup-stale', new Error(`${age}; open Settings > Backups`))
      }
      return undefined
    },
  }
}
