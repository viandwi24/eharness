/**
 * Restore the whole database from a backup (not just the entities of the workspace zip): what the
 * owner does after a disaster, or to go back to a known state.
 *
 * It cannot swap a file a running server has open, so it is STAGED (`infra/backup/database-restore.ts`):
 *  1. the owner sees a preview (rows per table, backup against live) and types a confirmation phrase;
 *  2. a verified safety backup of the live database is taken first (nothing is staged when it fails);
 *  3. the backup's copy is verified again and staged next to the database;
 *  4. a restore point is recorded (it lives in the backup directory, so it survives the swap);
 *  5. the server restarts (`Lifecycle`; without one the owner restarts it) and the copy is swapped in
 *     before the database opens.
 * Undo is the same operation with the safety backup as the source, so an undo can be undone too.
 */
import { COVERAGE_BY_TABLE, type TableClass } from '../domain/backup-coverage.ts'
import {
  type BackupRecord,
  beforeReason,
  RESTORE_POINT_ITEMS_MAX,
  type RestorePoint,
  restorePointId,
} from '../domain/backups.ts'
import { conflict, invalid, notFound } from '../domain/errors.ts'
import { backupPort } from './backup-port.ts'
import { createBackup } from './backups.ts'
import type { Deps, PendingDatabaseRestore } from './ports.ts'

/** What the owner types to confirm; compared without regard to case and surrounding space. */
export const RESTORE_PHRASE = 'restore whole database'

export interface DatabaseRestoreTable {
  table: string
  class: TableClass | 'unknown'
  feature: string
  backup: number
  live: number
  delta: number
}

export interface DatabaseRestorePreview {
  backup: BackupRecord
  phrase: string
  tables: DatabaseRestoreTable[]
  totals: { backup: number; live: number }
  /** `automatic`: the server restarts itself; `manual`: the owner restarts it. */
  restart: 'automatic' | 'manual'
  /** A restore that is staged and waits for the restart. */
  pending: PendingDatabaseRestore | null
  warnings: string[]
}

const BOOKKEEPING = new Set(['__drizzle_migrations', 'sqlite_sequence'])

export function previewDatabaseRestore(deps: Deps, backupId: string): DatabaseRestorePreview {
  const port = backupPort(deps)
  const backup = port.get(backupId)
  if (backup === undefined) throw notFound('Backup', backupId)
  const theirs = port.database.counts(backupId)
  if (theirs === undefined) throw notFound('Backup', backupId)
  const ours = port.data.counts()
  const names = [...new Set([...Object.keys(theirs), ...Object.keys(ours)])]
    .filter((t) => !BOOKKEEPING.has(t))
    .sort()
  const tables: DatabaseRestoreTable[] = names.map((table) => {
    const entry = COVERAGE_BY_TABLE.get(table)
    const b = theirs[table] ?? 0
    const l = ours[table] ?? 0
    return {
      table,
      class: entry?.class ?? 'unknown',
      feature: entry?.feature ?? table,
      backup: b,
      live: l,
      delta: b - l,
    }
  })
  tables.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || (a.table < b.table ? -1 : 1))
  const warnings: string[] = [
    'Everything written after this backup is lost from the running database (the safety backup taken first keeps it, and the restore can be undone).',
    "Secrets in the database copy are sealed with this server's key (TEAM_SECRET_KEY) and the channel log with TEAM_CHANNEL_KEY: the server must run with the same keys as when the backup was made, or they cannot be read.",
  ]
  if (port.database.file === undefined) {
    warnings.unshift('This server runs on an in-memory database: it cannot be restored.')
  }
  if (!backup.verified) {
    warnings.unshift('This backup did not verify: it cannot be restored.')
  }
  return {
    backup,
    phrase: RESTORE_PHRASE,
    tables,
    totals: {
      backup: tables.reduce((n, t) => n + t.backup, 0),
      live: tables.reduce((n, t) => n + t.live, 0),
    },
    restart: deps.lifecycle === undefined ? 'manual' : 'automatic',
    pending: port.database.pending() ?? null,
    warnings,
  }
}

export interface DatabaseRestoreResult {
  restorePointId: string
  safetyBackupId: string
  restart: 'automatic' | 'manual'
}

export async function restoreDatabase(
  deps: Deps,
  backupId: string,
  input: { confirm: string; by: string; undoOf?: string | undefined },
): Promise<DatabaseRestoreResult> {
  const port = backupPort(deps)
  if (input.confirm.trim().toLowerCase() !== RESTORE_PHRASE) {
    throw invalid(
      `Type "${RESTORE_PHRASE}" to confirm: this replaces the whole database`,
      'CONFIRMATION_REQUIRED',
    )
  }
  if (port.database.file === undefined) {
    throw conflict(
      'The whole database cannot be restored here: this server runs on an in-memory database',
      'RESTORE_UNAVAILABLE',
    )
  }
  if (port.database.pending() !== undefined) {
    throw conflict(
      'A restore is already staged and waits for the restart (cancel it first)',
      'RESTORE_PENDING',
    )
  }
  const preview = previewDatabaseRestore(deps, backupId)
  if (!preview.backup.verified) {
    throw conflict(
      'This backup did not verify, so it is not restored (pick a verified one)',
      'BACKUP_NOT_VERIFIED',
    )
  }
  let undone: RestorePoint | undefined
  if (input.undoOf !== undefined) {
    undone = port.restorePoints.get(input.undoOf)
    if (undone === undefined) throw notFound('Restore point', input.undoOf)
    if (undone.kind !== 'database-restore' || undone.safetyBackupId !== backupId) {
      throw invalid('That restore point is not a database restore of this backup', 'INVALID_UNDO')
    }
    if (undone.undoneBy !== null) {
      throw conflict('This restore point was already undone', 'ALREADY_UNDONE')
    }
  }
  const safety = await createBackup(deps, beforeReason(`database restore from ${backupId}`), {
    // the backup being restored must survive this run
    prune: false,
  })
  if (!safety.ok) {
    throw conflict(
      `Nothing was restored: the safety backup failed (${safety.error})`,
      'BACKUP_FAILED',
    )
  }
  const at = deps.clock.now()
  const id = restorePointId(at)
  port.database.stage(backupId, {
    backupId,
    safetyBackupId: safety.backup.id,
    restorePointId: id,
    stagedAt: at,
  })
  const changed = preview.tables.filter((t) => t.delta !== 0)
  const point: RestorePoint = {
    id,
    at,
    by: input.by,
    kind: 'database-restore',
    source: { kind: 'backup', backupId, label: `backup ${backupId}` },
    safetyBackupId: safety.backup.id,
    sections: ['database'],
    removedSections: [],
    counts: {
      added: changed.reduce((n, t) => n + Math.max(0, t.delta), 0),
      changed: 0,
      removed: changed.reduce((n, t) => n + Math.max(0, -t.delta), 0),
      failed: 0,
    },
    items: changed.slice(0, RESTORE_POINT_ITEMS_MAX).map((t) => ({
      key: t.table,
      action: t.delta > 0 ? ('added' as const) : ('removed' as const),
      note: `${t.live} rows now, ${t.backup} in the backup`,
    })),
    undoOf: input.undoOf ?? null,
    undoneBy: null,
  }
  port.restorePoints.add(point)
  if (input.undoOf !== undefined) port.restorePoints.markUndone(input.undoOf, id)
  deps.lifecycle?.restart()
  return {
    restorePointId: id,
    safetyBackupId: safety.backup.id,
    restart: deps.lifecycle === undefined ? 'manual' : 'automatic',
  }
}

export interface DatabaseRestoreStatus {
  pending: PendingDatabaseRestore | null
  /** What the last start did with a staged restore (applied, or why not). */
  last: {
    ok: boolean
    at: number
    backupId: string
    restorePointId: string
    error: string | null
  } | null
}

export function databaseRestoreStatus(deps: Deps): DatabaseRestoreStatus {
  const port = backupPort(deps)
  return { pending: port.database.pending() ?? null, last: port.database.lastResult() ?? null }
}

/** Drop a staged restore that has not been applied yet. */
export function cancelDatabaseRestore(deps: Deps): void {
  backupPort(deps).database.cancel()
}
