/** The backup port of the deps, or the readable refusal when this server has none. */
import { DomainError } from '../domain/errors.ts'
import type { BackupPort, Deps } from './ports.ts'

export function backupPort(deps: Deps): BackupPort {
  if (deps.backups === undefined) {
    throw new DomainError(
      'conflict',
      'BACKUPS_UNAVAILABLE',
      'Backups are not available: this server runs on an in-memory database without TEAM_BACKUP_DIR',
    )
  }
  return deps.backups
}
