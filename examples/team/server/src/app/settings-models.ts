/**
 * Which model each kind of call runs on, so no call silently uses a model nobody chose: the
 * workspace default (and where it comes from), the models of background work (classifier, web
 * search, compaction summaries, heartbeat, programs) and a warning for every agent or call that
 * ends up on a provider's built-in fallback because no model was picked.
 */
import type { AgentDef } from '../domain/agents.ts'
import { normalizeSelection, type ProfileView } from '../domain/providers.ts'
import type { WorkspaceSettings } from '../domain/settings.ts'
import type { Deps } from './ports.ts'

export type ModelSource = 'setting' | 'env' | 'built-in' | 'agent'

export interface ModelRow {
  key: 'classifier' | 'search' | 'compaction' | 'heartbeat' | 'programs'
  label: string
  /** The profile and model the call runs on; null when it follows each agent's own model. */
  profileId: string | null
  profileLabel: string | null
  modelId: string | null
  source: ModelSource
  /** One line for people. */
  note: string
}

export interface SettingsModelsView {
  /** What an agent without a pick of its own runs on; null when no provider is configured. */
  workspaceDefault: {
    profileId: string
    profileLabel: string
    modelId: string
    source: 'setting' | 'env' | 'built-in'
  } | null
  background: ModelRow[]
  /** Agents that run on the built-in fallback model because no model was picked for them. */
  agentsOnFallback: string[]
  /** Sentences for the Settings page; empty when every call runs on a model somebody picked. */
  warnings: string[]
}

/** The inputs of the report, pure so it is unit-tested without a server. */
export interface ModelsReportInput {
  settings: Pick<
    WorkspaceSettings,
    | 'defaultModel'
    | 'defaultProfile'
    | 'classifierModel'
    | 'classifierProfile'
    | 'searchModel'
    | 'searchProfile'
  >
  profiles: ReadonlyArray<
    Pick<ProfileView, 'id' | 'label' | 'enabled' | 'isDefault' | 'defaultModel'>
  >
  agents: ReadonlyArray<Pick<AgentDef, 'name' | 'model' | 'modelProfile' | 'archivedAt'>>
  defaultModelSource(profileId: string): 'env' | 'built-in'
  searchModelOf(profileId: string): string | undefined
}

interface Effective {
  profileId: string
  profileLabel: string
  modelId: string
  source: 'setting' | 'env' | 'built-in'
}

export function modelsReport(input: ModelsReportInput): SettingsModelsView {
  const { settings, profiles } = input
  const ids = profiles.map((p) => p.id)
  const labelOf = (id: string): string => profiles.find((p) => p.id === id)?.label ?? id
  const defaultProfile = profiles.find((p) => p.isDefault)

  /** The model of a pick with the workspace default applied, and where the model id came from. */
  const effective = (
    modelId: string | null,
    profileId: string | null,
    inheritModel: boolean,
  ): Effective | null => {
    const profile = profileId ?? settings.defaultProfile ?? defaultProfile?.id ?? null
    if (profile === null || !profiles.some((p) => p.id === profile)) return null
    const own = modelId ?? (inheritModel ? settings.defaultModel : null)
    if (own !== null) {
      return {
        profileId: profile,
        profileLabel: labelOf(profile),
        modelId: own,
        source: 'setting',
      }
    }
    const fallback = profiles.find((p) => p.id === profile)?.defaultModel
    if (fallback === undefined) return null
    return {
      profileId: profile,
      profileLabel: labelOf(profile),
      modelId: fallback,
      source: input.defaultModelSource(profile),
    }
  }

  const workspaceDefault = effective(null, null, true)
  const warnings: string[] = []

  const agentsOnFallback = input.agents
    .filter((a) => a.archivedAt === null)
    .filter((a) => {
      const e = effective(a.model, a.modelProfile, a.modelProfile === null)
      return e !== null && e.source === 'built-in'
    })
    .map((a) => a.name)
  if (workspaceDefault?.source === 'built-in') {
    warnings.push(
      `No default model is picked: agents without a model of their own run on ${workspaceDefault.modelId} (${workspaceDefault.profileLabel}'s built-in fallback). Pick a default model above.`,
    )
  } else if (agentsOnFallback.length > 0) {
    warnings.push(
      `${agentsOnFallback.join(', ')} run on a provider's built-in fallback model because no model was picked for them.`,
    )
  }

  const pickRow = (
    key: ModelRow['key'],
    label: string,
    model: string | null,
    profile: string | null,
    follows: string,
  ): ModelRow => {
    const sel = normalizeSelection(profile, model, ids)
    if (sel.modelId === null && sel.profileId === null) {
      return {
        key,
        label,
        profileId: null,
        profileLabel: null,
        modelId: null,
        source: 'agent',
        note: follows,
      }
    }
    const e = effective(sel.modelId, sel.profileId, false)
    return {
      key,
      label,
      profileId: e?.profileId ?? sel.profileId,
      profileLabel: e?.profileLabel ?? null,
      modelId: e?.modelId ?? sel.modelId,
      source: sel.modelId === null ? (e?.source ?? 'built-in') : 'setting',
      note: 'Picked in Settings.',
    }
  }

  const classifier = pickRow(
    'classifier',
    'Auto mode classifier',
    settings.classifierModel,
    settings.classifierProfile,
    'Same as the agent: it judges with the model of the agent whose action it reviews.',
  )

  // web search: a model of its own; with none picked, the built-in small model of the provider
  const searchSel = normalizeSelection(settings.searchProfile, settings.searchModel, ids)
  const searchProfile =
    searchSel.profileId ??
    (defaultProfile !== undefined && input.searchModelOf(defaultProfile.id) !== undefined
      ? defaultProfile.id
      : profiles.find((p) => p.enabled && input.searchModelOf(p.id) !== undefined)?.id)
  const builtInSearch = searchProfile === undefined ? undefined : input.searchModelOf(searchProfile)
  const search: ModelRow =
    searchSel.modelId !== null
      ? {
          key: 'search',
          label: 'Web search',
          profileId: searchProfile ?? null,
          profileLabel: searchProfile === undefined ? null : labelOf(searchProfile),
          modelId: searchSel.modelId,
          source: 'setting',
          note: 'Picked in Settings.',
        }
      : {
          key: 'search',
          label: 'Web search',
          profileId: searchProfile ?? null,
          profileLabel: searchProfile === undefined ? null : labelOf(searchProfile),
          modelId: builtInSearch ?? null,
          source: 'built-in',
          note:
            builtInSearch === undefined
              ? 'Needs an OpenRouter or AI Gateway profile: web search is off until one exists.'
              : "The provider's small built-in search model (pick one to change it).",
        }

  const agentModel = (key: ModelRow['key'], label: string, note: string): ModelRow => ({
    key,
    label,
    profileId: null,
    profileLabel: null,
    modelId: null,
    source: 'agent',
    note,
  })
  const background: ModelRow[] = [
    classifier,
    search,
    agentModel('compaction', 'Context summaries (compaction)', "The agent's own model."),
    agentModel('heartbeat', 'Heartbeat and digest', "The agent's own model."),
    agentModel('programs', 'Programs and routines', "The agent's own model."),
  ]
  if (agentsOnFallback.length > 0 && classifier.source === 'agent') {
    warnings.push(
      'The classifier, summaries, heartbeat and programs follow each agent, so they use the fallback model too until a model is picked.',
    )
  }
  return { workspaceDefault, background, agentsOnFallback, warnings }
}

export async function getSettingsModels(deps: Deps): Promise<SettingsModelsView> {
  const { profiles } = await deps.providers.describe()
  return modelsReport({
    settings: deps.settings.get(),
    profiles,
    agents: deps.agents.list(),
    defaultModelSource: (id) => deps.providers.defaultModelSource(id),
    searchModelOf: (id) => deps.providers.searchModelOf(id),
  })
}
