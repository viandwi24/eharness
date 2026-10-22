/**
 * Storage (Settings > Storage): the scan of the data directory with its warnings, the owner's
 * maintenance actions and the low-disk alarm (once per local day).
 */
import type { Alarm } from '../domain/alarms.ts'
import { conflict, invalid } from '../domain/errors.ts'
import { localDay } from '../domain/heartbeat.ts'
import {
  isLowDisk,
  lowDiskText,
  type StorageAction,
  type StorageActionResult,
  type StorageReport,
  type StorageWarning,
  storageWarnings,
} from '../domain/storage.ts'
import { raiseAlarm } from './alarms.ts'
import type { Deps, StoragePort } from './ports.ts'

function storagePort(deps: Deps): StoragePort {
  if (deps.storage === undefined) {
    throw conflict(
      'Storage monitoring is not available: this server runs on an in-memory database',
      'STORAGE_UNAVAILABLE',
    )
  }
  return deps.storage
}

export type StorageView = StorageReport & { warnings: StorageWarning[] }

/** The cached scan (60 s) with what the owner should look at. */
export async function getStorage(
  deps: Deps,
  options: { refresh?: boolean } = {},
): Promise<StorageView> {
  const report = await storagePort(deps).report(options)
  return { ...report, warnings: storageWarnings(report) }
}

/** Run one action. The owner's confirmation (`confirm: true`) is required for every one. */
export function runStorageAction(
  deps: Deps,
  action: StorageAction,
  input: { confirm: boolean; days?: number | undefined },
): Promise<StorageActionResult> {
  if (input.confirm !== true) throw invalid('confirm the action first (confirm: true)')
  const port = storagePort(deps)
  return port.run(action, input.days === undefined ? {} : { days: input.days })
}

/**
 * Raise the low-disk alarm when the data volume has less than 10% or 2 GB free: one per local
 * day, however often this is called. Reads the volume only (cheap).
 */
export function checkDiskAlarm(deps: Deps): Alarm | undefined {
  const volume = deps.storage?.volume()
  if (volume === undefined || volume === null || !isLowDisk(volume)) return undefined
  const day = localDay(deps.clock.now(), deps.settings.get().timezone)
  return raiseAlarm(deps, {
    kind: 'system',
    key: `storage-low:${day}`,
    subject: 'system:storage',
    text: lowDiskText(volume, volume.path),
    refs: ['/settings?section=storage'],
  })
}
