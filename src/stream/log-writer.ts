/**
 * Stream log writer (internal): a batched background drainer from the turn buffer to a
 * `StreamLogAdapter`, owned by the turn owner only.
 *
 * @see docs/specs/04-streaming.md#62-stream-log-port
 */
import type { StreamLogAdapter, StreamLogKey } from '../agent/session-types.ts'
import type { HarnessWarning } from '../errors.ts'
import type { TurnBuffer } from './run.ts'

/** Resolved stream log options (spec 04 §6.2). */
export interface StreamLogOptions {
  flushMs: number
  batchSize: number
  retentionMs: number
  pollMs: number
}

export const DEFAULT_STREAM_LOG_OPTIONS: StreamLogOptions = {
  flushMs: 100,
  batchSize: 64,
  retentionMs: 600_000,
  pollMs: 500,
}

/** Fill in the defaults of `HarnessAgentConfig.streams`. */
export function resolveStreamLogOptions(options?: Partial<StreamLogOptions>): StreamLogOptions {
  const pick = (value: number | undefined, fallback: number, min: number): number =>
    typeof value === 'number' && Number.isFinite(value) && value >= min ? value : fallback
  return {
    flushMs: pick(options?.flushMs, DEFAULT_STREAM_LOG_OPTIONS.flushMs, 1),
    batchSize: Math.floor(pick(options?.batchSize, DEFAULT_STREAM_LOG_OPTIONS.batchSize, 1)),
    retentionMs: pick(options?.retentionMs, DEFAULT_STREAM_LOG_OPTIONS.retentionMs, 0),
    pollMs: pick(options?.pollMs, DEFAULT_STREAM_LOG_OPTIONS.pollMs, 10),
  }
}

export interface StreamLogWriter {
  /** Begin draining (after the commit point). Idempotent. */
  start(): void
  /** Flush what is left, close the log and set its retention. No-op when never started. Never rejects. */
  finish(status: 'done' | 'error' | 'aborted'): Promise<void>
}

/** Create the drainer of one turn. Adapter failures are warnings; they never reach the turn. */
export function createStreamLogWriter(args: {
  adapter: StreamLogAdapter
  key: StreamLogKey
  buffer: TurnBuffer
  options: StreamLogOptions
  warn(warning: HarnessWarning, key?: string): void
}): StreamLogWriter {
  const { adapter, key, buffer, options } = args
  let timer: ReturnType<typeof setInterval> | undefined
  let started = false
  let finished = false
  /** Chunks the adapter confirmed (the `at` of the next append). */
  let sent = 0
  let chain: Promise<void> = Promise.resolve()
  const warned = new Set<string>()

  const fail = (operation: 'append' | 'close' | 'expire', error: unknown): void => {
    if (warned.has(operation)) return
    warned.add(operation)
    try {
      args.warn(
        {
          code: 'W_STREAM_LOG_FAILED',
          message: `The stream log ${operation} failed; other instances may not see this turn live.`,
          details: { ...key, operation, error: String(error) },
        },
        `stream-log:${key.turnId}:${operation}`,
      )
    } catch {
      // a warning handler never breaks the drainer
    }
  }

  /** Restarts from cursor 0 after an append failed with chunks already sent (gap: log lost). */
  let restarts = 0
  const MAX_RESTARTS = 3
  /** When the adapter last saw this log (an append or a keep-alive), for the retention refresh. */
  let touchedAt = Date.now()

  /** Append everything not yet confirmed, batch by batch. False when an append failed. */
  async function drain(): Promise<boolean> {
    while (sent < buffer.replayLength) {
      const chunks = buffer.replaySlice(sent, sent + options.batchSize)
      try {
        // `at` makes a retry after an unknown outcome idempotent
        await adapter.append(key, chunks, { at: sent })
        sent += chunks.length
        touchedAt = Date.now()
      } catch (error) {
        // the log may have expired / been lost (a gap): start over from the first chunk, which
        // is safe because appends with `at` are idempotent
        if (sent > 0 && restarts < MAX_RESTARTS) {
          restarts++
          sent = 0
          continue
        }
        fail('append', error)
        return false
      }
    }
    return true
  }

  /** Quiet turn: refresh the retention of the open log before it can expire (spec 04 §6.2). */
  async function keepAlive(): Promise<void> {
    if (adapter.expire === undefined || sent === 0) return
    if (Date.now() - touchedAt < Math.max(options.flushMs, options.retentionMs / 3)) return
    touchedAt = Date.now()
    try {
      await adapter.expire(key, options.retentionMs)
    } catch (error) {
      fail('expire', error)
    }
  }

  const flush = (): Promise<boolean> => {
    const run = chain.then(drain).then(async (ok) => {
      if (ok) await keepAlive()
      return ok
    })
    chain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  return {
    start() {
      if (started) return
      started = true
      timer = setInterval(() => void flush(), options.flushMs)
      ;(timer as { unref?: () => void }).unref?.()
    },
    async finish(status) {
      if (!started || finished) return
      finished = true
      if (timer !== undefined) clearInterval(timer)
      try {
        let ok = await flush()
        for (let attempt = 0; !ok && attempt < 2; attempt++) ok = await flush()
        // never close a log that is missing chunks: readers would take the gap for the end
        if (!ok) return
        try {
          await adapter.close(key, status)
        } catch (error) {
          fail('close', error)
          return
        }
        if (adapter.expire !== undefined) {
          try {
            await adapter.expire(key, options.retentionMs)
          } catch (error) {
            fail('expire', error)
          }
        }
      } catch (error) {
        fail('append', error)
      }
    },
  }
}
