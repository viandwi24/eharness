/**
 * In-memory {@link ProfileStore}.
 *
 * @see docs/specs/23-providers.md#3-profiles-and-the-store
 */
import type { ConfigProfile, ProfileStore } from './types.ts'

const key = (kind: string, id: string): string => `${kind}\u0000${id}`

/** A {@link ProfileStore} in memory (tests, single-process apps). Stores copies. */
export function memoryProfileStore(initial: ConfigProfile[] = []): ProfileStore {
  const map = new Map<string, ConfigProfile>()
  const listeners = new Set<() => void>()
  for (const profile of initial) map.set(key(profile.kind, profile.id), structuredClone(profile))
  const notify = (): void => {
    for (const listener of [...listeners]) {
      try {
        listener()
      } catch {
        // a listener must not break the store
      }
    }
  }
  return {
    list: async (query) =>
      [...map.values()]
        .filter((p) => query?.kind === undefined || p.kind === query.kind)
        .map((p) => structuredClone(p)),
    get: async (kind, id) => {
      const profile = map.get(key(kind, id))
      return profile === undefined ? undefined : structuredClone(profile)
    },
    put: async (profile) => {
      map.set(key(profile.kind, profile.id), structuredClone(profile))
      notify()
    },
    delete: async (kind, id) => {
      if (map.delete(key(kind, id))) notify()
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}
