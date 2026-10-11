/** Workspace settings (plan §6.7): defaults the factory and the use cases read. Pure. */
import { PERMISSION_MODES, type PermissionMode, TOOL_ACCESS, type ToolAccess } from './agents.ts'
import { invalid } from './errors.ts'
import { EH_MODE, type TeamMode, teamModeOf } from './modes.ts'

/**
 * The workspace default mode as stored: one of the three product modes, in eharness spelling
 * (`default` = Manual). Legacy values (`acceptEdits`, `plan`, `dontAsk`) normalize to Manual.
 */
export const SETTINGS_MODES = ['default', 'auto', 'bypassPermissions'] as const
export type SettingsMode = (typeof SETTINGS_MODES)[number]

export const toSettingsMode = (stored: string | null | undefined): SettingsMode =>
  EH_MODE[teamModeOf(stored)]

export const settingsTeamMode = (stored: string | null | undefined): TeamMode => teamModeOf(stored)

export interface WorkspaceSettings {
  /** Tool access of agents that have no setting of their own. */
  toolAccess: ToolAccess
  /** Mode of chats and agents that have no mode of their own (Manual, Auto or Bypass). */
  defaultPermissionMode: SettingsMode
  /** Monthly USD limit of the workspace budget ledger; null = tracked, not limited. */
  budgetUsd: number | null
  /** Children the lead runs at once (the `subagents` `maxConcurrent`). */
  spawnCap: number
  /** Model id of agents without their own; null = the default profile's default model. */
  defaultModel: string | null
  /** Provider profile of agents without their own; null = the server's default profile. */
  defaultProfile: string | null
  /** IANA timezone of the team: default of the heartbeat's active hours and the digest time. */
  timezone: string
}

/** The host's timezone (the `TZ` variable, else what the runtime reports), `UTC` as the last resort. */
export function hostTimezone(env: { TZ?: string | undefined } = {}): string {
  const candidates = [env.TZ, Intl.DateTimeFormat().resolvedOptions().timeZone]
  for (const tz of candidates) {
    if (tz === undefined || tz === '') continue
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: tz })
      return tz
    } catch {}
  }
  return 'UTC'
}

export const SPAWN_CAP_MAX = 32

/** A patch accepts any stored mode (legacy spellings too); the store keeps the normalized one. */
export type SettingsPatch = Partial<Omit<WorkspaceSettings, 'defaultPermissionMode'>> & {
  defaultPermissionMode?: PermissionMode | SettingsMode
}

export function checkSettingsPatch(patch: SettingsPatch): void {
  if (patch.timezone !== undefined) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: patch.timezone })
    } catch {
      throw invalid(`unknown timezone: ${patch.timezone}`, 'INVALID_SETTINGS')
    }
  }
  if (patch.toolAccess !== undefined && !TOOL_ACCESS.includes(patch.toolAccess)) {
    throw invalid(`toolAccess must be one of ${TOOL_ACCESS.join(', ')}`, 'INVALID_SETTINGS')
  }
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
  if (
    patch.defaultProfile != null &&
    (patch.defaultProfile.trim() === '' || patch.defaultProfile.length > 64)
  ) {
    throw invalid('defaultProfile must be 1-64 characters or null', 'INVALID_SETTINGS')
  }
}
