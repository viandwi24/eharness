/**
 * `eharness/http` end to end, through `http.fetch` only: a scripted model, memory storage, stream
 * log, inbox and activity store, two agent instances on shared storage where the case needs it.
 */
import { describe, expect, test } from 'bun:test'
import { tool, type UIMessage } from 'ai'
import { z } from 'zod/v4'
import { activity, memoryActivityStore } from '../activity/index.ts'
import { defineHarnessAgent, type HarnessAgent } from '../index.ts'
import { memoryInbox, memoryMessages, memoryState, memoryStreamLog } from '../storage/memory.ts'
import { subagentChild, subagents } from '../subagent/index.ts'
import { scriptedModel } from '../testing/scripted-model.ts'
import { createHarnessHttp, type HarnessHttpOptions, openAccess } from './index.ts'

const silent = { debug() {}, info() {}, warn() {}, error() {} }
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function until(what: string, condition: () => boolean | Promise<boolean>, ms = 4000) {
  const end = Date.now() + ms
  while (!(await condition())) {
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`)
    await sleep(5)
  }
}

// biome-ignore lint/suspicious/noExplicitAny: loosely typed agents in tests
type Agent = HarnessAgent<any>

function world() {
  return {
    messages: memoryMessages(),
    state: memoryState(),
    streams: memoryStreamLog(),
    inbox: memoryInbox(),
    store: memoryActivityStore(),
  }
}
type World = ReturnType<typeof world>

function agentOf(w: World, config: Record<string, unknown>): Agent {
  return defineHarnessAgent({
    contextWindow: 100_000,
    storage: { messages: w.messages, state: w.state, streams: w.streams, inbox: w.inbox },
    streams: { flushMs: 5, pollMs: 10 },
    inbox: { pollMs: 10 },
    logger: silent,
    onWarning() {},
    plugins: [activity({ store: w.store })],
    ...config,
  } as never) as Agent
}

function gate() {
  let release!: () => void
  const opened = new Promise<void>((resolve) => {
    release = resolve
  })
  let markStarted!: () => void
  const started = new Promise<void>((resolve) => {
    markStarted = resolve
  })
  const gated = tool({
    description: 'waits',
    inputSchema: z.object({}),
    execute: async () => {
      markStarted()
      await opened
      return 'ok'
    },
  })
  return { gated, release, started }
}
const gatedCall = { toolCalls: [{ toolName: 'gated', input: {} }] }

const BASE = 'http://t.local'
const post = (path: string, body: unknown, headers: Record<string, string> = {}): Request =>
  new Request(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
const get = (path: string, init?: RequestInit): Request => new Request(`${BASE}${path}`, init)

const userBody = (
  sessionId: string,
  text: string,
  id = `m-${Math.random().toString(36).slice(2)}`,
) => ({
  id: sessionId,
  messages: [{ id, role: 'user', parts: [{ type: 'text', text }] }],
  trigger: 'submit-message',
})

type Http = ReturnType<typeof createHarnessHttp>
const chat = (http: Http, sessionId: string, text: string, path = '', headers = {}, id?: string) =>
  http.fetch(post(`/sessions/${sessionId}/chat${path}`, userBody(sessionId, text, id), headers))

const messagesOf = async (http: Http, sessionId: string): Promise<UIMessage[]> =>
  (
    (await (await http.fetch(get(`/sessions/${sessionId}/messages?limit=200`))).json()) as {
      messages: UIMessage[]
    }
  ).messages

describe('send and stream', () => {
  test('a chat request streams the turn, stores it and reports the ids', async () => {
    const w = world()
    const agent = agentOf(w, { model: scriptedModel([{ text: 'hello there' }]) })
    const http = createHarnessHttp(agent, { authorize: openAccess })
    const res = await chat(http, 's1', 'hi', '', {}, 'client-1')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    expect(res.headers.get('x-eharness-session-id')).toBe('s1')
    expect(res.headers.get('x-eharness-turn-id')).toBeTruthy()
    expect(res.headers.get('x-accel-buffering')).toBe('no')
    expect(res.headers.get('cache-control')).toContain('no-transform')
    const text = await res.text()
    expect(text).toContain('hello there')
    expect(text).toContain('[DONE]')
    const stored = await messagesOf(http, 's1')
    expect(stored.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(
      (stored[0]?.metadata as { eharness?: { clientId?: string } } | undefined)?.eharness?.clientId,
    ).toBe('client-1')
    const snapshot = (await (await http.fetch(get('/sessions/s1'))).json()) as Record<
      string,
      unknown
    >
    expect(snapshot).toMatchObject({ id: 's1', running: false, busy: null, pending: null })
    await agent.close()
  })

  test('a session that does not exist reads as an empty snapshot and no messages', async () => {
    const agent = agentOf(world(), { model: scriptedModel([]) })
    const http = createHarnessHttp(agent, { authorize: openAccess })
    const snapshot = (await (await http.fetch(get('/sessions/nobody'))).json()) as Record<
      string,
      unknown
    >
    expect(snapshot).toMatchObject({
      id: 'nobody',
      running: false,
      pending: null,
      usage: { inputTokens: 0, outputTokens: 0, turns: 0 },
    })
    expect(await messagesOf(http, 'nobody')).toEqual([])
    await agent.close()
  })

  test('messages page backwards without gaps or duplicates', async () => {
    const agent = agentOf(world(), {
      model: scriptedModel([{ text: 'a1' }, { text: 'a2' }, { text: 'a3' }]),
    })
    const http = createHarnessHttp(agent, { authorize: openAccess })
    for (const t of ['q1', 'q2', 'q3']) await (await chat(http, 's1', t)).text()
    const seen: string[] = []
    let before: string | undefined
    for (let guard = 0; guard < 10; guard++) {
      const res = await http.fetch(
        get(`/sessions/s1/messages?limit=2${before ? `&before=${before}` : ''}`),
      )
      const page = (await res.json()) as { messages: UIMessage[]; nextBefore?: string }
      expect(page.messages.length).toBeLessThanOrEqual(2)
      seen.unshift(...page.messages.map((m) => m.id))
      if (page.nextBefore === undefined) break
      before = page.nextBefore
    }
    expect(seen).toHaveLength(6)
    expect(new Set(seen).size).toBe(6)
    expect([...seen].sort()).toEqual(seen)
    await agent.close()
  })
})

describe('authorization', () => {
  test('401 / 403 / 404 denials never open a session or read a body', async () => {
    const opened: string[] = []
    const agent = agentOf(world(), { model: scriptedModel([]) })
    const calls: string[] = []
    const make = (deny: HarnessHttpOptions['authorize']) =>
      createHarnessHttp(agent, {
        authorize: deny,
        session: (id) => {
          opened.push(id)
          return agent.session(id)
        },
        peek: (id) => {
          opened.push(id)
          return agent.peek(id)
        },
      })
    const http401 = make((c) => {
      calls.push(`${c.action}:${c.sessionId ?? ''}`)
      return { deny: 401 }
    })
    const res = await http401.fetch(post('/sessions/s1/chat', userBody('s1', 'hi')))
    expect(res.status).toBe(401)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'EH_HTTP_UNAUTHORIZED',
    )
    expect(calls).toEqual(['chat:s1'])
    // a body that is not even JSON is still a 401: authorization runs before the body is read
    const garbage = await http401.fetch(
      new Request(`${BASE}/sessions/s1/chat`, { method: 'POST', body: 'not json' }),
    )
    expect(garbage.status).toBe(401)
    expect((await make(() => ({ deny: 403 })).fetch(get('/sessions/s1'))).status).toBe(403)
    const custom = await make(() => ({ deny: 404, code: 'X_GONE', message: 'gone' })).fetch(
      get('/sessions/s1/messages'),
    )
    expect(custom.status).toBe(404)
    expect(await custom.json()).toEqual({ error: { code: 'X_GONE', message: 'gone' } })
    const own = await make(() => new Response('teapot', { status: 418 })).fetch(get('/sessions/s1'))
    expect(own.status).toBe(418)
    expect(opened).toEqual([])
    await agent.close()
  })

  test('authorize sees the action, the session id and the attention id', async () => {
    const seen: string[] = []
    const agent = agentOf(world(), { model: scriptedModel([]) })
    const http = createHarnessHttp(agent, {
      authorize: ({ action, sessionId, attentionId }) => {
        seen.push(`${action}|${sessionId ?? ''}|${attentionId ?? ''}`)
        return { deny: 403 }
      },
      attention: {
        roots: () => [],
        peek: (id) => agent.peek(id),
        open: (id) => agent.session(id) as never,
      },
    })
    await http.fetch(get('/sessions/a%3Ab/chat/stream'))
    await http.fetch(post('/attention/item-1/answer', {}))
    expect(seen).toEqual(['chat.resume|a:b|', 'attention.answer||item-1'])
    await agent.close()
  })

  test('a throwing authorize is mapped by onError, else a generic 500 with onFailure', async () => {
    const agent = agentOf(world(), { model: scriptedModel([]) })
    const failures: unknown[] = []
    const boom = () => {
      throw new Error('secret detail')
    }
    const plain = createHarnessHttp(agent, { authorize: boom, onFailure: (e) => failures.push(e) })
    const res = await plain.fetch(get('/sessions/s1'))
    expect(res.status).toBe(500)
    const text = await res.text()
    expect(text).not.toContain('secret detail')
    expect(JSON.parse(text).error.code).toBe('EH_INTERNAL')
    expect(failures).toHaveLength(1)
    const mapped = createHarnessHttp(agent, {
      authorize: boom,
      onError: () => new Response('mapped', { status: 418 }),
    })
    expect((await mapped.fetch(get('/sessions/s1'))).status).toBe(418)
    await agent.close()
  })
})

describe('busy sessions, steering and idempotency', () => {
  test('a second message while a turn runs is a 409 EH_SESSION_BUSY', async () => {
    const g = gate()
    const agent = agentOf(world(), {
      model: scriptedModel([gatedCall, { text: 'done' }]),
      tools: { gated: g.gated },
    })
    const http = createHarnessHttp(agent, { authorize: openAccess })
    const first = await chat(http, 's1', 'go')
    await g.started
    const second = await chat(http, 's1', 'again')
    expect(second.status).toBe(409)
    expect(((await second.json()) as { error: { code: string } }).error.code).toBe(
      'EH_SESSION_BUSY',
    )
    g.release()
    await first.text()
    await agent.close()
  })

  test('the same message id twice is a 409 duplicate with the turn, active or finished', async () => {
    const g = gate()
    const agent = agentOf(world(), {
      model: scriptedModel([gatedCall, { text: 'done' }]),
      tools: { gated: g.gated },
    })
    const http = createHarnessHttp(agent, { authorize: openAccess })
    const first = await chat(http, 's1', 'go', '', {}, 'same-id')
    await g.started
    const dup = await chat(http, 's1', 'go', '', {}, 'same-id')
    expect(dup.status).toBe(409)
    const body = (await dup.json()) as { error: { code: string; details: Record<string, unknown> } }
    expect(body.error.code).toBe('EH_HTTP_DUPLICATE_REQUEST')
    expect(body.error.details).toMatchObject({ active: true })
    expect(typeof body.error.details.turnId).toBe('string')
    expect(typeof body.error.details.messageId).toBe('string')
    g.release()
    await first.text()
    const later = await chat(http, 's1', 'go', '', {}, 'same-id')
    expect(later.status).toBe(409)
    expect(
      ((await later.json()) as { error: { details: { active: boolean } } }).error.details.active,
    ).toBe(false)
    // an explicit Idempotency-Key header is the key, whatever the message id
    const viaHeader = await chat(http, 's1', 'x', '', { 'idempotency-key': 'same-id' }, 'fresh-id')
    expect(viaHeader.status).toBe(409)
    await agent.close()
  })

  test('steer in the same instance follows the running turn (200 stream)', async () => {
    const g = gate()
    const model = scriptedModel([gatedCall, { text: 'done' }])
    const agent = agentOf(world(), { model, tools: { gated: g.gated } })
    const http = createHarnessHttp(agent, {
      authorize: openAccess,
      chat: { ifBusy: ['reject', 'steer'] },
    })
    const first = await chat(http, 's1', 'go')
    await g.started
    const steered = await chat(http, 's1', 'also check the logs', '?ifBusy=steer')
    expect(steered.status).toBe(200)
    g.release()
    await first.text()
    await steered.text()
    const stored = await messagesOf(http, 's1')
    const assistant = stored.find((m) => m.role === 'assistant')
    expect(JSON.stringify(assistant?.parts)).toContain('also check the logs')
    await agent.close()
  })

  test('steer into a turn of another instance is a 202 inbox item, repeated keys are duplicates', async () => {
    const w = world()
    const g = gate()
    const model = scriptedModel([gatedCall, { text: 'done' }])
    const a = agentOf(w, { model, tools: { gated: g.gated } })
    const b = agentOf(w, { model: scriptedModel([]), tools: { gated: g.gated } })
    const httpB = createHarnessHttp(b, {
      authorize: openAccess,
      chat: { ifBusy: ['reject', 'steer'] },
    })
    const run = a.session('s1').send('go')
    await g.started
    const res = await chat(httpB, 's1', 'steer me', '?ifBusy=steer', { 'idempotency-key': 'k-1' })
    expect(res.status).toBe(202)
    const queued = (await res.json()) as {
      inboxId: string
      delivered: string
      target: string
      duplicate?: boolean
    }
    expect(queued).toMatchObject({ delivered: 'steer', target: 'remote' })
    expect(queued.duplicate).toBeUndefined()
    const again = await chat(httpB, 's1', 'steer me', '?ifBusy=steer', { 'idempotency-key': 'k-1' })
    expect(again.status).toBe(202)
    expect(await again.json()).toMatchObject({ inboxId: queued.inboxId, duplicate: true })
    g.release()
    expect((await run.result).stop).toBe('complete')
    expect(JSON.stringify(model.prompts[1])).toContain('steer me')
    await a.close()
    await b.close()
  })

  test('an ifBusy policy the app does not allow, and a bad idempotency key, are 400', async () => {
    const agent = agentOf(world(), { model: scriptedModel([{ text: 'x' }]) })
    const http = createHarnessHttp(agent, { authorize: openAccess })
    expect((await chat(http, 's1', 'hi', '?ifBusy=steer')).status).toBe(400)
    expect((await chat(http, 's1', 'hi', '?ifBusy=queue')).status).toBe(400)
    const bad = await chat(http, 's1', 'hi', '', { 'idempotency-key': 'has space!' })
    expect(bad.status).toBe(400)
    await agent.close()
  })
})

describe('respond', () => {
  const pay = tool({
    description: 'pays',
    inputSchema: z.object({ amount: z.number() }),
    execute: async ({ amount }) => `paid ${amount}`,
  })
  const setup = () => {
    const agent = agentOf(world(), {
      model: scriptedModel([
        {
          toolCalls: [
            { toolName: 'pay', input: { amount: 1 }, toolCallId: 'c1' },
            { toolName: 'pay', input: { amount: 2 }, toolCallId: 'c2' },
          ],
        },
        { text: 'all paid' },
      ]),
      tools: { pay },
      approval: { policy: { pay: 'user-approval' } },
    })
    const http = createHarnessHttp(agent, { authorize: openAccess })
    return { agent, http }
  }
  const answer = (
    sessionId: string,
    messageId: string,
    toolCallId: string,
    approvalId: string,
    approved: boolean,
  ) => ({
    id: sessionId,
    messages: [
      {
        id: messageId,
        role: 'assistant',
        parts: [
          {
            type: 'tool-pay',
            toolCallId,
            state: 'approval-responded',
            approval: { id: approvalId, approved },
          },
        ],
      },
    ],
  })

  test('a partial answer records, the last one resumes, a repeated answer is a 409', async () => {
    const { agent, http } = setup()
    await (await chat(http, 's1', 'pay')).text()
    const snapshot = (await (await http.fetch(get('/sessions/s1'))).json()) as {
      pending: {
        messageId: string
        approvals: Array<{ approvalId: string; toolCallId: string; answered: boolean }>
      }
    }
    const [one, two] = snapshot.pending.approvals as unknown as [
      { approvalId: string; toolCallId: string },
      { approvalId: string; toolCallId: string },
    ]
    const mid = snapshot.pending.messageId
    const partial = await http.fetch(
      post('/sessions/s1/chat', answer('s1', mid, one.toolCallId, one.approvalId, true)),
    )
    expect(partial.status).toBe(200)
    await partial.text()
    const after = (await (await http.fetch(get('/sessions/s1'))).json()) as {
      pending: { approvals: Array<{ approvalId: string; answered: boolean }> }
    }
    expect(after.pending.approvals.map((a) => a.answered)).toEqual([true, false])
    // the same decision again: nothing waits for it any more
    const stale = await http.fetch(
      post('/sessions/s1/chat', answer('s1', mid, one.toolCallId, one.approvalId, true)),
    )
    expect(stale.status).toBe(409)
    expect(((await stale.json()) as { error: { code: string } }).error.code).toBe(
      'EH_HTTP_ALREADY_ANSWERED',
    )
    const full = await http.fetch(
      post('/sessions/s1/chat', answer('s1', mid, two.toolCallId, two.approvalId, true)),
    )
    expect(full.status).toBe(200)
    expect(await full.text()).toContain('all paid')
    const done = await http.fetch(
      post('/sessions/s1/chat', answer('s1', mid, two.toolCallId, two.approvalId, true)),
    )
    expect(done.status).toBe(409)
    await agent.close()
  })

  test('the actor of the principal reaches the decision; client metadata never does', async () => {
    const agent = agentOf(world(), {
      model: scriptedModel([
        { toolCalls: [{ toolName: 'pay', input: { amount: 1 }, toolCallId: 'c1' }] },
        { text: 'ok' },
      ]),
      tools: { pay },
      approval: { policy: { pay: 'user-approval' } },
    })
    const decided: unknown[] = []
    const http = createHarnessHttp<{ id: string }>(agent, {
      authorize: () => ({ id: 'alice' }),
      chat: { actorOf: (p) => ({ id: p.id }) },
    })
    await (await chat(http, 's1', 'pay')).text()
    const snap = (await (await http.fetch(get('/sessions/s1'))).json()) as {
      pending: { messageId: string; approvals: Array<{ approvalId: string; toolCallId: string }> }
    }
    const a = snap.pending.approvals[0] as { approvalId: string; toolCallId: string }
    const body = answer('s1', snap.pending.messageId, a.toolCallId, a.approvalId, true) as {
      messages: Array<Record<string, unknown>>
    }
    ;(body as Record<string, unknown>).actor = { id: 'mallory' }
    ;(body.messages[0] as Record<string, unknown>).metadata = { eharness: { kind: 'x' } }
    const res = await http.fetch(post('/sessions/s1/chat', body))
    expect(res.status).toBe(200)
    await res.text()
    const events = await (agent as Agent).peek('s1').messages({ limit: 50 })
    decided.push(JSON.stringify(events))
    expect(String(decided[0])).not.toContain('mallory')
    await agent.close()
  })
})

describe('attention', () => {
  test('lists a child approval through the parent; the answer goes to the child; ownership is enforced', async () => {
    const w = world()
    const log: string[] = []
    const holder: { main?: Agent } = {}
    const worker = agentOf(w, {
      model: scriptedModel([
        { toolCalls: [{ toolName: 'danger', input: { what: 'rm' } }] },
        { text: 'child report' },
      ]),
      tools: {
        danger: tool({
          description: 'danger',
          inputSchema: z.object({ what: z.string() }),
          execute: async ({ what }) => {
            log.push(what)
            return `did ${what}`
          },
        }),
      },
      approval: { policy: { danger: 'user-approval' } },
      plugins: [
        activity({ store: w.store }),
        subagentChild({ parent: () => holder.main as Agent }),
      ],
    })
    const main = agentOf(w, {
      model: scriptedModel([
        {
          toolCalls: [
            {
              toolName: 'agent',
              input: { subagent_type: 'worker', description: 'task', prompt: 'do it' },
              toolCallId: 'call-0-0',
            },
          ],
        },
        { text: 'parent done' },
      ]),
      plugins: [
        activity({ store: w.store }),
        subagents({
          agents: { worker: { agent: worker, description: 'works' } },
          approvals: 'park',
        }),
      ],
    })
    holder.main = main
    const agentFor = (id: string): Agent => (id === 'p1' ? main : worker)
    const http = createHarnessHttp<{ roots: string[] }>(main, {
      authorize: (c) => ({
        roots: c.request.headers.get('x-roots')?.split(',').filter(Boolean) ?? [],
      }),
      attention: {
        roots: ({ principal }) => principal.roots,
        peek: (id) => agentFor(id).peek(id),
        open: (id) => agentFor(id).session(id) as never,
        store: w.store,
      },
    })
    expect((await main.session('p1').send('go').result).stop).toBe('tool-pending')

    const none = await http.fetch(get('/attention'))
    expect(((await none.json()) as { items: unknown[] }).items).toEqual([])
    const listed = await http.fetch(get('/attention', { headers: { 'x-roots': 'p1' } }))
    const { items } = (await listed.json()) as {
      items: Array<{ id: string; sessionId: string; kind: string }>
    }
    expect(items).toHaveLength(1)
    const item = items[0] as { id: string; sessionId: string }
    expect(item.sessionId).not.toBe('p1')

    const answerPath = `/attention/${item.id}/answer`
    const asRoot = { 'x-roots': 'p1' }
    const approve = { kind: 'approval', approved: true }
    // outside the principal's roots reads as not found, and nothing runs
    expect(
      (await http.fetch(post(answerPath, { sessionId: item.sessionId, answer: approve }))).status,
    ).toBe(404)
    expect(
      (await http.fetch(post(answerPath, { sessionId: 'unrelated', answer: approve }, asRoot)))
        .status,
    ).toBe(404)
    expect(log).toEqual([])
    // wire validation
    const note = await http.fetch(
      post(
        answerPath,
        { sessionId: item.sessionId, answer: { ...approve, note: 'x'.repeat(2001) } },
        asRoot,
      ),
    )
    expect(note.status).toBe(400)
    const remember = await http.fetch(
      post(
        answerPath,
        { sessionId: item.sessionId, answer: { ...approve, remember: 'session' } },
        asRoot,
      ),
    )
    expect(remember.status).toBe(400)
    const wrongKind = await http.fetch(
      post(
        answerPath,
        { sessionId: item.sessionId, answer: { kind: 'client-tool', output: 1 } },
        asRoot,
      ),
    )
    expect(wrongKind.status).toBe(400)
    expect(log).toEqual([])

    const ok = await http.fetch(
      post(answerPath, { sessionId: item.sessionId, answer: approve }, asRoot),
    )
    expect(ok.status).toBe(200)
    expect(await ok.json()).toMatchObject({
      status: 'resumed',
      id: item.id,
      sessionId: item.sessionId,
    })
    await until('child ran', () => log.length === 1)
    await until('parent continued', async () =>
      JSON.stringify(await main.session('p1').messages()).includes('parent done'),
    )
    const again = await http.fetch(
      post(answerPath, { sessionId: item.sessionId, answer: approve }, asRoot),
    )
    expect(again.status).toBe(200)
    expect(((await again.json()) as { status: string }).status).toBe('already-answered')
    const unknown = await http.fetch(
      post('/attention/nope/answer', { sessionId: item.sessionId, answer: approve }, asRoot),
    )
    expect(unknown.status).toBe(404)
    const events = await w.store.read({ after: 0, limit: 200, types: ['attention-answered'] })
    expect(events.map((e) => e.payload.status)).toContain('resumed')
    await main.close()
    await worker.close()
  })
})

describe('resume and interrupt', () => {
  test('a second reader on another instance follows the turn of the first; after it ends the resume is 204', async () => {
    const w = world()
    const g = gate()
    const a = agentOf(w, {
      model: scriptedModel([gatedCall, { text: 'finally' }]),
      tools: { gated: g.gated },
    })
    const b = agentOf(w, { model: scriptedModel([]), tools: { gated: g.gated } })
    const httpA = createHarnessHttp(a, { authorize: openAccess })
    const httpB = createHarnessHttp(b, { authorize: openAccess })
    const first = await chat(httpA, 's1', 'go')
    await g.started
    let reader: Response | undefined
    await until('B attaches', async () => {
      const res = await httpB.fetch(get('/sessions/s1/chat/stream'))
      if (res.status === 200) {
        reader = res
        return true
      }
      return false
    })
    expect(reader?.headers.get('x-eharness-session-id')).toBe('s1')
    g.release()
    const [fromA, fromB] = await Promise.all([first.text(), (reader as Response).text()])
    expect(fromA).toContain('finally')
    expect(fromB).toContain('finally')
    await until(
      'turn closed',
      async () => (await httpB.fetch(get('/sessions/s1/chat/stream'))).status === 204,
    )
    const bad = await httpB.fetch(get('/sessions/s1/chat/stream?from=-1'))
    expect(bad.status).toBe(400)
    await a.close()
    await b.close()
  })

  test('interrupt reaches a local turn and a turn of another instance', async () => {
    const w = world()
    const g = gate()
    const a = agentOf(w, {
      model: scriptedModel([gatedCall, { text: 'never' }, gatedCall, { text: 'never' }]),
      tools: { gated: g.gated },
    })
    const b = agentOf(w, { model: scriptedModel([]), tools: { gated: g.gated } })
    const httpA = createHarnessHttp(a, { authorize: openAccess })
    const httpB = createHarnessHttp(b, { authorize: openAccess })
    const idle = await httpA.fetch(post('/sessions/s1/interrupt', {}))
    expect(await idle.json()).toEqual({ target: 'idle' })

    const run = await chat(httpA, 's1', 'go')
    await g.started
    const local = await httpA.fetch(post('/sessions/s1/interrupt', { reason: 'stop it' }))
    expect(await local.json()).toEqual({ target: 'local' })
    g.release()
    await run.text()
    await until(
      'idle again',
      async () =>
        ((await (await httpA.fetch(get('/sessions/s1'))).json()) as { running: boolean })
          .running === false,
    )

    // remote: a turn of A is stopped by an interrupt that arrives at B
    const g2 = gate()
    const c = agentOf(w, {
      model: scriptedModel([gatedCall, { text: 'never' }]),
      tools: { gated: g2.gated },
    })
    const run2 = c.session('s2').send('go')
    await g2.started
    const remote = await httpB.fetch(post('/sessions/s2/interrupt', {}))
    expect(await remote.json()).toEqual({ target: 'remote' })
    g2.release()
    expect((await run2.result).stop).toBe('aborted')
    await a.close()
    await b.close()
    await c.close()
  })

  test('an interrupt body that is too long or not an object is a 400', async () => {
    const agent = agentOf(world(), { model: scriptedModel([]) })
    const http = createHarnessHttp(agent, { authorize: openAccess })
    expect(
      (await http.fetch(post('/sessions/s1/interrupt', { reason: 'x'.repeat(201) }))).status,
    ).toBe(400)
    expect((await http.fetch(post('/sessions/s1/interrupt', [1]))).status).toBe(400)
    const empty = await http.fetch(new Request(`${BASE}/sessions/s1/interrupt`, { method: 'POST' }))
    expect(empty.status).toBe(200)
    await agent.close()
  })
})

describe('activity', () => {
  const readUntil = async (res: Response, done: (text: string) => boolean): Promise<string> => {
    const reader = (res.body as ReadableStream<Uint8Array>).getReader()
    const decoder = new TextDecoder()
    let text = ''
    const end = Date.now() + 3000
    while (Date.now() < end && !done(text)) {
      const { value, done: finished } = await reader.read()
      if (finished) break
      text += decoder.decode(value)
    }
    await reader.cancel()
    return text
  }

  const make = (w: World) => {
    const agent = agentOf(w, { model: scriptedModel([]) })
    const http = createHarnessHttp<{ prefix: string | 'all' }>(agent, {
      authorize: (c) => ({ prefix: c.request.headers.get('x-prefix') ?? 'all' }),
      activity: {
        store: w.store,
        bootId: 'boot-x',
        pollMs: 10,
        filter: (p) =>
          p.prefix === 'all' ? 'all' : (r) => (r.sessionId ?? '').startsWith(p.prefix),
      },
    })
    return { agent, http }
  }

  test('stream: boot first, then events filtered by principal; resync for a cursor past the head', async () => {
    const w = world()
    const { agent, http } = make(w)
    await w.store.append([
      { type: 'e', sessionId: 'alice:1' },
      { type: 'e', sessionId: 'bob:1' },
    ])
    const ac = new AbortController()
    const res = await http.fetch(
      get('/activity/stream?after=0', { headers: { 'x-prefix': 'alice' }, signal: ac.signal }),
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    setTimeout(() => void w.store.append({ type: 'e', sessionId: 'bob:2' }), 20)
    setTimeout(() => void w.store.append({ type: 'e', sessionId: 'alice:2' }), 40)
    const text = await readUntil(res, (t) => t.includes('alice:2'))
    ac.abort()
    expect(text).toContain('event: boot\ndata: {"boot":"boot-x"}')
    expect(text).toContain('alice:1')
    expect(text).toContain('alice:2')
    expect(text).not.toContain('bob')
    const ac2 = new AbortController()
    const resync = await http.fetch(get('/activity/stream?after=999', { signal: ac2.signal }))
    const t2 = await readUntil(resync, (t) => t.includes('resync'))
    ac2.abort()
    expect(t2).toContain('event: resync')
    const bad = await http.fetch(get('/activity/stream?after=x'))
    expect(bad.status).toBe(400)
    await agent.close()
  })

  test('page: filtered, limited, with the cursor; /health reports the boot id', async () => {
    const w = world()
    const { agent, http } = make(w)
    await w.store.append([
      { type: 'e', sessionId: 'alice:1' },
      { type: 'e', sessionId: 'bob:1' },
      { type: 'e', sessionId: 'alice:2' },
    ])
    const page = (await (
      await http.fetch(get('/activity?after=0&limit=10', { headers: { 'x-prefix': 'alice' } }))
    ).json()) as {
      events: Array<{ sessionId: string }>
      lastSeq: number
    }
    expect(page.events.map((e) => e.sessionId)).toEqual(['alice:1', 'alice:2'])
    expect(page.lastSeq).toBe(3)
    expect((await http.fetch(get('/activity?limit=0'))).status).toBe(400)
    expect(await (await http.fetch(get('/health'))).json()).toEqual({ ok: true, boot: 'boot-x' })
    await agent.close()
  })
})

describe('sessions list and describe', () => {
  test('the list route exists only with sessions.list; describe adds info to the snapshot', async () => {
    const agent = agentOf(world(), { model: scriptedModel([]) })
    const without = createHarnessHttp(agent, { authorize: openAccess })
    expect((await without.fetch(get('/sessions'))).status).toBe(404)
    const http = createHarnessHttp<string>(agent, {
      authorize: () => 'u1',
      sessions: {
        list: ({ principal, query }) => ({
          sessions: [{ id: `${principal}-1`, title: `limit ${query.limit}` }],
          next: 'c2',
        }),
        describe: (id) => ({ title: `title of ${id}` }),
      },
    })
    const list = (await (await http.fetch(get('/sessions?limit=5&cursor=c1'))).json()) as Record<
      string,
      unknown
    >
    expect(list).toEqual({ sessions: [{ id: 'u1-1', title: 'limit 5' }], next: 'c2' })
    expect((await http.fetch(get('/sessions?limit=999'))).status).toBe(400)
    const snap = (await (await http.fetch(get('/sessions/s9'))).json()) as { info: unknown }
    expect(snap.info).toEqual({ title: 'title of s9' })
    await agent.close()
  })
})

describe('turn of another instance (lock)', () => {
  /** A cross-instance lock shared by the two agents of a test. */
  function sharedLock() {
    const held = new Set<string>()
    return {
      async acquire(id: string) {
        if (held.has(id)) throw new Error('held')
        held.add(id)
        return async () => {
          held.delete(id)
        }
      },
    }
  }

  test('send (reject), respond, regenerate and edit are 409 EH_SESSION_BUSY, not an in-stream error', async () => {
    const w = world()
    const lock = sharedLock()
    const g = gate()
    const a = agentOf(w, {
      model: scriptedModel([gatedCall, { text: 'done' }]),
      tools: { gated: g.gated },
    })
    const b = agentOf(w, { model: scriptedModel([]), tools: { gated: g.gated } })
    const httpB = createHarnessHttp(b, {
      authorize: openAccess,
      session: (id) => b.session(id, { lock }),
    })
    const run = a.session('s1', { lock }).send('go')
    await g.started
    const send = await chat(httpB, 's1', 'again')
    expect(send.status).toBe(409)
    expect(((await send.json()) as { error: { code: string } }).error.code).toBe('EH_SESSION_BUSY')
    const asRespond = await httpB.fetch(
      post('/sessions/s1/chat', {
        id: 's1',
        messages: [
          {
            id: 'm1',
            role: 'assistant',
            parts: [
              {
                type: 'tool-gated',
                toolCallId: 'c1',
                state: 'output-available',
                input: {},
                output: 'x',
              },
            ],
          },
        ],
      }),
    )
    expect(asRespond.status).toBe(409)
    const regen = await httpB.fetch(
      post('/sessions/s1/chat', { id: 's1', trigger: 'regenerate-message', messages: [] }),
    )
    expect(regen.status).toBe(409)
    const edit = await httpB.fetch(
      post('/sessions/s1/chat', {
        id: 's1',
        messageId: 'u1',
        messages: [{ id: 'u2', role: 'user', parts: [{ type: 'text', text: 'edited' }] }],
      }),
    )
    expect(edit.status).toBe(409)
    g.release()
    await run.result
    await a.close()
    await b.close()
  })
})

describe('turn of another instance (no lock)', () => {
  test('reject, respond, regenerate and edit are 409 EH_SESSION_BUSY from the peek of the other instance', async () => {
    const w = world()
    const g = gate()
    const a = agentOf(w, {
      model: scriptedModel([gatedCall, { text: 'done' }]),
      tools: { gated: g.gated },
    })
    const b = agentOf(w, { model: scriptedModel([]), tools: { gated: g.gated } })
    const httpB = createHarnessHttp(b, { authorize: openAccess })
    const run = a.session('s1').send('go')
    await g.started
    const codes: string[] = []
    const bodies = [
      userBody('s1', 'again'),
      {
        id: 's1',
        messages: [
          {
            id: 'm1',
            role: 'assistant',
            parts: [
              {
                type: 'tool-gated',
                toolCallId: 'c1',
                state: 'output-available',
                input: {},
                output: 'x',
              },
            ],
          },
        ],
      },
      { id: 's1', trigger: 'regenerate-message', messages: [] },
      {
        id: 's1',
        messageId: 'u1',
        messages: [{ id: 'u2', role: 'user', parts: [{ type: 'text', text: 'edited' }] }],
      },
    ]
    for (const body of bodies) {
      const res = await httpB.fetch(post('/sessions/s1/chat', body))
      expect(res.status).toBe(409)
      codes.push(((await res.json()) as { error: { code: string } }).error.code)
    }
    expect(codes).toEqual(Array(4).fill('EH_SESSION_BUSY'))
    g.release()
    await run.result
    await a.close()
    await b.close()
  })
})

describe('hooks: chat.validate, attention.decorate / parseAnswer / agentId / onSettled', () => {
  test('chat.validate runs on the sanitised body: it can deny, or replace the body', async () => {
    const model = scriptedModel([{ text: 'ok' }])
    const agent = agentOf(world(), { model })
    const seen: Array<{ kind: string; parts: number }> = []
    const http = createHarnessHttp(agent, {
      authorize: openAccess,
      chat: {
        validate: ({ body, kind }) => {
          const text = JSON.stringify(body)
          seen.push({ kind, parts: body.messages.at(-1)?.parts.length ?? 0 })
          if (text.includes('forbidden')) return { deny: 403, message: 'nope' }
          if (text.includes('rewrite-me')) {
            return {
              body: {
                ...body,
                messages: [
                  { id: 'u9', role: 'user', parts: [{ type: 'text', text: 'rewritten' }] },
                ],
              },
            }
          }
          return undefined
        },
      },
    })
    const denied = await chat(http, 's1', 'forbidden')
    expect(denied.status).toBe(403)
    expect(await messagesOf(http, 's1')).toHaveLength(0)
    const res = await chat(http, 's1', 'rewrite-me')
    expect(res.status).toBe(200)
    await res.text()
    expect(JSON.stringify(await messagesOf(http, 's1'))).toContain('rewritten')
    expect(JSON.stringify(await messagesOf(http, 's1'))).not.toContain('rewrite-me')
    expect(seen.map((s) => s.kind)).toEqual(['send', 'send'])
    await agent.close()
  })

  test('decorate adds extra (or hides an item), parseAnswer falls through to the whitelist, agentId is a function, onSettled fires after the continuation', async () => {
    const w = world()
    const log: string[] = []
    const agent = agentOf(w, {
      model: scriptedModel([
        { toolCalls: [{ toolName: 'danger', input: { what: 'rm' } }] },
        { text: 'all done' },
      ]),
      tools: {
        danger: tool({
          description: 'danger',
          inputSchema: z.object({ what: z.string() }),
          execute: async ({ what }) => {
            log.push(what)
            return `did ${what}`
          },
        }),
      },
      approval: { policy: { danger: 'user-approval' } },
    })
    expect((await agent.session('r1').send('go').result).stop).toBe('tool-pending')
    const settled: Array<{ id: string; sessionId: string; stop?: string }> = []
    const parsed: string[] = []
    let hide = false
    const http = createHarnessHttp(agent, {
      authorize: openAccess,
      attention: {
        roots: () => ['r1'],
        peek: (id) => agent.peek(id),
        open: (id) => agent.session(id) as never,
        store: w.store,
        agentId: (sessionId) => `agent-of-${sessionId}`,
        maxNoteChars: 5,
        decorate: (item) => (hide ? null : { label: `tool ${item.toolName}`, n: 1 }),
        parseAnswer: ({ body, defaultParse }) => {
          const answer = (body as { answer?: { kind?: string } }).answer
          parsed.push(String(answer?.kind))
          if (answer?.kind === 'custom') return { kind: 'approval', approved: true }
          return defaultParse()
        },
        onSettled: ({ id, sessionId, result }) => {
          settled.push({ id, sessionId, ...(result === undefined ? {} : { stop: result.stop }) })
        },
      },
    })
    const listed = (await (await http.fetch(get('/attention'))).json()) as {
      items: Array<{ id: string; sessionId: string; extra?: Record<string, unknown> }>
    }
    expect(listed.items).toHaveLength(1)
    const item = listed.items[0] as { id: string; sessionId: string; extra?: unknown }
    expect(item.extra).toEqual({ label: 'tool danger', n: 1 })
    hide = true
    expect(((await (await http.fetch(get('/attention'))).json()) as { items: [] }).items).toEqual(
      [],
    )
    hide = false

    const path = `/attention/${item.id}/answer`
    // the default whitelist still applies through defaultParse: maxNoteChars and allowRemember
    const longNote = await http.fetch(
      post(path, {
        sessionId: item.sessionId,
        answer: { kind: 'approval', approved: true, note: 'too long' },
      }),
    )
    expect(longNote.status).toBe(400)
    const remember = await http.fetch(
      post(path, {
        sessionId: item.sessionId,
        answer: { kind: 'approval', approved: true, remember: 'session' },
      }),
    )
    expect(remember.status).toBe(400)
    expect(log).toEqual([])
    const ok = await http.fetch(
      post(path, { sessionId: item.sessionId, answer: { kind: 'custom' } }),
    )
    expect(ok.status).toBe(200)
    expect(((await ok.json()) as { status: string }).status).toBe('resumed')
    await until('settled', () => settled.length === 1)
    expect(settled[0]).toEqual({ id: item.id, sessionId: 'r1', stop: 'complete' })
    expect(log).toEqual(['rm'])
    expect(parsed).toEqual(['approval', 'approval', 'custom'])
    const events = await w.store.read({ after: 0, limit: 50, types: ['attention-answered'] })
    expect(events.at(-1)?.agentId).toBe('agent-of-r1')
    await agent.close()
  })
})
