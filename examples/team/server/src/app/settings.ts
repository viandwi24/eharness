/** Workspace settings use cases. */

import { invalid } from '../domain/errors.ts'
import { normalizeSelection } from '../domain/providers.ts'
import {
  checkSettingsPatch,
  type SettingsPatch,
  toSettingsMode,
  type WorkspaceSettings,
} from '../domain/settings.ts'
import { checkCompanyRoot } from '../domain/library-structure.ts'
import { checkWorksRoot } from '../domain/works-journal.ts'
import { syncDigestRoutine } from './heartbeat.ts'
import type { Deps } from './ports.ts'

/**
 * A pick stored as the legacy `profile:model` (an environment value such as `TEAM_CLASSIFIER_MODEL`)
 * is shown split into profile and model, like the default model.
 */
function splitPick(
  deps: Deps,
  profile: string | null,
  model: string | null,
): { profile: string | null; model: string | null } {
  const sel = normalizeSelection(profile, model, deps.providers.profileIds())
  return { profile: sel.profileId, model: sel.modelId }
}

export function getSettings(deps: Deps): WorkspaceSettings & { updatedAt: number } {
  const s = deps.settings.get()
  const classifier = splitPick(deps, s.classifierProfile, s.classifierModel)
  const search = splitPick(deps, s.searchProfile, s.searchModel)
  return {
    ...s,
    classifierProfile: classifier.profile,
    classifierModel: classifier.model,
    searchProfile: search.profile,
    searchModel: search.model,
  }
}

export function patchSettings(
  deps: Deps,
  patch: SettingsPatch,
): WorkspaceSettings & { updatedAt: number } {
  const clean = Object.fromEntries(
    Object.entries(patch).filter(([, v]) => v !== undefined),
  ) as SettingsPatch
  checkSettingsPatch(clean)
  if (clean.worksRoot !== undefined) clean.worksRoot = checkWorksRoot(clean.worksRoot)
  if (clean.companyRoot != null) clean.companyRoot = checkCompanyRoot(clean.companyRoot)
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
  for (const [profileKey, modelKey] of [
    ['classifierProfile', 'classifierModel'],
    ['searchProfile', 'searchModel'],
  ] as const) {
    if (clean[profileKey] === undefined && clean[modelKey] === undefined) continue
    const known = deps.providers.profileIds()
    const current = deps.settings.get()
    const sel = normalizeSelection(
      clean[profileKey] === undefined ? current[profileKey] : clean[profileKey],
      clean[modelKey] === undefined ? current[modelKey] : clean[modelKey],
      known,
    )
    if (sel.profileId !== null && !known.includes(sel.profileId)) {
      throw invalid(`unknown provider profile: ${sel.profileId}`, 'UNKNOWN_PROFILE')
    }
    clean[profileKey] = sel.profileId
    clean[modelKey] = sel.modelId
  }
  if (clean.defaultPermissionMode !== undefined) {
    clean.defaultPermissionMode = toSettingsMode(clean.defaultPermissionMode)
  }
  deps.settings.patch(clean, deps.clock.now())
  const next = getSettings(deps)
  // the digest time follows the team timezone unless it has its own
  if (clean.timezone !== undefined) syncDigestRoutine(deps)
  deps.events.append({ type: 'settings-changed', payload: { keys: Object.keys(clean) } })
  return next
}
