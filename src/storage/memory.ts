/**
 * `eharness/storage/memory`: in-memory `MessageAdapter` and `StateAdapter`.
 *
 * Useful for tests, prototypes and single-process apps that do not need history after a restart.
 * Every read and write deep-copies, so callers can never change stored data by mutating objects.
 *
 * Imports core only through `src/index.ts` (ADR-0008).
 *
 * @see docs/specs/05-session-and-storage.md#4-messageadapter-the-storage-contract
 */
import type { MessageAdapter, SessionStateSnapshot, StateAdapter } from '../index.ts'

type StoredMessage = Parameters<MessageAdapter['save']>[1][number]

/**
 * In-memory {@link MessageAdapter}: messages kept per session, ordered by id, upserted by id.
 *
 * Implements the optional `lastId` for cache validation.
 *
 * @example
 * ```ts
 * // import { memoryMessages, memoryState } from the eharness/storage/memory subpath
 * defineHarnessAgent({ model, storage: { messages: memoryMessages(), state: memoryState() } })
 * ```
 * @see docs/specs/05-session-and-storage.md#4-messageadapter-the-storage-contract
 */
export function memoryMessages(): MessageAdapter {
  const sessions = new Map<string, Map<string, StoredMessage>>()

  const sorted = (sessionId: string): StoredMessage[] => {
    const messages = sessions.get(sessionId)
    if (messages === undefined) return []
    return [...messages.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  }

  return {
    async load(q) {
      if (q.fromId !== undefined && q.beforeId !== undefined) {
        throw new TypeError('MessageAdapter.load: pass either fromId or beforeId, not both.')
      }
      let result = sorted(q.sessionId)
      if (q.fromId !== undefined) {
        const fromId = q.fromId
        result = result.filter((m) => m.id >= fromId)
      } else {
        if (q.beforeId !== undefined) {
          const beforeId = q.beforeId
          result = result.filter((m) => m.id < beforeId)
        }
        if (q.limit !== undefined) result = q.limit > 0 ? result.slice(-q.limit) : []
      }
      return structuredClone(result)
    },
    async save(sessionId, messages) {
      let stored = sessions.get(sessionId)
      if (stored === undefined) {
        stored = new Map()
        sessions.set(sessionId, stored)
      }
      for (const message of structuredClone(messages)) stored.set(message.id, message)
    },
    async lastId(sessionId) {
      return sorted(sessionId).at(-1)?.id ?? null
    },
  }
}

/**
 * In-memory {@link StateAdapter} with compare-and-set (`setIf`) on `rev`.
 *
 * @example
 * ```ts
 * const state = memoryState()
 * defineHarnessAgent({ model, storage: { state } })
 * ```
 * @see docs/specs/05-session-and-storage.md#7-state
 */
export function memoryState(): StateAdapter {
  const snapshots = new Map<string, SessionStateSnapshot>()
  return {
    async get(sessionId) {
      const snapshot = snapshots.get(sessionId)
      return snapshot === undefined ? null : structuredClone(snapshot)
    },
    async set(sessionId, state) {
      snapshots.set(sessionId, structuredClone(state))
    },
    async setIf(sessionId, state, expectedRev) {
      const current = snapshots.get(sessionId)
      const rev = current === undefined ? null : current.rev
      if (rev !== expectedRev) return false
      snapshots.set(sessionId, structuredClone(state))
      return true
    },
  }
}
