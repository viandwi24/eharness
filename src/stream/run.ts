/**
 * Turn buffer, `attach()` readers and `HarnessRun` objects (internal).
 *
 * @see docs/specs/04-streaming.md#6-turn-buffer-attach-and-session-events
 * @see docs/specs/04-streaming.md#7-harnessrun-and-responses
 */
import {
  createUIMessageStreamResponse,
  pipeUIMessageStreamToResponse,
  type UIMessage,
  type UIMessageChunk,
} from 'ai'
import type { HarnessRun } from '../agent/session-types.ts'
import type { TurnKind, TurnResult } from '../messages/types.ts'

/**
 * In-memory copy of every chunk of one turn, cloned at write time (AI SDK later mutates written
 * data chunks while reconciling parts, spec 04 §5).
 */
export interface TurnBuffer {
  /** Append a chunk (a clone is stored). */
  push(chunk: UIMessageChunk): void
  /** No more chunks will be written. */
  close(): void
  readonly closed: boolean
  /** A stream that replays the buffer from the start, then follows live chunks until `close()`. */
  reader(): ReadableStream<UIMessageChunk>
}

/** Create an empty turn buffer. */
export function createTurnBuffer(): TurnBuffer {
  const chunks: UIMessageChunk[] = []
  let closed = false
  let wake: (() => void) | undefined
  let changed = new Promise<void>((resolve) => {
    wake = resolve
  })
  const notify = () => {
    const resolve = wake
    changed = new Promise<void>((next) => {
      wake = next
    })
    resolve?.()
  }
  return {
    push(chunk) {
      if (closed) return
      chunks.push(structuredClone(chunk))
      notify()
    },
    close() {
      if (closed) return
      closed = true
      notify()
    },
    get closed() {
      return closed
    },
    reader() {
      let index = 0
      return new ReadableStream<UIMessageChunk>({
        async pull(controller) {
          while (index >= chunks.length && !closed) await changed
          if (index < chunks.length) {
            // every consumer gets its own copy (readers mutate data parts while reconciling)
            controller.enqueue(structuredClone(chunks[index++] as UIMessageChunk))
            return
          }
          controller.close()
        },
      })
    },
  }
}

/** Build a `HarnessRun` over a stream. */
export function createRun<M extends UIMessage>(init: {
  turnId: string
  kind: TurnKind
  messageId: Promise<string>
  stream: ReadableStream<UIMessageChunk>
  result: Promise<TurnResult<M>>
  abort: (reason?: string) => void
}): HarnessRun<M> {
  const stream = init.stream as HarnessRun<M>['stream']
  return {
    turnId: init.turnId,
    kind: init.kind,
    messageId: init.messageId,
    stream,
    result: init.result,
    abort: init.abort,
    toResponse(responseInit) {
      return createUIMessageStreamResponse({
        ...responseInit,
        stream: stream as ReadableStream<UIMessageChunk>,
      })
    },
    pipeTo(response) {
      return pipeUIMessageStreamToResponse({
        response,
        stream: stream as ReadableStream<UIMessageChunk>,
      })
    },
  }
}
