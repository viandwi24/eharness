/**
 * The outbound queue: every operation that talks to a platform goes through here. Per
 * conversation, operations run one at a time in order, at most one per `chatMinIntervalMs` and,
 * for groups and channels, at most `groupMax` per window; over the whole connection at most
 * `connectionMax` per window. A `rate_limit` error parks the connection for the time the
 * platform asked and retries (the park state is the API governor's: `governor.ts` is the one place
 * that knows when a connection or a chat may talk again; the flood storm is the library outbox's); a `fatal` error (or too many failures in a row) opens a circuit
 * breaker that refuses operations until its cooldown ends and raises an alert once.
 */

import { createGovernor, type Governor, governorLimitsOf } from './governor.ts'
import type { RateLimits } from './policy.ts'
import { ChannelError } from './types.ts'

export interface OutboundOptions {
  limitsOf: (connectionId: string) => RateLimits
  /** The shared API governor (buckets and park state). Absent = a private one. */
  governor?: Governor
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  /** The breaker opened or was extended (every trip): the library outbox worker holds the connection's rows too. */
  onTrip?: (event: { connectionId: string; reason: string; until: number }) => void
  /** The breaker was reset by hand. */
  onReset?: (connectionId: string) => void
  /** The breaker opened (or the identity needs attention): raise an alert. */
  onBreaker?: (event: { connectionId: string; reason: string; until: number }) => void
  onWarn?: (message: string) => void
}

export interface OutboundTarget {
  connectionId: string
  /** The id of the node the operation is for (the lane of its queue). */
  conversationId: string
  /** Direct messages have no per-group window. */
  kind: 'dm' | 'group' | 'channel'
}

export interface Outbound {
  /** Run `op` for the target when the limits allow; resolves with its result. */
  run<T>(target: OutboundTarget, op: () => Promise<T>): Promise<T>
  /** The breaker state of a connection. */
  breaker(connectionId: string): { open: boolean; until: number; reason: string } | undefined
  /** Close a breaker by hand (the person fixed the credential). */
  reset(connectionId: string): void
  /** Open the breaker from outside (a flood storm seen by the library outbox). */
  open(connectionId: string, reason: string): void
}

interface Window {
  times: number[]
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

export function createOutbound(options: OutboundOptions): Outbound {
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? defaultSleep
  const lanes = new Map<string, Promise<unknown>>()
  const chatWindow = new Map<string, Window>()
  const connWindow = new Map<string, Window>()
  const governor =
    options.governor ??
    createGovernor({
      limitsOf: (id) => governorLimitsOf(undefined, options.limitsOf(id).governor),
      now,
      sleep,
    })
  const failures = new Map<string, number>()
  const open = new Map<string, { until: number; reason: string; alerted: boolean }>()

  /** Milliseconds to wait before one more send fits in `w` (0 = now). */
  const waitFor = (
    w: Window | undefined,
    max: number,
    windowMs: number,
    minGap: number,
  ): number => {
    if (w === undefined) return 0
    const t = now()
    w.times = w.times.filter((x) => x > t - windowMs)
    let wait = 0
    const last = w.times.at(-1)
    if (last !== undefined && minGap > 0) wait = Math.max(wait, last + minGap - t)
    if (w.times.length >= max) wait = Math.max(wait, (w.times[0] as number) + windowMs - t)
    return Math.max(0, wait)
  }

  const record = (map: Map<string, Window>, key: string): void => {
    const w = map.get(key) ?? { times: [] }
    w.times.push(now())
    map.set(key, w)
  }

  const trip = (connectionId: string, reason: string): void => {
    const limits = options.limitsOf(connectionId)
    const until = now() + limits.breakerCooldownMs
    const alerted = open.get(connectionId)?.alerted ?? false
    open.set(connectionId, { until, reason, alerted: true })
    options.onTrip?.({ connectionId, reason, until })
    if (!alerted) options.onBreaker?.({ connectionId, reason, until })
  }

  async function exec<T>(
    target: OutboundTarget,
    op: () => Promise<T>,
    queuedAt: number,
  ): Promise<T> {
    const { connectionId } = target
    const chatKey = `${connectionId}\n${target.conversationId}`
    let attempt = 0
    // retries of one operation count once: the breaker is about the connection failing for
    // different messages in a row, never about one message that keeps failing
    let counted = false
    const countFailure = (reason: string): void => {
      if (counted) return
      counted = true
      const n = (failures.get(connectionId) ?? 0) + 1
      failures.set(connectionId, n)
      if (n >= options.limitsOf(connectionId).breakerFailures) trip(connectionId, reason)
    }
    for (;;) {
      const limits = options.limitsOf(connectionId)
      const b = open.get(connectionId)
      if (b !== undefined) {
        if (b.until > now()) {
          throw new ChannelError(
            'fatal',
            `the connection ${connectionId} is paused after errors (${b.reason}); it retries after the cooldown or when a person resets it`,
          )
        }
        // half-open: one attempt may pass; a failure trips it again
        open.delete(connectionId)
      }
      // wait for the limits (and a platform-asked pause), re-checking after every sleep
      for (;;) {
        if (now() - queuedAt > limits.maxWaitMs) {
          throw new ChannelError(
            'transient',
            'the outbound queue is backed up; the message was not sent',
          )
        }
        const wait = Math.max(
          governor.parkedFor(connectionId, chatKey),
          waitFor(
            chatWindow.get(chatKey),
            target.kind === 'dm' ? Number.MAX_SAFE_INTEGER : limits.groupMax,
            limits.groupWindowMs,
            limits.chatMinIntervalMs,
          ),
          waitFor(connWindow.get(connectionId), limits.connectionMax, limits.connectionWindowMs, 0),
        )
        if (wait <= 0) break
        await sleep(Math.ceil(wait))
      }
      record(chatWindow, chatKey)
      record(connWindow, connectionId)
      attempt++
      try {
        const result = await op()
        failures.set(connectionId, 0)
        return result
      } catch (error) {
        if (!(error instanceof ChannelError)) {
          // an adapter bug or a network failure: treat as transient
          countFailure(String(error))
          if (attempt >= limits.maxAttempts) throw error
          await sleep(Math.min(1000 * attempt, 5000))
          continue
        }
        // a request or content error fails this one message: it is no sign the connection is unwell
        if (error.kind === 'invalid') throw error
        if (error.kind === 'fatal') {
          trip(connectionId, error.message)
          throw error
        }
        if (error.kind === 'rate_limit') {
          // the platform asked everyone to wait: park the connection (or the chat) in the
          // governor, then try again. The governor ignores an error it parked already.
          const ms = Math.max(error.retryAfterMs ?? 1000, 1)
          governor.noteError(connectionId, error, chatKey)
          options.onWarn?.(
            `channels: ${connectionId} rate limited${error.scope === 'chat' ? ` (one chat)` : ''}, parked for ${ms} ms`,
          )
          if (attempt >= limits.maxAttempts) throw error
          // the governor's own refusal (an empty bucket) is not parked: wait for the bucket
          if ((error as { local?: boolean }).local === true) await sleep(Math.ceil(ms))
          continue
        }
        countFailure(error.message)
        if (attempt >= limits.maxAttempts) throw error
        await sleep(Math.min(250 * 2 ** (attempt - 1), 5000))
      }
    }
  }

  return {
    run(target, op) {
      const key = `${target.connectionId}\n${target.conversationId}`
      const queuedAt = now()
      const prev = lanes.get(key) ?? Promise.resolve()
      const next = prev.then(
        () => exec(target, op, queuedAt),
        () => exec(target, op, queuedAt),
      )
      lanes.set(
        key,
        next.catch(() => undefined),
      )
      return next
    },
    breaker(connectionId) {
      const b = open.get(connectionId)
      return b === undefined
        ? undefined
        : { open: b.until > now(), until: b.until, reason: b.reason }
    },
    reset(connectionId) {
      open.delete(connectionId)
      failures.set(connectionId, 0)
      governor.reset(connectionId)
      options.onReset?.(connectionId)
    },
    open(connectionId, reason) {
      trip(connectionId, reason)
    },
  }
}
