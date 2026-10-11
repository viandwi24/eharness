/**
 * The real client against `createHarnessHttp` served by `Bun.serve` on port 0: a scripted model,
 * memory storage and activity store. Servers are stopped after every test.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import type { UIMessage, UIMessageChunk } from 'ai'
import type { ActivityRecord } from '../activity/index.ts'
import { activity, memoryActivityStore } from '../activity/index.ts'
import { createHarnessHttp, openAccess } from '../http/index.ts'
import { defineHarnessAgent, type HarnessAgent } from '../index.ts'
import { memoryInbox, memoryMessages, memoryState, memoryStreamLog } from '../storage/memory.ts'
import { scriptedModel } from '../testing/scripted-model.ts'
import { createActivityFeed, type ResyncReason } from './activity-feed.ts'
import { createChatSession } from './chat-session.ts'
import { createHarnessClient, isHarnessHttpError } from './http-client.ts'
import { createHarnessTransport } from './transport.ts'

const silent = { debug() {}, info() {}, warn() {}, error() {} }
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(what: string, condition: () => boolean, ms = 4000) {
  const end = Date.now() + ms
  while (!condition()) {
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`)
    await sleep(5)
  }
}

// biome-ignore lint/suspicious/noExplicitAny: loosely typed agents in tests
type Agent = HarnessAgent<any>

const cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
})

function boot(replies: string[]) {
  const store = memoryActivityStore()
  const agent: Agent = defineHarnessAgent({
    contextWindow: 100_000,
    model: scriptedModel(replies.map((text) => ({ text }))),
    storage: {
      messages: memoryMessages(),
      state: memoryState(),
      streams: memoryStreamLog(),
      inbox: memoryInbox(),
    },
    streams: { flushMs: 5, pollMs: 10 },
    inbox: { pollMs: 10 },
    logger: silent,
    onWarning() {},
    plugins: [activity({ store })],
  } as never) as Agent
  const make = (bootId: string) =>
    createHarnessHttp(agent, {
      authorize: openAccess,
      chat: { ifBusy: ['reject', 'steer'] },
      activity: { store, bootId, pollMs: 10, filter: () => 'all' },
    })
  // the "process" the client talks to: swapping `current` is a restart (a new boot id)
  let current = make('boot-1')
  const server = Bun.serve({ port: 0, idleTimeout: 0, fetch: (req) => current.fetch(req) })
  cleanup.push(async () => {
    await server.stop(true)
    await agent.close()
  })
  const client = createHarnessClient({ baseUrl: `http://localhost:${server.port}` })
  return {
    client,
    agent,
    store,
    restart: (bootId: string) => {
      current = make(bootId)
    },
  }
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

const userMessage = (id: string, text: string): UIMessage => ({
  id,
  role: 'user',
  parts: [{ type: 'text', text }],
})

describe('client against a real server', () => {
  test('send a message through the transport and get the stream; it is stored and readable', async () => {
    const t = boot(['hello from the model'])
    expect(await t.client.health()).toMatchObject({ ok: true, boot: 'boot-1' })
    const transport = createHarnessTransport({ client: t.client })
    const chunks = await drain(
      await transport.sendMessages({
        chatId: 's1',
        messages: [userMessage('u-1', 'hi')],
        trigger: 'submit-message',
        messageId: undefined,
        abortSignal: undefined,
      }),
    )
    const text = chunks
      .filter((c) => c.type === 'text-delta')
      .map((c) => (c as { delta: string }).delta)
      .join('')
    expect(text).toBe('hello from the model')
    expect(chunks.at(-1)?.type).toBe('finish')
    const page = await t.client.sessions.messages('s1', { limit: 10 })
    expect(page.messages.map((m) => m.role)).toEqual(['user', 'assistant'])
    const snapshot = await t.client.sessions.get('s1')
    expect(snapshot).toMatchObject({ id: 's1', running: false })
    expect(await t.client.sessions.interrupt('s1')).toEqual({ target: 'idle' })
  })

  test('sending the same message again is a duplicate the client can recognise', async () => {
    const t = boot(['one'])
    const transport = createHarnessTransport({ client: t.client })
    const send = () =>
      transport.sendMessages({
        chatId: 's1',
        messages: [userMessage('u-dup', 'hi')],
        trigger: 'submit-message',
        messageId: undefined,
        abortSignal: undefined,
      })
    await drain(await send())
    const failure = await send().catch((e) => e)
    expect(isHarnessHttpError(failure)).toBe(true)
    expect(failure).toMatchObject({ status: 409, code: 'EH_HTTP_DUPLICATE_REQUEST' })
    expect(failure.isDuplicate).toBe(true)
    expect(failure.details).toMatchObject({ active: false })
    expect(typeof failure.details.messageId).toBe('string')
  })

  test('a chat session loads history from the server', async () => {
    const t = boot(['first reply'])
    const transport = createHarnessTransport({ client: t.client })
    await drain(
      await transport.sendMessages({
        chatId: 's1',
        messages: [userMessage('u-1', 'hi')],
        trigger: 'submit-message',
        messageId: undefined,
        abortSignal: undefined,
      }),
    )
    const session = createChatSession({ client: t.client, sessionId: 's1' })
    const bridge = {
      messages: [] as UIMessage[],
      status: 'ready' as const,
      sendMessage: async () => {},
      regenerate: async () => {},
      resumeStream: async () => {},
      stop: async () => {},
      clearError: () => {},
    }
    session.bind(bridge)
    await session.init()
    expect(bridge.messages.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(session.get()).toMatchObject({ loaded: true, hasOlder: false, busy: false })
  })

  test('the activity feed receives the events of a turn', async () => {
    const t = boot(['reply'])
    const events: ActivityRecord[] = []
    const feed = createActivityFeed({ client: t.client, onEvent: (e) => events.push(e), tickMs: 0 })
    cleanup.push(() => feed.stop())
    feed.start()
    await until('live', () => feed.get().status === 'live')
    const transport = createHarnessTransport({ client: t.client })
    await drain(
      await transport.sendMessages({
        chatId: 's1',
        messages: [userMessage('u-1', 'hi')],
        trigger: 'submit-message',
        messageId: undefined,
        abortSignal: undefined,
      }),
    )
    await until('turn-ended', () => events.some((e) => e.type === 'turn-ended'))
    const types = events.map((e) => e.type)
    expect(types).toContain('turn-started')
    expect(types.indexOf('turn-started')).toBeLessThan(types.indexOf('turn-ended'))
    expect(events.every((e) => e.sessionId === 's1')).toBe(true)
    expect(feed.get().lastSeq).toBe(events.at(-1)?.seq ?? -1)
  })

  test('a server restart (a new boot id) reconnects the feed and asks for a resync', async () => {
    const t = boot(['reply'])
    const reasons: ResyncReason[] = []
    const boots: Array<[string, boolean]> = []
    const feed = createActivityFeed({
      client: t.client,
      onResync: (r) => reasons.push(r),
      onBoot: (id, restarted) => boots.push([id, restarted]),
      tickMs: 0,
    })
    cleanup.push(() => feed.stop())
    feed.start()
    await until('first boot', () => boots.length === 1)
    expect(reasons).toEqual(['connect'])
    t.restart('boot-2')
    await feed.check()
    await until('resync after restart', () => reasons.length === 2)
    expect(reasons).toEqual(['connect', 'boot-changed'])
    expect(boots[1]).toEqual(['boot-2', true])
    expect(feed.get().boot).toBe('boot-2')
    await until('live again', () => feed.get().status === 'live')
  })

  test('a feed against a store that was pruned past the cursor reports a resync event', async () => {
    const t = boot(['a', 'b'])
    // history in the log, then a feed that resumes from a cursor the server does not hold
    await t.store.append(Array.from({ length: 5 }, (_, i) => ({ type: 'x', payload: { i } })))
    await t.store.prune({ keepLast: 1 })
    const reasons: ResyncReason[] = []
    const feed = createActivityFeed({
      client: t.client,
      initialAfter: 1,
      onResync: (r) => reasons.push(r),
      tickMs: 0,
    })
    cleanup.push(() => feed.stop())
    feed.start()
    await until('resync event', () => reasons.includes('resync-event'))
    expect(reasons[0]).toBe('connect')
  })
})
