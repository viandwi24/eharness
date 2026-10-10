/** Workspace settings (plan §6.7): defaults the factory and the use cases read. Pure. */
import { PERMISSION_MODES, type PermissionMode } from './agents.ts'
import { invalid } from './errors.ts'

export interface WorkspaceSettings {
  /** Mode of agents whose own `permissionMode` is `default` (and of agents created without one). */
  defaultPermissionMode: PermissionMode
  /** Monthly USD limit of the workspace budget ledger; null = tracked, not limited. */
  budgetUsd: number | null
  /** Children the lead runs at once (the `subagents` `maxConcurrent`). */
  spawnCap: number
  /** Model id of agents without their own; null = the server's configured default. */
  defaultModel: string | null
}

export const SPAWN_CAP_MAX = 32

export type SettingsPatch = Partial<WorkspaceSettings>

export function checkSettingsPatch(patch: SettingsPatch): void {
  if (
    patch.defaultPermissionMode !== undefined &&
    !PERMISSION_MODES.includes(patch.defaultPermissionMode)
  ) {
    throw invalid(
      `defaultPermissionMode must be one of ${PERMISSION_MODES.join(', ')}`,
      'INVALID_SETTINGS',
    )
  }
  if (patch.budgetUsd != null && !(Number.isFinite(patch.budgetUsd) && patch.budgetUsd > 0)) {
    throw invalid('budgetUsd must be a positive number or null', 'INVALID_SETTINGS')
  }
  if (
    patch.spawnCap !== undefined &&
    !(Number.isInteger(patch.spawnCap) && patch.spawnCap >= 1 && patch.spawnCap <= SPAWN_CAP_MAX)
  ) {
    throw invalid(`spawnCap must be an integer from 1 to ${SPAWN_CAP_MAX}`, 'INVALID_SETTINGS')
  }
  if (
    patch.defaultModel != null &&
    (patch.defaultModel.trim() === '' || patch.defaultModel.length > 200)
  ) {
    throw invalid('defaultModel must be 1-200 characters or null', 'INVALID_SETTINGS')
  }
}
