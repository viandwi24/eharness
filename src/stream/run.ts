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
import type { HarnessError } from '../errors.ts'
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

/**
 * A run that fails before it starts: a valid stream (`start` → `error` → `message-metadata` →
 * `finish`) and a resolved `run.result` (`stop: 'error'`). With `status`, `toResponse()` /
 * `pipeTo()` answer that HTTP status with a JSON body `{ error: { code, message } }` instead of
 * the stream (e.g. 409 for `EH_SESSION_BUSY` from `handleChatRequest`, spec 11 §7).
 */
export function failedRun(
  kind: TurnKind,
  generateId: () => string,
  error: HarnessError,
  status?: number,
): HarnessRun<UIMessage> {
  const buffer = createTurnBuffer()
  const turnId = generateId()
  const messageId = generateId()
  const chunks: UIMessageChunk[] = [
    { type: 'start', messageId },
    { type: 'error', errorText: error.message },
    {
      type: 'message-metadata',
      messageMetadata: {
        eharness: { stop: 'error', error: { code: error.code, message: error.message } },
      },
    },
    { type: 'finish' },
  ]
  for (const chunk of chunks) buffer.push(chunk)
  buffer.close()
  const result: TurnResult<UIMessage> = {
    turnId,
    kind,
    stop: 'error',
    messages: [],
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    steps: 0,
    durationMs: 0,
    error:
      error.details === undefined
        ? { code: error.code, message: error.message }
        : { code: error.code, message: error.message, details: structuredClone(error.details) },
  }
  const run = createRun({
    turnId,
    kind,
    messageId: Promise.resolve(messageId),
    stream: buffer.reader(),
    result: Promise.resolve(result),
    abort: () => {},
  })
  if (status === undefined) return run
  const body = JSON.stringify({ error: { code: error.code, message: error.message } })
  return {
    ...run,
    toResponse(init) {
      const headers = new Headers(init?.headers)
      headers.set('content-type', 'application/json')
      return new Response(body, { ...init, status, headers })
    },
    async pipeTo(response) {
      response.writeHead(status, { 'content-type': 'application/json' })
      response.end(body)
    },
  }
}
