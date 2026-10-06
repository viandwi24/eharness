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
  type BudgetLedger,
  type DeadInboxItem,
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
  /** Clock used for claim expiry, backoff delays and `availableAt` (tests). Default `Date.now`. */
  now?: () => number
  /** Claim expiry when `claim()` is called without `claimTtlMs`. Default 120 000. */
  claimTtlMs?: number
}

/**
 * In-memory {@link InboxAdapter} (spec 05 §12): one FIFO per session, atomic head-of-line claims
 * with expiry and renewal, `release` options (`delayMs` backoff, `uncount`, `lastError`),
 * `availableAt` timers, a dead-letter store (`deadLetter` / `redrive` / `listDead`), `stats`, and
 * `notify` / `subscribe` / `pending` within the process. Several agent instances in one process
 * (tests, examples) can share it to simulate a multi-instance deployment.
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
  type Entry = {
    sessionId: string
    item: InboxItem
    claim?: { owner: string; until: number }
    /** Released with `delayMs`: keeps its place, claimable from then on. */
    delayedUntil?: number
    dead?: { deadAt: number; reason: string }
  }
  const sessions = new Map<string, Map<string, Entry>>()
  const byId = new Map<string, Entry>()
  const listeners = new Map<string, Set<() => void>>()
  const live = (entry: Entry, at: number) => entry.claim !== undefined && entry.claim.until > at
  const timer = (entry: Entry, at: number) =>
    entry.item.availableAt !== undefined && entry.item.availableAt > at
  const delayed = (entry: Entry, at: number) =>
    entry.delayedUntil !== undefined && entry.delayedUntil > at
  const byIdOrder = (a: Entry, b: Entry) =>
    a.item.id < b.item.id ? -1 : a.item.id > b.item.id ? 1 : 0

  /**
   * The entries a claim of `owner` takes (in id order) and the ones it renews. Dead items and
   * future `availableAt` timers are skipped (they hold nothing back); an item another owner
   * holds stops the scan (head of line); a delayed item holds back the `send` / `wake` items
   * behind it, not `abort` items (rule 14).
   */
  function scan(sessionId: string, at: number, owner: string | undefined) {
    const take: Entry[] = []
    const renew: Entry[] = []
    let blocked = false
    const entries = [...(sessions.get(sessionId)?.values() ?? [])].sort(byIdOrder)
    for (const entry of entries) {
      if (entry.dead !== undefined || timer(entry, at)) continue
      if (live(entry, at)) {
        if (entry.claim?.owner !== owner) break
        renew.push(entry)
        continue
      }
      if (delayed(entry, at)) {
        blocked = true
        continue
      }
      if (blocked && entry.item.kind !== 'abort') continue
      take.push(entry)
    }
    return { take, renew }
  }

  function remove(entry: Entry): void {
    byId.delete(entry.item.id)
    const items = sessions.get(entry.sessionId)
    items?.delete(entry.item.id)
    if (items?.size === 0) sessions.delete(entry.sessionId)
  }

  function deadItem(entry: Entry & { dead: { deadAt: number; reason: string } }): DeadInboxItem {
    return {
      ...structuredClone(entry.item),
      sessionId: entry.sessionId,
      deadAt: entry.dead.deadAt,
      reason: entry.dead.reason,
    }
  }

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
      const { take, renew } = scan(sessionId, at, owner)
      // renewal: the owner still holds them (not returned again, attempts kept)
      for (const entry of renew) if (entry.claim !== undefined) entry.claim.until = at + ttl
      const out: InboxItem[] = []
      for (const entry of take.slice(0, Math.max(0, limit))) {
        entry.claim = { owner, until: at + ttl }
        delete entry.delayedUntil
        entry.item.attempts++
        out.push(structuredClone(entry.item))
      }
      return out
    },
    async ack(ids) {
      for (const id of ids) {
        const entry = byId.get(id)
        if (entry !== undefined) remove(entry)
      }
    },
    async release(ids, opts = {}) {
      const at = now()
      for (const id of ids) {
        const entry = byId.get(id)
        if (entry === undefined || entry.dead !== undefined || entry.claim === undefined) continue
        // a stale holder must not release (or uncount) what another owner claimed since
        if (opts.owner !== undefined && entry.claim.owner !== opts.owner) continue
        delete entry.claim
        if (opts.uncount === true) entry.item.attempts = Math.max(0, entry.item.attempts - 1)
        if (opts.delayMs !== undefined && opts.delayMs > 0) entry.delayedUntil = at + opts.delayMs
        if (opts.lastError !== undefined) entry.item.lastError = opts.lastError
      }
    },
    async deadLetter(ids, info) {
      const at = now()
      for (const id of ids) {
        const entry = byId.get(id)
        if (entry === undefined || entry.dead !== undefined) continue
        delete entry.claim
        delete entry.delayedUntil
        if (info.lastError !== undefined) entry.item.lastError = info.lastError
        entry.dead = { deadAt: at, reason: info.reason }
      }
    },
    async redrive(ids) {
      for (const id of ids) {
        const entry = byId.get(id)
        if (entry?.dead === undefined) continue
        delete entry.dead
        delete entry.item.lastError
        entry.item.attempts = 0
      }
    },
    async listDead(opts = {}) {
      const out: DeadInboxItem[] = []
      const entries = [...byId.values()].sort(byIdOrder)
      for (const entry of entries) {
        if (out.length >= (opts.limit ?? Number.POSITIVE_INFINITY)) break
        if (entry.dead === undefined) continue
        if (opts.sessionId !== undefined && entry.sessionId !== opts.sessionId) continue
        out.push(deadItem(entry as Entry & { dead: { deadAt: number; reason: string } }))
      }
      return out
    },
    async stats(opts = {}) {
      const at = now()
      const out = { ready: 0, claimed: 0, delayed: 0, dead: 0 }
      for (const entry of byId.values()) {
        if (opts.sessionId !== undefined && entry.sessionId !== opts.sessionId) continue
        if (entry.dead !== undefined) out.dead++
        else if (live(entry, at)) out.claimed++
        else if (delayed(entry, at) || timer(entry, at)) out.delayed++
        else out.ready++
      }
      return out
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
      for (const sessionId of sessions.keys()) {
        if (out.length >= (opts.limit ?? Number.POSITIVE_INFINITY)) break
        // claimable by a new owner: head of line, delays and timers as in `claim`
        if (scan(sessionId, at, undefined).take.length > 0) out.push(sessionId)
      }
      return out
    },
  }
}

/** Options of {@link memoryBudgetLedger}. */
export interface MemoryBudgetLedgerOptions {
  /** Static USD limits per scope; a scope without an entry has no limit. No periods. */
  limits?: Record<string, number>
  /** Clock used for reservation expiry (tests). Default `Date.now`. */
  now?: () => number
}

/**
 * In-memory {@link BudgetLedger} (spec 12 §4.1): spent and reserved USD per scope with static
 * limits and no periods, all-or-nothing reservations with expiry, idempotent commit / release /
 * record. Several agent instances in one process (tests, examples) can share it to simulate a
 * multi-instance deployment; a real deployment needs a shared store (see
 * `examples/postgres-budget-ledger.ts`).
 *
 * @example
 * ```ts
 * const adapter = memoryBudgetLedger({ limits: { 'user:ada': 5 } })
 * defineHarnessAgent({ model, models, budget: { ledger: { adapter, scopes: () => ['user:ada'] } } })
 * ```
 * @see docs/specs/12-models-and-cost.md#41-budget-ledger-normative
 */
export function memoryBudgetLedger(options: MemoryBudgetLedgerOptions = {}): BudgetLedger {
  const now = options.now ?? (() => Date.now())
  const limits = new Map(Object.entries(options.limits ?? {}))
  const spent = new Map<string, number>()
  type Reservation = {
    scopes: string[]
    amountUsd: number
    until: number
    key: string
    state: 'open' | 'committed' | 'released'
  }
  const reservations = new Map<string, Reservation>()
  const openByKey = new Map<string, string>()
  const recorded = new Set<string>()

  const isOpen = (r: Reservation, at: number) => r.state === 'open' && r.until > at
  const reservedOn = (scope: string, at: number): number => {
    let sum = 0
    for (const r of reservations.values()) {
      if (isOpen(r, at) && r.scopes.includes(scope)) sum += r.amountUsd
    }
    return sum
  }
  const charge = (scopes: readonly string[], amountUsd: number) => {
    for (const scope of new Set(scopes)) spent.set(scope, (spent.get(scope) ?? 0) + amountUsd)
  }
  const amount = (value: number) => (Number.isFinite(value) && value > 0 ? value : 0)
  const close = (id: string, r: Reservation, state: 'committed' | 'released') => {
    r.state = state
    if (openByKey.get(r.key) === id) openByKey.delete(r.key)
  }

  return {
    async reserve(req) {
      const at = now()
      const existing = openByKey.get(req.key)
      const held = existing === undefined ? undefined : reservations.get(existing)
      if (existing !== undefined && held !== undefined && isOpen(held, at)) {
        return { ok: true, reservationId: existing }
      }
      const amountUsd = amount(req.amountUsd)
      const scopes = [...new Set(req.scopes)]
      for (const scope of scopes) {
        const limit = limits.get(scope)
        if (limit === undefined) continue
        const used = (spent.get(scope) ?? 0) + reservedOn(scope, at)
        if (used >= limit || used + amountUsd > limit) {
          return { ok: false, scope, limitUsd: limit, spentUsd: used }
        }
      }
      const reservationId = uuidv7()
      reservations.set(reservationId, {
        scopes,
        amountUsd,
        until: at + Math.max(0, req.ttlMs),
        key: req.key,
        state: 'open',
      })
      openByKey.set(req.key, reservationId)
      return { ok: true, reservationId }
    },
    async commit(reservationId, actualUsd) {
      const r = reservations.get(reservationId)
      if (r === undefined || r.state !== 'open') return
      // an expired reservation still charges: the spend happened
      close(reservationId, r, 'committed')
      charge(r.scopes, amount(actualUsd))
    },
    async release(reservationId) {
      const r = reservations.get(reservationId)
      if (r === undefined || r.state !== 'open') return
      close(reservationId, r, 'released')
    },
    async record(req) {
      if (recorded.has(req.key)) return
      recorded.add(req.key)
      charge(req.scopes, amount(req.amountUsd))
    },
    async check(scopes) {
      const at = now()
      let ok = true
      const out = [...new Set(scopes)].map((scope) => {
        const limitUsd = limits.get(scope)
        const spentUsd = spent.get(scope) ?? 0
        const reservedUsd = reservedOn(scope, at)
        if (limitUsd !== undefined && spentUsd + reservedUsd >= limitUsd) ok = false
        return limitUsd === undefined
          ? { scope, spentUsd, reservedUsd }
          : { scope, limitUsd, spentUsd, reservedUsd }
      })
      return { ok, scopes: out }
    },
  }
}
