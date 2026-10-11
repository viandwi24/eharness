import { assertTrue, uniqueSessionId } from './assert.ts'
import type { ConformanceCase } from './types.ts'

/** What the factory of {@link httpConformance} returns. */
export interface HttpUnderTest {
  /** The handler under test (`createHarnessHttp(...).fetch`, or a client of a running server). */
  fetch(request: Request): Promise<Response>
  /** Origin and base path of the routes. Default `http://localhost`. */
  baseUrl?: string
}

/** Options of {@link httpConformance}. */
export interface HttpConformanceOptions {
  /** Cleanup after every case (stop a server, close the agent). */
  dispose?: () => void | Promise<void>
  /**
   * Maps the session id the suite suggests (`conf-stream-…`, unique per case) to one the handler
   * accepts and that the handler reports back unchanged. Use it when the app only serves sessions
   * it knows (create the owning agent or row here and return its session id). Default: identity.
   */
  sessionId?: (suggested: string) => string | Promise<string>
}

const JSON_HEADERS = { 'content-type': 'application/json' }

/**
 * Conformance cases for an `eharness/http` handler (spec 26 §11).
 *
 * The handler must serve an agent that answers every message with a streamed text reply that
 * takes at least 250 ms (e.g. a scripted model with `delayMs: 60` per stream part), allow the
 * suite's requests without credentials (`openAccess`), and mount the session routes (chat,
 * messages, interrupt) at `baseUrl`. Checks the route table, the error shape of every failure,
 * that the first chunk arrives before the turn ends, and that a client abort ends the stream.
 *
 * @example
 * ```ts
 * const http = createHarnessHttp(slowAgent, { authorize: openAccess })
 * for (const c of httpConformance(() => ({ fetch: http.fetch }))) test(c.name, c.run)
 * ```
 * @see docs/specs/26-http.md#11-conformance
 */
export function httpConformance(
  factory: () => HttpUnderTest | Promise<HttpUnderTest>,
  options: HttpConformanceOptions = {},
): ConformanceCase[] {
  const wrap = (
    name: string,
    body: (t: Required<HttpUnderTest>) => Promise<void>,
  ): ConformanceCase => ({
    name,
    run: async () => {
      const t = await factory()
      try {
        await body({
          fetch: (r) => t.fetch(r),
          baseUrl: (t.baseUrl ?? 'http://localhost').replace(/\/$/, ''),
        })
      } finally {
        await options.dispose?.()
      }
    },
  })

  const sessionFor = async (suggested: string): Promise<string> =>
    (await options.sessionId?.(suggested)) ?? suggested

  const errorShape = async (
    res: Response,
    status: number,
    code: string,
    what: string,
  ): Promise<void> => {
    assertTrue(res.status === status, `${what}: expected status ${status}, got ${res.status}`)
    const body = (await res.json()) as { error?: { code?: unknown; message?: unknown } }
    assertTrue(
      typeof body.error?.code === 'string' && typeof body.error?.message === 'string',
      `${what}: the body must be { error: { code, message } }`,
    )
    assertTrue(
      body.error?.code === code,
      `${what}: expected code ${code}, got ${String(body.error?.code)}`,
    )
  }

  const chatBody = (sessionId: string, text: string, id = `m-${sessionId}`): string =>
    JSON.stringify({
      id: sessionId,
      messages: [{ id, role: 'user', parts: [{ type: 'text', text }] }],
      trigger: 'submit-message',
    })

  return [
    wrap('GET /health answers { ok: true, boot }', async ({ fetch, baseUrl }) => {
      const res = await fetch(new Request(`${baseUrl}/health`))
      assertTrue(res.status === 200, `health: status ${res.status}`)
      const body = (await res.json()) as { ok?: unknown; boot?: unknown }
      assertTrue(
        body.ok === true && typeof body.boot === 'string',
        'health: { ok: true, boot: string }',
      )
    }),
    wrap('an unknown path is a 404 with the error shape', async ({ fetch, baseUrl }) => {
      await errorShape(
        await fetch(new Request(`${baseUrl}/nope`)),
        404,
        'EH_HTTP_NOT_FOUND',
        'unknown path',
      )
    }),
    wrap('a wrong method is a 405 with an Allow header', async ({ fetch, baseUrl }) => {
      const res = await fetch(new Request(`${baseUrl}/sessions/x/chat`, { method: 'DELETE' }))
      assertTrue(res.headers.get('allow') !== null, 'a 405 carries Allow')
      await errorShape(res, 405, 'EH_HTTP_METHOD_NOT_ALLOWED', 'wrong method')
    }),
    wrap('a chat request that is not JSON is a 415', async ({ fetch, baseUrl }) => {
      const res = await fetch(
        new Request(`${baseUrl}/sessions/x/chat`, {
          method: 'POST',
          headers: { 'content-type': 'text/plain' },
          body: 'hello',
        }),
      )
      await errorShape(res, 415, 'EH_HTTP_UNSUPPORTED_MEDIA_TYPE', 'text body')
    }),
    wrap('a chat body that does not parse is a 400', async ({ fetch, baseUrl }) => {
      const res = await fetch(
        new Request(`${baseUrl}/sessions/x/chat`, {
          method: 'POST',
          headers: JSON_HEADERS,
          body: '{nope',
        }),
      )
      await errorShape(res, 400, 'EH_HTTP_INVALID_JSON', 'broken JSON')
    }),
    wrap('a body id that differs from the path is a 400', async ({ fetch, baseUrl }) => {
      const res = await fetch(
        new Request(`${baseUrl}/sessions/a/chat`, {
          method: 'POST',
          headers: JSON_HEADERS,
          body: chatBody('b', 'hi'),
        }),
      )
      await errorShape(res, 400, 'EH_HTTP_INVALID_BODY', 'id mismatch')
    }),
    wrap('a part type clients may not send is a 400', async ({ fetch, baseUrl }) => {
      const res = await fetch(
        new Request(`${baseUrl}/sessions/a/chat`, {
          method: 'POST',
          headers: JSON_HEADERS,
          body: JSON.stringify({
            id: 'a',
            messages: [{ id: 'm1', role: 'user', parts: [{ type: 'data-eh.input', data: {} }] }],
          }),
        }),
      )
      await errorShape(res, 400, 'EH_INVALID_INPUT', 'data part')
    }),
    wrap(
      'a turn streams: the first chunk arrives before the turn ends, then the stream ends',
      async ({ fetch, baseUrl }) => {
        const id = await sessionFor(uniqueSessionId('conf-stream'))
        const res = await fetch(
          new Request(`${baseUrl}/sessions/${id}/chat`, {
            method: 'POST',
            headers: JSON_HEADERS,
            body: chatBody(id, 'hello'),
          }),
        )
        assertTrue(res.status === 200, `chat: status ${res.status}`)
        assertTrue(
          (res.headers.get('content-type') ?? '').includes('text/event-stream'),
          'chat is an event stream',
        )
        assertTrue(
          (res.headers.get('x-eharness-turn-id') ?? '') !== '',
          'chat carries x-eharness-turn-id',
        )
        assertTrue(res.body !== null, 'chat has a body')
        const reader = (res.body as ReadableStream<Uint8Array>).getReader()
        const first = await reader.read()
        assertTrue(!first.done, 'the first chunk arrives')
        const afterFirst = Date.now()
        let text = new TextDecoder().decode(first.value)
        for (;;) {
          const next = await reader.read()
          if (next.done) break
          text += new TextDecoder().decode(next.value)
        }
        assertTrue(
          Date.now() - afterFirst >= 50,
          'the stream was still running after its first chunk',
        )
        assertTrue(text.includes('[DONE]'), 'the stream ends with [DONE]')
        const page = await fetch(new Request(`${baseUrl}/sessions/${id}/messages`))
        assertTrue(page.status === 200, `messages: status ${page.status}`)
        const messages = ((await page.json()) as { messages: Array<{ role: string }> }).messages
        assertTrue(
          messages.map((m) => m.role).join() === 'user,assistant',
          `the turn is stored (got ${messages.map((m) => m.role).join()})`,
        )
        const snap = await fetch(new Request(`${baseUrl}/sessions/${id}`))
        const snapshot = (await snap.json()) as {
          id?: string
          running?: boolean
          pending?: unknown
        }
        assertTrue(
          snapshot.id === id && snapshot.running === false && snapshot.pending === null,
          'a finished session is idle',
        )
      },
    ),
    wrap('aborting the request ends the stream', async ({ fetch, baseUrl }) => {
      const id = await sessionFor(uniqueSessionId('conf-abort'))
      const controller = new AbortController()
      const res = await fetch(
        new Request(`${baseUrl}/sessions/${id}/chat`, {
          method: 'POST',
          headers: JSON_HEADERS,
          body: chatBody(id, 'hello'),
          signal: controller.signal,
        }),
      )
      const reader = (res.body as ReadableStream<Uint8Array>).getReader()
      await reader.read()
      controller.abort()
      const ended = await Promise.race([
        reader.read().then(
          (r) => (r.done ? 'done' : 'chunk'),
          () => 'error',
        ),
        new Promise<string>((resolve) => setTimeout(() => resolve('timeout'), 3000)),
      ])
      // `chunk` is allowed: a chunk already in flight; the next read must end
      if (ended === 'chunk') {
        const again = await Promise.race([
          reader.read().then(
            (r) => (r.done ? 'done' : 'chunk'),
            () => 'error',
          ),
          new Promise<string>((resolve) => setTimeout(() => resolve('timeout'), 3000)),
        ])
        assertTrue(again !== 'timeout', 'the stream ends after the client aborts')
      } else {
        assertTrue(ended !== 'timeout', 'the stream ends after the client aborts')
      }
    }),
    wrap(
      'messages: an invalid limit is a 400 and a missing session is empty',
      async ({ fetch, baseUrl }) => {
        const limited = await sessionFor(uniqueSessionId('conf-limit'))
        await errorShape(
          await fetch(new Request(`${baseUrl}/sessions/${limited}/messages?limit=0`)),
          400,
          'EH_INVALID_INPUT',
          'limit 0',
        )
        const none = await sessionFor(uniqueSessionId('conf-none'))
        const res = await fetch(new Request(`${baseUrl}/sessions/${none}/messages`))
        const body = (await res.json()) as { messages: unknown[] }
        assertTrue(
          res.status === 200 && body.messages.length === 0,
          'a missing session has no messages',
        )
      },
    ),
    wrap(
      'resume: 204 when nothing runs, 400 for a malformed cursor',
      async ({ fetch, baseUrl }) => {
        const id = await sessionFor(uniqueSessionId('conf-resume'))
        const idle = await fetch(new Request(`${baseUrl}/sessions/${id}/chat/stream`))
        assertTrue(idle.status === 204, `idle resume: status ${idle.status}`)
        const bad = await fetch(new Request(`${baseUrl}/sessions/${id}/chat/stream?from=abc`))
        await errorShape(bad, 400, 'EH_INVALID_INPUT', 'bad cursor')
      },
    ),
    wrap('interrupt of an idle session answers { target: "idle" }', async ({ fetch, baseUrl }) => {
      const id = await sessionFor(uniqueSessionId('conf-int'))
      const res = await fetch(
        new Request(`${baseUrl}/sessions/${id}/interrupt`, {
          method: 'POST',
          headers: JSON_HEADERS,
          body: '{}',
        }),
      )
      assertTrue(res.status === 200, `interrupt: status ${res.status}`)
      const body = (await res.json()) as { target?: string }
      assertTrue(
        body.target === 'idle' || body.target === 'unsupported',
        `interrupt target ${String(body.target)}`,
      )
    }),
  ]
}
