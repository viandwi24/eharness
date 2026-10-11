import { describe, expect, test } from 'bun:test'
import type { UIMessage, UIMessageChunk } from 'ai'
import { createHarnessClient, HarnessHttpError } from './http-client.ts'
import { createHarnessTransport, emptyStreamResponse } from './transport.ts'

const msg = (id: string, role: 'user' | 'assistant' = 'user', text = id): UIMessage => ({
  id,
  role,
  parts: [{ type: 'text', text }],
})

const uiStream = (...chunks: unknown[]): Response =>
  new Response(
    [...chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`), 'data: [DONE]\n\n'].join(''),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  )
const err = (status: number, code: string, details?: Record<string, unknown>): Response =>
  new Response(JSON.stringify({ error: { code, message: `${code} happened`, details } }), {
    status,
    headers: { 'content-type': 'application/json' },
  })

interface Seen {
  url: string
  method: string
  headers: Record<string, string>
  body: Record<string, unknown> | undefined
}

function setup(handler: (seen: Seen, n: number) => Response | Promise<Response>, extra = {}) {
  const calls: Seen[] = []
  const queued: unknown[] = []
  const client = createHarnessClient({
    baseUrl: 'http://x.test/api',
    headers: () => ({ authorization: 'Bearer t' }),
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const seen: Seen = {
        url: String(input),
        method: init?.method ?? 'GET',
        headers: Object.fromEntries(new Headers(init?.headers)),
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      }
      calls.push(seen)
      return handler(seen, calls.length)
    }) as typeof fetch,
  })
  const transport = createHarnessTransport({ client, onQueued: (q) => queued.push(q), ...extra })
  return { calls, queued, transport }
}

async function drain(stream: ReadableStream<UIMessageChunk>): Promise<UIMessageChunk[]> {
  const out: UIMessageChunk[] = []
  const reader = stream.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return out
    out.push(value)
  }
}

const send = (
  t: ReturnType<typeof setup>['transport'],
  messages: UIMessage[],
  trigger = 'submit-message' as const,
) =>
  t.sendMessages({ chatId: 's1', messages, trigger, messageId: undefined, abortSignal: undefined })

describe('harness transport: send', () => {
  test('posts only the last message with an Idempotency-Key, the client headers and the session path', async () => {
    const { calls, transport } = setup(() => uiStream({ type: 'start' }, { type: 'finish' }))
    const chunks = await drain(
      await send(transport, [msg('a1', 'assistant'), msg('u-1'), msg('u-2')]),
    )
    expect(chunks.map((c) => c.type)).toEqual(['start', 'finish'])
    const call = calls[0]
    expect(call?.url).toBe('http://x.test/api/sessions/s1/chat')
    expect(call?.method).toBe('POST')
    expect(call?.headers['idempotency-key']).toBe('u-2')
    expect(call?.headers.authorization).toBe('Bearer t')
    expect(call?.headers['content-type']).toBe('application/json')
    expect(call?.body?.id).toBe('s1')
    expect(((call?.body?.messages ?? []) as UIMessage[]).map((m) => m.id)).toEqual(['u-2'])
    expect(call?.body?.trigger).toBe('submit-message')
  })

  test('maps the chat id to a session id, adds ifBusy and body extras, skips invalid keys', async () => {
    const { calls, transport } = setup(() => uiStream({ type: 'start' }, { type: 'finish' }), {
      sessionId: (chatId: string) => `dm:${chatId}`,
      ifBusy: 'steer',
      body: { pageContext: { page: 'x' } },
    })
    await drain(await send(transport, [msg('bad id!')]))
    expect(calls[0]?.url).toBe('http://x.test/api/sessions/dm%3As1/chat?ifBusy=steer')
    expect(calls[0]?.headers['idempotency-key']).toBeUndefined()
    expect(calls[0]?.body?.id).toBe('dm:s1')
    expect(calls[0]?.body?.pageContext).toEqual({ page: 'x' })
  })

  test('a regenerate sends the trigger and the message id', async () => {
    const { calls, transport } = setup(() => uiStream({ type: 'start' }, { type: 'finish' }))
    await drain(
      await transport.sendMessages({
        chatId: 's1',
        messages: [msg('u1')],
        trigger: 'regenerate-message',
        messageId: 'a9',
        abortSignal: undefined,
      }),
    )
    expect(calls[0]?.body).toMatchObject({ trigger: 'regenerate-message', messageId: 'a9' })
    // decided by the message id alone: no message (it may be a stored event) and no idempotency key
    expect(calls[0]?.body?.messages).toEqual([])
    expect(calls[0]?.headers?.['idempotency-key']).toBeUndefined()
  })

  test('202 becomes onQueued and a valid empty UI message stream', async () => {
    const queuedBody = { inboxId: 'i1', delivered: 'steer', target: 'remote' }
    const { queued, transport } = setup(
      () => new Response(JSON.stringify(queuedBody), { status: 202 }),
    )
    const chunks = await drain(await send(transport, [msg('u1')]))
    expect(chunks).toEqual([])
    expect(queued).toEqual([queuedBody])
  })

  test('a non-OK answer is a HarnessHttpError with status, code and details', async () => {
    const { transport } = setup(() => err(409, 'EH_SESSION_BUSY', { x: 1 }))
    const failure = await send(transport, [msg('u1')]).catch((e) => e)
    expect(failure).toBeInstanceOf(HarnessHttpError)
    expect(failure).toMatchObject({ status: 409, code: 'EH_SESSION_BUSY', details: { x: 1 } })
    expect(failure.isBusy).toBe(true)
  })

  test('409 already-answered and an unparsable error body', async () => {
    const a = setup(() => err(409, 'EH_HTTP_ALREADY_ANSWERED', { ids: ['p'] }))
    const first = await send(a.transport, [msg('u1')]).catch((e) => e)
    expect(first.isAlreadyAnswered).toBe(true)
    const b = setup(() => new Response('<html>bad gateway</html>', { status: 502 }))
    const second = await send(b.transport, [msg('u1')]).catch((e) => e)
    expect(second).toMatchObject({ status: 502, code: 'HTTP_502' })
  })

  test('409 duplicate of an active turn resumes that turn instead of failing', async () => {
    const { calls, transport } = setup((seen) =>
      seen.method === 'POST'
        ? err(409, 'EH_HTTP_DUPLICATE_REQUEST', { active: true, messageId: 'u1', turnId: 't1' })
        : uiStream({ type: 'start' }, { type: 'finish' }),
    )
    const chunks = await drain(await send(transport, [msg('u1')]))
    expect(chunks.map((c) => c.type)).toEqual(['start', 'finish'])
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'POST http://x.test/api/sessions/s1/chat',
      'GET http://x.test/api/sessions/s1/chat/stream',
    ])
  })

  test('409 duplicate that ended: the resume has nothing (204): an empty stream', async () => {
    const { transport } = setup((seen) =>
      seen.method === 'POST'
        ? err(409, 'EH_HTTP_DUPLICATE_REQUEST', { active: true })
        : new Response(null, { status: 204 }),
    )
    expect(await drain(await send(transport, [msg('u1')]))).toEqual([])
  })

  test('409 duplicate of a finished turn is an error the session can recognise', async () => {
    const { transport } = setup(() => err(409, 'EH_HTTP_DUPLICATE_REQUEST', { active: false }))
    const failure = await send(transport, [msg('u1')]).catch((e) => e)
    expect(failure.isDuplicate).toBe(true)
  })
})

describe('harness transport: resume', () => {
  test('reconnects through /chat/stream and replays from the start', async () => {
    const { calls, transport } = setup(() => uiStream({ type: 'start' }, { type: 'finish' }))
    expect(transport.resumeStreamIsReplay).toBe(true)
    const stream = await transport.reconnectToStream({ chatId: 's1' })
    expect(stream).not.toBeNull()
    await drain(stream as ReadableStream<UIMessageChunk>)
    expect(calls[0]).toMatchObject({
      method: 'GET',
      url: 'http://x.test/api/sessions/s1/chat/stream',
    })
    expect(calls[0]?.headers.authorization).toBe('Bearer t')
  })

  test('204 means no active turn', async () => {
    const { transport } = setup(() => new Response(null, { status: 204 }))
    expect(await transport.reconnectToStream({ chatId: 's1' })).toBeNull()
  })

  test('a failed resume is a HarnessHttpError', async () => {
    const { transport } = setup(() => err(403, 'EH_HTTP_FORBIDDEN'))
    const failure = await transport.reconnectToStream({ chatId: 's1' }).catch((e) => e)
    expect(failure).toMatchObject({ status: 403, code: 'EH_HTTP_FORBIDDEN' })
  })
})

test('emptyStreamResponse is a valid UI message stream', async () => {
  const res = emptyStreamResponse()
  expect(res.headers.get('x-vercel-ai-ui-message-stream')).toBe('v1')
  expect(await res.text()).toBe('data: [DONE]\n\n')
})
