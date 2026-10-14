/**
 * Types of the delivery machinery: the outbox item and the {@link OutboxStore} port.
 *
 * @see docs/specs/31-channels.md#3-outbox
 */

/** JSON value. */
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json }

/** What an app enqueues. */
export interface OutboxItem {
  /** Caller-chosen id: enqueueing the same id twice stores one item (idempotent). */
  id: string
  /** The lane of the item: the circuit breaker and the park key are per target. */
  target: string
  /** What `send` needs; JSON-serializable. */
  payload: Json
  /** Epoch ms from which the item may be claimed. */
  availableAt: number
  /** Attempts already used (normally 0). */
  attempts: number
  /** The item is dead-lettered once this many attempts failed. */
  maxAttempts: number
}

/** `pending` (waiting or leased back), `claimed` (leased), `done`, `dead` (dead-lettered). */
export type OutboxState = 'pending' | 'claimed' | 'done' | 'dead'

/** A stored item. */
export interface OutboxRecord extends OutboxItem {
  state: OutboxState
  owner?: string
  /** Epoch ms the lease of a claimed item ends. */
  leaseUntil?: number
  result?: Json
  /** The last error text. */
  error?: string
  createdAt: number
  updatedAt: number
}

/** Argument of {@link OutboxStore.fail}. */
export interface OutboxFailure {
  /** When to retry (epoch ms). Default: now. */
  retryAt?: number
  error: string
  /** Dead-letter now, whatever the attempts left. */
  permanent?: boolean
}

/**
 * The outbox storage port. Every method is async. `claim` is the only way to lease work and must
 * be atomic: two owners never hold the same item at once. Items are at-least-once: a lease that
 * expires (crashed worker) is claimable again.
 */
export interface OutboxStore {
  /** Store the item; if the id exists, change nothing and return the existing record (`created: false`). */
  enqueue(item: OutboxItem): Promise<{ created: boolean; record: OutboxRecord }>
  /**
   * Lease up to `limit` due items (`pending` with `availableAt <= now`, or `claimed` with an
   * expired lease) to `owner` for `leaseMs`, oldest `availableAt` first, then by id. Each claim
   * increments `attempts`. An expired-lease item that already used `maxAttempts` is dead-lettered
   * instead of claimed.
   */
  claim(now: number, owner: string, leaseMs: number, limit: number): Promise<OutboxRecord[]>
  /** Mark done. False when `owner` no longer holds the lease. */
  succeed(id: string, owner: string, result?: Json): Promise<boolean>
  /**
   * Record a failed attempt: back to `pending` at `retryAt`, or `dead` when `permanent` or the
   * attempts are used up. Returns the new state, or `undefined` when `owner` lost the lease.
   */
  fail(id: string, owner: string, failure: OutboxFailure): Promise<'pending' | 'dead' | undefined>
  /** Give the item back without counting the attempt (breaker open, platform parked). False when the lease is lost. */
  defer(id: string, owner: string, availableAt: number): Promise<boolean>
  get(id: string): Promise<OutboxRecord | undefined>
  /** Records in `state`, oldest `availableAt` first. */
  list(query?: { state?: OutboxState; limit?: number }): Promise<OutboxRecord[]>
  /** Delete `done` and `dead` records last updated before `olderThan`; returns how many. */
  purge(olderThan: number): Promise<number>
}
