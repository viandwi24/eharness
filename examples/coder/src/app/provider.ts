/**
 * Model provider selection: OpenRouter (`OPENROUTER_API_KEY`) or the Vercel AI Gateway
 * (`AI_GATEWAY_API_KEY`), and how a model id becomes a model for each of them.
 *
 * Keys are only ever read from the environment and handed to the provider; they are never logged
 * or put into error messages.
 */
import { createOpenRouter } from '@openrouter/ai-sdk-provider'
import type { LanguageModel } from 'ai'
import type { ModelProvider } from '../contracts.ts'

/** Valid values of `--provider` and the `provider` settings key. */
export const MODEL_PROVIDERS = ['openrouter', 'gateway'] as const

/** Default model id per provider (newest Sonnet that each lists, with tools and reasoning). */
export const DEFAULT_MODEL: Record<ModelProvider, string> = {
  openrouter: 'anthropic/claude-sonnet-5.5',
  gateway: 'anthropic/claude-sonnet-4.6',
}

/** The environment variable that holds the API key of a provider. */
export const KEY_ENV: Record<ModelProvider, string> = {
  openrouter: 'OPENROUTER_API_KEY',
  gateway: 'AI_GATEWAY_API_KEY',
}

type Env = Record<string, string | undefined>

/** Validate a provider name coming from a flag or a settings file. */
export function parseProvider(value: string, origin: string): ModelProvider {
  if ((MODEL_PROVIDERS as readonly string[]).includes(value)) return value as ModelProvider
  throw new Error(
    `Invalid provider "${value}" (${origin}). Use one of: ${MODEL_PROVIDERS.join(', ')}`,
  )
}

/** The provider the environment asks for: OpenRouter when its key is set, else the gateway. */
export function detectProvider(env: Env = process.env): ModelProvider {
  return env[KEY_ENV.openrouter] ? 'openrouter' : 'gateway'
}

/**
 * The startup error for a provider whose API key is missing, or `undefined` when it is set.
 * The CLI exits with code 2 on it (except for scripted offline runs).
 */
export function missingKeyError(
  provider: ModelProvider,
  env: Env = process.env,
): string | undefined {
  if (env[KEY_ENV[provider]]) return undefined
  const other = provider === 'openrouter' ? 'gateway' : 'openrouter'
  return env[KEY_ENV[other]]
    ? `provider "${provider}" needs ${KEY_ENV[provider]} (only ${KEY_ENV[other]} is set; pass --provider ${other} to use it).`
    : `no API key: set ${KEY_ENV.openrouter} (OpenRouter) or ${KEY_ENV.gateway} (Vercel AI Gateway).`
}

/**
 * Turn a model id into a model for `provider`. OpenRouter gets a real model instance (the
 * `OPENROUTER_BASE_URL` override is honoured); the gateway takes the plain id string, which the AI
 * SDK resolves through the AI Gateway.
 */
export function createModelResolver(
  provider: ModelProvider,
  env: Env = process.env,
): (id: string) => LanguageModel {
  if (provider === 'gateway') return (id) => id
  const apiKey = env[KEY_ENV.openrouter]
  const baseURL = env.OPENROUTER_BASE_URL
  const openrouter = createOpenRouter({
    ...(apiKey ? { apiKey } : {}),
    ...(baseURL ? { baseURL } : {}),
  })
  const cache = new Map<string, LanguageModel>()
  return (id) => {
    let model = cache.get(id)
    if (model === undefined) {
      model = openrouter(id) as unknown as LanguageModel
      cache.set(id, model)
    }
    return model
  }
}
