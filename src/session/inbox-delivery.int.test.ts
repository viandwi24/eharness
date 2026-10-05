/**
 * Durable inbox delivery guarantees (spec 05 §12 rules 3, 5, 7) under claim expiry, crashes and
 * two live holders: a held steer is delivered once, nothing is lost when a process dies between
 * a state write and the save of the item's effect, and id order holds across holders.
 */
import { expect, test } from 'bun:test'
import { tool } from 'ai'
import { z } from 'zod/v4'
import { defineHarnessAgent } from '../agent/define-agent.ts'
import type { InboxItemInput } from '../agent/session-types.ts'
import { memoryInbox } from '../storage/memory.ts'
import { scriptedModel } from '../testing/scripted-model.ts'
import { defaultMemoryMessages, defaultMemoryState } from './memory-storage.ts'

const silent = { debug() {}, info() {}, warn() {}, error() {} }
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const never = () => new Promise<never>(() => {})

async function until(what: string, condition: () => boolean | Promise<boolean>, ms = 3_000) {
  const end = Date.now() + ms
  while (!(await condition())) {
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`)
    await sleep(2)
  }
}

/** A tool that runs until `release()` (or its abort). */
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

/** Every method of `inner`, optionally hanging forever once `dead.v` (a crashed process). */
function killable<T extends object>(
  inner: T,
  dead: { v: boolean },
  after?: (method: string, args: unknown[]) => void,
): T {
  return new Proxy(inner, {
    get(target, key) {
      const value = (target as Record<PropertyKey, unknown>)[key]
      if (typeof value !== 'function') return value
      return async (...args: unknown[]) => {
        if (dead.v) return never()
        const result = await value.apply(target, args)
        after?.(String(key), args)
        return result
      }
    },
  }) as T
}

/** Every method of `inner` after a delay of `ms.v`. */
function slow<T extends object>(inner: T, ms: { v: number }): T {
  return new Proxy(inner, {
    get(target, key) {
      const value = (target as Record<PropertyKey, unknown>)[key]
      if (typeof value !== 'function') return value
      return async (...args: unknown[]) => {
        if (ms.v > 0) await sleep(ms.v)
        return value.apply(target, args)
      }
    },
  }) as T
}

const queued = (text: string): InboxItemInput => ({
  kind: 'send',
  mode: 'queue',
  input: { parts: [{ type: 'text', text }] },
  at: Date.now(),
})

test('a durable steer held across its claim TTL is delivered once (claims are renewed)', async () => {
  const storage = {
    messages: defaultMemoryMessages(),
    state: defaultMemoryState(),
    inbox: memoryInbox(),
  }
  const { gated, started, release } = gateTool()
  const model = scriptedModel([gateCall, { text: 'done' }])
  const base = { contextWindow: 100_000, storage, logger: silent, onWarning() {}, model }
  const a = defineHarnessAgent({ ...base, tools: { gated }, inbox: { pollMs: 10, claimTtlMs: 80 } })
  const b = defineHarnessAgent({ ...base, inbox: { pollMs: 0 } })
  const run = a.session('s1').send('go')
  await started
  await b.session('s1').enqueue('STEER-TEXT', { mode: 'steer' })
  await sleep(400) // the tool runs for several claim TTLs
  release()
  const result = await run.result
  const prompt = JSON.stringify(model.prompts[1])
  expect(prompt.split('STEER-TEXT').length - 1).toBe(1)
  const stored = await storage.messages.load({ sessionId: 's1' })
  const assistant = stored.find((m) => m.id === result.messageId)
  expect(assistant?.parts.filter((p) => p.type === 'data-eh.input')).toHaveLength(1)
  await a.close()
  await b.close()
})

test('a steer delivered but not saved when the process dies is applied by the next holder', async () => {
  const messages = defaultMemoryMessages()
  const state = defaultMemoryState()
  const inbox = memoryInbox()
  const dead = { v: false }
  const { gated, started, release } = gateTool()
  const modelA = scriptedModel([gateCall, { text: 'never finishes', delayMs: 5_000 }])
  const a = defineHarnessAgent({
    contextWindow: 100_000,
    logger: silent,
    onWarning() {},
    model: modelA,
    tools: { gated },
    storage: {
      messages: killable(messages, dead),
      state: killable(state, dead),
      inbox: killable(inbox, dead),
    },
    recovery: { staleMs: 400 },
    inbox: { pollMs: 10 },
  })
  const b = defineHarnessAgent({
    contextWindow: 100_000,
    logger: silent,
    onWarning() {},
    model: modelA,
    storage: { messages, state, inbox },
    inbox: { pollMs: 0 },
  })
  const run = a.session('s1').send('go')
  void run.result
  await started
  await b.session('s1').enqueue('STEER-TEXT', { mode: 'steer' })
  await sleep(30)
  release()
  await until('step 2 started', () => modelA.prompts.length === 2)
  expect(JSON.stringify(modelA.prompts[1])).toContain('STEER-TEXT')
  // a heartbeat state write after the delivery (before 0.4.0 it published the steer as applied)
  const t0 = Date.now()
  await until('heartbeat after the delivery', async () => {
    const heartbeatAt = (await state.get('s1'))?.core.activeTurn?.heartbeatAt ?? 0
    return heartbeatAt > t0
  })
  expect(JSON.stringify(await messages.load({ sessionId: 's1' }))).not.toContain('STEER-TEXT')
  dead.v = true // process A dies
  await sleep(500) // its heartbeat and claims go stale
  const modelC = scriptedModel([{ text: 'recovered' }, { text: 'x' }])
  const c = defineHarnessAgent({
    contextWindow: 100_000,
    logger: silent,
    onWarning() {},
    model: modelC,
    storage: { messages, state, inbox },
    recovery: { staleMs: 400 },
    inbox: { pollMs: 10 },
  })
  const session = c.session('s1')
  await until('the steer is applied again', async () =>
    JSON.stringify(await messages.load({ sessionId: 's1' })).includes('STEER-TEXT'),
  )
  await session.idle()
  expect(await inbox.pending?.({})).toEqual([])
  await c.close()
  await b.close()
})

test('a queued item is not lost when the process dies after the commit-point state write', async () => {
  const messages = defaultMemoryMessages()
  const state = defaultMemoryState()
  const inbox = memoryInbox()
  const dead = { v: false }
  // dies right after the first state write that starts a turn (activeTurn), before the user
  // message is saved
  const stateA = killable(state, dead, (method, args) => {
    const snapshot = args[1] as { core?: { activeTurn?: unknown } } | undefined
    if ((method === 'setIf' || method === 'set') && snapshot?.core?.activeTurn !== undefined) {
      dead.v = true
    }
  })
  const model = scriptedModel([{ text: 'a' }, { text: 'b' }])
  const a = defineHarnessAgent({
    contextWindow: 100_000,
    logger: silent,
    onWarning() {},
    model,
    storage: { messages: killable(messages, dead), state: stateA, inbox: killable(inbox, dead) },
    recovery: { staleMs: 300 },
    inbox: { pollMs: 10 },
  })
  await a.session('s1').ready()
  await inbox.enqueue('s1', queued('QUEUED-TEXT'))
  await inbox.notify?.('s1')
  await until('process A died', () => dead.v)
  expect(JSON.stringify(await messages.load({ sessionId: 's1' }))).not.toContain('QUEUED-TEXT')
  await sleep(400) // A's activeTurn and claims go stale
  const c = defineHarnessAgent({
    contextWindow: 100_000,
    logger: silent,
    onWarning() {},
    model,
    storage: { messages, state, inbox },
    recovery: { staleMs: 300 },
    inbox: { pollMs: 10 },
  })
  const session = c.session('s1')
  await until('the item is applied again', async () =>
    JSON.stringify(await messages.load({ sessionId: 's1' })).includes('QUEUED-TEXT'),
  )
  await session.idle()
  const users = (await messages.load({ sessionId: 's1' })).filter((m) => m.role === 'user')
  expect(users).toHaveLength(1)
  await c.close()
})

for (let round = 0; round < 3; round++) {
  test(`two live holders apply queued items in id order (round ${round})`, async () => {
    const messages = defaultMemoryMessages()
    const state = defaultMemoryState()
    const inbox = memoryInbox()
    const delayA = { v: 0 }
    const model = scriptedModel(Array.from({ length: 10 }, (_, i) => ({ text: `r${i}` })))
    const make = (store: typeof messages) =>
      defineHarnessAgent({
        contextWindow: 100_000,
        logger: silent,
        onWarning() {},
        model,
        storage: { messages: store, state, inbox },
        inbox: { pollMs: 5 },
      })
    const a = make(slow(messages, delayA))
    const b = make(messages)
    const sa = a.session('s1')
    const sb = b.session('s1')
    await sa.ready()
    await sb.ready()
    delayA.v = 40
    for (const text of ['m1', 'm2', 'm3']) await inbox.enqueue('s1', queued(text))
    await inbox.notify?.('s1')
    const users = async () =>
      (await messages.load({ sessionId: 's1' })).filter((m) => m.role === 'user')
    await until('all applied', async () => (await users()).length === 3, 5_000)
    await sa.idle()
    await sb.idle()
    const texts = (await users()).map((m) => (m.parts[0] as { text: string }).text)
    expect(texts).toEqual(['m1', 'm2', 'm3'])
    await a.close()
    await b.close()
  })
}
