/**
 * Ready-made provider definitions. The app passes the provider package factory
 * (`createOpenRouter`, `createOpenAI`, ...), so the library imports no provider package.
 *
 * @see docs/specs/23-providers.md#6-built-in-definitions
 */
import type { LanguageModel } from 'ai'
import { z } from 'zod/v4'
import { parseOpenRouterModels } from './catalog-loader.ts'
import { ehMeta } from './form.ts'
import type {
  ListedModel,
  ProviderContext,
  ProviderDefinition,
  ProviderInstance,
  TestResult,
} from './types.ts'

/**
 * Any AI SDK provider factory: `(settings) => provider`, where the provider is callable
 * (`provider(modelId)`) or has `languageModel(modelId)`.
 */
export type ProviderFactory<Settings> = (
  settings: Settings,
) => ((modelId: string) => unknown) | { languageModel(modelId: string): unknown }

/**
 * Typed helper to write a {@link ProviderDefinition}: the settings schema types `create`,
 * `listModels` and `test`.
 */
export function defineProvider<S extends z.ZodObject>(
  definition: ProviderDefinition<S>,
): ProviderDefinition {
  return definition as unknown as ProviderDefinition
}

function instanceOf(provider: ReturnType<ProviderFactory<never>>): ProviderInstance {
  return {
    languageModel: (id) =>
      (typeof provider === 'function' ? provider(id) : provider.languageModel(id)) as LanguageModel,
  }
}

const apiKeyField = (required: boolean, envHint: string, placeholder?: string) => {
  const base = z.string().min(1)
  return (required ? base : base.optional()).meta({
    title: 'API key',
    description: 'Stored encrypted by the app; never shown again after saving.',
    ...ehMeta({
      secret: true,
      group: 'auth',
      widget: 'password',
      envHint,
      ...(placeholder ? { placeholder } : {}),
    }),
  })
}

const baseURLField = (envHint: string | undefined, placeholder: string) =>
  z
    .url()
    .optional()
    .meta({
      title: 'Base URL',
      description: 'Override the API endpoint (proxy, gateway, self-hosted).',
      ...ehMeta({ group: 'endpoint', placeholder, ...(envHint ? { envHint } : {}) }),
    })

const headersField = z
  .record(z.string(), z.string())
  .optional()
  .meta({
    title: 'Extra headers',
    description: 'Sent with every request. Values are treated as secrets.',
    ...ehMeta({ group: 'advanced', widget: 'keyvalue', secretValues: true }),
  })

const trimSlash = (url: string): string => url.replace(/\/+$/, '')

async function getJson(
  url: string,
  headers: Record<string, string>,
  ctx: ProviderContext,
): Promise<unknown> {
  const response = await ctx.fetch(url, {
    headers,
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  })
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText} from ${new URL(url).origin}`)
  }
  return response.json()
}

function bearer(
  apiKey: string | undefined,
  headers?: Record<string, string>,
): Record<string, string> {
  return { ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}), ...headers }
}

/** `GET <baseURL>/models` of an OpenAI-style API: `{ data: [{ id }] }`. */
function parseIdList(data: unknown, filter?: (id: string) => boolean): ListedModel[] {
  const list = (data as { data?: unknown } | null)?.data
  if (!Array.isArray(list)) return []
  const out: ListedModel[] = []
  for (const item of list as Array<{ id?: unknown; name?: unknown } | null>) {
    if (typeof item?.id !== 'string' || item.id === '') continue
    if (filter && !filter(item.id)) continue
    out.push({ id: item.id, name: typeof item.name === 'string' ? item.name : item.id })
  }
  return out
}

const listTest = async (list: Promise<ListedModel[]>): Promise<TestResult> => {
  const models = await list
  return { ok: true, message: `Connected, ${models.length} models.` }
}

// ---------------------------------------------------------------- OpenRouter

const openRouterSettings = z.object({
  apiKey: apiKeyField(true, 'OPENROUTER_API_KEY', 'sk-or-...'),
  baseURL: baseURLField('OPENROUTER_BASE_URL', 'https://openrouter.ai/api/v1'),
  headers: headersField,
})

/** Options of {@link openRouterProvider}. */
export interface OpenRouterProviderOptions {
  /** `createOpenRouter` of `@openrouter/ai-sdk-provider`. */
  createOpenRouter: ProviderFactory<{
    apiKey?: string
    baseURL?: string
    headers?: Record<string, string>
  }>
  /** Also list models live from `<baseURL>/models` (needs the network on every refresh). Default: the cached public list. */
  live?: boolean
  id?: string
  label?: string
}

/**
 * OpenRouter. Models and prices come from the public OpenRouter list (cached 24 h by the
 * manager's catalog loader); `live: true` lists from the configured endpoint instead.
 */
export function openRouterProvider(options: OpenRouterProviderOptions): ProviderDefinition {
  const base = (s: z.output<typeof openRouterSettings>): string =>
    trimSlash(s.baseURL ?? 'https://openrouter.ai/api/v1')
  return defineProvider({
    id: options.id ?? 'openrouter',
    label: options.label ?? 'OpenRouter',
    doc: 'https://openrouter.ai/docs',
    settings: openRouterSettings,
    envMap: { apiKey: 'OPENROUTER_API_KEY', baseURL: 'OPENROUTER_BASE_URL' },
    defaultModel: 'anthropic/claude-sonnet-5.5',
    catalog: { kind: 'openrouter' },
    create: (s) =>
      instanceOf(
        options.createOpenRouter({
          apiKey: s.apiKey,
          ...(s.baseURL ? { baseURL: s.baseURL } : {}),
          ...(s.headers ? { headers: s.headers } : {}),
        }),
      ),
    ...(options.live
      ? {
          listModels: async (s: z.output<typeof openRouterSettings>, ctx: ProviderContext) =>
            parseOpenRouterModels(
              await getJson(`${base(s)}/models`, bearer(s.apiKey, s.headers), ctx),
            ),
        }
      : {}),
    test: async (s, ctx) => {
      await getJson(`${base(s)}/key`, bearer(s.apiKey, s.headers), ctx)
      return { ok: true, message: 'API key accepted.' }
    },
  })
}

// ------------------------------------------------------------------ Gateway

const gatewaySettings = z.object({
  apiKey: apiKeyField(false, 'AI_GATEWAY_API_KEY'),
  baseURL: baseURLField(undefined, 'https://ai-gateway.vercel.sh/v4/ai'),
  headers: headersField,
})

/** Providers of models.dev whose models the AI Gateway serves under `<provider>/<model>` ids. */
export const GATEWAY_MODELS_DEV_PROVIDERS: string[] = [
  'anthropic',
  'openai',
  'google',
  'xai',
  'deepseek',
  'mistral',
]

/** Options of {@link gatewayProvider}. */
export interface GatewayProviderOptions {
  /**
   * `createGateway` of `ai` / `@ai-sdk/gateway`. With it, models are objects built from the
   * profile's key and the live listing (`getAvailableModels`) is used. Without it, models are
   * plain id strings resolved by the AI SDK with `AI_GATEWAY_API_KEY` from the environment.
   */
  createGateway?: (settings: {
    apiKey?: string
    baseURL?: string
    headers?: Record<string, string>
  }) => {
    (modelId: string): unknown
    getAvailableModels?: () => Promise<{
      models: Array<{
        id: string
        name?: string
        description?: string | null
        pricing?: { input: string; output: string; cachedInputTokens?: string } | null
      }>
    }>
  }
  id?: string
  label?: string
}

const perMillion = (perToken: string | undefined): number | undefined => {
  const n = Number(perToken)
  return perToken !== undefined && Number.isFinite(n) && n >= 0
    ? Math.round(n * 1e12) / 1e6
    : undefined
}

/** The Vercel AI Gateway. */
export function gatewayProvider(options: GatewayProviderOptions = {}): ProviderDefinition {
  const make = (
    s: z.output<typeof gatewaySettings>,
  ): ReturnType<NonNullable<GatewayProviderOptions['createGateway']>> | undefined =>
    options.createGateway?.({
      ...(s.apiKey ? { apiKey: s.apiKey } : {}),
      ...(s.baseURL ? { baseURL: s.baseURL } : {}),
      ...(s.headers ? { headers: s.headers } : {}),
    })
  return defineProvider({
    id: options.id ?? 'gateway',
    label: options.label ?? 'Vercel AI Gateway',
    doc: 'https://vercel.com/docs/ai-gateway',
    settings: gatewaySettings,
    // `@ai-sdk/gateway` reads only AI_GATEWAY_API_KEY from the environment (checked in 4.0.110: no
    // base-URL variable exists), so `baseURL` has no env mapping: set it on the profile.
    envMap: { apiKey: 'AI_GATEWAY_API_KEY' },
    defaultModel: 'anthropic/claude-sonnet-4.6',
    catalog: { modelsDevKey: GATEWAY_MODELS_DEV_PROVIDERS },
    create: (s) => {
      const provider = make(s)
      return provider === undefined ? { languageModel: (id) => id } : instanceOf(provider)
    },
    ...(options.createGateway
      ? {
          listModels: async (s: z.output<typeof gatewaySettings>): Promise<ListedModel[]> => {
            const provider = make(s)
            if (provider?.getAvailableModels === undefined) return []
            const { models } = await provider.getAvailableModels()
            return models.map((m) => {
              const input = perMillion(m.pricing?.input)
              const output = perMillion(m.pricing?.output)
              const cacheRead = perMillion(m.pricing?.cachedInputTokens)
              return {
                id: m.id,
                name: m.name ?? m.id,
                ...(m.description ? { description: m.description } : {}),
                ...(input !== undefined && output !== undefined
                  ? {
                      info: {
                        pricing: {
                          input,
                          output,
                          ...(cacheRead !== undefined ? { cacheRead } : {}),
                        },
                      },
                    }
                  : {}),
              }
            })
          },
        }
      : {}),
  })
}

// -------------------------------------------------------- OpenAI-compatible

/** Options of {@link openAICompatibleProvider}. */
export interface OpenAICompatibleProviderOptions {
  /** `createOpenAICompatible` of `@ai-sdk/openai-compatible`. */
  createOpenAICompatible: ProviderFactory<{
    name: string
    baseURL: string
    apiKey?: string
    headers?: Record<string, string>
  }>
  /** Definition id (several presets can coexist: `ollama`, `lmstudio`). Default `openai-compatible`. */
  id?: string
  label?: string
  /** Pre-filled base URL (form default and placeholder). */
  defaultBaseURL?: string
  /** The API key is optional (local servers). Default `false`: required. */
  apiKeyOptional?: boolean
}

/** Any OpenAI-compatible endpoint (vLLM, Ollama, LM Studio, a proxy). */
export function openAICompatibleProvider(
  options: OpenAICompatibleProviderOptions,
): ProviderDefinition {
  const settings = z.object({
    baseURL: z.url().meta({
      title: 'Base URL',
      description: 'Endpoint root, for example http://localhost:11434/v1.',
      ...(options.defaultBaseURL ? { default: options.defaultBaseURL } : {}),
      ...ehMeta({ group: 'endpoint', placeholder: options.defaultBaseURL ?? 'https://host/v1' }),
    }),
    apiKey: apiKeyField(options.apiKeyOptional !== true, 'API_KEY'),
    headers: headersField,
  })
  type S = z.output<typeof settings>
  const id = options.id ?? 'openai-compatible'
  const list = async (s: S, ctx: ProviderContext): Promise<ListedModel[]> =>
    parseIdList(await getJson(`${trimSlash(s.baseURL)}/models`, bearer(s.apiKey, s.headers), ctx))
  return defineProvider({
    id,
    label: options.label ?? 'OpenAI-compatible',
    settings,
    create: (s: S) =>
      instanceOf(
        options.createOpenAICompatible({
          name: id,
          baseURL: s.baseURL,
          ...(s.apiKey ? { apiKey: s.apiKey } : {}),
          ...(s.headers ? { headers: s.headers } : {}),
        }),
      ),
    listModels: list,
    test: (s: S, ctx) => listTest(list(s, ctx)),
  })
}

// ------------------------------------------------------------------- OpenAI

const openAISettings = z.object({
  apiKey: apiKeyField(true, 'OPENAI_API_KEY', 'sk-...'),
  baseURL: baseURLField('OPENAI_BASE_URL', 'https://api.openai.com/v1'),
  organization: z
    .string()
    .optional()
    .meta({ title: 'Organization', ...ehMeta({ group: 'advanced', envHint: 'OPENAI_ORG_ID' }) }),
  project: z
    .string()
    .optional()
    .meta({ title: 'Project', ...ehMeta({ group: 'advanced', envHint: 'OPENAI_PROJECT_ID' }) }),
  headers: headersField,
})

/** Options of {@link openAIProvider}. */
export interface OpenAIProviderOptions {
  /** `createOpenAI` of `@ai-sdk/openai`. */
  createOpenAI: ProviderFactory<{
    apiKey?: string
    baseURL?: string
    organization?: string
    project?: string
    headers?: Record<string, string>
  }>
  id?: string
  label?: string
}

const NOT_CHAT =
  /embedding|whisper|tts|dall-e|moderation|davinci|babbage|image|audio|realtime|transcribe|omni-moderation/

/** OpenAI. Lists `GET /models` (embedding, audio and image models are dropped). */
export function openAIProvider(options: OpenAIProviderOptions): ProviderDefinition {
  const list = async (
    s: z.output<typeof openAISettings>,
    ctx: ProviderContext,
  ): Promise<ListedModel[]> =>
    parseIdList(
      await getJson(
        `${trimSlash(s.baseURL ?? 'https://api.openai.com/v1')}/models`,
        {
          ...bearer(s.apiKey, s.headers),
          ...(s.organization ? { 'openai-organization': s.organization } : {}),
          ...(s.project ? { 'openai-project': s.project } : {}),
        },
        ctx,
      ),
      (id) => !NOT_CHAT.test(id),
    )
  return defineProvider({
    id: options.id ?? 'openai',
    label: options.label ?? 'OpenAI',
    doc: 'https://platform.openai.com/docs',
    settings: openAISettings,
    envMap: {
      apiKey: 'OPENAI_API_KEY',
      baseURL: 'OPENAI_BASE_URL',
      organization: 'OPENAI_ORG_ID',
      project: 'OPENAI_PROJECT_ID',
    },
    catalog: { modelsDevKey: 'openai' },
    create: (s) =>
      instanceOf(
        options.createOpenAI({
          apiKey: s.apiKey,
          ...(s.baseURL ? { baseURL: s.baseURL } : {}),
          ...(s.organization ? { organization: s.organization } : {}),
          ...(s.project ? { project: s.project } : {}),
          ...(s.headers ? { headers: s.headers } : {}),
        }),
      ),
    listModels: list,
    test: (s, ctx) => listTest(list(s, ctx)),
  })
}

// ---------------------------------------------------------------- Anthropic

const anthropicSettings = z.object({
  apiKey: apiKeyField(true, 'ANTHROPIC_API_KEY', 'sk-ant-...'),
  baseURL: baseURLField('ANTHROPIC_BASE_URL', 'https://api.anthropic.com/v1'),
  headers: headersField,
})

/** Options of {@link anthropicProvider}. */
export interface AnthropicProviderOptions {
  /** `createAnthropic` of `@ai-sdk/anthropic`. */
  createAnthropic: ProviderFactory<{
    apiKey?: string
    baseURL?: string
    headers?: Record<string, string>
  }>
  id?: string
  label?: string
}

/** Anthropic. Lists `GET /v1/models`. */
export function anthropicProvider(options: AnthropicProviderOptions): ProviderDefinition {
  const list = async (
    s: z.output<typeof anthropicSettings>,
    ctx: ProviderContext,
  ): Promise<ListedModel[]> => {
    const data = (await getJson(
      `${trimSlash(s.baseURL ?? 'https://api.anthropic.com/v1')}/models?limit=1000`,
      { 'x-api-key': s.apiKey ?? '', 'anthropic-version': '2023-06-01', ...s.headers },
      ctx,
    )) as { data?: Array<{ id?: unknown; display_name?: unknown }> } | null
    const out: ListedModel[] = []
    for (const m of data?.data ?? []) {
      if (typeof m?.id !== 'string') continue
      out.push({ id: m.id, name: typeof m.display_name === 'string' ? m.display_name : m.id })
    }
    return out
  }
  return defineProvider({
    id: options.id ?? 'anthropic',
    label: options.label ?? 'Anthropic',
    doc: 'https://docs.anthropic.com',
    settings: anthropicSettings,
    envMap: { apiKey: 'ANTHROPIC_API_KEY', baseURL: 'ANTHROPIC_BASE_URL' },
    catalog: { modelsDevKey: 'anthropic' },
    create: (s) =>
      instanceOf(
        options.createAnthropic({
          apiKey: s.apiKey,
          ...(s.baseURL ? { baseURL: s.baseURL } : {}),
          ...(s.headers ? { headers: s.headers } : {}),
        }),
      ),
    listModels: list,
    test: (s, ctx) => listTest(list(s, ctx)),
  })
}
