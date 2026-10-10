/**
 * Model provider config (as examples/coder): OpenRouter (`OPENROUTER_API_KEY`) or the Vercel AI
 * Gateway (`AI_GATEWAY_API_KEY`), and an offline scripted model (`TEAM_SCRIPTED_MODEL`).
 * Keys are read from the environment only and never logged.
 */
import { readFileSync } from 'node:fs'
import { createOpenRouter } from '@openrouter/ai-sdk-provider'
import type { LanguageModel } from 'ai'
import { type ScriptedStepInput, scriptedModel } from 'eharness/testing'
import { createSearchFn, type SearchFn } from './web-search.ts'

export type ModelProviderName = 'openrouter' | 'gateway' | 'scripted'

export const DEFAULT_MODEL: Record<Exclude<ModelProviderName, 'scripted'>, string> = {
  openrouter: 'anthropic/claude-sonnet-5.5',
  gateway: 'anthropic/claude-sonnet-4.6',
}

type Env = Record<string, string | undefined>

export interface ModelConfig {
  provider: ModelProviderName
  /** Id used when a definition has no model of its own. */
  defaultModel: string
  /** Resolve a model id (or the default) to a model. */
  resolve(id: string | null): LanguageModel
  /** Provider web search for `web_search`; absent (scripted model) = the tool is not offered. */
  search?: SearchFn
}

/**
 * Pick the provider from the environment: `TEAM_SCRIPTED_MODEL` (path to a JSON array of
 * scripted steps) wins, then OpenRouter, then the gateway. Throws a readable error when no
 * provider is configured, so the server fails at boot rather than at the first chat.
 */
export function createModelConfig(env: Env = process.env): ModelConfig {
  const scriptFile = env.TEAM_SCRIPTED_MODEL
  if (scriptFile !== undefined && scriptFile !== '') {
    const steps = JSON.parse(readFileSync(scriptFile, 'utf8')) as ScriptedStepInput[]
    return scriptedModelConfig(scriptedModel(steps))
  }
  const forced = env.TEAM_PROVIDER
  const provider: Exclude<ModelProviderName, 'scripted'> =
    forced === 'gateway' || forced === 'openrouter'
      ? forced
      : env.OPENROUTER_API_KEY
        ? 'openrouter'
        : 'gateway'
  const defaultModel = env.TEAM_MODEL ?? DEFAULT_MODEL[provider]
  if (provider === 'gateway') {
    if (!env.AI_GATEWAY_API_KEY) {
      throw new Error(
        'no model provider: set OPENROUTER_API_KEY, AI_GATEWAY_API_KEY or TEAM_SCRIPTED_MODEL',
      )
    }
    const resolve = (id: string | null): LanguageModel => id ?? defaultModel
    return {
      provider,
      defaultModel,
      resolve,
      search: createSearchFn({ provider, resolveModel: (id) => resolve(id) }),
    }
  }
  if (!env.OPENROUTER_API_KEY) {
    throw new Error('provider "openrouter" needs OPENROUTER_API_KEY')
  }
  const openrouter = createOpenRouter({
    apiKey: env.OPENROUTER_API_KEY,
    ...(env.OPENROUTER_BASE_URL ? { baseURL: env.OPENROUTER_BASE_URL } : {}),
  })
  const cache = new Map<string, LanguageModel>()
  const resolve = (id: string | null): LanguageModel => {
    const wanted = id ?? defaultModel
    let model = cache.get(wanted)
    if (model === undefined) {
      model = openrouter(wanted) as unknown as LanguageModel
      cache.set(wanted, model)
    }
    return model
  }
  return {
    provider,
    defaultModel,
    resolve,
    search: createSearchFn({ provider, resolveModel: (id) => resolve(id) }),
  }
}

/** A model config that always returns `model` (tests, offline runs). */
export function scriptedModelConfig(model: LanguageModel): ModelConfig {
  return { provider: 'scripted', defaultModel: 'scripted', resolve: () => model }
}
