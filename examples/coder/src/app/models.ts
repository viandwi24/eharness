/**
 * The models.dev catalog (context windows and prices), cached on disk at `<userDir>/models.json`.
 *
 * A missing cache is fetched once at startup (at most {@link FETCH_TIMEOUT_MS} of waiting); a
 * cache older than 24 h is used as is and refreshed in the background for the next start. Every
 * failure keeps the cache or leaves the catalog empty. `CODER_OFFLINE=1` disables fetching.
 */
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { type ModelCatalog, type ModelInfo, modelsDevCatalog } from 'eharness'
import type { ModelOption, ModelProvider } from '../contracts.ts'

/** Source of the catalog. */
export const MODELS_URL = 'https://models.dev/api.json'
/** Source of the OpenRouter model list (public, no key needed). */
export const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models'
/** A cache older than this is refreshed. */
export const MAX_AGE_MS = 24 * 60 * 60 * 1000
/** Longest a fetch may take. */
export const FETCH_TIMEOUT_MS = 3000

/** Options of {@link loadModelCatalog}; the defaults are what the app uses. */
export interface LoadModelCatalogOptions {
  fetch?: typeof fetch
  now?: () => number
  /** Default: `process.env.CODER_OFFLINE === '1'`. */
  offline?: boolean
}

async function readCache(file: string): Promise<{ data: unknown; mtimeMs: number } | undefined> {
  try {
    const [text, info] = await Promise.all([readFile(file, 'utf8'), stat(file)])
    return { data: JSON.parse(text), mtimeMs: info.mtimeMs }
  } catch {
    return undefined
  }
}

async function download(
  file: string,
  doFetch: typeof fetch,
  url: string = MODELS_URL,
): Promise<unknown | undefined> {
  try {
    const response = await doFetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    if (!response.ok) return undefined
    const text = await response.text()
    const data = JSON.parse(text) as unknown
    if (data === null || typeof data !== 'object') return undefined
    await mkdir(join(file, '..'), { recursive: true })
    const temp = `${file}.${process.pid}.tmp`
    await writeFile(temp, text)
    await rename(temp, file)
    return data
  } catch {
    return undefined
  }
}

/** Cached JSON with the 24 h refresh policy shared by both catalogs. */
async function loadCached(
  file: string,
  url: string,
  opts: LoadModelCatalogOptions,
): Promise<{ data: unknown | undefined; refresh?: Promise<void> }> {
  const offline = opts.offline ?? process.env.CODER_OFFLINE === '1'
  const doFetch = opts.fetch ?? fetch
  const now = opts.now ?? Date.now
  const cached = await readCache(file)
  if (cached !== undefined) {
    const stale = now() - cached.mtimeMs > MAX_AGE_MS
    const refresh = stale && !offline ? download(file, doFetch, url).then(() => {}) : undefined
    return { data: cached.data, ...(refresh ? { refresh } : {}) }
  }
  if (offline) return { data: undefined }
  return { data: await download(file, doFetch, url) }
}

/**
 * Load the catalog. `refresh` (only set when a background refresh was started) resolves when it
 * finished; the returned catalog never changes afterwards.
 */
export async function loadModelCatalog(
  userDir: string,
  opts: LoadModelCatalogOptions = {},
): Promise<{ catalog: ModelCatalog | undefined; raw?: unknown; refresh?: Promise<void> }> {
  const { data, refresh } = await loadCached(join(userDir, 'models.json'), MODELS_URL, opts)
  let catalog: ModelCatalog | undefined
  if (data !== undefined) {
    try {
      catalog = modelsDevCatalog(data)
    } catch {
      catalog = undefined
    }
  }
  return { catalog, ...(data !== undefined ? { raw: data } : {}), ...(refresh ? { refresh } : {}) }
}

const finite = (value: unknown): number | undefined => {
  const n = typeof value === 'string' ? Number(value) : value
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : undefined
}

/** Parsed OpenRouter model list: the eharness catalog and the picker entries. */
export interface OpenRouterModels {
  catalog: Record<string, ModelInfo>
  options: ModelOption[]
}

/** Order of the picker: tool-capable first, then by display name. */
const byUsability = (a: ModelOption, b: ModelOption): number =>
  Number(b.tools) - Number(a.tools) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id)

const perMillion = (perToken: number): number => Math.round(perToken * 1e12) / 1e6

/**
 * Parse the body of `GET /api/v1/models`. Prices are USD per token (strings); the catalog stores
 * USD per 1M tokens. Entries without an id are skipped; a negative price (variable pricing such as
 * `openrouter/auto`) means unpriced.
 */
export function parseOpenRouterModels(data: unknown): OpenRouterModels {
  const out: OpenRouterModels = { catalog: {}, options: [] }
  const list = (data as { data?: unknown } | null)?.data
  if (!Array.isArray(list)) return out
  for (const raw of list as Array<Record<string, unknown> | null>) {
    if (raw === null || typeof raw !== 'object' || typeof raw.id !== 'string' || raw.id === '') {
      continue
    }
    const params = Array.isArray(raw.supported_parameters) ? raw.supported_parameters : []
    const contextWindow = finite(raw.context_length)
    const maxOutput = finite(
      (raw.top_provider as { max_completion_tokens?: unknown } | null)?.max_completion_tokens,
    )
    const price = raw.pricing as Record<string, unknown> | null
    const input = finite(price?.prompt)
    const output = finite(price?.completion)
    const cacheRead = finite(price?.input_cache_read)
    const pricing =
      input !== undefined && output !== undefined
        ? {
            input: perMillion(input),
            output: perMillion(output),
            ...(cacheRead !== undefined ? { cacheRead: perMillion(cacheRead) } : {}),
          }
        : undefined
    const info: ModelInfo = {}
    if (contextWindow !== undefined && contextWindow > 0) info.contextWindow = contextWindow
    if (maxOutput !== undefined && maxOutput > 0) info.maxOutputTokens = maxOutput
    if (pricing !== undefined) info.pricing = pricing
    out.catalog[raw.id] = info
    out.options.push({
      id: raw.id,
      name: typeof raw.name === 'string' && raw.name !== '' ? raw.name : raw.id,
      provider: 'openrouter',
      ...(info.contextWindow !== undefined ? { contextWindow: info.contextWindow } : {}),
      ...(info.maxOutputTokens !== undefined ? { maxOutputTokens: info.maxOutputTokens } : {}),
      ...(pricing !== undefined ? { pricing } : {}),
      reasoning: params.includes('reasoning'),
      tools: params.includes('tools'),
      ...(typeof raw.description === 'string' ? { description: raw.description } : {}),
    })
  }
  out.options.sort(byUsability)
  return out
}

/**
 * The OpenRouter model list, cached at `<userDir>/openrouter-models.json` (24 h, 3 s fetch
 * timeout, `CODER_OFFLINE=1` disables the network). Empty when offline without a cache.
 */
export async function loadOpenRouterModels(
  userDir: string,
  opts: LoadModelCatalogOptions = {},
): Promise<OpenRouterModels & { refresh?: Promise<void> }> {
  const { data, refresh } = await loadCached(
    join(userDir, 'openrouter-models.json'),
    OPENROUTER_MODELS_URL,
    opts,
  )
  return { ...parseOpenRouterModels(data), ...(refresh ? { refresh } : {}) }
}

/** Providers of models.dev whose models the AI Gateway serves under `<provider>/<model>` ids. */
const GATEWAY_PROVIDERS = ['anthropic', 'openai', 'google', 'xai', 'deepseek', 'mistral']

/** Picker entries for the AI Gateway, from the raw models.dev data. */
export function gatewayModelOptions(raw: unknown): ModelOption[] {
  const out: ModelOption[] = []
  if (raw === null || typeof raw !== 'object') return out
  type Entry = {
    name?: unknown
    reasoning?: unknown
    tool_call?: unknown
    limit?: { context?: unknown; output?: unknown }
    cost?: { input?: unknown; output?: unknown; cache_read?: unknown }
  }
  for (const providerId of GATEWAY_PROVIDERS) {
    const models = (raw as Record<string, { models?: Record<string, Entry | null> } | undefined>)[
      providerId
    ]?.models
    if (models === undefined || models === null || typeof models !== 'object') continue
    for (const [modelId, m] of Object.entries(models)) {
      if (m === null || typeof m !== 'object') continue
      const contextWindow = finite(m.limit?.context)
      const maxOutputTokens = finite(m.limit?.output)
      const input = finite(m.cost?.input)
      const output = finite(m.cost?.output)
      const cacheRead = finite(m.cost?.cache_read)
      out.push({
        id: `${providerId}/${modelId}`,
        name: typeof m.name === 'string' ? m.name : modelId,
        provider: 'gateway',
        ...(contextWindow ? { contextWindow } : {}),
        ...(maxOutputTokens ? { maxOutputTokens } : {}),
        ...(input !== undefined && output !== undefined
          ? { pricing: { input, output, ...(cacheRead !== undefined ? { cacheRead } : {}) } }
          : {}),
        reasoning: m.reasoning === true,
        tools: m.tool_call === true,
      })
    }
  }
  return out.sort(byUsability)
}

/** The model catalog and picker entries for `provider`. */
export async function loadProviderModels(
  provider: ModelProvider,
  userDir: string,
  opts: LoadModelCatalogOptions = {},
): Promise<{ catalog: ModelCatalog | undefined; options: ModelOption[]; refresh?: Promise<void> }> {
  if (provider === 'openrouter') {
    const r = await loadOpenRouterModels(userDir, opts)
    return {
      catalog: r.options.length > 0 ? r.catalog : undefined,
      options: r.options,
      ...(r.refresh ? { refresh: r.refresh } : {}),
    }
  }
  const r = await loadModelCatalog(userDir, opts)
  return {
    catalog: r.catalog,
    options: gatewayModelOptions(r.raw),
    ...(r.refresh ? { refresh: r.refresh } : {}),
  }
}
