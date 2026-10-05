/**
 * Durable inbox (spec 05 §12): two agent instances ("processes") share one message store, one
 * state store and one `memoryInbox()`; inputs, wake-ups and aborts enqueued in instance B are
 * applied by the instance that holds the session.
 */
import { describe, expect, test } from 'bun:test'
import { tool } from 'ai'
import { z } from 'zod/v4'
import { defineHarnessAgent } from '../agent/define-agent.ts'
import type { InboxAdapter, InboxItemInput, SessionEvent } from '../agent/session-types.ts'
import type { HarnessAgentConfig } from '../agent/types.ts'
import type { HarnessWarning } from '../errors.ts'
import type { HarnessUIMessage } from '../messages/types.ts'
import { memoryInbox } from '../storage/memory.ts'
import { type ScriptedPrompt, scriptedModel } from '../testing/scripted-model.ts'
import { defaultMemoryMessages, defaultMemoryState } from './memory-storage.ts'

const silent = { debug() {}, info() {}, warn() {}, error() {} }
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function until(what: string, condition: () => boolean | Promise<boolean>, ms = 3_000) {
  const end = Date.now() + ms
  while (!(await condition())) {
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`)
    await sleep(2)
  }
}

/** A memory inbox that records claims, acks and releases; `loseAcks` drops acks (a crash). */
function spyInbox(inner: InboxAdapter = memoryInbox()) {
  const log = {
    enqueued: [] as string[],
    claims: [] as Array<{ owner: string; ids: string[] }>,
    acks: [] as string[],
    releases: [] as string[],
    loseAcks: 0,
  }
  const adapter: InboxAdapter = {
    async enqueue(sessionId, item) {
      const id = await inner.enqueue(sessionId, item)
      log.enqueued.push(id)
      return id
    },
    async claim(sessionId, owner, opts) {
      const items = await inner.claim(sessionId, owner, opts)
      if (items.length > 0) log.claims.push({ owner, ids: items.map((i) => i.id) })
      return items
    },
    async ack(ids) {
      if (log.loseAcks > 0) {
        log.loseAcks--
        return
      }
      log.acks.push(...ids)
      return inner.ack(ids)
    },
    async release(ids) {
      log.releases.push(...ids)
      return inner.release(ids)
    },
    notify: (sessionId) => inner.notify?.(sessionId) ?? Promise.resolve(),
    subscribe: (sessionId, onNotify) => inner.subscribe?.(sessionId, onNotify) ?? (() => {}),
    pending: (opts) => inner.pending?.(opts) ?? Promise.resolve([]),
  }
  /** The item is claimed right now (claimed more often than released). */
  const held = (id: string): boolean =>
    log.claims.filter((c) => c.ids.includes(id)).length >
    log.releases.filter((r) => r === id).length
  /** Items enqueued and not acked yet (claimed or not). */
  const left = async (): Promise<number> =>
    log.enqueued.filter((id) => !log.acks.includes(id)).length
  return { adapter, log, left, held }
}

function sharedStorage(inbox = spyInbox()) {
  return { messages: defaultMemoryMessages(), state: defaultMemoryState(), inbox }
}
type Storage = ReturnType<typeof sharedStorage>

function instance(
  storage: Storage,
  config: Partial<HarnessAgentConfig> & Pick<HarnessAgentConfig, 'model'>,
) {
  const warnings: HarnessWarning[] = []
  const agent = defineHarnessAgent({
    contextWindow: 100_000,
    storage: { messages: storage.messages, state: storage.state, inbox: storage.inbox.adapter },
    logger: silent,
    onWarning: (w) => warnings.push(w),
    ...config,
    inbox: { pollMs: 10, ...config.inbox },
  })
  return { agent, warnings }
}

/** Collect a session's events until `stop()`. */
function record<E = SessionEvent>(stream: ReadableStream<E>): E[] {
  const events: E[] = []
  const reader = stream.getReader()
  void (async () => {
    for (;;) {
      const next = await reader.read()
      if (next.done) return
      events.push(next.value)
    }
  })()
  return events
}

/** A tool that waits for `release()` (or the turn's abort signal). */
function gateTool() {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let markStarted!: () => void
  const started = new Promise<void>((resolve) => {
    markStarted = resolve
  })
  const gated = tool({
    inputSchema: z.object({}),
    execute: (_input, { abortSignal }) =>
      new Promise<string>((resolve) => {
        markStarted()
        abortSignal?.addEventListener('abort', () => resolve('cancelled'))
        void gate.then(() => resolve('ok'))
      }),
  })
  return { gated, started, release }
}
const gateCall = { toolCalls: [{ toolName: 'gated', input: {} }] }

async function stored(storage: Storage): Promise<HarnessUIMessage[]> {
  return (await storage.messages.load({ sessionId: 's1' })) as HarnessUIMessage[]
}

function userTexts(messages: HarnessUIMessage[]): string[] {
  return messages
    .filter((m) => m.role === 'user')
    .map((m) => m.parts.map((p) => (p.type === 'text' ? p.text : '')).join(''))
}

/** The text of the last user message of a provider prompt. */
function lastUserText(prompt: ScriptedPrompt | undefined): string {
  const user = [...(prompt ?? [])].reverse().find((m) => m.role === 'user')
  if (user === undefined || typeof user.content === 'string') return String(user?.content ?? '')
  return user.content.map((p) => (p.type === 'text' ? p.text : '')).join('')
}

describe('durable inbox across instances (spec 05 §12)', () => {
  test('steer from B reaches the turn running in A at the next step boundary', async () => {
    const storage = sharedStorage()
    const { gated, started, release } = gateTool()
    const model = scriptedModel([gateCall, { text: 'done' }])
    const a = instance(storage, { model, tools: { gated } })
    const b = instance(storage, { model, inbox: { pollMs: 0 } })
    const sessionA = a.agent.session('s1')
    const eventsA = record(sessionA.events())

    const run = sessionA.send('go')
    await started
    const enqueued = await b.agent.session('s1').enqueue('also check the logs', { mode: 'steer' })
    expect(enqueued.target).toBe('remote')
    // held by A's running turn: claimed and not released (B releases what it claims)
    await until('A holds the steer', () => storage.inbox.held(enqueued.inboxId))
    release()
    const result = await run.result
    expect(result.stop).toBe('complete')
    expect(model.prompts.length).toBe(2)
    // stored order = model order: the input follows the tool result in both
    expect(lastUserText(model.prompts[1])).toBe('also check the logs')
    const assistant = (await stored(storage)).find((m) => m.id === result.messageId)
    const types = assistant?.parts.map((p) => p.type) ?? []
    expect(types.indexOf('data-eh.input')).toBeGreaterThan(types.indexOf('tool-gated'))
    const input = assistant?.parts.find((p) => p.type === 'data-eh.input') as
      | { data: { text: string; inboxId?: string } }
      | undefined
    expect(input?.data).toMatchObject({ text: 'also check the logs', inboxId: enqueued.inboxId })
    await until('acked', () => storage.inbox.log.acks.includes(enqueued.inboxId))
    expect(await storage.inbox.left()).toBe(0)
    expect(eventsA).toContainEqual({
      type: 'inbox-drained',
      inboxIds: [enqueued.inboxId],
      turnId: run.turnId,
    })
    // dedupe reads data-eh.input.inboxId of the saved snapshot; the state never lists a steer
    expect((await storage.state.get('s1'))?.core.inboxDelivered ?? []).not.toContain(
      enqueued.inboxId,
    )
    await a.agent.close()
    await b.agent.close()
  })

  test('queue from B runs as the next turn in A', async () => {
    const storage = sharedStorage()
    const { gated, started, release } = gateTool()
    const model = scriptedModel([gateCall, { text: 'first done' }, { text: 'second done' }])
    const a = instance(storage, { model, tools: { gated } })
    const b = instance(storage, { model, inbox: { pollMs: 0 } })
    const sessionA = a.agent.session('s1')
    const eventsA = record(sessionA.events())
    const sessionB = b.agent.session('s1')
    const eventsB = record(sessionB.events())

    const run = sessionA.send('first')
    await started
    const enqueued = await sessionB.enqueue('second')
    expect(enqueued.target).toBe('remote')
    expect(eventsB).toContainEqual({
      type: 'inbox-enqueued',
      inboxId: enqueued.inboxId,
      kind: 'send',
      mode: 'queue',
    })
    release()
    expect((await run.result).stop).toBe('complete')
    await until('the queued turn ran', () =>
      eventsA.some((e) => e.type === 'turn-end' && e.turnId !== run.turnId),
    )
    await sessionA.idle()
    const messages = await stored(storage)
    expect(userTexts(messages)).toEqual(['first', 'second'])
    const second = messages.filter((m) => m.role === 'user')[1]
    expect(second?.metadata?.eharness?.inboxId).toBe(enqueued.inboxId)
    expect(eventsA).toContainEqual(
      expect.objectContaining({ type: 'turn-start', kind: 'send', queued: true }),
    )
    expect(eventsA).toContainEqual(
      expect.objectContaining({ type: 'inbox-drained', inboxIds: [enqueued.inboxId] }),
    )
    expect(model.prompts.length).toBe(3)
    expect(await storage.inbox.left()).toBe(0)
    await a.agent.close()
    await b.agent.close()
  })

  test('wake from B while A runs: A runs a wake turn after its turn (the event reaches the model)', async () => {
    const storage = sharedStorage()
    const { gated, started, release } = gateTool()
    const model = scriptedModel([gateCall, { text: 'first done' }, { text: 'woke up' }])
    const a = instance(storage, { model, tools: { gated } })
    const b = instance(storage, { model, inbox: { pollMs: 0 } })
    const sessionA = a.agent.session('s1')
    const eventsA = record(sessionA.events())

    const run = sessionA.send('first')
    await started
    const injected = await b.agent
      .session('s1')
      .inject('eh.event', { name: 'deploy', text: 'The deploy finished.' }, { wake: true })
    expect(injected.run).toBeUndefined()
    release()
    await run.result
    await until('the wake turn ended', () =>
      eventsA.some((e) => e.type === 'turn-end' && e.turnId !== run.turnId),
    )
    expect(eventsA).toContainEqual(
      expect.objectContaining({ type: 'turn-start', kind: 'wake', queued: true }),
    )
    expect(JSON.stringify(model.prompts[2])).toContain('The deploy finished.')
    expect(await storage.inbox.left()).toBe(0)
    await a.agent.close()
    await b.agent.close()
  })

  test('wake from B while A is idle starts a turn at once', async () => {
    const storage = sharedStorage()
    const model = scriptedModel([{ text: 'woke up' }])
    const a = instance(storage, { model })
    const b = instance(storage, { model })
    await a.agent.session('s1').ready()
    const injected = await b.agent
      .session('s1')
      .inject('eh.event', { name: 'tick', text: 'tick' }, { wake: true })
    expect((await injected.run?.result)?.stop).toBe('complete')
    expect(await storage.inbox.left()).toBe(0)
    await a.agent.close()
    await b.agent.close()
  })

  test('abort from B goes through the inbox and stops the turn in A', async () => {
    const storage = sharedStorage()
    const { gated, started } = gateTool()
    const model = scriptedModel([gateCall, gateCall, { text: 'never' }])
    // no state poll: only the inbox can deliver the abort
    const a = instance(storage, { model, tools: { gated }, recovery: { abortPollMs: 0 } })
    const b = instance(storage, { model, inbox: { pollMs: 0 } })
    const run = a.agent.session('s1').send('go')
    await started
    const sessionB = b.agent.session('s1')
    const eventsB = record(sessionB.events())
    expect(await sessionB.requestAbort('user stop')).toEqual({ target: 'remote' })
    expect(eventsB).toContainEqual(
      expect.objectContaining({ type: 'inbox-enqueued', kind: 'abort' }),
    )
    expect((await storage.state.get('s1'))?.core.abortRequest).toBeUndefined()
    const result = await run.result
    expect(result.stop).toBe('aborted')
    expect(model.prompts.length).toBe(1)
    await until('abort acked', async () => (await storage.inbox.left()) === 0)
    await a.agent.close()
    await b.agent.close()
  })

  test('a claim of a dead instance expires; the item is applied once by another instance', async () => {
    const storage = sharedStorage()
    const item: InboxItemInput = {
      kind: 'send',
      mode: 'queue',
      input: { parts: [{ type: 'text', text: 'hello' }] },
      at: Date.now(),
    }
    const id = await storage.inbox.adapter.enqueue('s1', item)
    // a process claimed it and died before applying it
    await storage.inbox.adapter.claim('s1', 'dead-instance', { claimTtlMs: 40 })
    const model = scriptedModel([{ text: 'hi' }])
    const a = instance(storage, { model })
    const sessionA = a.agent.session('s1')
    await until('applied', async () => userTexts(await stored(storage)).length === 1)
    await sessionA.idle()
    const user = (await stored(storage)).find((m) => m.role === 'user')
    expect(user?.metadata?.eharness?.inboxId).toBe(id)
    expect(model.prompts.length).toBe(1)
    expect(await storage.inbox.left()).toBe(0)
    await a.agent.close()
  })

  test('a lost ack (crash after the commit point) is redelivered and skipped, never applied twice', async () => {
    const storage = sharedStorage()
    const model = scriptedModel([{ text: 'answer' }, { text: 'must not run' }])
    const a = instance(storage, { model, inbox: { pollMs: 0, claimTtlMs: 150 } })
    storage.inbox.log.loseAcks = 1
    const sessionA = a.agent.session('s1')
    const enqueued = await sessionA.enqueue('only once')
    expect(enqueued.target).toBe('local')
    await until('turn done', async () =>
      (await stored(storage)).some((m) => m.metadata?.eharness?.stop === 'complete'),
    )
    await a.agent.close() // "restart"
    expect(storage.inbox.log.acks).not.toContain(enqueued.inboxId)

    const c = instance(storage, { model, inbox: { claimTtlMs: 150 } })
    const sessionC = c.agent.session('s1')
    await until('redelivered and acked', () => storage.inbox.log.acks.includes(enqueued.inboxId))
    await sessionC.idle()
    expect(userTexts(await stored(storage))).toEqual(['only once'])
    expect(model.prompts.length).toBe(1)
    expect(await storage.inbox.left()).toBe(0)
    await c.agent.close()
  })

  test('pending approvals hold queued items; abort items are not held', async () => {
    const storage = sharedStorage()
    const pay = tool({
      inputSchema: z.object({ amount: z.number() }),
      execute: async ({ amount }) => `paid ${amount}`,
    })
    const model = scriptedModel([
      { toolCalls: [{ toolName: 'pay', input: { amount: 5 } }] },
      { text: 'paid' },
      { text: 'next answered' },
    ])
    const config = {
      model,
      tools: { pay },
      approval: { policy: { pay: 'user-approval' as const } },
    }
    const a = instance(storage, config)
    const b = instance(storage, { ...config, inbox: { pollMs: 0 } })
    const sessionA = a.agent.session('s1')
    const first = await sessionA.send('pay 5').result
    expect(first.stop).toBe('tool-pending')

    const enqueued = await b.agent.session('s1').enqueue('next')
    await storage.inbox.adapter.enqueue('s1', { kind: 'abort', at: Date.now() })
    await sleep(60) // several drains of A (pollMs 10)
    expect(model.prompts.length).toBe(1)
    expect(await storage.inbox.left()).toBe(1) // the abort was drained, the send is held

    const approvalId = first.pending?.approvals[0]?.approvalId as string
    const respond = await sessionA.respond({ approvals: [{ id: approvalId, approved: true }] })
      .result
    expect(respond.stop).toBe('complete')
    await until('next applied', async () => userTexts(await stored(storage)).includes('next'))
    await sessionA.idle()
    expect(model.prompts.length).toBe(3)
    const next = (await stored(storage)).find(
      (m) => m.metadata?.eharness?.inboxId === enqueued.inboxId,
    )
    expect(next?.role).toBe('user')
    await a.agent.close()
    await b.agent.close()
  })
})

describe('collect (spec 05 §12 rule 6)', () => {
  test('three collect inputs within quietMs become one turn with one merged user message', async () => {
    const storage = sharedStorage()
    const model = scriptedModel([{ text: 'merged answer' }, { text: 'must not run' }])
    const a = instance(storage, { model, inbox: { collect: { quietMs: 60 } } })
    const b = instance(storage, { model, inbox: { collect: { quietMs: 60 } } })
    await a.agent.session('s1').ready()
    const sessionB = b.agent.session('s1')
    const ids: string[] = []
    for (const text of ['one', 'two', 'three']) {
      ids.push((await sessionB.enqueue(text, { mode: 'collect' })).inboxId)
      await sleep(5)
    }
    await until('merged turn', async () =>
      (await stored(storage)).some((m) => m.metadata?.eharness?.stop === 'complete'),
    )
    await a.agent.session('s1').idle()
    await sessionB.idle()
    await sleep(80)
    const users = (await stored(storage)).filter((m) => m.role === 'user')
    expect(users.length).toBe(1)
    expect(users[0]?.parts).toEqual([{ type: 'text', text: 'one\n\ntwo\n\nthree' }])
    expect(users[0]?.metadata?.eharness?.collected).toEqual(ids.map((inboxId) => ({ inboxId })))
    expect(model.prompts.length).toBe(1)
    expect(await storage.inbox.left()).toBe(0)
    await a.agent.close()
    await b.agent.close()
  })

  test('maxItems flushes at once; the rest follows after quietMs', async () => {
    const storage = sharedStorage()
    const model = scriptedModel([{ text: 'first' }, { text: 'second' }])
    const a = instance(storage, {
      model,
      inbox: { collect: { quietMs: 5_000, maxWaitMs: 60_000, maxItems: 2 } },
    })
    const sessionA = a.agent.session('s1')
    const started = Date.now()
    await sessionA.enqueue('a', { mode: 'collect' })
    await sessionA.enqueue('b', { mode: 'collect' })
    await sessionA.enqueue('c', { mode: 'collect', collect: { quietMs: 30 } })
    await until('two turns', async () => userTexts(await stored(storage)).length === 2)
    await sessionA.idle()
    expect(Date.now() - started).toBeLessThan(3_000)
    expect(userTexts(await stored(storage))).toEqual(['a\n\nb', 'c'])
    await a.agent.close()
  })

  test('maxWaitMs flushes a burst that never goes quiet', async () => {
    const storage = sharedStorage()
    const model = scriptedModel([{ text: 'first' }])
    const a = instance(storage, {
      model,
      inbox: { collect: { quietMs: 10_000, maxWaitMs: 50 } },
    })
    const sessionA = a.agent.session('s1')
    const started = Date.now()
    await sessionA.enqueue('x', { mode: 'collect' })
    await sessionA.enqueue('y', { mode: 'collect' })
    await until('flushed', async () => userTexts(await stored(storage)).length === 1)
    await sessionA.idle()
    expect(Date.now() - started).toBeLessThan(3_000)
    expect(userTexts(await stored(storage))).toEqual(['x\n\ny'])
    await a.agent.close()
  })

  test("without an inbox: send(…, { ifBusy: 'collect' }) merges into one queued turn", async () => {
    const messages = defaultMemoryMessages()
    const { gated, started, release } = gateTool()
    const model = scriptedModel([gateCall, { text: 'first done' }, { text: 'merged' }])
    const agent = defineHarnessAgent({
      model,
      contextWindow: 100_000,
      tools: { gated },
      storage: { messages, state: defaultMemoryState() },
      logger: silent,
      inbox: { collect: { quietMs: 20 } },
    })
    const session = agent.session('s1')
    const first = session.send('first')
    await started
    const runs = ['x', { text: 'y' }, 'z'].map((input) =>
      session.send(input, { ifBusy: 'collect' }),
    )
    expect(new Set(runs.map((r) => r.turnId)).size).toBe(1)
    release()
    await first.result
    const results = await Promise.all(runs.map((r) => r.result))
    expect(results.map((r) => r.stop)).toEqual(['complete', 'complete', 'complete'])
    expect(new Set(results.map((r) => r.messageId)).size).toBe(1)
    const stored = (await messages.load({ sessionId: 's1' })) as HarnessUIMessage[]
    expect(userTexts(stored)).toEqual(['first', 'x\n\ny\n\nz'])
    const merged = stored.filter((m) => m.role === 'user')[1]
    expect(merged?.metadata?.eharness?.collected).toEqual([{}, {}, {}])
    expect(model.prompts.length).toBe(3)
    await agent.close()
  })

  test('without an inbox: enqueue() applies locally (queue, steer and collect)', async () => {
    const messages = defaultMemoryMessages()
    const { gated, started, release } = gateTool()
    const model = scriptedModel([
      gateCall,
      { text: 'steered and done' },
      { text: 'queued done' },
      { text: 'collected done' },
    ])
    const agent = defineHarnessAgent({
      model,
      contextWindow: 100_000,
      tools: { gated },
      storage: { messages, state: defaultMemoryState() },
      logger: silent,
      inbox: { collect: { quietMs: 20 } },
    })
    const session = agent.session('s1')
    const events = record(session.events())
    const first = session.send('first')
    await started
    const steer = await session.enqueue('steer me', { mode: 'steer' })
    const queued = await session.enqueue('queued')
    expect([steer.target, queued.target]).toEqual(['local', 'local'])
    release()
    await first.result
    await until('queued turn', async () => events.filter((e) => e.type === 'turn-end').length >= 2)
    await session.idle()
    const collected = await session.enqueue('later', { mode: 'collect' })
    await until(
      'collected turn',
      async () => events.filter((e) => e.type === 'turn-end').length >= 3,
    )
    await session.idle()
    const stored = (await messages.load({ sessionId: 's1' })) as HarnessUIMessage[]
    expect(userTexts(stored)).toEqual(['first', 'queued', 'later'])
    const users = stored.filter((m) => m.role === 'user')
    expect(users[1]?.metadata?.eharness?.inboxId).toBe(queued.inboxId)
    expect(users[2]?.metadata?.eharness?.collected).toEqual([{ inboxId: collected.inboxId }])
    expect(lastUserText(model.prompts[1])).toBe('steer me')
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'inbox-drained', inboxIds: [steer.inboxId] }),
    )
    await agent.close()
  })
})
