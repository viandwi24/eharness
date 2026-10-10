/**
 * The model catalog (context windows and prices) the agents are built with, cached as JSON next to
 * the database. App policy, not core: the core never fetches (spec 12).
 *
 * - OpenRouter provider: the public OpenRouter list (`openRouterCatalog`);
 * - gateway provider: models.dev (`modelsDevCatalog`);
 * - scripted model / `TEAM_OFFLINE=1`: no catalog, nothing is fetched.
 *
 * A missing cache is fetched at startup (at most {@link FETCH_TIMEOUT_MS}); a cache older than 24 h
 * is used as is and refreshed in the background for the next start. Every failure keeps the cache
 * or leaves the catalog empty: the server never fails to boot because of it.
 */
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { type ModelCatalog, modelsDevCatalog, openRouterCatalog } from 'eharness'
import type { ModelProviderName } from './provider.ts'

export const MODELS_DEV_URL = 'https://models.dev/api.json'
export const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models'
/** A cache older than this is refreshed. */
export const MAX_AGE_MS = 24 * 60 * 60 * 1000
/** Longest a fetch may take. */
export const FETCH_TIMEOUT_MS = 3000

export interface LoadCatalogOptions {
  fetch?: typeof fetch
  now?: () => number
  /** Default: `process.env.TEAM_OFFLINE === '1'`. */
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

async function download(file: string, url: string, doFetch: typeof fetch): Promise<unknown> {
  try {
    const response = await doFetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    if (!response.ok) return undefined
    const text = await response.text()
    const data = JSON.parse(text) as unknown
    if (data === null || typeof data !== 'object') return undefined
    await mkdir(dirname(file), { recursive: true })
    const temp = `${file}.${process.pid}.tmp`
    await writeFile(temp, text)
    await rename(temp, file)
    return data
  } catch {
    return undefined
  }
}

/**
 * Load the catalog of `provider`, cached in `dataDir`. `refresh` is set when a background refresh
 * of a stale cache was started (it resolves when done; the returned catalog never changes).
 */
export async function loadModelCatalog(
  provider: ModelProviderName,
  dataDir: string,
  opts: LoadCatalogOptions = {},
): Promise<{ catalog: ModelCatalog | undefined; refresh?: Promise<void> }> {
  if (provider === 'scripted') return { catalog: undefined }
  const offline = opts.offline ?? process.env.TEAM_OFFLINE === '1'
  const doFetch = opts.fetch ?? fetch
  const now = opts.now ?? Date.now
  const openrouter = provider === 'openrouter'
  const file = join(dataDir, openrouter ? 'openrouter-models.json' : 'models.json')
  const url = openrouter ? OPENROUTER_MODELS_URL : MODELS_DEV_URL

  let data: unknown
  let refresh: Promise<void> | undefined
  const cached = await readCache(file)
  if (cached !== undefined) {
    data = cached.data
    if (now() - cached.mtimeMs > MAX_AGE_MS && !offline) {
      refresh = download(file, url, doFetch).then(() => undefined)
    }
  } else if (!offline) {
    data = await download(file, url, doFetch)
  }
  if (data === undefined) return { catalog: undefined }
  try {
    const catalog = openrouter ? openRouterCatalog(data) : modelsDevCatalog(data)
    return {
      catalog: Object.keys(catalog).length > 0 ? catalog : undefined,
      ...(refresh ? { refresh } : {}),
    }
  } catch {
    return { catalog: undefined }
  }
}
