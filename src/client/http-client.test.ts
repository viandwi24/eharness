import { describe, expect, test } from 'bun:test'
import {
  createHarnessClient,
  HarnessHttpError,
  isHarnessHttpError,
  isNetworkError,
} from './http-client.ts'

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function setup(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ url: string; init: RequestInit; headers: Record<string, string> }> = []
  const client = createHarnessClient({
    baseUrl: 'https://h.test/api///',
    headers: async () => ({ authorization: 'Bearer t' }),
    credentials: 'include',
    fetch: (async (input: RequestInfo | URL, init: RequestInit = {}) => {
      calls.push({
        url: String(input),
        init,
        headers: Object.fromEntries(new Headers(init.headers)),
      })
      return handler(String(input), init)
    }) as typeof fetch,
  })
  return { client, calls }
}

describe('harness client', () => {
  test('builds urls, encodes ids, applies headers and credentials', async () => {
    const { client, calls } = setup(() => json({ id: 'dm:a', running: false }))
    await client.sessions.get('dm:a/b')
    await client.sessions.messages('s1', { before: 'm9', limit: 20 })
    await client.activity.page({ after: 4, limit: 10 })
    expect(calls.map((c) => c.url)).toEqual([
      'https://h.test/api/sessions/dm%3Aa%2Fb',
      'https://h.test/api/sessions/s1/messages?before=m9&limit=20',
      'https://h.test/api/activity?after=4&limit=10',
    ])
    expect(calls[0]?.headers.authorization).toBe('Bearer t')
    expect(calls[0]?.init.credentials).toBe('include')
    expect(client.baseUrl).toBe('https://h.test/api')
  })

  test('errors carry status, code, message and details', async () => {
    const { client } = setup(() =>
      json({ error: { code: 'EH_HTTP_FORBIDDEN', message: 'nope', details: { why: 1 } } }, 403),
    )
    const e = await client.health().catch((x) => x)
    expect(e).toBeInstanceOf(HarnessHttpError)
    expect(isHarnessHttpError(e)).toBe(true)
    expect(isHarnessHttpError(e, 'EH_HTTP_FORBIDDEN')).toBe(true)
    expect(isHarnessHttpError(e, 'other')).toBe(false)
    expect(e).toMatchObject({
      status: 403,
      code: 'EH_HTTP_FORBIDDEN',
      message: 'nope',
      details: { why: 1 },
    })
  })

  test('interrupt, attention answer and send use the documented paths and bodies', async () => {
    const { client, calls } = setup((url) =>
      url.endsWith('/chat?ifBusy=steer')
        ? new Response(JSON.stringify({ inboxId: 'i', delivered: 'steer', target: 'local' }), {
            status: 202,
          })
        : json({ target: 'idle', status: 'resumed', id: 'x', sessionId: 's' }),
    )
    await client.sessions.interrupt('s1', 'because')
    await client.attention.answer('ap1', {
      sessionId: 's1',
      answer: { kind: 'approval', approved: true },
    })
    const sent = await client.sessions.send(
      's1',
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hi' }] },
      { ifBusy: 'steer' },
    )
    expect(sent.kind).toBe('queued')
    expect(calls[0]?.url).toEndWith('/sessions/s1/interrupt')
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ reason: 'because' })
    expect(calls[1]?.url).toEndWith('/attention/ap1/answer')
    expect(calls[2]?.headers['idempotency-key']).toBe('u1')
    expect(JSON.parse(String(calls[2]?.init.body))).toMatchObject({
      id: 's1',
      trigger: 'submit-message',
    })
  })

  test('isNetworkError tells a dropped connection from an abort and a server error', () => {
    expect(isNetworkError(new TypeError('Failed to fetch'))).toBe(true)
    expect(isNetworkError(new Error('socket hang up'))).toBe(true)
    expect(isNetworkError(new DOMException('x', 'AbortError'))).toBe(false)
    expect(isNetworkError(new HarnessHttpError(502, 'HTTP_502', 'network down'))).toBe(false)
  })
})
