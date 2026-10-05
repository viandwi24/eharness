/**
 * `eharness/storage/memory`: in-memory `MessageAdapter`, `StateAdapter` and `InboxAdapter`.
 *
 * Useful for tests, prototypes and single-process apps that do not need history after a restart.
 * Every read and write deep-copies, so callers can never change stored data by mutating objects.
 *
 * Imports core only through `src/index.ts` (ADR-0008).
 *
 * @see docs/specs/05-session-and-storage.md#4-messageadapter-the-storage-contract
 */
import {
  type InboxAdapter,
  type InboxItem,
  type MessageAdapter,
  type SessionStateSnapshot,
  type StateAdapter,
  uuidv7,
} from '../index.ts'

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

/** Options of {@link memoryInbox}. */
export interface MemoryInboxOptions {
  /** Clock used for claim expiry (tests). Default `Date.now`. */
  now?: () => number
  /** Claim expiry when `claim()` is called without `claimTtlMs`. Default 120 000. */
  claimTtlMs?: number
}

/**
 * In-memory {@link InboxAdapter} (spec 05 §12): one FIFO per session, atomic head-of-line claims
 * with expiry and renewal, and `notify` / `subscribe` / `pending` within the process. Several agent instances in one
 * process (tests, examples) can share it to simulate a multi-instance deployment.
 *
 * @example
 * ```ts
 * const inbox = memoryInbox()
 * defineHarnessAgent({ model, storage: { messages, state, inbox } })
 * ```
 * @see docs/specs/05-session-and-storage.md#12-inbox
 */
export function memoryInbox(options: MemoryInboxOptions = {}): InboxAdapter {
  const now = options.now ?? (() => Date.now())
  type Entry = { sessionId: string; item: InboxItem; claim?: { owner: string; until: number } }
  const sessions = new Map<string, Map<string, Entry>>()
  const byId = new Map<string, Entry>()
  const listeners = new Map<string, Set<() => void>>()
  const ready = (entry: Entry, at: number) => entry.claim === undefined || entry.claim.until <= at

  return {
    async enqueue(sessionId, input) {
      const id = uuidv7()
      const entry: Entry = { sessionId, item: { ...structuredClone(input), id, attempts: 0 } }
      let items = sessions.get(sessionId)
      if (items === undefined) {
        items = new Map()
        sessions.set(sessionId, items)
      }
      items.set(id, entry)
      byId.set(id, entry)
      return id
    },
    async claim(sessionId, owner, opts = {}) {
      const at = now()
      const limit = opts.limit ?? Number.POSITIVE_INFINITY
      const ttl = opts.claimTtlMs ?? options.claimTtlMs ?? 120_000
      const out: InboxItem[] = []
      const entries = [...(sessions.get(sessionId)?.values() ?? [])].sort((a, b) =>
        a.item.id < b.item.id ? -1 : a.item.id > b.item.id ? 1 : 0,
      )
      for (const entry of entries) {
        const claim = entry.claim
        if (claim !== undefined && !ready(entry, at)) {
          // head of line: nothing behind an item another owner still holds
          if (claim.owner !== owner) break
          claim.until = at + ttl // renewal: the owner still holds it (not returned again)
          continue
        }
        if (out.length >= limit) continue
        entry.claim = { owner, until: at + ttl }
        entry.item.attempts++
        out.push(structuredClone(entry.item))
      }
      return out
    },
    async ack(ids) {
      for (const id of ids) {
        const entry = byId.get(id)
        if (entry === undefined) continue
        byId.delete(id)
        const items = sessions.get(entry.sessionId)
        items?.delete(id)
        if (items?.size === 0) sessions.delete(entry.sessionId)
      }
    },
    async release(ids) {
      for (const id of ids) {
        const entry = byId.get(id)
        if (entry !== undefined) delete entry.claim
      }
    },
    async notify(sessionId) {
      for (const listener of [...(listeners.get(sessionId) ?? [])]) {
        queueMicrotask(() => {
          try {
            listener()
          } catch {}
        })
      }
    },
    subscribe(sessionId, onNotify) {
      let set = listeners.get(sessionId)
      if (set === undefined) {
        set = new Set()
        listeners.set(sessionId, set)
      }
      const own = () => onNotify()
      set.add(own)
      return () => {
        const current = listeners.get(sessionId)
        current?.delete(own)
        if (current?.size === 0) listeners.delete(sessionId)
      }
    },
    async pending(opts = {}) {
      const at = now()
      const out: string[] = []
      for (const [sessionId, items] of sessions) {
        if (out.length >= (opts.limit ?? Number.POSITIVE_INFINITY)) break
        // claimable: the oldest item is ready (nothing is claimed behind a held item)
        let oldest: Entry | undefined
        for (const entry of items.values()) {
          if (oldest === undefined || entry.item.id < oldest.item.id) oldest = entry
        }
        if (oldest !== undefined && ready(oldest, at)) out.push(sessionId)
      }
      return out
    },
  }
}
