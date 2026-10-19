/**
 * Durable inbox port and its item, option and stats types.
 *
 * @see docs/specs/05-session-and-storage.md
 */
import type { FileUIPart, JSONValue, TextUIPart } from 'ai'

/**
 * User input in the serialized (JSON) form an inbox stores: normalized `text` / `file` parts, the
 * client's message id and, with `acceptClientMetadata`, app metadata keys.
 *
 * @see docs/specs/05-session-and-storage.md#12-inbox
 */
export interface SerializedInput {
  parts: Array<TextUIPart | FileUIPart>
  clientId?: string
  appMetadata?: Record<string, JSONValue>
  /** Server-set app metadata of `enqueue(…, { metadata })`; becomes `metadata.app` as is. */
  app?: Record<string, JSONValue>
}

/**
 * Debounce of `collect` inputs: they are merged into one user message after `quietMs` without a
 * new item, `maxWaitMs` after the first one, or once `maxItems` are waiting.
 *
 * @see docs/specs/05-session-and-storage.md#12-inbox
 */
export interface CollectOptions {
  /** Default 1 500. */
  quietMs?: number
  /** Default 10 000. */
  maxWaitMs?: number
  /** Default 20. */
  maxItems?: number
}

/**
 * What an {@link InboxAdapter} stores: an input for the session (`send`), a wake-up for a kind
 * message another instance already saved (`wake`), or an abort request (`abort`). `at` is the
 * enqueue time (epoch ms). `availableAt` (epoch ms, optional) makes the item claimable only from
 * then on: until then it is invisible and does not hold back the items after it (a durable timer,
 * not a queue entry; spec 05 §12 rule 14). `dedupeKey` (optional) is the caller id of
 * `session.enqueue(…, { id })`: see {@link InboxAdapter.enqueueOnce} (spec 05 §12 rule 17).
 *
 * @see docs/specs/05-session-and-storage.md#12-inbox
 */
export type InboxItemInput =
  | {
      kind: 'send'
      mode: 'queue' | 'steer' | 'collect'
      input: SerializedInput
      collect?: CollectOptions
      at: number
      availableAt?: number
      dedupeKey?: string
    }
  | { kind: 'wake'; messageId: string; at: number; availableAt?: number; dedupeKey?: string }
  | {
      kind: 'abort'
      turnId?: string
      reason?: string
      at: number
      availableAt?: number
      dedupeKey?: string
    }
  | { kind: 'wait-timeout'; waitId: string; at: number; availableAt?: number; dedupeKey?: string }

/**
 * A stored inbox item: the input plus its id (time-sortable, assigned by the adapter), the
 * number of counted claims (`attempts`, spec 05 §12 rule 11) and the error of the last failed
 * attempt (`lastError`, set by `release(…, { lastError })`).
 *
 * @see docs/specs/05-session-and-storage.md#12-inbox
 */
export type InboxItem = InboxItemInput & { id: string; attempts: number; lastError?: string }

/**
 * A dead-lettered inbox item (spec 05 §12 rule 12): kept by the adapter, never claimed, listed by
 * `listDead()` and made ready again by `redrive()`. `reason` is `'max-attempts'` or
 * `'non-retryable'`; `deadAt` is epoch ms.
 *
 * @see docs/specs/05-session-and-storage.md#12-inbox
 */
export type DeadInboxItem = InboxItem & { sessionId: string; deadAt: number; reason: string }

/**
 * Options of `InboxAdapter.release()` (spec 05 §12 rule 11). An adapter that ignores them keeps
 * the 0.4 behaviour (ready at once, every claim counted).
 *
 * @see docs/specs/05-session-and-storage.md#12-inbox
 */
export interface InboxReleaseOptions {
  /**
   * The items become claimable only after `now + delayMs` (retry backoff). A delayed item keeps
   * its place: `send` / `wake` items behind it are not claimed meanwhile (`abort` items are).
   */
  delayMs?: number
  /**
   * A deferral, not a failed attempt (the core held the items without trying them): undo the
   * `attempts` increment of the claim being released.
   */
  uncount?: boolean
  /** The error of the failed attempt, returned as `lastError` by later claims. */
  lastError?: string
  /**
   * Release only items still claimed by this owner (the owner string of `claim`); items another
   * owner claimed since (a stale holder after its claim expired) are left alone. The core always
   * passes it. Omitted: every claimed item of `ids` (the 0.4 behaviour).
   */
  owner?: string
}

/**
 * Counts of `InboxAdapter.stats()`: `ready` (due, not claimed, not dead), `claimed` (a live
 * claim), `delayed` (released with `delayMs` or `availableAt` in the future), `dead`.
 *
 * @see docs/specs/05-session-and-storage.md#12-inbox
 */
export interface InboxStats {
  ready: number
  claimed: number
  delayed: number
  dead: number
}

/**
 * Optional durable inbox of a multi-instance deployment: inputs, wake-ups and abort requests for a
 * session, drained by whichever instance holds the session (spec 05 §12). eharness ships only
 * `inMemoryInbox()` (`eharness/storage/memory`) and `inboxAdapterConformance` (`eharness/testing`).
 *
 * @see docs/specs/05-session-and-storage.md#12-inbox
 */
export interface InboxAdapter {
  /** Store an item; durable before the promise resolves. Returns its id (time-sortable). */
  enqueue(sessionId: string, item: InboxItemInput): Promise<string>
  /**
   * Optional: idempotent enqueue (spec 05 §12 rule 17). Atomically: when the session already has
   * an item with the same `item.dedupeKey` — still stored (ready, claimed, delayed, dead) or
   * acked within the adapter's dedupe window (at least 24 hours) — store nothing and return
   * `{ id: <the existing item id>, duplicate: true }`; otherwise store the item like `enqueue`
   * and return `{ id, duplicate: false }`. Keys are per session. Required for
   * `session.enqueue(…, { id })` (without it the core throws `EH_INVALID_INPUT`).
   */
  enqueueOnce?(
    sessionId: string,
    item: InboxItemInput & { dedupeKey: string },
  ): Promise<{ id: string; duplicate: boolean }>
  /**
   * Atomically claim the ready items of a session for `owner`, oldest (lowest id) first, at most
   * `limit`. Claimed items are invisible to other claims until `ack` / `release` or until the
   * claim expires (`claimTtlMs`). Every claim increments `attempts`.
   *
   * Head of line: never return an item behind an older item of the session that another owner
   * still holds. Renewal: items `owner` already holds get their claim extended to
   * `now + claimTtlMs` (not returned again, `attempts` unchanged).
   */
  claim(
    sessionId: string,
    owner: string,
    opts?: { limit?: number; claimTtlMs?: number },
  ): Promise<InboxItem[]>
  /** Remove items (their effect is durable). Unknown ids are ignored. */
  ack(ids: string[]): Promise<void>
  /**
   * Make claimed items ready again. Unknown ids are ignored. `opts` (optional to honour, spec 05
   * §12 rule 11): `delayMs` backoff, `uncount` for deferrals, `lastError`.
   */
  release(ids: string[], opts?: InboxReleaseOptions): Promise<void>
  /** Optional: wake the instances subscribed to the session (LISTEN/NOTIFY, pub/sub). */
  notify?(sessionId: string): Promise<void>
  /** Optional: called on `notify` of the session; returns the unsubscribe function. */
  subscribe?(sessionId: string, onNotify: () => void): () => void
  /** Optional: ids of sessions with claimable items (the oldest is not claimed; a sweeper). */
  pending?(opts?: { limit?: number }): Promise<string[]>
  /**
   * Optional: move items to dead (kept, never claimed, listed by `listDead`). Without it the
   * core acks dead items after reporting them (spec 05 §12 rule 12). Unknown ids are ignored.
   */
  deadLetter?(ids: string[], info: { reason: string; lastError?: string }): Promise<void>
  /**
   * Optional: dead items become ready again with `attempts` 0, in their original id order.
   * Unknown ids and ids that are not dead are ignored.
   */
  redrive?(ids: string[]): Promise<void>
  /** Optional: dead items, oldest (lowest id) first (an admin UI). */
  listDead?(opts?: { sessionId?: string; limit?: number }): Promise<DeadInboxItem[]>
  /** Optional: item counts for metrics; without `sessionId` over the whole inbox. */
  stats?(opts?: { sessionId?: string }): Promise<InboxStats>
}

/**
 * Options of `session.enqueue()`.
 *
 * @see docs/specs/05-session-and-storage.md#12-inbox
 */
export interface EnqueueOptions {
  /**
   * `'queue'` (default): a turn of its own after the running one. `'steer'`: delivered into the
   * running turn at its next step boundary (a queued turn when none runs). `'collect'`: merged
   * with other `collect` inputs into one user message (debounced, {@link CollectOptions}).
   */
  mode?: 'queue' | 'steer' | 'collect'
  collect?: CollectOptions
  /**
   * Epoch ms: the item is not claimable before it (a durable timer, spec 05 §12 rule 14). With an
   * inbox only (without one, a future value is `EH_INVALID_INPUT`); not with `mode: 'collect'`.
   */
  availableAt?: number
  /**
   * Caller-supplied id (1–256 chars), unique per session: a repeated id is a no-op that returns
   * the existing item with `duplicate: true` — also after the item was processed, within the
   * inbox's dedupe window (spec 05 §12 rule 17). A deterministic id makes a producer idempotent
   * (`sched:<id>:<scheduledAt>`). With an inbox the adapter must implement `enqueueOnce`; without
   * one the id is remembered for the life of the session object.
   */
  id?: string
  /**
   * App metadata for the user message the item becomes, stored as `metadata.app` (never inside
   * `metadata.eharness`). `enqueue` is a server API, so unlike client input this is trusted (it overrides a client `app` key), but
   * it must be a plain JSON object of at most 16 KiB serialized (`EH_INVALID_INPUT` otherwise).
   * Merged shallowly (later items win) into one message for `mode: 'collect'`; stored as
   * `app` on the `data-eh.input` part of a `steer` delivered into a running turn.
   */
  metadata?: Record<string, unknown>
}

/**
 * Result of `session.enqueue()`: the item id (`metadata.eharness.inboxId` / `collected` of the
 * user message it becomes) and where it will be applied — in this process (`'local'`) or by the
 * instance whose turn is running (`'remote'`, best effort: the holder is decided when it drains).
 * `duplicate: true` when `options.id` was already used: nothing was stored, `inboxId` is the
 * existing item's id.
 *
 * @see docs/specs/05-session-and-storage.md#12-inbox
 */
export interface EnqueueResult {
  inboxId: string
  target: 'local' | 'remote'
  duplicate?: true
}
