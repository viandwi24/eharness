import { describe, expect, test } from 'bun:test'
import type { UIMessage, UIMessageChunk } from 'ai'
import { followSessionStream } from './follow.ts'
import { createHarnessClient } from './http-client.ts'

const sse = (chunks: unknown[]): Response =>
  new Response(`${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('')}data: [DONE]\n\n`, {
    status: 200,
    headers: { 'content-type': 'text/event-stream', 'x-vercel-ai-ui-message-stream': 'v1' },
  })

const turn = [
  { type: 'start', messageId: 'm1' },
  { type: 'start-step' },
  { type: 'text-start', id: 't' },
  { type: 'text-delta', id: 't', delta: 'hel' },
  { type: 'text-delta', id: 't', delta: 'lo' },
  { type: 'text-end', id: 't' },
  { type: 'finish-step' },
  { type: 'finish' },
]

function setup(handler: (url: string) => Response | Promise<Response>) {
  const urls: string[] = []
  const client = createHarnessClient({
    baseUrl: '/api',
    headers: () => ({ authorization: 'Bearer t' }),
    fetch: (async (input: RequestInfo | URL) => {
      urls.push(String(input))
      return handler(String(input))
    }) as typeof fetch,
  })
  return { client, urls }
}

describe('followSessionStream', () => {
  test('builds the streamed message from the resume route', async () => {
    const { client, urls } = setup(() => sse(turn))
    const seen: UIMessage[] = []
    const chunks: UIMessageChunk[] = []
    const result = await followSessionStream(client, 'dm:a', {
      onMessage: (m) => seen.push(structuredClone(m)),
      onChunk: (c) => chunks.push(c),
    })
    expect(result).toBe('streamed')
    expect(urls).toEqual(['/api/sessions/dm%3Aa/chat/stream'])
    expect(chunks).toHaveLength(turn.length)
    expect(seen.at(-1)?.id).toBe('m1')
    expect(seen.at(-1)?.parts.find((p) => p.type === 'text')).toMatchObject({ text: 'hello' })
  })

  test('204 is idle', async () => {
    const { client } = setup(() => new Response(null, { status: 204 }))
    expect(await followSessionStream(client, 's1')).toBe('idle')
  })

  test('a failed request is an error, reported once', async () => {
    const { client } = setup(() => new Response('boom', { status: 500 }))
    const errors: unknown[] = []
    expect(await followSessionStream(client, 's1', { onError: (e) => errors.push(e) })).toBe(
      'error',
    )
    expect(errors).toHaveLength(1)
  })

  test('an abort ends with error', async () => {
    const ctl = new AbortController()
    ctl.abort()
    const client = createHarnessClient({
      baseUrl: '/api',
      fetch: (async (_u: RequestInfo | URL, init?: RequestInit) => {
        init?.signal?.throwIfAborted()
        return sse(turn)
      }) as typeof fetch,
    })
    expect(await followSessionStream(client, 's1', { signal: ctl.signal })).toBe('error')
  })
})
