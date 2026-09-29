/**
 * `lastRead` (spec 08 §4): path → version of the last read, per session, in the plugin state
 * (`plugins.filesystem.lastRead`), capped at 500 entries (least recently used first out).
 *
 * @see docs/specs/08-filesystem-plugin.md#4-editing-rules-from-the-predecessor-harness-proven-in-production
 */
import type { PluginState } from '../index.ts'

/** Maximum number of `lastRead` entries kept in the plugin state. */
export const LAST_READ_LIMIT = 500

/** State key of the `lastRead` map. */
export const LAST_READ_KEY = 'lastRead'

/** Accessor over `ctx.state` for the `lastRead` map. */
export interface LastRead {
  get(path: string): string | undefined
  /** Record a version; the entry becomes the most recently used. */
  set(path: string, version: string): void
  delete(path: string): void
}

/** `lastRead` map over a plugin state; insertion order is the LRU order (oldest first). */
export function lastReadOf(state: PluginState, limit: number = LAST_READ_LIMIT): LastRead {
  const load = (): Record<string, string> => {
    const value = state.get(LAST_READ_KEY)
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
    const out: Record<string, string> = {}
    for (const [path, version] of Object.entries(value)) {
      if (typeof version === 'string') out[path] = version
    }
    return out
  }
  return {
    get(path) {
      return load()[path]
    },
    set(path, version) {
      const map = load()
      delete map[path]
      map[path] = version
      const keys = Object.keys(map)
      for (const key of keys.slice(0, Math.max(0, keys.length - limit))) delete map[key]
      state.set(LAST_READ_KEY, map)
    },
    delete(path) {
      const map = load()
      if (!(path in map)) return
      delete map[path]
      state.set(LAST_READ_KEY, Object.keys(map).length === 0 ? undefined : map)
    },
  }
}
