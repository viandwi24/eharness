/**
 * `followSessionStream`: a read-only follower of the active turn of a session this tab did not
 * start (a task, a routine, another tab). It reads `GET /sessions/:id/chat/stream` through the AI
 * SDK's own transport and folds the chunks with `readUIMessageStream`; nothing is reimplemented.
 *
 * @see docs/specs/27-client.md#8-following-a-session
 */
import { readUIMessageStream, type UIMessage, type UIMessageChunk } from 'ai'
import type { HarnessClient } from './http-client.ts'
import { createHarnessTransport } from './transport.ts'

/** How {@link followSessionStream} ended. */
export type FollowResult = 'streamed' | 'idle' | 'error'

/** Options of {@link followSessionStream}. */
export interface FollowOptions<UI extends UIMessage = UIMessage> {
  signal?: AbortSignal
  /** Every state of the message being built (clone it before keeping it: the SDK mutates it). */
  onMessage?: (message: UI) => void
  /** Every raw chunk, before it is merged, clipped or folded into the message. */
  onChunk?: (chunk: UIMessageChunk) => void
  /**
   * How long (ms) a `text-delta` / `reasoning-delta` waits for the next delta of the same part to
   * be merged with it before the SDK folds it. Default 50; `0` folds every delta on its own.
   * Merging leaves the built message unchanged and cuts the number of message states (each one is
   * a full copy of the message) on long turns.
   */
  deltaHoldMs?: number
  /**
   * Characters of JSON over which a tool `input` / `output` or a non-transient data part's `data`
   * is replaced by a preview, in the shape of `?clip=` reads (`isClippedPart` tells it; fetch the
   * stored message for the whole value). Off by default.
   */
  clip?: number
  /** The stream failed (a dropped connection, a non-2xx answer). The result is `error`. */
  onError?: (error: unknown) => void
}

/**
 * Follow the active turn of `sessionId`. `idle` = nothing streams (`204`). The server replays the
 * whole message first, also for a `respond()` continuation, so `onMessage` always sees a complete
 * message. Never throws: failures (and an abort) give `error`.
 */
type Delta = Extract<UIMessageChunk, { type: 'text-delta' | 'reasoning-delta' }>

const isDelta = (chunk: UIMessageChunk): chunk is Delta =>
  chunk.type === 'text-delta' || chunk.type === 'reasoning-delta'

/**
 * Merge consecutive deltas of the same part, as the SDK reducer would fold them (text appended,
 * the last `providerMetadata` wins). A held delta goes out with the next other chunk, after
 * `holdMs`, or at the end.
 */
function mergeDeltas(holdMs: number): TransformStream<UIMessageChunk, UIMessageChunk> {
  let held: Delta | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const release = (controller: TransformStreamDefaultController<UIMessageChunk>): void => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    if (held === undefined) return
    const out = held
    held = undefined
    controller.enqueue(out)
  }
  return new TransformStream<UIMessageChunk, UIMessageChunk>({
    transform(chunk, controller) {
      if (!isDelta(chunk)) {
        release(controller)
        controller.enqueue(chunk)
        return
      }
      if (held !== undefined && held.type === chunk.type && held.id === chunk.id) {
        const providerMetadata = chunk.providerMetadata ?? held.providerMetadata
        held = {
          ...held,
          delta: held.delta + chunk.delta,
          ...(providerMetadata === undefined ? {} : { providerMetadata }),
        }
        return
      }
      release(controller)
      held = chunk
      timer = setTimeout(() => {
        try {
          release(controller)
        } catch {
          // the stream ended or was cancelled meanwhile
        }
      }, holdMs)
    },
    flush(controller) {
      release(controller)
    },
  })
}

/** The `?clip=` preview of `value` (spec 26 §2.2), or undefined when it is small enough. */
function clipValue(value: unknown, clip: number): unknown {
  if (value === undefined) return undefined
  let text: string | undefined
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value)
  } catch {
    return undefined
  }
  if (text === undefined) return undefined
  const jsonLength = typeof value === 'string' ? JSON.stringify(value).length : text.length
  if (jsonLength <= clip) return undefined
  return { eharnessClipped: true, chars: text.length, preview: text.slice(0, clip) }
}

/** Clip one chunk's tool input/output or data payload; the same chunk when nothing is over. */
function clipChunk(chunk: UIMessageChunk, clip: number): UIMessageChunk {
  if (chunk.type === 'tool-output-available') {
    const output = clipValue(chunk.output, clip)
    return output === undefined ? chunk : { ...chunk, output }
  }
  if (chunk.type === 'tool-input-available') {
    const input = clipValue(chunk.input, clip)
    return input === undefined ? chunk : { ...chunk, input }
  }
  if (chunk.type.startsWith('data-')) {
    const c = chunk as { data?: unknown; transient?: boolean }
    if (c.transient === true) return chunk
    const data = clipValue(c.data, clip)
    return data === undefined ? chunk : ({ ...chunk, data } as UIMessageChunk)
  }
  return chunk
}

export async function followSessionStream<UI extends UIMessage = UIMessage>(
  client: HarnessClient,
  sessionId: string,
  options: FollowOptions<UI> = {},
): Promise<FollowResult> {
  try {
    const transport = createHarnessTransport<UI>({ client })
    const stream = await transport.reconnectToStream({
      chatId: sessionId,
      ...(options.signal === undefined ? {} : { abortSignal: options.signal }),
    })
    if (stream === null) return 'idle'
    const { onChunk, clip } = options
    const holdMs = options.deltaHoldMs ?? 50
    let chunks =
      onChunk === undefined && clip === undefined
        ? stream
        : stream.pipeThrough(
            new TransformStream<UIMessageChunk, UIMessageChunk>({
              transform(chunk, controller) {
                onChunk?.(chunk)
                controller.enqueue(clip === undefined ? chunk : clipChunk(chunk, clip))
              },
            }),
          )
    if (holdMs > 0) chunks = chunks.pipeThrough(mergeDeltas(holdMs))
    for await (const message of readUIMessageStream<UI>({ stream: chunks, onError: () => {} })) {
      options.onMessage?.(message)
    }
    return 'streamed'
  } catch (error) {
    options.onError?.(error)
    return 'error'
  }
}
