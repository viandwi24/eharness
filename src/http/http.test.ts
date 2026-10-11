import { describe, expect, test } from 'bun:test'
import { defineHarnessAgent } from '../index.ts'
import { inMemoryMessages, inMemoryState } from '../storage/memory.ts'
import { scriptedModel } from '../testing/scripted-model.ts'
import { denialOf } from './authorize.ts'
import { readJsonBody } from './body.ts'
import { isIdempotencyKey } from './chat.ts'
import { httpError, statusOfCode } from './errors.ts'
import { createHarnessHttp, openAccess } from './index.ts'
import { classifyChatBody, sanitizeChatBody } from './sanitize.ts'

const silent = { debug() {}, info() {}, warn() {}, error() {} }
const text = (id: string, t = 'hi') => ({ id, role: 'user', parts: [{ type: 'text', text: t }] })
const body = (over: Record<string, unknown> = {}) => ({ id: 's1', messages: [text('m1')], ...over })

describe('sanitizeChatBody', () => {
  test('keeps the last message only, with whitelisted fields', () => {
    const r = sanitizeChatBody(
      body({
        messages: [text('old'), { ...text('m2'), metadata: { eharness: { kind: 'x' } }, extra: 1 }],
        actor: { id: 'x' },
        runtime: { a: 1 },
        ifBusy: 'steer',
        model: 'm',
      }),
      { sessionId: 's1' },
    )
    expect(r as unknown).toEqual({
      ok: true,
      body: { messages: [text('m2')] },
      clientId: 'm2',
    })
  })

  test('file parts keep url, mediaType and filename only', () => {
    const r = sanitizeChatBody(
      body({
        messages: [
          {
            id: 'm',
            role: 'user',
            parts: [
              {
                type: 'file',
                url: 'data:x',
                mediaType: 'a/b',
                filename: 'f',
                providerMetadata: {},
              },
            ],
          },
        ],
      }),
    )
    expect(r.ok && r.body.messages[0]?.parts).toEqual([
      { type: 'file', url: 'data:x', mediaType: 'a/b', filename: 'f' },
    ])
  })

  test('file part urls: data only by default, http(s) or a predicate on request', () => {
    const file = (url: string): unknown =>
      body({
        messages: [{ id: 'm', role: 'user', parts: [{ type: 'file', url, mediaType: 'a/b' }] }],
      })
    const remote = 'http://169.254.169.254/latest'
    const refusedDefault = sanitizeChatBody(file(remote))
    expect(!refusedDefault.ok && refusedDefault.details).toEqual({ reason: 'file-url' })
    expect(sanitizeChatBody(file('data:text/plain;base64,aGk=')).ok).toBe(true)
    expect(sanitizeChatBody(file(remote), { allowFileUrls: true }).ok).toBe(true)
    expect(sanitizeChatBody(file('file:///etc/passwd'), { allowFileUrls: true }).ok).toBe(false)
    const only = (u: URL): boolean => u.hostname === 'cdn.example.com'
    expect(
      sanitizeChatBody(file('https://cdn.example.com/a.png'), { allowFileUrls: only }).ok,
    ).toBe(true)
    expect(sanitizeChatBody(file(remote), { allowFileUrls: only }).ok).toBe(false)
  })

  const refused: Array<[string, unknown, Record<string, unknown>?, string?]> = [
    ['not an object', [], undefined, 'EH_HTTP_INVALID_BODY'],
    ['id mismatch', body({ id: 'other' }), { sessionId: 's1' }, 'EH_HTTP_INVALID_BODY'],
    ['missing id', { messages: [text('m')] }, { sessionId: 's1' }, 'EH_HTTP_INVALID_BODY'],
    ['bad trigger', body({ trigger: 'nope' }), undefined, 'EH_HTTP_INVALID_BODY'],
    ['empty messageId', body({ messageId: '' }), undefined, 'EH_HTTP_INVALID_BODY'],
    ['numeric messageId', body({ messageId: 3 }), undefined, 'EH_HTTP_INVALID_BODY'],
    ['messages not an array', body({ messages: 'x' }), undefined, 'EH_HTTP_INVALID_BODY'],
    ['no messages', body({ messages: [] }), undefined, 'EH_HTTP_INVALID_BODY'],
    [
      'system role',
      body({ messages: [{ id: 'm', role: 'system', parts: [] }] }),
      undefined,
      'EH_HTTP_INVALID_BODY',
    ],
    [
      'data part',
      body({ messages: [{ id: 'm', role: 'user', parts: [{ type: 'data-eh.input', data: {} }] }] }),
      undefined,
      'EH_INVALID_INPUT',
    ],
    [
      'tool part in a user message',
      body({ messages: [{ id: 'm', role: 'user', parts: [{ type: 'tool-x' }] }] }),
      undefined,
      'EH_INVALID_INPUT',
    ],
    [
      'reasoning part',
      body({ messages: [{ id: 'm', role: 'user', parts: [{ type: 'reasoning', text: 'x' }] }] }),
      undefined,
      'EH_INVALID_INPUT',
    ],
    [
      'too many parts',
      body({
        messages: [{ id: 'm', role: 'user', parts: Array(3).fill({ type: 'text', text: 'x' }) }],
      }),
      { maxParts: 2 } as never,
      'EH_INVALID_INPUT',
    ],
    [
      'text too large',
      body({ messages: [text('m', 'é'.repeat(10))] }),
      { maxTextBytes: 10 } as never,
      'EH_INVALID_INPUT',
    ],
    [
      'file without url',
      body({ messages: [{ id: 'm', role: 'user', parts: [{ type: 'file', mediaType: 'a/b' }] }] }),
      undefined,
      'EH_INVALID_INPUT',
    ],
  ]
  for (const [name, input, caps, code] of refused) {
    test(`refuses: ${name}`, () => {
      const r = sanitizeChatBody(input, caps as never)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.code as string).toBe(code as string)
    })
  }

  test('an assistant message is reduced to decisions', () => {
    const r = sanitizeChatBody(
      body({
        messages: [
          {
            id: 'a1',
            role: 'assistant',
            metadata: { x: 1 },
            parts: [
              { type: 'text', text: 'ignored' },
              {
                type: 'tool-pay',
                toolCallId: 'c1',
                state: 'approval-responded',
                input: { amount: 99 },
                approval: { id: 'ap1', approved: false, reason: 'no', extra: 1 },
              },
              {
                type: 'tool-ask',
                toolCallId: 'c2',
                state: 'output-available',
                output: { a: 1 },
                input: 'x',
              },
              { type: 'tool-ask', toolCallId: 'c3', state: 'output-error', errorText: 'bad' },
              {
                type: 'tool-ask',
                toolCallId: 'c4',
                state: 'output-available',
                output: 1,
                preliminary: true,
              },
              { type: 'tool-ask', toolCallId: 'c5', state: 'input-available' },
              {
                type: 'tool-pay',
                state: 'approval-responded',
                approval: { id: 'x', approved: 'yes' },
              },
            ],
          },
        ],
      }),
    )
    expect(r.ok && (r.body.messages[0] as unknown)).toEqual({
      id: 'a1',
      role: 'assistant',
      parts: [
        {
          type: 'tool-pay',
          state: 'approval-responded',
          toolCallId: 'c1',
          approval: { id: 'ap1', approved: false, reason: 'no' },
        },
        { type: 'tool-ask', state: 'output-available', toolCallId: 'c2', output: { a: 1 } },
        { type: 'tool-ask', state: 'output-error', toolCallId: 'c3', errorText: 'bad' },
      ],
    })
  })

  test('clientTools and pageContext are read only when enabled', () => {
    const input = body({ clientTools: [{ name: 't' }], pageContext: [{ id: 'p' }] })
    const off = sanitizeChatBody(input)
    expect(off.ok && 'clientTools' in off.body).toBe(false)
    expect(off.ok && 'pageContext' in off.body).toBe(false)
    const on = sanitizeChatBody(input, { clientTools: true, pageContext: true })
    expect(on.ok && on.body.clientTools).toEqual([{ name: 't' }] as never)
    expect(on.ok && on.body.pageContext).toEqual([{ id: 'p' }] as never)
    expect(sanitizeChatBody(body({ clientTools: 'x' }), { clientTools: true }).ok).toBe(false)
  })

  test('regenerate needs no messages', () => {
    const r = sanitizeChatBody({
      id: 's1',
      messages: [],
      trigger: 'regenerate-message',
      messageId: 'a',
    })
    expect(r.ok && classifyChatBody(r.body)).toBe('regenerate')
  })

  test('classifyChatBody follows the dispatch of handleChatRequest', () => {
    const user = sanitizeChatBody(body())
    expect(user.ok && classifyChatBody(user.body)).toBe('send')
    const edit = sanitizeChatBody(body({ messageId: 'x' }))
    expect(edit.ok && classifyChatBody(edit.body)).toBe('edit')
    const respond = sanitizeChatBody(
      body({ messages: [{ id: 'a', role: 'assistant', parts: [] }] }),
    )
    expect(respond.ok && classifyChatBody(respond.body)).toBe('respond')
  })
})

describe('body limits', () => {
  const req = (init: RequestInit & { duplex?: string }) =>
    new Request('http://x/y', { method: 'POST', ...init })
  test('content-length over the limit is a 413 without reading', async () => {
    const r = await readJsonBody(
      req({ headers: { 'content-type': 'application/json', 'content-length': '999' }, body: '{}' }),
      10,
    )
    expect(!r.ok && r.response.status).toBe(413)
  })
  test('a streamed body without content-length is counted', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode('{"a":"'))
        c.enqueue(new TextEncoder().encode('x'.repeat(100)))
        c.enqueue(new TextEncoder().encode('"}'))
        c.close()
      },
    })
    const r = await readJsonBody(
      req({ headers: { 'content-type': 'application/json' }, body: stream, duplex: 'half' }),
      50,
    )
    expect(!r.ok && r.response.status).toBe(413)
  })
  test('invalid JSON is 400, non-JSON is 415, within the limit parses', async () => {
    const json = { 'content-type': 'application/json' }
    const bad = await readJsonBody(req({ headers: json, body: '{' }), 100)
    expect(!bad.ok && bad.response.status).toBe(400)
    const type = await readJsonBody(
      req({ headers: { 'content-type': 'text/plain' }, body: '{}' }),
      100,
    )
    expect(!type.ok && type.response.status).toBe(415)
    const ok = await readJsonBody(
      req({ headers: { 'content-type': 'application/json; charset=utf-8' }, body: '{"a":1}' }),
      100,
    )
    expect(ok).toEqual({ ok: true, value: { a: 1 } })
    const vendor = await readJsonBody(
      req({ headers: { 'content-type': 'application/vnd.x+json' }, body: '[]' }),
      100,
    )
    expect(vendor.ok).toBe(true)
  })
  test('an optional body may be empty', async () => {
    expect(await readJsonBody(req({}), 100, true)).toEqual({ ok: true, value: {} })
  })
})

describe('status table', () => {
  const table: Array<[string, number]> = [
    ['EH_INVALID_INPUT', 400],
    ['EH_INVALID_MESSAGE', 400],
    ['EH_PENDING_RESPONSE', 400],
    ['EH_HTTP_INVALID_JSON', 400],
    ['EH_HTTP_INVALID_BODY', 400],
    ['EH_HTTP_UNAUTHORIZED', 401],
    ['EH_HTTP_FORBIDDEN', 403],
    ['EH_HTTP_NOT_FOUND', 404],
    ['EH_HTTP_METHOD_NOT_ALLOWED', 405],
    ['EH_SESSION_BUSY', 409],
    ['EH_SESSION_CLOSED', 409],
    ['EH_HTTP_ALREADY_ANSWERED', 409],
    ['EH_HTTP_DUPLICATE_REQUEST', 409],
    ['EH_HTTP_PAYLOAD_TOO_LARGE', 413],
    ['EH_HTTP_UNSUPPORTED_MEDIA_TYPE', 415],
    ['EH_COMPACTION_FAILED', 502],
    ['EH_STORAGE', 503],
    ['EH_CONFIG_INVALID', 500],
    ['EH_INTERNAL', 500],
    ['SOMETHING_ELSE', 500],
  ]
  for (const [code, status] of table)
    test(`${code} is ${status}`, () => expect(statusOfCode(code)).toBe(status))

  test('httpError builds the shape and takes a status override', async () => {
    const r = httpError('EH_INVALID_INPUT', 'm', { a: 1 })
    expect(r.status).toBe(400)
    expect(await r.json()).toEqual({
      error: { code: 'EH_INVALID_INPUT', message: 'm', details: { a: 1 } },
    })
    expect(httpError('X', 'm', undefined, 418).status).toBe(418)
  })
})

describe('deny forms', () => {
  test('Response passes through, { deny } becomes the error shape, anything else is a principal', async () => {
    const own = new Response('x', { status: 402 })
    expect(denialOf(own)).toBe(own)
    const d = denialOf({ deny: 403 })
    expect(d?.status).toBe(403)
    expect(await d?.json()).toEqual({
      error: { code: 'EH_HTTP_FORBIDDEN', message: 'Not allowed.' },
    })
    expect(denialOf({ deny: 401 })?.status).toBe(401)
    expect(denialOf({ deny: 404, code: 'C', message: 'M' })?.status).toBe(404)
    expect(denialOf({ deny: 500 })).toBeUndefined()
    expect(denialOf({ id: 'u' })).toBeUndefined()
  })

  test('fail closed: a result that is not an object is a 401', async () => {
    for (const result of [undefined, null, 'user', 42, true, [], ['u']]) {
      const denied = denialOf(result)
      expect(denied?.status).toBe(401)
      expect(await denied?.json()).toEqual({
        error: { code: 'EH_HTTP_UNAUTHORIZED', message: 'Authentication is required.' },
      })
    }
  })

  test('createHarnessHttp answers 401 when authorize returns nothing, and runs the route for a principal', async () => {
    const agent = defineHarnessAgent({
      model: scriptedModel([]),
      contextWindow: 100_000,
      storage: { messages: inMemoryMessages(), state: inMemoryState() },
      logger: silent,
    })
    const get = (authorize: () => unknown) =>
      createHarnessHttp(agent, { authorize: authorize as never }).fetch(
        new Request('http://x/health'),
      )
    for (const result of [undefined, null, 'user']) {
      expect((await get(() => result)).status).toBe(401)
    }
    expect((await get(() => ({ id: 'u' }))).status).toBe(200)
  })
})

describe('idempotency keys', () => {
  test('validation', () => {
    for (const ok of ['a', 'A-b_c.d:e', 'x'.repeat(128)]) expect(isIdempotencyKey(ok)).toBe(true)
    for (const bad of ['', 'x'.repeat(129), 'a b', 'a/b', 'é', 'a;b'])
      expect(isIdempotencyKey(bad)).toBe(false)
  })
})

describe('routing', () => {
  const make = (extra: Record<string, unknown> = {}) => {
    const agent = defineHarnessAgent({
      model: scriptedModel([]),
      contextWindow: 100_000,
      storage: { messages: inMemoryMessages(), state: inMemoryState() },
      logger: silent,
    })
    return createHarnessHttp(agent, { authorize: openAccess, ...extra })
  }
  const status = async (http: ReturnType<typeof make>, method: string, path: string) =>
    http.fetch(new Request(`http://x${path}`, { method }))

  test('404 for unknown paths and routes whose option is absent', async () => {
    const http = make()
    for (const path of [
      '/',
      '/nope',
      '/sessions/a/b/c',
      '/sessions',
      '/attention',
      '/activity',
      '/activity/stream',
    ]) {
      const r = await status(http, 'GET', path)
      expect(r.status).toBe(404)
      expect(((await r.json()) as { error: { code: string } }).error.code).toBe('EH_HTTP_NOT_FOUND')
    }
  })

  test('405 with Allow when the path exists with another method', async () => {
    const http = make()
    const r = await status(http, 'DELETE', '/sessions/a/chat')
    expect(r.status).toBe(405)
    expect(r.headers.get('allow')).toBe('POST')
    expect((await status(http, 'POST', '/health')).headers.get('allow')).toBe('GET')
    expect((await status(http, 'OPTIONS', '/sessions/a')).status).toBe(405)
    expect((await status(http, 'GET', '/sessions/a/interrupt')).headers.get('allow')).toBe('POST')
  })

  test('basePath, trailing slash, encoded ids and match()', async () => {
    const http = make({ basePath: 'api/' })
    expect((await status(http, 'GET', '/health')).status).toBe(404)
    expect((await status(http, 'GET', '/api/health')).status).toBe(200)
    expect((await status(http, 'GET', '/api/health/')).status).toBe(200)
    expect((await status(http, 'GET', '/apix/health')).status).toBe(404)
    expect(http.match(new Request('http://x/api/sessions/dm%3Aabc/messages'))).toEqual({
      action: 'session.messages',
      params: { id: 'dm:abc' },
    })
    expect(http.match(new Request('http://x/api/sessions/%E0%A4/messages'))).toBeNull()
    expect(http.routes.map((r) => `${r.method} ${r.path}`)).toContain('POST /api/sessions/:id/chat')
    expect(http.routes.find((r) => r.action === 'session.list')).toBeUndefined()
  })

  test('the headers option reaches every answer, including denials and 404s', async () => {
    const http = make({
      headers: { 'access-control-allow-origin': '*' },
      authorize: () => ({ deny: 401 }),
    })
    expect((await status(http, 'GET', '/health')).headers.get('access-control-allow-origin')).toBe(
      '*',
    )
    expect((await status(http, 'GET', '/zzz')).headers.get('access-control-allow-origin')).toBe('*')
  })

  test('authorize is required', () => {
    expect(() => createHarnessHttp(undefined, {} as never)).toThrow('authorize')
  })

  test('the handlers table runs a route without routing', async () => {
    const http = make()
    const r = await http.handlers.health(new Request('http://x/anything'))
    expect(((await r.json()) as { ok: boolean }).ok).toBe(true)
    expect((await http.handlers['session.list'](new Request('http://x/'))).status).toBe(404)
  })
})
