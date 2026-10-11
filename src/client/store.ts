/**
 * The store contract of `eharness/client`: the Svelte store contract (`subscribe` calls back
 * synchronously) that `useSyncExternalStore` also accepts through `get()`.
 *
 * @see docs/specs/27-client.md#1-stores
 */

/** A readable store. Snapshots are immutable and referentially stable until the next change. */
export interface Store<T> {
  /** Calls `run` synchronously with the current value, then on every change. Returns the unsubscribe. */
  subscribe(run: (value: T) => void): () => void
  /** The current snapshot (the same object until the store changes). */
  get(): T
}

/** A store its owner can write. */
export interface WritableStore<T> extends Store<T> {
  set(value: T): void
  update(fn: (value: T) => T): void
}

/** Timers of a store (injectable for tests). */
export interface StoreTimers {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

/** Hooks of a store that does work only while somebody listens. */
export interface StoreLifecycle {
  /** The first subscriber arrived. */
  onActive?: () => void
  /** The last subscriber left and `graceMs` passed without a new one. */
  onIdle?: () => void
  /** Default 1000. */
  graceMs?: number
  timers?: StoreTimers
}

const realTimers: StoreTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

function freeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value
  for (const key of Object.keys(value)) {
    const child = (value as Record<string, unknown>)[key]
    if (Array.isArray(child)) Object.freeze(child)
  }
  return Object.freeze(value)
}

/**
 * Create a writable store. Objects (and the arrays directly inside them) are frozen on `set`, so a
 * snapshot is safe to hand to a renderer. `set` with the same value (`Object.is`) does not notify.
 */
export function createStore<T>(initial: T, lifecycle: StoreLifecycle = {}): WritableStore<T> {
  let value = freeze(initial)
  const subscribers = new Set<(value: T) => void>()
  const timers = lifecycle.timers ?? realTimers
  let idleTimer: unknown
  let active = false

  const set = (next: T): void => {
    if (Object.is(next, value)) return
    value = freeze(next)
    for (const run of [...subscribers]) run(value)
  }

  return {
    get: () => value,
    set,
    update: (fn) => set(fn(value)),
    subscribe(run) {
      const entry = (v: T): void => run(v)
      subscribers.add(entry)
      if (idleTimer !== undefined) {
        timers.clearTimeout(idleTimer)
        idleTimer = undefined
      }
      if (!active) {
        active = true
        lifecycle.onActive?.()
      }
      run(value)
      let done = false
      return () => {
        if (done) return
        done = true
        subscribers.delete(entry)
        if (subscribers.size > 0 || !active) return
        idleTimer = timers.setTimeout(() => {
          idleTimer = undefined
          if (subscribers.size > 0) return
          active = false
          lifecycle.onIdle?.()
        }, lifecycle.graceMs ?? 1000)
      }
    },
  }
}
