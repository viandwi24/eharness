/**
 * Stream log reader (internal): replay + follow of a turn owned by another process.
 *
 * @see docs/specs/04-streaming.md#62-stream-log-port
 */
import type { UIMessageChunk } from 'ai'
import type { StreamLogAdapter, StreamLogKey } from '../agent/session-types.ts'

const PAGE = 256
/** How long a log of a turn the state no longer calls active may stay open before readers end. */
export const ORPHAN_GRACE_MS = 5_000

/** Result of {@link createLogStream}: the stream and how it ended. */
export interface LogStream {
  stream: ReadableStream<UIMessageChunk>
  /** Resolves when the stream ended: `status` of the log (or `'orphaned'`) and the last `stop` seen. */
  ended: Promise<{ status: 'done' | 'error' | 'aborted' | 'orphaned'; stop?: string }>
}

/**
 * Replay the log of `key` from cursor `from`, then follow it until it closes. `isActive` tells
 * whether the state still lists the turn as running (a log whose turn is gone and that is not
 * closed within {@link ORPHAN_GRACE_MS} ends the stream: the owner crashed or lost the log).
 * `signal` and `cancel()` stop only this reader.
 */
export function createLogStream(args: {
  adapter: StreamLogAdapter
  key: StreamLogKey
  from: number
  pollMs: number
  signal?: AbortSignal
  isActive: () => Promise<boolean>
}): LogStream {
  const { adapter, key, pollMs, signal } = args
  let cursor = Math.max(0, Math.floor(args.from))
  let stop: string | undefined
  let wake: (() => void) | undefined
  let unsubscribe: (() => void) | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let inactiveSince: number | undefined
  let finish: (value: Awaited<LogStream['ended']>) => void = () => {}
  const ended = new Promise<Awaited<LogStream['ended']>>((resolve) => {
    finish = resolve
  })
  let stopped = false

  const cleanup = () => {
    stopped = true
    unsubscribe?.()
    if (timer !== undefined) clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
    wake?.()
  }
  const onAbort = () => {
    cleanup()
  }
  signal?.addEventListener('abort', onAbort, { once: true })
  if (signal?.aborted) stopped = true

  try {
    unsubscribe = adapter.subscribe?.(key, () => wake?.())
  } catch {
    unsubscribe = undefined
  }

  const sleep = () =>
    new Promise<void>((resolve) => {
      wake = resolve
      timer = setTimeout(resolve, pollMs)
    }).finally(() => {
      wake = undefined
      if (timer !== undefined) clearTimeout(timer)
    })

  const stream = new ReadableStream<UIMessageChunk>({
    async pull(controller) {
      while (!stopped) {
        let result: Awaited<ReturnType<StreamLogAdapter['read']>>
        try {
          result = await adapter.read(key, cursor, { limit: PAGE })
        } catch {
          // a failing store ends this reader, never the turn
          finish({ status: 'orphaned', ...(stop === undefined ? {} : { stop }) })
          cleanup()
          controller.close()
          return
        }
        if (stopped) break
        if (result.chunks.length > 0) {
          for (const chunk of result.chunks as UIMessageChunk[]) {
            const meta = (chunk as { messageMetadata?: { eharness?: { stop?: string } } })
              .messageMetadata?.eharness?.stop
            if (chunk.type === 'message-metadata' && typeof meta === 'string') stop = meta
            controller.enqueue(chunk)
          }
          cursor = result.next
          inactiveSince = undefined
          return
        }
        if (result.status === 'streaming') {
          if (!(await args.isActive().catch(() => true))) {
            inactiveSince ??= Date.now()
            if (Date.now() - inactiveSince > ORPHAN_GRACE_MS) {
              finish({ status: 'orphaned', ...(stop === undefined ? {} : { stop }) })
              cleanup()
              controller.close()
              return
            }
          } else inactiveSince = undefined
          await sleep()
          continue
        }
        // closed (or expired) and fully read
        finish({
          status: result.status === 'missing' ? 'orphaned' : result.status,
          ...(stop === undefined ? {} : { stop }),
        })
        cleanup()
        controller.close()
        return
      }
      finish({ status: 'orphaned', ...(stop === undefined ? {} : { stop }) })
      try {
        controller.close()
      } catch {
        // already closed
      }
    },
    cancel() {
      finish({ status: 'orphaned', ...(stop === undefined ? {} : { stop }) })
      cleanup()
    },
  })
  return { stream, ended }
}
