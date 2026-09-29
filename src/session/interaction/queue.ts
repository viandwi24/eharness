/**
 * Queued turns (internal): the per-session in-memory FIFO of `send(…, { ifBusy: 'queue' })` and
 * undelivered steers, and the `HarnessRun` a queued send returns before its turn starts.
 *
 * @see docs/specs/11-interaction.md#62-queue
 */
import type { UIMessage, UIMessageChunk } from 'ai'
import type { HarnessRun, SendOptions } from '../../agent/session-types.ts'
import type { TurnResult } from '../../messages/types.ts'
import { createRun } from '../../stream/run.ts'
import type { NormalizedInput } from '../input.ts'

/** A queued `send` turn. */
export interface QueuedTurn {
  turnId: string
  /** Normalized input (`undefined` = no-input send). */
  input: NormalizedInput | undefined
  /** Input that already passed `input.submit` (an undelivered steer). */
  submitted?: { input: NormalizedInput; contexts: string[] }
  options: SendOptions
  /** The run handed to the caller (bound to the real run when the turn starts). */
  handle: DeferredRun
}

/** A `HarnessRun` whose turn has not started yet. */
export interface DeferredRun {
  readonly run: HarnessRun<UIMessage>
  /** The turn started: forward its stream, message id, result and abort. */
  bind(real: HarnessRun<UIMessage>): void
  /** The queued turn was dropped (`abort()` / `close()`): `start` → `abort`, stop `'aborted'`. */
  drop(): void
}

/**
 * Create a deferred run. `onAbort` is called when the caller aborts it before the turn started
 * (the queue removes and drops it).
 */
export function createDeferredRun(args: {
  turnId: string
  generateId: () => string
  onAbort: () => void
}): DeferredRun {
  let resolveSource!: (stream: ReadableStream<UIMessageChunk>) => void
  const source = new Promise<ReadableStream<UIMessageChunk>>((resolve) => {
    resolveSource = resolve
  })
  let resolveMessageId!: (id: string) => void
  const messageId = new Promise<string>((resolve) => {
    resolveMessageId = resolve
  })
  let resolveResult!: (result: TurnResult<UIMessage>) => void
  const result = new Promise<TurnResult<UIMessage>>((resolve) => {
    resolveResult = resolve
  })
  let real: HarnessRun<UIMessage> | undefined
  let settled = false

  let reader: ReadableStreamDefaultReader<UIMessageChunk> | undefined
  const stream = new ReadableStream<UIMessageChunk>({
    async pull(controller) {
      reader ??= (await source).getReader()
      const next = await reader.read()
      if (next.done) controller.close()
      else controller.enqueue(next.value)
    },
    async cancel(reason) {
      await reader?.cancel(reason)
    },
  })

  const run = createRun<UIMessage>({
    turnId: args.turnId,
    kind: 'send',
    messageId,
    stream,
    result,
    abort: (reason) => {
      if (real !== undefined) real.abort(reason)
      else if (!settled) args.onAbort()
    },
  })

  return {
    run,
    bind(started) {
      if (settled) return
      settled = true
      real = started
      resolveSource(started.stream as ReadableStream<UIMessageChunk>)
      void started.messageId.then(resolveMessageId)
      void started.result.then(resolveResult)
    },
    drop() {
      if (settled) return
      settled = true
      const id = args.generateId() // throwaway, never stored
      resolveSource(
        new ReadableStream<UIMessageChunk>({
          start(controller) {
            controller.enqueue({ type: 'start', messageId: id })
            controller.enqueue({ type: 'abort', reason: 'aborted' })
            controller.close()
          },
        }),
      )
      resolveMessageId(id)
      resolveResult({
        turnId: args.turnId,
        kind: 'send',
        stop: 'aborted',
        messages: [],
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        steps: 0,
        durationMs: 0,
      })
    },
  }
}
