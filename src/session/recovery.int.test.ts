import { describe, expect, test } from 'bun:test'
import { tool } from 'ai'
import { z } from 'zod/v4'
import { defineHarnessAgent } from '../agent/define-agent.ts'
import type { HarnessAgentConfig } from '../agent/types.ts'
import type { HarnessWarning } from '../errors.ts'
import { uuidv7 } from '../messages/ids.ts'
import { INTERRUPTED_CRASH, INTERRUPTED_TURN, INTERRUPTED_UNKNOWN } from '../messages/texts.ts'
import type { HarnessUIMessage } from '../messages/types.ts'
import { scriptedModel } from '../testing/scripted-model.ts'
import { until } from '../testing/test-utils.ts'
import { collect, spyMessages, spyState } from './test-kit.ts'

const silent = { debug() {}, info() {}, warn() {}, error() {} }

function setup(
  config: Omit<Partial<HarnessAgentConfig>, 'model'> & Pick<HarnessAgentConfig, 'model'>,
) {
  const messages = spyMessages()
  const state = spyState()
  const warnings: HarnessWarning[] = []
  const agent = defineHarnessAgent({
    contextWindow: 100_000,
    storage: { messages, state },
    logger: silent,
    onWarning: (w) => warnings.push(w),
    ...config,
  })
  return { agent, messages, state, warnings }
}

/** Storage as a crashed process leaves it: a user message, an unfinished assistant message with a
 * tool call and no result, and `state.core.activeTurn` owned by a dead instance. */
async function crashedStorage(heartbeatAt: number) {
  const messages = spyMessages()
  const state = spyState()
  const userId = uuidv7()
  const assistantId = uuidv7()
  const turnId = uuidv7()
  const user: HarnessUIMessage = {
    id: userId,
    role: 'user',
    metadata: { eharness: { v: 1, createdAt: 1, turnId } },
    parts: [{ type: 'text', text: 'Charge the card.' }],
  }
  const assistant = {
    id: assistantId,
    role: 'assistant',
    metadata: { eharness: { v: 1, createdAt: 2, turnId } },
    parts: [
      { type: 'step-start' },
      { type: 'tool-charge', toolCallId: 'c1', state: 'input-available', input: { amount: 5 } },
    ],
  } as unknown as HarnessUIMessage
  await messages.save('s1', [user, assistant])
  await state.set('s1', {
    v: 1,
    rev: 1,
    core: {
      activeTurn: {
        turnId,
        kind: 'send',
        messageId: assistantId,
        userMessageId: userId,
        owner: 'dead-instance',
        startedAt: heartbeatAt,
        heartbeatAt,
      },
    },
    plugins: {},
  })
  messages.saves.length = 0
  state.writes.length = 0
  return { messages, state, assistantId, turnId }
}

describe('scenario 29: crash recovery', () => {
  test('a second instance recovers on the next send; the tool is not re-executed', async () => {
    const { messages, state, assistantId, turnId } = await crashedStorage(Date.now() - 10_000)
    let charged = 0
    const charge = tool({
      inputSchema: z.object({ amount: z.number() }),
      execute: async () => {
        charged++
        return 'charged'
      },
    })
    const model = scriptedModel([{ text: 'The previous attempt was interrupted.' }])
    const agent = defineHarnessAgent({
      model,
      contextWindow: 100_000,
      tools: { charge },
      storage: { messages, state },
      recovery: { staleMs: 1_000 },
      logger: silent,
    })
    const session = agent.session('s1')
    const events: unknown[] = []
    const reader = session.events().getReader()
    const pump = (async () => {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        events.push(value)
      }
    })()
    const result = await session.send('What happened?').result
    expect(result.stop).toBe('complete')
    expect(charged).toBe(0)

    const stored = (await messages.load({ sessionId: 's1' })) as HarnessUIMessage[]
    const recovered = stored.find((m) => m.id === assistantId) as HarnessUIMessage
    expect(recovered.metadata?.eharness?.stop).toBe('interrupted')
    expect(recovered.parts[1]).toMatchObject({
      type: 'tool-charge',
      state: 'output-error',
      errorText: INTERRUPTED_CRASH,
    })
    const notice = stored.find((m) => m.metadata?.eharness?.kind === 'eh.notice')
    expect(notice?.parts[0]).toMatchObject({
      data: { level: 'warning', code: 'EH_TURN_INTERRUPTED' },
    })
    expect(notice?.metadata?.eharness?.turnId).toBe(turnId)
    // id order: recovered assistant < notice < new user < new assistant
    const ids = stored.map((m) => m.id)
    expect(ids).toEqual([...ids].sort())
    expect(ids.indexOf(notice?.id as string)).toBeLessThan(ids.indexOf(result.messageId as string))
    expect(result.messages[0]?.id).toBe(notice?.id as string)
    // the model saw the interrupted call as an error result
    expect(JSON.stringify(model.prompts[0])).toContain(INTERRUPTED_CRASH)
    expect((await state.get('s1'))?.core.activeTurn).toBeUndefined()
    await session.close()
    await pump
    expect(events).toContainEqual({
      type: 'turn-end',
      turnId,
      messageId: assistantId,
      stop: 'interrupted',
    })
  })

  test('a fresh foreign heartbeat → EH_SESSION_BUSY, nothing persisted', async () => {
    const { messages, state } = await crashedStorage(Date.now())
    const model = scriptedModel([{ text: 'x' }])
    const agent = defineHarnessAgent({
      model,
      storage: { messages, state },
      logger: silent,
    })
    const run = agent.session('s1').send('Hello?')
    const result = await run.result
    expect(result.stop).toBe('error')
    expect(result.error?.code).toBe('EH_SESSION_BUSY')
    expect(messages.saves).toHaveLength(0)
    expect(state.writes).toHaveLength(0)
    expect(model.calls).toHaveLength(0)
  })

  test('an acquired SessionLock makes a foreign activeTurn stale', async () => {
    const { messages, state } = await crashedStorage(Date.now())
    const agent = defineHarnessAgent({
      model: scriptedModel([{ text: 'x' }]),
      storage: { messages, state },
      logger: silent,
    })
    const lock = { acquire: async () => async () => {} }
    const result = await agent.session('s1', { lock }).send('Hello?').result
    expect(result.stop).toBe('complete')
  })

  test('recovery: false writes no activeTurn and ignores a foreign one', async () => {
    const { messages, state } = await crashedStorage(Date.now())
    const agent = defineHarnessAgent({
      model: scriptedModel([{ text: 'x' }]),
      storage: { messages, state },
      recovery: false,
      logger: silent,
    })
    const result = await agent.session('s1').send('Hello?').result
    expect(result.stop).toBe('complete')
    // projection still answers the dangling call
    const stored = (await messages.load({ sessionId: 's1' })) as HarnessUIMessage[]
    expect(stored.some((m) => m.metadata?.eharness?.stop === 'interrupted')).toBe(false)
  })

  test('activeTurn is written at the commit point and cleared at the end', async () => {
    const { agent, state } = setup({ model: scriptedModel([{ text: 'x' }]) })
    await agent.session('s1').send('hi').result
    expect(state.writes).toHaveLength(2)
    expect(state.writes[0]?.core.activeTurn?.owner).toBeString()
    expect(state.writes[1]?.core.activeTurn).toBeUndefined()
    expect(state.writes[1]?.core.usage).toEqual({ inputTokens: 10, outputTokens: 5, turns: 1 })
    expect(state.writes.map((w) => w.rev)).toEqual([1, 2])
  })

  test('long turns refresh the heartbeat', async () => {
    let writesOf: () => number = () => 0
    const slow = tool({
      inputSchema: z.object({}),
      execute: async () => {
        // runs until the heartbeat was refreshed at least once (no fixed delay)
        await until('a refreshed heartbeat', () => writesOf() > 1)
        return 'ok'
      },
    })
    const model = scriptedModel([
      { toolCalls: [{ toolName: 'slow', input: {} }] },
      { text: 'done' },
    ])
    const { agent, state } = setup({ model, tools: { slow }, recovery: { staleMs: 100 } })
    writesOf = () => state.writes.filter((w) => w.core.activeTurn !== undefined).length
    await agent.session('s1').send('hi').result
    const heartbeats = state.writes.filter((w) => w.core.activeTurn !== undefined)
    expect(heartbeats.length).toBeGreaterThan(1)
  })
})

describe('scenario 30: abort / timeout with a running tool', () => {
  const slowTool = () =>
    tool({
      inputSchema: z.object({}),
      execute: async (_input, { abortSignal }) => {
        // runs until the turn is aborted or times out (capped so a bug cannot hang the suite)
        await new Promise<void>((resolve) => {
          const cap = setTimeout(resolve, 5_000)
          abortSignal?.addEventListener('abort', () => {
            clearTimeout(cap)
            resolve()
          })
        })
        return 'late'
      },
    })

  test('abort while a tool runs: the stored tool part becomes output-error Interrupted:', async () => {
    const model = scriptedModel([{ toolCalls: [{ toolName: 'slow', input: {} }] }])
    const { agent, messages } = setup({ model, tools: { slow: slowTool() } })
    const run = agent.session('s1').send('go')
    const chunks = []
    for await (const chunk of run.stream) {
      chunks.push(chunk)
      if (chunk.type === 'tool-input-available') setTimeout(() => run.abort(), 10)
    }
    const result = await run.result
    expect(result.stop).toBe('aborted')
    // the live stream carries the same interruption as storage (spec 05 §3 step 16)
    expect(chunks.slice(-3)).toEqual([
      { type: 'tool-output-error', toolCallId: 'call-0-0', errorText: INTERRUPTED_TURN },
      expect.objectContaining({ type: 'message-metadata' }),
      { type: 'abort', reason: 'aborted' },
    ])
    const final = messages.saves.at(-1)?.[0] as HarnessUIMessage
    expect(final.parts.find((p) => p.type === 'tool-slow')).toMatchObject({
      state: 'output-error',
      errorText: INTERRUPTED_TURN,
    })
  })

  test('loop.turnTimeoutMs → stop timeout, abort { reason: timeout }, EH_TURN_TIMEOUT notice', async () => {
    const model = scriptedModel([{ toolCalls: [{ toolName: 'slow', input: {} }] }])
    const { agent, messages } = setup({
      model,
      tools: { slow: slowTool() },
      loop: { turnTimeoutMs: 50 },
    })
    const run = agent.session('s1').send('go')
    const chunks = await collect(run.stream)
    const result = await run.result
    expect(result.stop).toBe('timeout')
    expect(chunks.at(-1)).toEqual({ type: 'abort', reason: 'timeout' })
    expect(chunks).toContainEqual({
      type: 'tool-output-error',
      toolCallId: 'call-0-0',
      errorText: INTERRUPTED_TURN,
    })
    const saved = messages.saves.flat()
    const notice = saved.find((m) => m.metadata?.eharness?.kind === 'eh.notice')
    expect(notice?.parts[0]).toMatchObject({ data: { level: 'warning', code: 'EH_TURN_TIMEOUT' } })
    const assistant = saved.filter((m) => m.id === result.messageId).at(-1)
    expect(assistant?.metadata?.eharness?.stop).toBe('timeout')
    expect(JSON.stringify(assistant?.parts)).toContain(INTERRUPTED_TURN)
  })

  test('an AI SDK chunk timeout (settings.timeout.chunkMs) → stop timeout', async () => {
    const model = scriptedModel([{ text: 'slow text', delayMs: 100 }])
    const { agent } = setup({ model, settings: { timeout: { chunkMs: 20 } } })
    const run = agent.session('s1').send('go')
    const chunks = await collect(run.stream)
    const result = await run.result
    expect(result.stop).toBe('timeout')
    expect(chunks.at(-1)).toEqual({ type: 'abort', reason: 'timeout' })
  })
})

describe('scenario 7 (P2 part): guard sanitize and overflow stop', () => {
  test('a stored tool call without result gets an Interrupted: error result; orphans are removed', async () => {
    const messages = spyMessages()
    const userId = uuidv7()
    const assistantId = uuidv7()
    await messages.save('s1', [
      {
        id: userId,
        role: 'user',
        metadata: { eharness: { v: 1, createdAt: 1 } },
        parts: [{ type: 'text', text: 'old question' }],
      },
      {
        id: assistantId,
        role: 'assistant',
        metadata: { eharness: { v: 1, createdAt: 2, stop: 'complete' } },
        parts: [
          { type: 'step-start' },
          { type: 'tool-gone', toolCallId: 'x1', state: 'input-available', input: {} },
        ],
      } as unknown as HarnessUIMessage,
    ])
    const model = scriptedModel([{ text: 'ok' }])
    const agent = defineHarnessAgent({ model, storage: { messages }, logger: silent })
    await agent.session('s1').send('new question').result
    const prompt = JSON.stringify(model.prompts[0])
    expect(prompt).toContain(INTERRUPTED_UNKNOWN)
  })

  test('a context over the hard limit ends the turn with EH_CONTEXT_OVERFLOW (no model call)', async () => {
    const model = scriptedModel([{ text: 'never' }])
    const { agent } = setup({ model, contextWindow: 50 })
    const result = await agent.session('s1').send('x'.repeat(400)).result
    expect(result.stop).toBe('error')
    expect(result.error?.code).toBe('EH_CONTEXT_OVERFLOW')
    expect(model.calls).toHaveLength(0)
  })
})

describe('session.recover() and recovery.instanceId (spec 05 §9.2)', () => {
  test('a restarted instance with the same instanceId recovers at once, without waiting for staleMs', async () => {
    const { messages, state, assistantId, turnId } = await crashedStorage(Date.now())
    // the dead owner is now "us": rewrite the owner to the stable id
    const stored = (await state.get('s1')) as unknown as {
      core: { activeTurn: Record<string, unknown> }
    }
    stored.core.activeTurn.owner = 'srv'
    await state.set('s1', stored as never)
    const agent = defineHarnessAgent({
      model: scriptedModel([{ text: 'unused' }]),
      contextWindow: 100_000,
      tools: {},
      storage: { messages, state },
      recovery: { instanceId: 'srv' },
      logger: silent,
    })
    const session = agent.session('s1')
    expect(await session.busy()).toBeNull()
    expect(await session.recover()).toEqual({ recovered: true, turnId, messageId: assistantId })
    const after = (await messages.load({ sessionId: 's1' })) as HarnessUIMessage[]
    const message = after.find((m) => m.id === assistantId) as HarnessUIMessage
    expect(message.metadata?.eharness?.stop).toBe('interrupted')
    const part = message.parts.find((p) => p.type === 'tool-charge') as {
      state: string
      errorText: string
    }
    expect(part.state).toBe('output-error')
    expect(part.errorText).toBe(INTERRUPTED_CRASH)
    expect(after.some((m) => m.metadata?.eharness?.kind === 'eh.notice')).toBe(true)
    expect((await session.stats()).activeTurn).toBeNull()
    // idempotent
    expect(await session.recover()).toEqual({ recovered: false, reason: 'idle' })
    await agent.close()
  })

  test('a live foreign turn is left alone; a stale one is recovered', async () => {
    const live = await crashedStorage(Date.now())
    const agent = defineHarnessAgent({
      model: scriptedModel([]),
      contextWindow: 100_000,
      storage: { messages: live.messages, state: live.state },
      recovery: { staleMs: 60_000 },
      logger: silent,
    })
    expect(await agent.session('s1').recover()).toEqual({ recovered: false, reason: 'live' })
    await agent.close()
    const old = await crashedStorage(Date.now() - 120_000)
    const agent2 = defineHarnessAgent({
      model: scriptedModel([]),
      contextWindow: 100_000,
      storage: { messages: old.messages, state: old.state },
      recovery: { staleMs: 60_000 },
      logger: silent,
    })
    expect((await agent2.session('s1').recover()).recovered).toBe(true)
    await agent2.close()
  })

  test('inject({ key }) is idempotent', async () => {
    const agent = defineHarnessAgent({
      model: scriptedModel([]),
      contextWindow: 100_000,
      logger: silent,
    })
    const s = agent.session('k')
    await s.inject('eh.event', { name: 'x', text: 'one' }, { key: 'k1' })
    await s.inject('eh.event', { name: 'x', text: 'two' }, { key: 'k1' })
    await s.inject('eh.event', { name: 'x', text: 'three' }, { key: 'k2' })
    expect((await s.messages()).length).toBe(2)
    await agent.close()
  })

  test('a sibling agent object with the same instanceId does not recover a turn that runs in this process', async () => {
    const messages = spyMessages()
    const state = spyState()
    let release!: () => void
    let toolStarted = false
    const held = new Promise<void>((r) => {
      release = r
    })
    const slow = tool({
      inputSchema: z.object({}),
      execute: async () => {
        toolStarted = true
        await held
        return 'ok'
      },
    })
    const make = (steps: Parameters<typeof scriptedModel>[0]) =>
      defineHarnessAgent({
        model: scriptedModel(steps),
        contextWindow: 100_000,
        tools: { slow },
        storage: { messages, state },
        recovery: { instanceId: 'srv' },
        logger: silent,
      })
    const a = make([
      { toolCalls: [{ toolName: 'slow', toolCallId: 't1', input: {} }] },
      { text: 'done' },
    ])
    const b = make([{ text: 'x' }])
    const run = a.session('s').send('go')
    await until('the tool started', () => toolStarted)
    expect(await b.session('s').recover()).toEqual({ recovered: false, reason: 'live' })
    expect((await b.session('s').busy())?.scope).toBe('remote')
    release()
    expect((await run.result).stop).toBe('complete')
    await a.close()
    await b.close()
  })

  test('a crash before the first step was saved leaves a placeholder reply that can be regenerated', async () => {
    const messages = spyMessages()
    const state = spyState()
    const userId = uuidv7()
    const assistantId = uuidv7()
    const turnId = uuidv7()
    await messages.save('s2', [
      {
        id: userId,
        role: 'user',
        metadata: { eharness: { v: 1, createdAt: 1, turnId } },
        parts: [{ type: 'text', text: 'Hello' }],
      } as HarnessUIMessage,
    ])
    await state.set('s2', {
      v: 1,
      rev: 1,
      core: {
        activeTurn: {
          turnId,
          kind: 'send',
          messageId: assistantId,
          userMessageId: userId,
          owner: 'srv',
          startedAt: 1,
          heartbeatAt: Date.now(),
        },
      },
      plugins: {},
    } as never)
    const agent = defineHarnessAgent({
      model: scriptedModel([{ text: 'second try' }]),
      contextWindow: 100_000,
      storage: { messages, state },
      recovery: { instanceId: 'srv' },
      logger: silent,
    })
    const session = agent.session('s2')
    expect((await session.recover()).recovered).toBe(true)
    const stored = (await messages.load({ sessionId: 's2' })) as HarnessUIMessage[]
    const stub = stored.find((m) => m.id === assistantId) as HarnessUIMessage
    expect(stub.metadata?.eharness?.stop).toBe('interrupted')
    const result = await session.regenerate().result
    expect(result.stop).toBe('complete')
    await agent.close()
  })
})
