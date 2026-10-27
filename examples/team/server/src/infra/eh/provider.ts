/**
 * The model port of the agent factory: which model an agent runs on, which model decides in Auto
 * mode, which one answers `web_search`, and the catalog (prices, context windows).
 *
 * - `scriptedModelConfig` / `TEAM_SCRIPTED_MODEL` (offline, tests): one fixed model, wins over
 *   everything;
 * - `providerModelConfig`: profiles of `eharness/providers` (`providers.ts`): an agent picks
 *   `{ profileId, modelId }`; a missing profile follows the workspace default.
 *
 * Keys are never logged; the profile settings stay inside the provider manager.
 */
import { readFileSync } from 'node:fs'
import { extractReasoningMiddleware, type LanguageModel, wrapLanguageModel } from 'ai'
import type { ModelCatalog } from 'eharness'
import { type ScriptedStepInput, scriptedModel } from 'eharness/testing'
import { conflict } from '../../domain/errors.ts'
import { normalizeSelection } from '../../domain/providers.ts'
import type { ProviderService } from './providers.ts'
import { createSearchFn, SEARCH_MODEL, type SearchFn } from './web-search.ts'

export type ModelProviderName = 'providers' | 'scripted'

/** The profile and model a selection ends up on. */
export interface ResolvedSelection {
  profileId: string
  modelId: string
}

export interface ModelConfig {
  provider: ModelProviderName
  /** Model id shown when nothing names one (informational). */
  defaultModel: string
  /**
   * The model of a pick (the factory already applied the workspace default pick). A null profile
   * is the default profile, a null model that profile's default model. A plain `modelId` is on the
   * default profile; a legacy `profile:model` id is split when the prefix names a profile.
   * Synchronous: the profiles are loaded at boot.
   */
  resolve(modelId: string | null, profileId?: string | null): LanguageModel
  /** Where a pick ends up (profile + model id); absent for fixed (scripted) models. */
  effective?(modelId: string | null, profileId?: string | null): ResolvedSelection | undefined
  /** Prices and context windows of the models `resolve` makes. */
  catalog?: ModelCatalog
  /**
   * Model of the Auto mode classifier when no agent model is known: the classifier model of the
   * workspace settings, else the default model. Absent (scripted model) = Auto mode is not offered.
   */
  classifierModel?: () => LanguageModel
  /**
   * The classifier model picked in Settings (initial value `TEAM_CLASSIFIER_MODEL`) when there is
   * one: it wins over the agent's own model. Read on every call, so a change applies at once.
   */
  classifierOverride?: () => LanguageModel | undefined
  /** Provider web search for `web_search`; absent (scripted model) = the tool is not offered. */
  search?: SearchFn
  /** Bumps when the profiles change (agents are rebuilt). */
  rev?: () => number
}

type Env = Record<string, string | undefined>

/** A model config that always returns `model` (tests, offline runs). */
export function scriptedModelConfig(model: LanguageModel): ModelConfig {
  return { provider: 'scripted', defaultModel: 'scripted', resolve: () => model }
}

/** `TEAM_SCRIPTED_MODEL`: path to a JSON array of scripted steps; undefined when unset. */
export function scriptedModelConfigFromEnv(env: Env = process.env): ModelConfig | undefined {
  const file = env.TEAM_SCRIPTED_MODEL
  if (file === undefined || file === '') return undefined
  const steps = JSON.parse(readFileSync(file, 'utf8')) as ScriptedStepInput[]
  return scriptedModelConfig(scriptedModel(steps))
}

/**
 * Models that think out loud in the text (`<think>...</think>`) instead of the provider's separate
 * reasoning field (DeepSeek R1 and V3.x families, QwQ, other open reasoning models): D2 of the e2e
 * pass saw the deliberation rendered as the answer. The AI SDK's own `extractReasoningMiddleware`
 * moves tagged text into reasoning parts; a provider that already sends the reasoning separately
 * is unaffected (no tag, nothing to move). Reasoning written as plain text without any tag cannot
 * be told apart from the answer: that is a provider setting, not something to guess here.
 */
const INLINE_THINKING = /deepseek|(^|[/:-])r1\b|qwq|reasoner/i

export function splitInlineReasoning(model: LanguageModel, modelId: string): LanguageModel {
  if (typeof model === 'string' || !INLINE_THINKING.test(modelId)) return model
  return wrapLanguageModel({
    model,
    middleware: extractReasoningMiddleware({ tagName: 'think' }),
  } as never) as LanguageModel
}

/** The model picks of the workspace settings that background calls read (per call, never cached). */
export interface BackgroundModelSettings {
  classifierModel: string | null
  classifierProfile: string | null
  searchModel: string | null
  searchProfile: string | null
}

/** The model config over a provider service; `settings` is read on every classifier and search call. */
export function providerModelConfig(
  service: ProviderService,
  settings: () => BackgroundModelSettings = () => ({
    classifierModel: null,
    classifierProfile: null,
    searchModel: null,
    searchProfile: null,
  }),
  options: { observeSearch?: (model: LanguageModel) => LanguageModel } = {},
): ModelConfig {
  const { manager } = service

  const effective = (
    modelId: string | null,
    profileId: string | null = null,
  ): ResolvedSelection => {
    const picked = normalizeSelection(profileId, modelId, service.profileIds())
    const profile = picked.profileId ?? service.defaultProfileId()
    if (profile === undefined) {
      throw conflict(
        'no model provider is configured: add one in Settings > Providers, or set OPENROUTER_API_KEY / AI_GATEWAY_API_KEY',
        'NO_PROVIDER',
      )
    }
    return { profileId: profile, modelId: picked.modelId ?? service.defaultModelOf(profile) }
  }

  /** A pick of the settings: `profile` + model, a legacy `profile:model`, or a plain id on the default profile. */
  const fromSetting = (
    model: string | null,
    profile: string | null,
  ): ResolvedSelection | undefined => {
    if (model === null && profile === null) return undefined
    const n = normalizeSelection(profile, model, service.profileIds())
    return effective(n.modelId, n.profileId)
  }
  const classifierPick = (): ResolvedSelection | undefined => {
    const s = settings()
    return fromSetting(s.classifierModel, s.classifierProfile)
  }

  const defaultResolved = (): ResolvedSelection => effective(null)

  const search: SearchFn = createSearchFn({
    ...(options.observeSearch === undefined ? {} : { observe: options.observeSearch }),
    target: () => {
      const profiles = service.profiles()
      const kindOf = (id: string): 'openrouter' | 'gateway' | undefined => {
        const d = profiles.find((p) => p.id === id && p.enabled)?.definitionId
        return d === 'openrouter' || d === 'gateway' ? d : undefined
      }
      const s = settings()
      let pick =
        s.searchModel === null && s.searchProfile !== null
          ? // a profile with no model: its built-in search model, never the profile's chat default
            kindOf(s.searchProfile) === undefined
            ? undefined
            : {
                profileId: s.searchProfile,
                modelId: SEARCH_MODEL[kindOf(s.searchProfile) as 'openrouter' | 'gateway'],
              }
          : fromSetting(s.searchModel, s.searchProfile)
      let provider = pick === undefined ? undefined : kindOf(pick.profileId)
      if (pick === undefined || provider === undefined) {
        // the default profile if it can search, else the first profile that can
        const defaultId = service.defaultProfileId()
        const profileId =
          defaultId !== undefined && kindOf(defaultId) !== undefined
            ? defaultId
            : profiles.find((p) => p.enabled && kindOf(p.id) !== undefined)?.id
        if (profileId === undefined) {
          throw new Error(
            'web search needs an OpenRouter or AI Gateway profile (Settings > Providers)',
          )
        }
        provider = kindOf(profileId) as 'openrouter' | 'gateway'
        pick = { profileId, modelId: SEARCH_MODEL[provider] }
      }
      return {
        provider: provider as 'openrouter' | 'gateway',
        model: manager.resolve({ profile: pick.profileId, model: pick.modelId }),
      }
    },
  })

  return {
    provider: 'providers',
    defaultModel: 'default profile',
    resolve(modelId, profileId) {
      const r = effective(modelId, profileId)
      return splitInlineReasoning(
        manager.resolve({ profile: r.profileId, model: r.modelId }),
        r.modelId,
      )
    },
    effective: (modelId, profileId) => {
      try {
        return effective(modelId, profileId)
      } catch {
        return undefined
      }
    },
    catalog: manager.catalog(),
    classifierModel: () => {
      const r = classifierPick() ?? defaultResolved()
      return manager.resolve({ profile: r.profileId, model: r.modelId })
    },
    classifierOverride: () => {
      const r = classifierPick()
      return r === undefined
        ? undefined
        : manager.resolve({ profile: r.profileId, model: r.modelId })
    },
    search,
    rev: service.rev,
  }
}
