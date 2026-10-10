/** Workspace settings use cases. */
import {
  checkSettingsPatch,
  type SettingsPatch,
  toSettingsMode,
  type WorkspaceSettings,
} from '../domain/settings.ts'
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
  if (clean.defaultPermissionMode !== undefined) {
    clean.defaultPermissionMode = toSettingsMode(clean.defaultPermissionMode)
  }
  const next = deps.settings.patch(clean, deps.clock.now())
  deps.events.append({ type: 'settings-changed', payload: { keys: Object.keys(clean) } })
  return next
}
