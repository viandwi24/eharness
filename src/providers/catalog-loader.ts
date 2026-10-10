/**
 * Cached loader of the public model catalogs (models.dev, OpenRouter). The only code of eharness
 * that fetches, and only through an injected `fetch` (spec 12 keeps the core network-free).
 *
 * @see docs/specs/23-providers.md#5-catalog-loader
 */
import { type ModelInfo, modelsDevCatalog, openRouterCatalog } from '../index.ts'
import type { ListedModel } from './types.ts'

/** Source of the models.dev database. */
export const MODELS_DEV_URL: string = 'https://models.dev/api.json'
/** Source of the OpenRouter model list (public, no key needed). */
export const OPENROUTER_MODELS_URL: string = 'https://openrouter.ai/api/v1/models'
/** Default age after which a cached JSON is refreshed (24 h). */
export const DEFAULT_CATALOG_TTL_MS: number = 24 * 60 * 60 * 1000
/** Default longest a download may take. */
export const DEFAULT_CATALOG_TIMEOUT_MS: number = 3000

/** A cached raw JSON document and when it was fetched. */
export interface CatalogCacheEntry {
  data: unknown
  /** Epoch ms. */
  fetchedAt: number
}

/** Port: where raw catalog JSON is cached between runs (file, database, KV). */
export interface CatalogCache {
  get(key: string): Promise<CatalogCacheEntry | undefined>
  set(key: string, entry: CatalogCacheEntry): Promise<void>
}

/** In-memory {@link CatalogCache}. */
export function memoryCatalogCache(): CatalogCache {
  const map = new Map<string, CatalogCacheEntry>()
  return {
    get: async (key) => {
      const entry = map.get(key)
      return entry === undefined ? undefined : structuredClone(entry)
    },
    set: async (key, entry) => {
      map.set(key, structuredClone(entry))
    },
  }
}

/** Options of {@link loadCachedJson}. */
export interface LoadCachedJsonOptions {
  /** Cache key (`models.dev`, `openrouter`). */
  key: string
  url: string
  fetch: typeof fetch
  cache?: CatalogCache
  now?: () => number
  /** Default {@link DEFAULT_CATALOG_TTL_MS}. */
  ttlMs?: number
  /** Default {@link DEFAULT_CATALOG_TIMEOUT_MS}. */
  timeoutMs?: number
  /** Never touch the network; use the cache only. */
  offline?: boolean
  /** Fetch now even when the cache is fresh. */
  force?: boolean
  signal?: AbortSignal
}

/** Result of {@link loadCachedJson}. */
export interface LoadedJson {
  data: unknown | undefined
  /** Epoch ms of `data`. */
  fetchedAt?: number
  source: 'cache' | 'network' | 'none'
  /** The data is older than the TTL (a refresh failed, was started, or is not allowed). */
  stale: boolean
  /** Set when a background refresh of stale cached data was started; resolves with the new data. */
  refresh?: Promise<unknown | undefined>
}

async function download(
  options: LoadCachedJsonOptions,
  cache: CatalogCache | undefined,
  now: () => number,
): Promise<{ data: unknown; fetchedAt: number } | undefined> {
  try {
    const timeout = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_CATALOG_TIMEOUT_MS)
    const signal =
      options.signal === undefined ? timeout : AbortSignal.any([timeout, options.signal])
    const response = await options.fetch(options.url, { signal })
    if (!response.ok) return undefined
    const data = (await response.json()) as unknown
    if (data === null || typeof data !== 'object') return undefined
    const entry = { data, fetchedAt: now() }
    try {
      await cache?.set(options.key, entry)
    } catch {
      // a failing cache must not lose the data
    }
    return entry
  } catch {
    return undefined
  }
}

/**
 * JSON from the cache or the network with the usual catalog policy: a missing cache is fetched
 * (bounded by `timeoutMs`); a cache older than `ttlMs` is returned as is and refreshed in the
 * background (`refresh`); a failed download keeps the stale cache; `offline` never fetches. Never
 * throws.
 */
export async function loadCachedJson(options: LoadCachedJsonOptions): Promise<LoadedJson> {
  const now = options.now ?? Date.now
  const ttl = options.ttlMs ?? DEFAULT_CATALOG_TTL_MS
  let cached: CatalogCacheEntry | undefined
  try {
    cached = await options.cache?.get(options.key)
  } catch {
    cached = undefined
  }
  const stale = cached !== undefined && now() - cached.fetchedAt > ttl
  if (options.offline === true) {
    return cached === undefined
      ? { data: undefined, source: 'none', stale: false }
      : { data: cached.data, fetchedAt: cached.fetchedAt, source: 'cache', stale }
  }
  if (cached !== undefined && options.force !== true) {
    if (!stale) return { data: cached.data, fetchedAt: cached.fetchedAt, source: 'cache', stale }
    const refresh = download(options, options.cache, now).then((entry) => entry?.data)
    return { data: cached.data, fetchedAt: cached.fetchedAt, source: 'cache', stale, refresh }
  }
  const fresh = await download(options, options.cache, now)
  if (fresh !== undefined) {
    return { data: fresh.data, fetchedAt: fresh.fetchedAt, source: 'network', stale: false }
  }
  return cached === undefined
    ? { data: undefined, source: 'none', stale: false }
    : { data: cached.data, fetchedAt: cached.fetchedAt, source: 'cache', stale: true }
}

const has = (info: ModelInfo): boolean => Object.keys(info).length > 0

/**
 * Parse the body of OpenRouter's `GET /api/v1/models` into listed models: limits and prices come
 * from core `openRouterCatalog`, `reasoning` / `tools` from `supported_parameters`. Entries
 * without an id are skipped.
 */
export function parseOpenRouterModels(data: unknown): ListedModel[] {
  const catalog = openRouterCatalog(data)
  const list = (data as { data?: unknown } | null)?.data
  const out: ListedModel[] = []
  if (!Array.isArray(list)) return out
  for (const raw of list as Array<Record<string, unknown> | null>) {
    if (raw === null || typeof raw !== 'object' || typeof raw.id !== 'string' || raw.id === '') {
      continue
    }
    const params = Array.isArray(raw.supported_parameters) ? raw.supported_parameters : []
    const info = catalog[raw.id]
    out.push({
      id: raw.id,
      name: typeof raw.name === 'string' && raw.name !== '' ? raw.name : raw.id,
      ...(info !== undefined && has(info) ? { info } : {}),
      reasoning: params.includes('reasoning'),
      tools: params.includes('tools'),
      ...(typeof raw.description === 'string' ? { description: raw.description } : {}),
    })
  }
  return out
}

/**
 * List the models of models.dev providers. One key lists plain model ids; several keys (an
 * aggregator) list `<provider>/<model>` ids.
 */
export function parseModelsDevModels(data: unknown, providers: string | string[]): ListedModel[] {
  const out: ListedModel[] = []
  if (data === null || typeof data !== 'object') return out
  const keys = Array.isArray(providers) ? providers : [providers]
  const prefixed = Array.isArray(providers)
  const catalog = modelsDevCatalog(data)
  for (const key of keys) {
    const models = (data as Record<string, { models?: unknown } | undefined>)[key]?.models
    if (models === undefined || models === null || typeof models !== 'object') continue
    for (const [modelId, raw] of Object.entries(models as Record<string, unknown>)) {
      if (raw === null || typeof raw !== 'object') continue
      const m = raw as { name?: unknown; reasoning?: unknown; tool_call?: unknown }
      const info = catalog[`${key}/${modelId}`]
      out.push({
        id: prefixed ? `${key}/${modelId}` : modelId,
        name: typeof m.name === 'string' && m.name !== '' ? m.name : modelId,
        ...(info !== undefined && has(info) ? { info } : {}),
        reasoning: m.reasoning === true,
        tools: m.tool_call === true,
      })
    }
  }
  return out
}

/** Options of {@link loadModelsDev} and {@link loadOpenRouterModels}. */
export type LoadCatalogOptions = Omit<LoadCachedJsonOptions, 'key' | 'url'> & {
  url?: string
}

/** The models.dev catalog (cache key `models.dev`). */
export async function loadModelsDev(
  options: LoadCatalogOptions,
): Promise<LoadedJson & { catalog: Record<string, ModelInfo> }> {
  const loaded = await loadCachedJson({
    ...options,
    key: 'models.dev',
    url: options.url ?? MODELS_DEV_URL,
  })
  return { ...loaded, catalog: modelsDevCatalog(loaded.data) }
}

/** The public OpenRouter list (cache key `openrouter`): catalog and listed models. */
export async function loadOpenRouterModels(
  options: LoadCatalogOptions,
): Promise<LoadedJson & { catalog: Record<string, ModelInfo>; models: ListedModel[] }> {
  const loaded = await loadCachedJson({
    ...options,
    key: 'openrouter',
    url: options.url ?? OPENROUTER_MODELS_URL,
  })
  return {
    ...loaded,
    catalog: openRouterCatalog(loaded.data),
    models: parseOpenRouterModels(loaded.data),
  }
}
