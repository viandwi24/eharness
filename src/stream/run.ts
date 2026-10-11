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
  /** Number of chunks stored so far (the next cursor). */
  readonly length: number
  /** Clones of the chunks `from` … `to - 1` (used by the stream log drainer). */
  slice(from: number, to?: number): UIMessageChunk[]
  /** A stream of the RAW chunks of the turn from chunk `from` (default 0), then live chunks until `close()`. */
  reader(from?: number): ReadableStream<UIMessageChunk>
  /**
   * Continuation turns only (spec 04 §6.3): the chunks that rebuild the continued message, from `start`
   * on. Set before the first `push`; lazy (built when a replay needs it).
   */
  setReplayPrefix(make: () => UIMessageChunk[]): void
  /** Length of the replay view (spec 04 §6.3): the replay prefix, then the raw chunks after the first. */
  readonly replayLength: number
  /** Clones of the replay view chunks `from` … `to - 1` (the stream log stores the replay view). */
  replaySlice(from: number, to?: number): UIMessageChunk[]
  /** Like {@link TurnBuffer.reader} over the replay view: cursor `from` counts replay chunks. */
  replayReader(from?: number): ReadableStream<UIMessageChunk>
}

/** Create an empty turn buffer. */
export function createTurnBuffer(): TurnBuffer {
  const chunks: UIMessageChunk[] = []
  let closed = false
  let wake: (() => void) | undefined
  let changed = new Promise<void>((resolve) => {
    wake = resolve
  })
  let makePrefix: (() => UIMessageChunk[]) | undefined
  let prefixCache: UIMessageChunk[] | undefined
  const prefix = (): UIMessageChunk[] | undefined => {
    if (makePrefix === undefined) return undefined
    prefixCache ??= makePrefix()
    return prefixCache
  }
  /** Chunk `index` of the replay view, `undefined` past its end. */
  const viewAt = (index: number): UIMessageChunk | undefined => {
    const head = prefix()
    if (head === undefined) return chunks[index]
    if (chunks.length === 0) return undefined
    return index < head.length ? head[index] : chunks[index - head.length + 1]
  }
  const viewLength = (): number => {
    const head = prefix()
    if (head === undefined) return chunks.length
    return chunks.length === 0 ? 0 : head.length + chunks.length - 1
  }
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
    get length() {
      return chunks.length
    },
    slice(from, to) {
      return chunks.slice(from, to).map((chunk) => structuredClone(chunk))
    },
    reader(from = 0) {
      let index = Math.max(0, Math.floor(from))
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
    setReplayPrefix(make) {
      if (chunks.length === 0) makePrefix = make
    },
    get replayLength() {
      return viewLength()
    },
    replaySlice(from, to) {
      const end = Math.min(to ?? viewLength(), viewLength())
      const out: UIMessageChunk[] = []
      for (let i = Math.max(0, from); i < end; i++) {
        out.push(structuredClone(viewAt(i) as UIMessageChunk))
      }
      return out
    },
    replayReader(from = 0) {
      let index = Math.max(0, Math.floor(from))
      return new ReadableStream<UIMessageChunk>({
        async pull(controller) {
          while (index >= viewLength() && !closed) await changed
          if (index < viewLength()) {
            controller.enqueue(structuredClone(viewAt(index++) as UIMessageChunk))
            return
          }
          controller.close()
        },
      })
    },
  }
}

type TurnError = NonNullable<TurnResult['error']>

/** HTTP status of a failure before a turn's commit point (spec 04 §7). */
export function statusOfError(code: string | undefined): number {
  switch (code) {
    case 'EH_SESSION_BUSY':
    case 'EH_SESSION_CLOSED':
      return 409
    case 'EH_INVALID_INPUT':
    case 'EH_PENDING_RESPONSE':
    case 'EH_INVALID_MESSAGE':
      return 400
    case 'EH_STORAGE':
    case 'EH_LOCK_UNAVAILABLE':
      return 503
    default:
      return 500
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
  /** Default: accepted at once. */
  accepted?: Promise<TurnError | undefined>
}): HarnessRun<M> {
  const stream = init.stream as HarnessRun<M>['stream']
  const accepted = init.accepted ?? Promise.resolve(undefined)
  const toStreamResponse: HarnessRun<M>['toStreamResponse'] = (responseInit) =>
    createUIMessageStreamResponse({
      ...responseInit,
      stream: stream as ReadableStream<UIMessageChunk>,
    })
  return {
    turnId: init.turnId,
    kind: init.kind,
    messageId: init.messageId,
    stream,
    result: init.result as Promise<TurnResult<M, never>>,
    accepted,
    abort: init.abort,
    toStreamResponse,
    async toResponse(responseInit) {
      const error = await accepted
      if (error === undefined) return toStreamResponse(responseInit)
      const body = JSON.stringify({ error: { code: error.code, message: error.message } })
      const headers = new Headers(responseInit?.headers)
      headers.set('content-type', 'application/json')
      void stream.cancel().catch(() => {})
      return new Response(body, { ...responseInit, status: statusOfError(error.code), headers })
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
 * `toStreamResponse()` / `pipeTo()` answer that HTTP status with a JSON body `{ error: { code, message } }` instead of
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
    accepted: Promise.resolve(result.error),
  })
  if (status === undefined) return run
  const body = JSON.stringify({ error: { code: error.code, message: error.message } })
  return {
    ...run,
    toStreamResponse(init) {
      const headers = new Headers(init?.headers)
      headers.set('content-type', 'application/json')
      return new Response(body, { ...init, status, headers })
    },
    async toResponse(init) {
      return this.toStreamResponse(init)
    },
    async pipeTo(response) {
      response.writeHead(status, { 'content-type': 'application/json' })
      response.end(body)
    },
  }
}
