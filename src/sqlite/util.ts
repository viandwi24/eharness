/** Small helpers shared by the adapters. Internal, not exported from the package. */
import type { SqlDriver, SqlParam } from './driver.ts'

/** Options every adapter takes. */
export interface AdapterOptions {
  /** Table prefix (letters, digits and underscores). Default `eh_`. */
  prefix?: string
  /** Clock in epoch ms (tests). Default `Date.now`. */
  now?: () => number
}

export const DEFAULT_PREFIX = 'eh_'

/** Table names of one prefix. */
export interface Tables {
  schemaVersion: string
  messages: string
  state: string
  locks: string
  inbox: string
  inboxKeys: string
  streamLog: string
  streamChunks: string
  budgetScope: string
  budgetReservation: string
  budgetRecord: string
  activity: string
  activityMeta: string
  schedules: string
  outbox: string
  handoffs: string
  people: string
  personAccounts: string
  personCodes: string
  personEvents: string
  profiles: string
}

/** Validate a prefix (a programmer error when it is not safe to splice into SQL). */
export function checkPrefix(prefix: string): string {
  if (!/^[A-Za-z0-9_]*$/.test(prefix)) {
    // plain-error: programmer error in the adapter options
    throw new TypeError(
      `eharness/sqlite: prefix "${prefix}" may contain only letters, digits and _`,
    )
  }
  return prefix
}

/** The table names for `prefix`. */
export function tables(prefix: string = DEFAULT_PREFIX): Tables {
  const p = checkPrefix(prefix)
  return {
    schemaVersion: `${p}schema_version`,
    messages: `${p}messages`,
    state: `${p}state`,
    locks: `${p}locks`,
    inbox: `${p}inbox`,
    inboxKeys: `${p}inbox_keys`,
    streamLog: `${p}stream_log`,
    streamChunks: `${p}stream_chunks`,
    budgetScope: `${p}budget_scope`,
    budgetReservation: `${p}budget_reservation`,
    budgetRecord: `${p}budget_record`,
    activity: `${p}activity`,
    activityMeta: `${p}activity_meta`,
    schedules: `${p}schedules`,
    outbox: `${p}outbox`,
    handoffs: `${p}handoffs`,
    people: `${p}people`,
    personAccounts: `${p}person_accounts`,
    personCodes: `${p}person_codes`,
    personEvents: `${p}person_events`,
    profiles: `${p}profiles`,
  }
}

/** `?,?,?` for `n` parameters. */
export const placeholders = (n: number): string => Array.from({ length: n }, () => '?').join(',')

/** One row or `undefined`. */
export function one<T>(db: SqlDriver, sql: string, params?: readonly SqlParam[]): T | undefined {
  return db.query<T>(sql, params)[0]
}

/** Clock of an adapter. */
export const clock = (options: { now?: (() => number) | undefined }): (() => number) =>
  options.now ?? (() => Date.now())

/** Run `fn` for every listener; a throwing listener never breaks the caller. */
export function notifyAll(listeners: ReadonlySet<() => void>): void {
  for (const listener of [...listeners]) {
    try {
      listener()
    } catch {
      // a listener must not break a write
    }
  }
}

/**
 * Poll `read` every `pollMs` while there are listeners; `onChange` runs when the value differs from
 * the previous one. The timer never keeps the process alive.
 */
export function createWatcher(
  read: () => string,
  pollMs: number,
): { add(listener: () => void): () => void; fire(): void; size(): number } {
  const listeners = new Set<() => void>()
  let timer: ReturnType<typeof setInterval> | undefined
  let last = ''
  const tick = (): void => {
    let next: string
    try {
      next = read()
    } catch {
      return // the database went away under a stopped process
    }
    if (next !== last) {
      last = next
      notifyAll(listeners)
    }
  }
  return {
    add(listener) {
      if (listeners.size === 0) {
        try {
          last = read()
        } catch {
          last = ''
        }
        timer = setInterval(tick, Math.max(10, pollMs))
        ;(timer as { unref?: () => void }).unref?.()
      }
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0 && timer !== undefined) {
          clearInterval(timer)
          timer = undefined
        }
      }
    },
    size: () => listeners.size,
    fire() {
      last = ''
      try {
        last = read()
      } catch {
        // see tick
      }
      notifyAll(listeners)
    },
  }
}
