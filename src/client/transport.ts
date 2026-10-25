/**
 * `createHarnessTransport`: the AI SDK chat transport for `eharness/http`. It builds on
 * `DefaultChatTransport` and only adds what the server contract needs: the last message only, an
 * `Idempotency-Key`, `202` as an empty stream plus `onQueued`, typed errors, and a resume of the
 * active turn after a duplicate. Reconnects replay from the start (`resumeStreamIsReplay`).
 *
 * @see docs/specs/27-client.md#3-chat-transport
 */
import { type ChatTransport, DefaultChatTransport, type UIMessage } from 'ai'
import type { ChatQueued } from '../http/index.ts'
import { type HarnessClient, type Resolvable, readHttpError } from './http-client.ts'

/** Options of {@link createHarnessTransport}. */
export interface HarnessTransportOptions {
  client: HarnessClient
  /** The session of a chat id. Default: the chat id itself. */
  sessionId?: (chatId: string) => string
  /** The busy policy sent as `?ifBusy=` (the server must allow it). Default: none (the server default). */
  ifBusy?: 'reject' | 'steer' | 'wait'
  /** Extra body fields (`clientTools`, `pageContext`), when the server enables them. */
  body?: Resolvable<Record<string, unknown>>
  /** The server answered `202`: the message was handed to a turn that runs elsewhere. */
  onQueued?: (queued: ChatQueued) => void
}

const KEY = /^[A-Za-z0-9_.:-]{1,128}$/

/** A valid, empty UI message stream (`[DONE]` only): lets the chat finish cleanly after a `202`. */
export function emptyStreamResponse(): Response {
  return new Response('data: [DONE]\n\n', {
    status: 200,
    headers: { 'content-type': 'text/event-stream', 'x-vercel-ai-ui-message-stream': 'v1' },
  })
}

class HarnessChatTransport<UI extends UIMessage> extends DefaultChatTransport<UI> {
  constructor(options: ConstructorParameters<typeof DefaultChatTransport<UI>>[0]) {
    super(options)
    // Set after `super`, not as a field: newer `ai` versions declare this member on the base class
    // (a field here would need `override` there and is not allowed with older versions).
    Object.defineProperty(this, 'resumeStreamIsReplay', { value: true, enumerable: true })
  }
}

/**
 * Create the transport of a chat. Pass it to `new Chat({ transport })` (or take
 * `createChatSession(...).chatInit`, which already does).
 */
export function createHarnessTransport<UI extends UIMessage = UIMessage>(
  options: HarnessTransportOptions,
): ChatTransport<UI> {
  const { client } = options
  const sessionOf = options.sessionId ?? ((chatId: string) => chatId)
  const chatUrl = (chatId: string): string => {
    const query = options.ifBusy === undefined ? undefined : { ifBusy: options.ifBusy }
    return client.url(`/sessions/${encodeURIComponent(sessionOf(chatId))}/chat`, query)
  }

  const fetcher = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const target = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const isSend = (init?.method ?? 'GET').toUpperCase() === 'POST'
    const response = await client.request(target, init)
    if (isSend && response.status === 202) {
      const queued = (await response.json().catch(() => undefined)) as ChatQueued | undefined
      if (queued !== undefined) options.onQueued?.(queued)
      return emptyStreamResponse()
    }
    if (response.ok) return response // `204` of a resume is handled by the AI SDK
    const error = await readHttpError(response)
    if (isSend && error.isDuplicate && error.details?.active === true) {
      // the message was stored and its turn still runs (a retried request): follow that turn
      const resume = `${target.split('?')[0]}/stream`
      const followed = await client.request(resume, {
        method: 'GET',
        ...(init?.signal == null ? {} : { signal: init.signal }),
      })
      if (followed.status === 204) return emptyStreamResponse()
      if (followed.ok) return followed
      throw await readHttpError(followed)
    }
    throw error
  }

  return new HarnessChatTransport<UI>({
    api: client.url('/sessions'),
    fetch: fetcher as typeof fetch,
    ...(options.body === undefined ? {} : { body: options.body }),
    prepareSendMessagesRequest: ({ id, messages, trigger, messageId, body }) => {
      // the server reads only the last message and decides everything else itself; a regenerate
      // is decided by `messageId` alone, and the message before the reply may be a stored kind
      // message (an event, a notice) that is not client input: send none, and no idempotency key
      const last = trigger === 'regenerate-message' ? undefined : messages.at(-1)
      return {
        api: chatUrl(id),
        headers: (last !== undefined && KEY.test(last.id)
          ? { 'idempotency-key': last.id }
          : {}) as Record<string, string>,
        body: {
          ...body,
          id: sessionOf(id),
          messages: last === undefined ? [] : [last],
          trigger,
          ...(messageId === undefined ? {} : { messageId }),
        },
      }
    },
    prepareReconnectToStreamRequest: ({ id }) => ({
      api: client.url(`/sessions/${encodeURIComponent(sessionOf(id))}/chat/stream`),
    }),
  })
}
