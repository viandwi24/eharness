/**
 * The models.dev catalog (context windows and prices), cached on disk at `<userDir>/models.json`.
 *
 * A missing cache is fetched once at startup (at most {@link FETCH_TIMEOUT_MS} of waiting); a
 * cache older than 24 h is used as is and refreshed in the background for the next start. Every
 * failure keeps the cache or leaves the catalog empty. `CODER_OFFLINE=1` disables fetching.
 */
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { type ModelCatalog, modelsDevCatalog } from 'eharness'

/** Source of the catalog. */
export const MODELS_URL = 'https://models.dev/api.json'
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

async function download(file: string, doFetch: typeof fetch): Promise<unknown | undefined> {
  try {
    const response = await doFetch(MODELS_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
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

/**
 * Load the catalog. `refresh` (only set when a background refresh was started) resolves when it
 * finished; the returned catalog never changes afterwards.
 */
export async function loadModelCatalog(
  userDir: string,
  opts: LoadModelCatalogOptions = {},
): Promise<{ catalog: ModelCatalog | undefined; refresh?: Promise<void> }> {
  const file = join(userDir, 'models.json')
  const offline = opts.offline ?? process.env.CODER_OFFLINE === '1'
  const doFetch = opts.fetch ?? fetch
  const now = opts.now ?? Date.now
  const cached = await readCache(file)
  const toCatalog = (data: unknown): ModelCatalog | undefined => {
    try {
      return modelsDevCatalog(data)
    } catch {
      return undefined
    }
  }
  if (cached !== undefined) {
    const stale = now() - cached.mtimeMs > MAX_AGE_MS
    const refresh = stale && !offline ? download(file, doFetch).then(() => {}) : undefined
    return { catalog: toCatalog(cached.data), ...(refresh ? { refresh } : {}) }
  }
  if (offline) return { catalog: undefined }
  const data = await download(file, doFetch)
  return { catalog: data === undefined ? undefined : toCatalog(data) }
}
