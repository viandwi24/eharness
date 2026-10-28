/**
 * Ready-made provider definitions. The app passes the provider package factory
 * (`createOpenRouter`, `createOpenAI`, ...), so the library imports no provider package.
 *
 * @see docs/specs/23-providers.md#6-built-in-definitions
 */
import { type LanguageModel, type LanguageModelMiddleware, wrapLanguageModel } from 'ai'
import { z } from 'zod/v4'
import { HarnessError } from '../index.ts'
import { parseOpenRouterModels } from './catalog-loader.ts'
import { ehMeta } from './form.ts'
import {
  describeLlamaCpp,
  describeLmStudio,
  describeOllama,
  describeVllm,
  type LocalServer,
} from './local.ts'
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

const apiKeyField = (
  required: boolean,
  envHint: string | undefined,
  placeholder?: string,
  description = 'Stored encrypted by the app; never shown again after saving.',
) => {
  const base = z.string().min(1)
  return (required ? base : base.optional()).meta({
    title: 'API key',
    description,
    ...ehMeta({
      secret: true,
      group: 'auth',
      widget: 'password',
      ...(envHint ? { envHint } : {}),
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

/** Suggested model of the gateway-style providers (OpenRouter, Vercel AI Gateway): one constant, one generation. */
const DEFAULT_GATEWAY_MODEL = 'anthropic/claude-sonnet-5.5'

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
    throw new HarnessError(
      'EH_PROVIDER',
      `HTTP ${response.status} ${response.statusText} from ${new URL(url).origin}`,
    )
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
  providerOrder: z
    .string()
    .optional()
    .meta({
      title: 'Preferred upstream providers (in order)',
      description:
        'Comma-separated OpenRouter provider slugs tried in this order, e.g. "anthropic, amazon-bedrock". Empty: OpenRouter chooses (and may switch provider between calls, which breaks the prompt cache).',
      ...ehMeta({ group: 'advanced', placeholder: 'anthropic, amazon-bedrock' }),
    }),
  allowFallbacks: z
    .boolean()
    .optional()
    .meta({
      title: 'Allow fallback to other providers',
      description:
        'When off, a call fails instead of going to a provider outside the preferred list. Default: on.',
      default: true,
      ...ehMeta({ group: 'advanced' }),
    }),
  stickyProvider: z
    .boolean()
    .optional()
    .meta({
      title: 'Prefer the same provider within a session',
      description:
        'Tries the provider that served the previous call of the same conversation first, so the prompt cache stays warm. Default: off.',
      default: false,
      ...ehMeta({ group: 'advanced' }),
    }),
})

type OpenRouterModelSettings = Record<string, unknown>

/** Options of {@link openRouterProvider}. */
export interface OpenRouterProviderOptions {
  /** `createOpenRouter` of `@openrouter/ai-sdk-provider`. */
  createOpenRouter: (settings: {
    apiKey?: string
    baseURL?: string
    headers?: Record<string, string>
  }) =>
    | ((modelId: string, settings?: OpenRouterModelSettings) => unknown)
    | { languageModel(modelId: string, settings?: OpenRouterModelSettings): unknown }
  /** Also list models live from `<baseURL>/models` (needs the network on every refresh). Default: the cached public list. */
  live?: boolean
  id?: string
  label?: string
}

/** Slugs of a comma-separated list. */
function slugList(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part !== '')
}

/** OpenRouter reports the provider display name (`Amazon Bedrock`); routing wants the slug. */
const slugOf = (name: string): string => name.trim().toLowerCase().replace(/\s+/g, '-')

/** A stable key of a conversation: the text of its first two prompt messages. */
function conversationKey(modelId: string, prompt: unknown): string {
  const parts: string[] = [modelId]
  for (const message of Array.isArray(prompt) ? prompt.slice(0, 2) : []) {
    const m = message as { role?: unknown; content?: unknown }
    parts.push(String(m.role))
    if (typeof m.content === 'string') parts.push(m.content)
    else if (Array.isArray(m.content)) {
      for (const part of m.content) {
        const text = (part as { text?: unknown } | null)?.text
        if (typeof text === 'string') parts.push(text)
      }
    }
  }
  const text = parts.join('\u0000')
  let hash = 5381
  for (let i = 0; i < text.length; i++) hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0
  return `${hash}:${text.length}`
}

const upstreamOf = (metadata: unknown): string | undefined => {
  const name = (metadata as { openrouter?: { provider?: unknown } } | null | undefined)?.openrouter
    ?.provider
  return typeof name === 'string' && name !== '' ? name : undefined
}

/**
 * App-side sticky routing: remembers which upstream provider served the previous call of a
 * conversation and sends it first in `provider.order` of the next one (OpenRouter's prompt cache
 * only works within one provider). The conversation is told apart by its first two prompt messages.
 * A failed call (rejected, an `error` stream part, a broken stream) forgets the remembered provider,
 * so the next call is routed by OpenRouter again instead of returning to a failing upstream.
 */
function stickyRouting(
  model: LanguageModel,
  learned: Map<string, string>,
  base: { order?: string[]; allow_fallbacks?: boolean } | undefined,
): LanguageModel {
  if (typeof model === 'string' || typeof model !== 'object' || model === null) return model
  const m = model as unknown as {
    modelId: string
    doGenerate(p: Record<string, unknown>): Promise<Record<string, unknown>>
    doStream(p: Record<string, unknown>): Promise<Record<string, unknown>>
  }
  const withOrder = (
    params: Record<string, unknown>,
  ): { params: Record<string, unknown>; key: string } => {
    const key = conversationKey(m.modelId, params.prompt)
    const sticky = learned.get(key)
    if (sticky === undefined) return { params, key }
    const providerOptions = (params.providerOptions ?? {}) as Record<
      string,
      Record<string, unknown>
    >
    const own = (providerOptions.openrouter?.provider ?? {}) as Record<string, unknown>
    const configured = (own.order ?? base?.order ?? []) as string[]
    const order = [sticky, ...configured.filter((slug) => slug !== sticky)]
    return {
      key,
      params: {
        ...params,
        providerOptions: {
          ...providerOptions,
          openrouter: {
            ...providerOptions.openrouter,
            provider: { ...base, ...own, order },
          },
        },
      },
    }
  }
  const learn = (key: string, metadata: unknown): void => {
    const name = upstreamOf(metadata)
    if (name === undefined) return
    learned.delete(key)
    learned.set(key, slugOf(name))
    if (learned.size > 500) learned.delete(learned.keys().next().value as string)
  }
  // An abort is the caller stopping, not the upstream failing: keep the provider then.
  const forget = (key: string, error?: unknown): void => {
    if ((error as { name?: unknown } | null)?.name === 'AbortError') return
    learned.delete(key)
  }
  const middleware: LanguageModelMiddleware = {
    specificationVersion: 'v4',
    wrapGenerate: async ({ params }: { params: unknown }) => {
      const next = withOrder(params as Record<string, unknown>)
      let result: Record<string, unknown>
      try {
        result = await m.doGenerate(next.params)
      } catch (error) {
        forget(next.key, error)
        throw error
      }
      learn(next.key, result.providerMetadata)
      return result
    },
    wrapStream: async ({ params }: { params: unknown }) => {
      const next = withOrder(params as Record<string, unknown>)
      let result: Record<string, unknown>
      try {
        result = await m.doStream(next.params)
      } catch (error) {
        forget(next.key, error)
        throw error
      }
      const reader = (
        result.stream as ReadableStream<{ type: string; providerMetadata?: unknown }>
      ).getReader()
      let failed = false
      const stream = new ReadableStream<{ type: string; providerMetadata?: unknown }>({
        async pull(controller) {
          let read: Awaited<ReturnType<typeof reader.read>>
          try {
            read = await reader.read()
          } catch (error) {
            forget(next.key, error)
            controller.error(error)
            return
          }
          if (read.done) {
            controller.close()
            return
          }
          const part = read.value
          if (part.type === 'error') {
            failed = true
            forget(next.key)
          } else if (part.type === 'finish' && !failed) learn(next.key, part.providerMetadata)
          controller.enqueue(part)
        },
        cancel(reason) {
          return reader.cancel(reason)
        },
      })
      return { ...result, stream }
    },
  } as unknown as LanguageModelMiddleware
  return wrapLanguageModel({
    model: model as Parameters<typeof wrapLanguageModel>[0]['model'],
    middleware,
  }) as LanguageModel
}

/**
 * `@openrouter/ai-sdk-provider` reads reasoning only from `providerOptions.openrouter.reasoning`:
 * the AI SDK `reasoning` call option (`settings.reasoning`) becomes `{ effort }` there, unless the
 * caller set OpenRouter's own reasoning options. `'provider-default'` sends nothing.
 */
function openRouterReasoning(model: LanguageModel): LanguageModel {
  if (typeof model === 'string' || typeof model !== 'object' || model === null) return model
  const middleware = {
    specificationVersion: 'v4',
    transformParams: async ({ params }: { params: Record<string, unknown> }) => {
      const level = params.reasoning
      if (typeof level !== 'string') return params
      const { reasoning: _taken, ...rest } = params
      if (level === 'provider-default') return rest
      const providerOptions = (params.providerOptions ?? {}) as Record<
        string,
        Record<string, unknown>
      >
      if (providerOptions.openrouter?.reasoning !== undefined) return rest
      return {
        ...rest,
        providerOptions: {
          ...providerOptions,
          openrouter: { ...providerOptions.openrouter, reasoning: { effort: level } },
        },
      }
    },
  } as unknown as LanguageModelMiddleware
  return wrapLanguageModel({
    model: model as Parameters<typeof wrapLanguageModel>[0]['model'],
    middleware,
  }) as LanguageModel
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
    defaultModel: DEFAULT_GATEWAY_MODEL,
    catalog: { kind: 'openrouter' },
    create: (s) => {
      const provider = options.createOpenRouter({
        apiKey: s.apiKey,
        ...(s.baseURL ? { baseURL: s.baseURL } : {}),
        ...(s.headers ? { headers: s.headers } : {}),
      })
      const order = slugList(s.providerOrder)
      const routing: { order?: string[]; allow_fallbacks?: boolean } = {
        ...(order.length > 0 ? { order } : {}),
        ...(s.allowFallbacks === false ? { allow_fallbacks: false } : {}),
      }
      const hasRouting = Object.keys(routing).length > 0
      // usage accounting: the response carries the billed cost (providerMetadata.openrouter.usage.cost)
      const modelSettings: OpenRouterModelSettings = {
        usage: { include: true },
        ...(hasRouting ? { provider: routing } : {}),
      }
      const learned = new Map<string, string>()
      return {
        languageModel: (id) => {
          const model = (
            typeof provider === 'function'
              ? provider(id, modelSettings)
              : provider.languageModel(id, modelSettings)
          ) as LanguageModel
          const routed =
            s.stickyProvider === true
              ? stickyRouting(model, learned, hasRouting ? routing : undefined)
              : model
          return openRouterReasoning(routed)
        },
      }
    },
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
    defaultModel: DEFAULT_GATEWAY_MODEL,
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

/** Any OpenAI-compatible endpoint (vLLM, Ollama, LM Studio, a proxy, a hosted API). */
export function openAICompatibleProvider(
  options: OpenAICompatibleProviderOptions,
): ProviderDefinition {
  return compatibleDefinition(options)
}

/** Adds what a server knows beyond the ids (`local.ts`); never throws. */
type DescribeModels = (
  models: ListedModel[],
  server: LocalServer,
  ctx: ProviderContext,
) => Promise<ListedModel[]> | ListedModel[]

/** `GET <baseURL>/models` ids, with vLLM's `max_model_len` as the context window when present. */
function parseCompatibleList(data: unknown): ListedModel[] {
  const raw = (data as { data?: unknown } | null)?.data
  const lengths = new Map<string, number>()
  if (Array.isArray(raw)) {
    for (const item of raw as Array<{ id?: unknown; max_model_len?: unknown } | null>) {
      const n = item?.max_model_len
      if (typeof item?.id === 'string' && typeof n === 'number' && Number.isFinite(n) && n > 0)
        lengths.set(item.id, Math.floor(n))
    }
  }
  return parseIdList(data).map((m) => {
    const n = lengths.get(m.id)
    return n === undefined ? m : { ...m, info: { contextWindow: n } }
  })
}

function compatibleDefinition(
  options: OpenAICompatibleProviderOptions,
  describe?: DescribeModels,
): ProviderDefinition {
  const settings = z.object({
    // a preset's usual address applies when the field is left empty
    baseURL: (options.defaultBaseURL ? z.url().default(options.defaultBaseURL) : z.url()).meta({
      title: 'Base URL',
      description: 'Endpoint root, for example http://localhost:11434/v1.',
      ...ehMeta({ group: 'endpoint', placeholder: options.defaultBaseURL ?? 'https://host/v1' }),
    }),
    // no environment variable maps to it (`envMap` is empty): no hint
    apiKey:
      options.apiKeyOptional === true
        ? apiKeyField(
            false,
            undefined,
            undefined,
            'Only when the server asks for one (a proxy, or a server started with an API key). Stored encrypted.',
          )
        : apiKeyField(true, undefined),
    headers: headersField,
    contextWindow: z
      .number()
      .int()
      .min(256)
      .optional()
      .meta({
        title: 'Context length',
        description:
          'Tokens the server runs a model with, used when the server does not report it. A model added by hand can set its own.',
        ...ehMeta({ group: 'advanced', placeholder: 'e.g. 32768' }),
      }),
  })
  type S = z.output<typeof settings>
  const id = options.id ?? 'openai-compatible'
  const list = async (s: S, ctx: ProviderContext): Promise<ListedModel[]> => {
    const headers = bearer(s.apiKey, s.headers)
    let models = parseCompatibleList(await getJson(`${trimSlash(s.baseURL)}/models`, headers, ctx))
    if (describe !== undefined) {
      const server: LocalServer = { baseURL: s.baseURL, headers, contextWindow: s.contextWindow }
      models = await describe(models, server, ctx)
    }
    const fallback = s.contextWindow
    if (fallback === undefined) return models
    return models.map((m) =>
      m.info?.contextWindow === undefined
        ? { ...m, info: { ...m.info, contextWindow: fallback } }
        : m,
    )
  }
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

// ---------------------------------------------------------- Local servers

/** Options of the local server presets ({@link ollamaProvider}, {@link lmStudioProvider}, ...). */
export interface LocalProviderOptions {
  /** `createOpenAICompatible` of `@ai-sdk/openai-compatible`. */
  createOpenAICompatible: OpenAICompatibleProviderOptions['createOpenAICompatible']
  /** Definition id. Default: the preset's (`ollama`, `lmstudio`, `vllm`, `llamacpp`). */
  id?: string
  label?: string
  /** Pre-filled base URL. Default: the server's usual local address. */
  defaultBaseURL?: string
}

const localPreset = (
  options: LocalProviderOptions,
  preset: { id: string; label: string; baseURL: string },
  describe: DescribeModels,
): ProviderDefinition =>
  compatibleDefinition(
    {
      createOpenAICompatible: options.createOpenAICompatible,
      id: options.id ?? preset.id,
      label: options.label ?? preset.label,
      defaultBaseURL: options.defaultBaseURL ?? preset.baseURL,
      apiKeyOptional: true,
    },
    describe,
  )

/**
 * Ollama (`http://localhost:11434/v1`). Models list with the context they run with (`/api/ps`, a
 * Modelfile `num_ctx`, the profile's "Context length", else Ollama's 4K default), capabilities
 * (`/api/show`: tools, vision, thinking) and a zero price (not for `*-cloud` models).
 */
export function ollamaProvider(options: LocalProviderOptions): ProviderDefinition {
  return localPreset(
    options,
    { id: 'ollama', label: 'Ollama', baseURL: 'http://localhost:11434/v1' },
    describeOllama,
  )
}

/**
 * LM Studio (`http://localhost:1234/v1`). Models list with the context of the loaded instance
 * (`/api/v1/models`, else `/api/v0/models`; the profile's "Context length", else 4K when not
 * loaded), tools and vision support, display names, a zero price; embedding models are left out.
 */
export function lmStudioProvider(options: LocalProviderOptions): ProviderDefinition {
  return localPreset(
    options,
    { id: 'lmstudio', label: 'LM Studio', baseURL: 'http://localhost:1234/v1' },
    describeLmStudio,
  )
}

/** vLLM (`http://localhost:8000/v1`): the context window is `max_model_len`; a zero price. */
export function vllmProvider(options: LocalProviderOptions): ProviderDefinition {
  return localPreset(
    options,
    { id: 'vllm', label: 'vLLM', baseURL: 'http://localhost:8000/v1' },
    describeVllm,
  )
}

/** llama.cpp server (`http://localhost:8080/v1`): the context window is `n_ctx` of `/props`; a zero price. */
export function llamaCppProvider(options: LocalProviderOptions): ProviderDefinition {
  return localPreset(
    options,
    { id: 'llamacpp', label: 'llama.cpp', baseURL: 'http://localhost:8080/v1' },
    describeLlamaCpp,
  )
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
