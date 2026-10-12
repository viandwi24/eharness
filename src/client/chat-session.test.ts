import { describe, expect, test } from 'bun:test'
import type { AbstractChat, ChatStatus, UIMessage } from 'ai'
import { type ChatBridge, createChatSession } from './chat-session.ts'
import { createHarnessClient } from './http-client.ts'

const user = (id: string, text = id): UIMessage => ({
  id,
  role: 'user',
  parts: [{ type: 'text', text }],
})
const assistant = (id: string, extra: Partial<UIMessage> = {}): UIMessage => ({
  id,
  role: 'assistant',
  parts: [{ type: 'text', text: id }],
  ...extra,
})
const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const err = (status: number, code: string, details?: Record<string, unknown>): Response =>
  json({ error: { code, message: `${code} message`, details } }, status)

/** A scripted server: stored messages, a snapshot, and a hook for the chat POST. */
function world() {
  const w = {
    stored: [] as UIMessage[],
    running: false,
    activeMessageId: undefined as string | undefined,
    log: [] as string[],
    chat: (_body: Record<string, unknown>): Response => new Response(null, { status: 500 }),
    resume: (): Response => new Response(null, { status: 204 }),
    interrupt: (): Response => json({ target: 'local' }),
    pageLimit: 50,
  }
  const client = createHarnessClient({
    baseUrl: 'http://x.test/api',
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      const method = init?.method ?? 'GET'
      w.log.push(`${method} ${url.pathname}${url.search}`)
      if (url.pathname.endsWith('/messages')) {
        const limit = Number(url.searchParams.get('limit'))
        const before = url.searchParams.get('before')
        const pool = before === null ? w.stored : w.stored.filter((m) => m.id < before)
        const messages = pool.slice(-limit)
        const first = messages[0]
        const hasOlder = first !== undefined && pool.length > messages.length
        return json({ messages, ...(hasOlder ? { nextBefore: first.id } : {}) })
      }
      if (url.pathname.endsWith('/interrupt')) return w.interrupt()
      if (url.pathname.endsWith('/chat/stream')) return w.resume()
      if (url.pathname.endsWith('/chat')) {
        return w.chat(JSON.parse(String(init?.body)) as Record<string, unknown>)
      }
      if (url.pathname.startsWith('/api/sessions/')) {
        return json({
          id: 's1',
          running: w.running,
          busy: null,
          activeTurn:
            w.activeMessageId === undefined
              ? null
              : {
                  turnId: 't1',
                  kind: 'respond',
                  messageId: w.activeMessageId,
                  owner: 'o',
                  startedAt: 0,
                  heartbeatAt: 0,
                },
          pending: null,
          usage: {},
        })
      }
      return new Response(null, { status: 404 })
    }) as typeof fetch,
  })
  return { w, client }
}

/** A fake chat object: just enough of AbstractChat for the session. */
function fakeChat(session: ReturnType<typeof createChatSession>) {
  const chat = {
    messages: [] as UIMessage[],
    status: 'ready' as ChatStatus,
    log: [] as string[],
    resumes: [] as Array<() => void | Promise<void>>,
    stopped: 0,
    cleared: 0,
    async sendMessage(m: { text: string }) {
      chat.log.push(`send:${m.text}`)
      const optimistic = user(`u-${chat.messages.length}`, m.text)
      chat.messages = [...chat.messages, optimistic]
      chat.status = 'submitted'
      try {
        const stream = await session.chatInit.transport.sendMessages({
          chatId: 's1',
          messages: chat.messages,
          trigger: 'submit-message',
          messageId: undefined,
          abortSignal: undefined,
        })
        const reader = stream.getReader()
        while (!(await reader.read()).done) {}
        chat.status = 'ready'
        session.chatInit.onFinish({
          message: assistant('a-x'),
          messages: [],
          isAbort: false,
          isDisconnect: false,
          isError: false,
        } as never)
      } catch (e) {
        chat.status = 'error'
        session.chatInit.onError(e as Error)
      }
    },
    async regenerate(o?: { messageId?: string }) {
      chat.log.push(`regenerate:${o?.messageId}`)
    },
    async resumeStream() {
      chat.log.push('resume')
      chat.status = 'streaming'
      try {
        await chat.resumes.shift()?.()
      } finally {
        chat.status = 'ready'
      }
    },
    async stop() {
      chat.stopped++
      chat.status = 'ready'
    },
    clearError() {
      chat.cleared++
      if (chat.status === 'error') chat.status = 'ready'
    },
  }
  return chat satisfies ChatBridge
}

function setup(
  options: {
    messages?: UIMessage[]
    pageSize?: number
    notify?: (l: string, t: string) => void
  } = {},
) {
  const { w, client } = world()
  const notes: Array<[string, string]> = []
  const session = createChatSession({
    client,
    sessionId: 's1',
    sleep: async () => {},
    notify: (level, text) => notes.push([level, text]),
    ...options,
  })
  const chat = fakeChat(session)
  session.bind(chat)
  return { w, client, session, chat, notes }
}

describe('chat session: init and follow', () => {
  test('init loads the first page, then follows a running turn and refetches', async () => {
    const t = setup({ pageSize: 2 })
    t.w.stored = [user('m1'), assistant('m2'), user('m3'), assistant('m4')]
    t.w.running = true
    t.chat.resumes.push(() => {
      t.w.stored = [...t.w.stored, user('m5'), assistant('m6')]
    })
    await t.session.init()
    expect(t.chat.log).toEqual(['resume'])
    expect(t.chat.messages.map((m) => m.id)).toEqual(['m3', 'm4', 'm5', 'm6'])
    const state = t.session.get()
    expect(state).toMatchObject({ loaded: true, hasOlder: true, following: false, busy: false })
    expect(t.w.log[0]).toBe('GET /api/sessions/s1/messages?limit=2')
    expect(t.w.log.filter((l) => l.includes('/messages')).length).toBe(3) // init, the refetch and the adjacency check of its page
  })

  test('init is idempotent and does not follow when no turn runs', async () => {
    const t = setup()
    t.w.stored = [user('m1')]
    await Promise.all([t.session.init(), t.session.init()])
    await t.session.init()
    expect(t.chat.log).toEqual([])
    expect(t.w.log.filter((l) => l.includes('/messages')).length).toBe(1)
    expect(t.session.get()).toMatchObject({ loaded: true, hasOlder: false })
  })

  test('initial messages skip the first page', async () => {
    const t = setup({ messages: [user('m1')] })
    expect(t.session.get().loaded).toBe(true)
    await t.session.init()
    expect(t.w.log.some((l) => l.includes('/messages'))).toBe(false)
  })

  test('a turn that continues an earlier assistant message streams it as the last message', async () => {
    // a respond() continuation after an event message was stored behind the waiting reply:
    // AI SDK resumeStream() only replaces the last message, so it must be last (no duplicate id)
    const t = setup()
    t.w.stored = [user('m1'), assistant('m2'), user('m3')] // m3: an event stored behind m2
    await t.session.init()
    t.w.running = true
    t.w.activeMessageId = 'm2'
    let orderAtResume: string[] = []
    t.chat.resumes.push(() => {
      orderAtResume = t.chat.messages.map((m) => m.id)
      t.w.running = false
      t.w.activeMessageId = undefined
    })
    await t.session.followServerTurn()
    expect(orderAtResume).toEqual(['m1', 'm3', 'm2'])
    // after the turn, storage is the truth again: the stored order comes back
    expect(t.chat.messages.map((m) => m.id)).toEqual(['m1', 'm2', 'm3'])
    expect(new Set(t.chat.messages.map((m) => m.id)).size).toBe(t.chat.messages.length)
  })

  test('the newest message, a user message or an unknown id is left in place', async () => {
    const t = setup()
    t.w.stored = [user('m1'), assistant('m2')]
    await t.session.init()
    for (const id of ['m2', 'm1', 'gone']) {
      t.w.running = true
      t.w.activeMessageId = id
      let order: string[] = []
      t.chat.resumes.push(() => {
        order = t.chat.messages.map((m) => m.id)
        t.w.running = false
      })
      await t.session.followServerTurn()
      expect(order).toEqual(['m1', 'm2'])
    }
  })

  test('a dropped connection while following is retried quietly', async () => {
    const t = setup()
    t.w.running = true
    let tries = 0
    for (let i = 0; i < 2; i++) {
      t.chat.resumes.push(() => {
        tries++
        t.session.chatInit.onError(new TypeError('Failed to fetch'))
      })
    }
    await t.session.init()
    expect(tries).toBe(2)
    expect(t.chat.log.filter((l) => l === 'resume').length).toBe(3) // 2 failures + the one that worked
    expect(t.session.get().problem).toBeNull()
    expect(t.notes).toEqual([])
  })

  test('when the retries run out the banner offers Retry', async () => {
    const t = setup()
    t.w.running = true
    for (let i = 0; i < 6; i++) {
      t.chat.resumes.push(() => t.session.chatInit.onError(new TypeError('Failed to fetch')))
    }
    await t.session.init()
    expect(t.chat.log.filter((l) => l === 'resume').length).toBe(4)
    expect(t.session.get().problem).toEqual({
      message: 'Cannot reach the server. Check your connection.',
      retry: 'follow',
    })
    t.chat.resumes.length = 0
    await t.session.retry()
    expect(t.session.get().problem).toBeNull()
    expect(t.chat.log.filter((l) => l === 'resume').length).toBe(5)
    t.session.dismissProblem()
  })
})

describe('chat session: send', () => {
  test('send while a turn runs steers with ifBusy=steer and does not start a second turn', async () => {
    const t = setup()
    t.chat.status = 'streaming'
    t.w.chat = () =>
      new Response(JSON.stringify({ inboxId: 'i', delivered: 'steer', target: 'remote' }), {
        status: 202,
      })
    await t.session.send('and also this')
    expect(t.chat.log).toEqual([])
    expect(t.w.log).toContain('POST /api/sessions/s1/chat?ifBusy=steer')
    expect(t.session.get().notice).toBe('Sent to the running turn')
  })

  test('a 200 answer to a steer (the turn is local) cancels its body and says so', async () => {
    const t = setup()
    t.chat.status = 'streaming'
    t.w.chat = () => new Response('data: [DONE]\n\n', { status: 200 })
    await t.session.send('more')
    expect(t.session.get().notice).toBe('Sent to the running turn')
    expect(t.notes).toEqual([])
  })

  test('a failed steer is a toast', async () => {
    const t = setup()
    t.chat.status = 'streaming'
    t.w.chat = () => err(400, 'EH_INVALID_INPUT')
    await t.session.send('x')
    expect(t.notes.length).toBe(1)
    expect(t.notes[0]?.[0]).toBe('error')
  })

  test('send when idle goes through the chat; a 202 then follows the turn and refetches', async () => {
    const t = setup()
    t.w.chat = () =>
      new Response(JSON.stringify({ inboxId: 'i', delivered: 'steer', target: 'remote' }), {
        status: 202,
      })
    t.w.stored = [user('m1'), assistant('m2')]
    await t.session.send('hello')
    expect(t.chat.log).toEqual(['send:hello', 'resume'])
    expect(t.chat.messages.map((m) => m.id)).toContain('m2')
    expect(t.session.get().busy).toBe(false)
  })

  test('messages stored while this tab streamed its own turn show when the turn ends', async () => {
    const t = setup()
    await t.session.init()
    t.w.chat = () => {
      // the turn stores its messages and announces them while the reply streams
      t.w.stored = [user('m1', 'hello'), assistant('m2'), user('m3')]
      void t.session.storedElsewhere() // busy: skipped, remembered
      return new Response('data: [DONE]\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream', 'x-vercel-ai-ui-message-stream': 'v1' },
      })
    }
    await t.session.send('hello')
    // the optimistic user message (a made-up id) is replaced by the stored ones
    expect(t.chat.messages.map((m) => m.id)).toEqual(['m1', 'm2', 'm3'])
    expect(t.w.log.filter((l) => l.includes('/messages')).length).toBe(2) // init + the flush
  })

  test('nothing is refetched after an own turn when nothing was announced', async () => {
    const t = setup({ messages: [] })
    t.w.chat = () =>
      new Response('data: [DONE]\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream', 'x-vercel-ai-ui-message-stream': 'v1' },
      })
    await t.session.send('hello')
    expect(t.w.log.filter((l) => l.includes('/messages')).length).toBe(0)
  })

  test('a busy 409 drops the optimistic message and toasts', async () => {
    const t = setup()
    t.w.chat = () => err(409, 'EH_SESSION_BUSY')
    await t.session.send('hello')
    expect(t.chat.messages).toEqual([])
    expect(t.notes).toEqual([
      ['error', 'The agent is busy with another turn. It will show here when it finishes.'],
    ])
    expect(t.chat.cleared).toBe(1)
  })

  test('a stale answer (already answered) refetches quietly', async () => {
    const t = setup()
    t.w.stored = [user('m1')]
    t.w.chat = () => err(409, 'EH_HTTP_ALREADY_ANSWERED', { ids: ['p'] })
    await t.session.send('x')
    await Promise.resolve()
    await new Promise((r) => setTimeout(r, 5))
    expect(t.notes).toEqual([])
    expect(t.session.get().problem).toBeNull()
    expect(t.w.log.some((l) => l.includes('/messages'))).toBe(true)
  })

  test('a connection that broke after the reply began re-attaches', async () => {
    const t = setup()
    t.chat.messages = [assistant('a1')]
    t.session.chatInit.onError(new TypeError('Failed to fetch'))
    await new Promise((r) => setTimeout(r, 5))
    expect(t.chat.log).toEqual(['resume'])
    expect(t.notes).toEqual([])
  })

  test('another error of a message the person sent is a toast', async () => {
    const t = setup()
    t.w.chat = () => err(400, 'EH_PENDING_RESPONSE')
    await t.session.send('x')
    expect(t.notes[0]?.[1]).toContain('waiting for your answer')
  })

  test('the status of the streamed turn is tracked and the item refetches after an approval continuation', async () => {
    const t = setup()
    t.session.chatInit.onData({ type: 'data-eh.status', data: { state: 'tool' } } as never)
    expect(t.session.get().activity).toBe('tool')
    t.w.stored = [user('m1'), assistant('m2')]
    t.session.chatInit.onFinish({
      message: { ...assistant('m2'), parts: [{ type: 'tool-x', approval: { id: 'a' } }] },
      messages: [],
      isAbort: false,
      isDisconnect: false,
      isError: false,
    } as never)
    expect(t.session.get().activity).toBeNull()
    await new Promise((r) => setTimeout(r, 5))
    expect(t.chat.messages.map((m) => m.id)).toEqual(['m1', 'm2'])
  })
})

describe('chat session: stop, stalled, paging, interrupted', () => {
  test('stop interrupts the server turn, then stops reading', async () => {
    const t = setup()
    await t.session.stop()
    expect(t.w.log).toContain('POST /api/sessions/s1/interrupt')
    expect(t.chat.stopped).toBe(1)
  })

  test('a failing interrupt is retried, reported, and keeps `stopping` until the server confirms (K-11)', async () => {
    const t = setup()
    t.w.running = true
    t.w.interrupt = () => {
      throw new TypeError('Failed to fetch')
    }
    await t.session.stop()
    const attempts = () => t.w.log.filter((l) => l.endsWith('/interrupt')).length
    expect(attempts()).toBe(3)
    expect(t.chat.stopped).toBe(1) // reading stops regardless
    expect(t.notes.map((n) => n[0])).toEqual(['error'])
    expect(t.session.get()).toMatchObject({ stopping: true, busy: true })
    // the server is back and still runs the turn: the next check asks again, and now it works
    t.w.interrupt = () => json({ target: 'local' })
    await t.session.checkStalled()
    expect(attempts()).toBe(4)
    expect(t.session.get()).toMatchObject({ stopping: false, busy: false })
  })

  test('a stop that failed ends when the server reports the turn is over', async () => {
    const t = setup()
    t.w.interrupt = () => json({ error: { code: 'EH_HTTP_FORBIDDEN', message: 'no' } }, 403)
    await t.session.stop()
    // 403: retrying cannot help
    expect(t.w.log.filter((l) => l.endsWith('/interrupt'))).toHaveLength(1)
    expect(t.session.get().stopping).toBe(true)
    t.w.running = false
    await t.session.checkStalled()
    expect(t.session.get()).toMatchObject({ stopping: false, busy: false })
  })

  test('a silent connection is dropped after two idle checks', async () => {
    const t = setup()
    t.w.stored = [user('m1'), assistant('m2')]
    t.chat.status = 'streaming'
    t.w.running = false
    await t.session.checkStalled()
    expect(t.chat.stopped).toBe(0)
    await t.session.checkStalled()
    expect(t.chat.stopped).toBe(1)
    expect(t.chat.messages.map((m) => m.id)).toEqual(['m1', 'm2'])
  })

  test('a server that still runs the turn, or is unreachable, keeps the reader', async () => {
    const t = setup()
    t.chat.status = 'streaming'
    t.w.running = true
    await t.session.checkStalled()
    await t.session.checkStalled()
    expect(t.chat.stopped).toBe(0)
  })

  test('loadOlder pages back without duplicates; refetch replaces only the tail', async () => {
    const t = setup({ pageSize: 2 })
    t.w.stored = ['m1', 'm2', 'm3', 'm4', 'm5'].map((id) =>
      id === 'm2' || id === 'm4' ? assistant(id) : user(id),
    )
    await t.session.init()
    expect(t.chat.messages.map((m) => m.id)).toEqual(['m4', 'm5'])
    expect(await t.session.loadOlder()).toBe(2)
    expect(t.chat.messages.map((m) => m.id)).toEqual(['m2', 'm3', 'm4', 'm5'])
    expect(await t.session.loadOlder()).toBe(1)
    expect(t.session.get().hasOlder).toBe(false)
    expect(await t.session.loadOlder()).toBe(0)
    t.w.stored = [...t.w.stored, assistant('m6')]
    await t.session.refetch()
    expect(t.chat.messages.map((m) => m.id)).toEqual(['m1', 'm2', 'm3', 'm4', 'm5', 'm6'])
  })

  test('refetch after more than a page was stored drops the stale messages and pages from the new page', async () => {
    const t = setup({ pageSize: 2 })
    t.w.stored = [user('m01'), assistant('m02'), user('m03'), assistant('m04')]
    await t.session.init()
    expect(t.chat.messages.map((m) => m.id)).toEqual(['m03', 'm04'])
    t.w.stored = [
      ...t.w.stored,
      user('m05'),
      assistant('m06'),
      user('m07'),
      assistant('m08'),
      user('m09'),
      assistant('m10'),
    ]
    await t.session.refetch()
    expect(t.chat.messages.map((m) => m.id)).toEqual(['m09', 'm10'])
    expect(t.session.get().hasOlder).toBe(true)
    expect(await t.session.loadOlder()).toBe(2)
    expect(t.chat.messages.map((m) => m.id)).toEqual(['m07', 'm08', 'm09', 'm10'])
  })

  test('an optimistic user message never survives a refetch that holds the stored one', async () => {
    const t = setup({ pageSize: 5 })
    t.w.stored = [user('m01'), assistant('m02')]
    await t.session.init()
    t.chat.messages = [...t.chat.messages, user('zzOptimistic', 'hello')]
    t.w.stored = [...t.w.stored, user('m03', 'hello'), assistant('m04')]
    await t.session.refetch()
    expect(t.chat.messages.map((m) => m.id)).toEqual(['m01', 'm02', 'm03', 'm04'])
  })

  test('an interrupted reply offers Continue and Retry', async () => {
    const t = setup()
    t.chat.messages = [
      user('m1'),
      assistant('m2', { metadata: { eharness: { stop: 'interrupted' } } }),
      assistant('m3', { metadata: { eharness: { kind: 'eh.recovery' } } }),
    ]
    expect(t.session.interrupted()).toBe(true)
    await t.session.retryTurn()
    expect(t.chat.log).toEqual(['regenerate:m2'])
    t.chat.log.length = 0
    t.w.chat = () => new Response('data: [DONE]\n\n', { status: 200 })
    await t.session.continueTurn()
    expect(t.chat.log).toEqual(['send:Continue where you left off.'])
    t.chat.messages = [...t.chat.messages, user('m4')]
    expect(t.session.interrupted()).toBe(false)
  })

  test('the store follows the Store contract', async () => {
    const t = setup()
    const seen: boolean[] = []
    const off = t.session.subscribe((s) => seen.push(s.loaded))
    expect(seen).toEqual([false])
    await t.session.init()
    expect(seen.at(-1)).toBe(true)
    expect(t.session.get()).toBe(t.session.get())
    off()
  })
})

// `Chat` of `@ai-sdk/svelte` extends `AbstractChat`: it satisfies the bridge structurally
describe('chat bridge', () => {
  test('AbstractChat (base of the Svelte Chat) is assignable to ChatBridge', () => {
    const check = (chat: AbstractChat<UIMessage>): ChatBridge => chat
    expect(typeof check).toBe('function')
  })
})

describe('chat session: real AI SDK Chat', () => {
  test('a refused send leaves the real Chat ready (Chat calls onError before it sets the status)', async () => {
    const { AbstractChat } = await import('ai')
    class Chat extends AbstractChat<UIMessage> {
      constructor(
        init: ConstructorParameters<typeof AbstractChat<UIMessage>>[0] extends infer I
          ? Omit<NonNullable<I>, 'state'>
          : never,
      ) {
        const state = {
          status: 'ready' as ChatStatus,
          error: undefined as Error | undefined,
          messages: [] as UIMessage[],
          pushMessage(m: UIMessage) {
            this.messages.push(m)
          },
          popMessage() {
            this.messages.pop()
          },
          replaceMessage(i: number, m: UIMessage) {
            this.messages[i] = m
          },
          snapshot: <T>(v: T): T => structuredClone(v),
        }
        super({ ...init, state })
      }
    }
    const { w, client } = world()
    const notes: string[] = []
    const session = createChatSession({
      client,
      sessionId: 's1',
      sleep: async () => {},
      notify: (_l, t) => notes.push(t),
    })
    w.chat = () => err(409, 'EH_SESSION_BUSY')
    const chat = new Chat(session.chatInit)
    session.bind(chat as unknown as ChatBridge)
    await chat.sendMessage({ text: 'hi' })
    await new Promise((r) => setTimeout(r, 0))
    expect(chat.status).toBe('ready')
    expect(chat.error).toBeUndefined()
    expect(notes.length).toBe(1)
    expect(session.get().busy).toBe(false)
  })
})
