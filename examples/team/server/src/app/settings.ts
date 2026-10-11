/** Workspace settings use cases. */
import { invalid } from '../domain/errors.ts'
import { normalizeSelection } from '../domain/providers.ts'
import {
  checkSettingsPatch,
  type SettingsPatch,
  toSettingsMode,
  type WorkspaceSettings,
} from '../domain/settings.ts'
import { syncDigestRoutine } from './heartbeat.ts'
import type { Deps } from './ports.ts'

export const getSettings = (deps: Deps): WorkspaceSettings & { updatedAt: number } =>
  deps.settings.get()

export function patchSettings(
  deps: Deps,
  patch: SettingsPatch,
): WorkspaceSettings & { updatedAt: number } {
  const clean = Object.fromEntries(
    Object.entries(patch).filter(([, v]) => v !== undefined),
  ) as SettingsPatch
  checkSettingsPatch(clean)
  if (clean.defaultModel !== undefined || clean.defaultProfile !== undefined) {
    const known = deps.providers.profileIds()
    const current = deps.settings.get()
    const sel = normalizeSelection(
      clean.defaultProfile === undefined ? current.defaultProfile : clean.defaultProfile,
      clean.defaultModel === undefined ? current.defaultModel : clean.defaultModel,
      known,
    )
    if (sel.profileId !== null && !known.includes(sel.profileId)) {
      throw invalid(`unknown provider profile: ${sel.profileId}`, 'UNKNOWN_PROFILE')
    }
    clean.defaultProfile = sel.profileId
    clean.defaultModel = sel.modelId
  }
  if (clean.defaultPermissionMode !== undefined) {
    clean.defaultPermissionMode = toSettingsMode(clean.defaultPermissionMode)
  }
  const next = deps.settings.patch(clean, deps.clock.now())
  // the digest time follows the team timezone unless it has its own
  if (clean.timezone !== undefined) syncDigestRoutine(deps)
  deps.events.append({ type: 'settings-changed', payload: { keys: Object.keys(clean) } })
  return next
}
