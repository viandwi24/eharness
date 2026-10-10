/**
 * Model provider selection: OpenRouter (`OPENROUTER_API_KEY`) or the Vercel AI Gateway
 * (`AI_GATEWAY_API_KEY`), and how a model id becomes a model for each of them (through the
 * `eharness/providers` manager: {@link createCoderProviders}).
 *
 * Keys are only ever read from the environment and handed to the provider; they are never logged
 * or put into error messages.
 */
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createOpenRouter } from '@openrouter/ai-sdk-provider'
import type { LanguageModel } from 'ai'
import type { ModelCatalog } from 'eharness'
import {
  type CatalogCache,
  createProviderManager,
  gatewayProvider,
  openRouterProvider,
  type ProviderManager,
  type ProviderProfile,
} from 'eharness/providers'
import type { ModelOption, ModelProvider } from '../contracts.ts'

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

/** Cache file of each catalog (kept at the paths the app always used). */
const CACHE_FILES: Record<string, string> = {
  'models.dev': 'models.json',
  openrouter: 'openrouter-models.json',
}

/**
 * A file-backed `CatalogCache`: `<dir>/models.json` (models.dev) and
 * `<dir>/openrouter-models.json` (OpenRouter). `fetchedAt` is the file's mtime and writes are
 * atomic (temp file + rename), exactly like the caches of earlier versions.
 */
export function fileCatalogCache(dir: string): CatalogCache {
  const fileOf = (key: string): string => join(dir, CACHE_FILES[key] ?? `${key}.json`)
  return {
    async get(key) {
      const file = fileOf(key)
      try {
        const [text, info] = await Promise.all([readFile(file, 'utf8'), stat(file)])
        return { data: JSON.parse(text) as unknown, fetchedAt: info.mtimeMs }
      } catch {
        return undefined
      }
    },
    async set(key, entry) {
      const file = fileOf(key)
      await mkdir(dir, { recursive: true })
      const temp = `${file}.${process.pid}.tmp`
      await writeFile(temp, JSON.stringify(entry.data))
      await rename(temp, file)
    },
  }
}

/** Options of {@link createCoderProviders}; the defaults are what the app uses. */
export interface CoderProvidersOptions {
  provider: ModelProvider
  /** Where the catalog caches live (`config.userDir`). */
  userDir: string
  /** Default `process.env`. */
  env?: Env
  fetch?: typeof fetch
  now?: () => number
  /** Default: `env.CODER_OFFLINE === '1'`. */
  offline?: boolean
}

/** The coder's view of the provider manager. */
export interface CoderProviders {
  manager: ProviderManager
  /** Model id → model for the session's provider (profile id = provider name). */
  resolve(id: string): LanguageModel
  /** `agent.models`: context windows and prices of the models `resolve` made. */
  catalog(): ModelCatalog
  /** Load the catalogs of the provider (cached 24 h). */
  load(): Promise<void>
  /** The picker entries: tool-capable models first, then by name. Empty without a catalog. */
  options(): Promise<ModelOption[]>
}

const finite = (n: number | undefined): n is number => n !== undefined && Number.isFinite(n)

/** Create the manager for the selected provider: env profile, file caches, offline switch. */
export function createCoderProviders(opts: CoderProvidersOptions): CoderProviders {
  const env = opts.env ?? process.env
  const provider = opts.provider
  const definitions = [
    openRouterProvider({ createOpenRouter: createOpenRouter as never }),
    // no `createGateway`: plain model ids, resolved by the AI SDK with AI_GATEWAY_API_KEY
    gatewayProvider(),
  ]
  const own = definitions.find((d) => d.id === provider)
  // only the selected provider's variables: the other provider's catalog is never fetched
  const ownEnv: Env = {}
  for (const variable of Object.values(own?.envMap ?? {}))
    ownEnv[variable as string] = env[variable as string]
  // a keyless placeholder keeps the catalog and the picker working without a key (the env
  // profile of the same id replaces it when the key is set)
  const seed: ProviderProfile = {
    id: provider,
    kind: 'provider',
    definitionId: provider,
    label: own?.label ?? provider,
    settings: {},
    enabled: true,
    updatedAt: 0,
  }
  const manager = createProviderManager({
    definitions,
    env: ownEnv,
    seed: [seed],
    cache: fileCatalogCache(opts.userDir),
    catalogs: { offline: opts.offline ?? env.CODER_OFFLINE === '1' },
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    ...(opts.now ? { now: opts.now } : {}),
  })
  const ready = manager.ready()
  return {
    manager,
    resolve(id) {
      try {
        return manager.resolve({ profile: provider, model: id })
      } catch (error) {
        const problem = missingKeyError(provider, env)
        throw problem !== undefined ? new Error(problem) : error
      }
    },
    catalog: () => manager.catalog(),
    async load() {
      await ready
      await manager.loadCatalogs()
    },
    async options() {
      await ready
      const list = await manager.models(provider)
      return list.map((m) => {
        const info = m.info
        const pricing = info?.pricing
        return {
          id: m.id,
          name: m.name,
          provider,
          ...(info?.contextWindow !== undefined ? { contextWindow: info.contextWindow } : {}),
          ...(info?.maxOutputTokens !== undefined ? { maxOutputTokens: info.maxOutputTokens } : {}),
          ...(pricing !== undefined && finite(pricing.input) && finite(pricing.output)
            ? {
                pricing: {
                  input: pricing.input,
                  output: pricing.output,
                  ...(finite(pricing.cacheRead) ? { cacheRead: pricing.cacheRead } : {}),
                },
              }
            : {}),
          reasoning: m.reasoning === true,
          tools: m.tools === true,
          ...(m.description !== undefined ? { description: m.description } : {}),
        }
      })
    },
  }
}
