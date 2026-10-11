/**
 * The outbound queue: every operation that talks to a platform goes through here. Per
 * conversation, operations run one at a time in order, at most one per `chatMinIntervalMs` and,
 * for groups and channels, at most `groupMax` per window; over the whole connection at most
 * `connectionMax` per window. A `rate_limit` error parks the connection for the time the
 * platform asked and retries; a `fatal` error (or too many failures in a row) opens a circuit
 * breaker that refuses operations until its cooldown ends and raises an alert once.
 */

import type { RateLimits } from './policy.ts'
import { ChannelError, type ConversationKind } from './types.ts'

export interface OutboundOptions {
  limitsOf: (connectionId: string) => RateLimits
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  /** The breaker opened (or the identity needs attention): raise an alert. */
  onBreaker?: (event: { connectionId: string; reason: string; until: number }) => void
  onWarn?: (message: string) => void
}

export interface OutboundTarget {
  connectionId: string
  conversationId: string
  kind: ConversationKind
}

export interface Outbound {
  /** Run `op` for the target when the limits allow; resolves with its result. */
  run<T>(target: OutboundTarget, op: () => Promise<T>): Promise<T>
  /** The breaker state of a connection. */
  breaker(connectionId: string): { open: boolean; until: number; reason: string } | undefined
  /** Close a breaker by hand (the person fixed the credential). */
  reset(connectionId: string): void
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
  const parkedUntil = new Map<string, number>()
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
        const parked = (parkedUntil.get(connectionId) ?? 0) - now()
        const wait = Math.max(
          parked,
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
          const n = (failures.get(connectionId) ?? 0) + 1
          failures.set(connectionId, n)
          if (n >= limits.breakerFailures) trip(connectionId, String(error))
          if (attempt >= limits.maxAttempts) throw error
          await sleep(Math.min(1000 * attempt, 5000))
          continue
        }
        if (error.kind === 'invalid') throw error
        if (error.kind === 'fatal') {
          trip(connectionId, error.message)
          throw error
        }
        if (error.kind === 'rate_limit') {
          // the platform asked everyone to wait: park the connection, then try again
          const ms = Math.max(error.retryAfterMs ?? 1000, 1)
          parkedUntil.set(connectionId, Math.max(parkedUntil.get(connectionId) ?? 0, now() + ms))
          options.onWarn?.(`channels: ${connectionId} rate limited, parked for ${ms} ms`)
          if (attempt >= limits.maxAttempts) throw error
          continue
        }
        const n = (failures.get(connectionId) ?? 0) + 1
        failures.set(connectionId, n)
        if (n >= limits.breakerFailures) trip(connectionId, error.message)
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
      parkedUntil.delete(connectionId)
    },
  }
}
