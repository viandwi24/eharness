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
  /** Every raw chunk, before it is folded into the message. */
  onChunk?: (chunk: UIMessageChunk) => void
  /** The stream failed (a dropped connection, a non-2xx answer). The result is `error`. */
  onError?: (error: unknown) => void
}

/**
 * Follow the active turn of `sessionId`. `idle` = nothing streams (`204`). The server replays the
 * whole message first, also for a `respond()` continuation, so `onMessage` always sees a complete
 * message. Never throws: failures (and an abort) give `error`.
 */
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
    const { onChunk } = options
    const chunks =
      onChunk === undefined
        ? stream
        : stream.pipeThrough(
            new TransformStream<UIMessageChunk, UIMessageChunk>({
              transform(chunk, controller) {
                onChunk(chunk)
                controller.enqueue(chunk)
              },
            }),
          )
    for await (const message of readUIMessageStream<UI>({ stream: chunks, onError: () => {} })) {
      options.onMessage?.(message)
    }
    return 'streamed'
  } catch (error) {
    options.onError?.(error)
    return 'error'
  }
}
