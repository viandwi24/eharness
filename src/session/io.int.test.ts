import { describe, expect, test } from 'bun:test'
import { tool, type UIMessageChunk } from 'ai'
import { z } from 'zod/v4'
import { defineHarnessAgent } from '../agent/define-agent.ts'
import type { SessionEvent } from '../agent/session-types.ts'
import type { HarnessAgentConfig } from '../agent/types.ts'
import { type HarnessWarning, isHarnessError } from '../errors.ts'
import { defineDataPart } from '../messages/data-parts.ts'
import { createUuidV7Generator } from '../messages/ids.ts'
import type { HarnessUIMessage } from '../messages/types.ts'
import { definePlugin } from '../plugin/define-plugin.ts'
import { scriptedModel } from '../testing/scripted-model.ts'
import { collect, spyMessages, spyState } from './int-kit.ts'

const silent = { debug() {}, info() {}, warn() {}, error() {} }

function setup(config: Partial<HarnessAgentConfig> & Pick<HarnessAgentConfig, 'model'>) {
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

function reader<T>(stream: ReadableStream<unknown>) {
  const items: T[] = []
  const r = stream.getReader()
  const done = (async () => {
    while (true) {
      const { done: end, value } = await r.read()
      if (end) break
      items.push(value as T)
    }
  })()
  return { items, done, cancel: () => r.cancel() }
}

describe('scenario 11: data parts', () => {
  const progress = defineDataPart({ schema: z.object({ n: z.number() }), transient: true })
  const report = defineDataPart({ schema: z.object({ text: z.string() }) })

  test('transient parts are streamed, never persisted; persistent parts are reconciled by id', async () => {
    const plugin = definePlugin({
      name: 'rep',
      dataParts: { progress, report },
      setup: () => ({
        hooks: {
          'turn.start': (ctx) => {
            ctx.stream.data('progress', { n: 1 })
            ctx.stream.data('report', { text: 'v1' }, { id: 'r' })
            ctx.stream.data('report', { text: 'v2' }, { id: 'r' })
          },
        },
      }),
    })
    const { agent, messages } = setup({ model: scriptedModel([{ text: 'ok' }]), plugins: [plugin] })
    const run = agent.session('s1').send('go')
    const chunks = await collect(run.stream)
    const result = await run.result
    expect(chunks.filter((c) => c.type === 'data-rep.progress')).toEqual([
      { type: 'data-rep.progress', data: { n: 1 }, transient: true },
    ])
    const final = messages.saves.at(-1)?.[0] as HarnessUIMessage
    const parts = final.parts as unknown as Array<{ type: string; id?: string; data?: unknown }>
    expect(parts.filter((p) => p.type === 'data-rep.progress')).toHaveLength(0)
    expect(parts.filter((p) => p.type === 'data-rep.report')).toEqual([
      { type: 'data-rep.report', id: 'r', data: { text: 'v2' } },
    ])
    expect(result.stop).toBe('complete')
  })

  test('misuse warnings: unknown part, transient override, persistent write outside a turn', async () => {
    let ctxRef:
      | Parameters<NonNullable<Parameters<typeof definePlugin>[0]['session']>>[0]
      | undefined
    const plugin = definePlugin({
      name: 'rep',
      dataParts: { progress, report },
      session: (ctx) => {
        ctxRef = ctx
      },
      setup: () => ({
        hooks: {
          'turn.start': (ctx) => {
            ctx.stream.write({ type: 'data-nope', data: {} })
            ctx.stream.data('progress', { n: 1 }, { transient: false })
          },
        },
      }),
    })
    const { agent, warnings } = setup({ model: scriptedModel([{ text: 'ok' }]), plugins: [plugin] })
    const session = agent.session('s1')
    const run = session.send('go')
    const chunks = await collect(run.stream)
    await run.result
    expect(chunks.some((c) => c.type === 'data-nope')).toBe(false)
    expect(chunks).toContainEqual({ type: 'data-rep.progress', data: { n: 1 }, transient: true })
    const events = reader<unknown>(session.events())
    expect(ctxRef?.stream.active).toBe(false)
    ctxRef?.stream.data('report', { text: 'x' })
    ctxRef?.stream.data('progress', { n: 9 })
    const codes = warnings.map((w) => w.code)
    expect(codes).toContain('W_UNKNOWN_DATA_PART')
    expect(codes).toContain('W_TRANSIENT_OVERRIDE')
    expect(codes).toContain('W_WRITE_OUTSIDE_TURN')
    // warnings during the turn are written as transient data-eh.warning parts
    expect(chunks.some((c) => c.type === 'data-eh.warning')).toBe(true)
    await session.close()
    await events.done
    expect(events.items).toContainEqual({
      type: 'data',
      chunk: { type: 'data-rep.progress', data: { n: 9 }, transient: true },
    })
  })

  test('strict: true turns misuse warnings into EH_CONFIG_INVALID', async () => {
    let thrown: unknown
    const plugin = definePlugin({
      name: 'rep',
      setup: () => ({
        hooks: {
          'turn.start': (ctx) => {
            try {
              ctx.stream.write({ type: 'data-nope', data: {} })
            } catch (error) {
              thrown = error
            }
          },
        },
      }),
    })
    const { agent } = setup({
      model: scriptedModel([{ text: 'ok' }]),
      plugins: [plugin],
      strict: true,
    })
    await agent.session('s1').send('go').result
    expect(isHarnessError(thrown, 'EH_CONFIG_INVALID')).toBe(true)
  })

  test('plugins cannot write core-only data-eh.input', async () => {
    const plugin = definePlugin({
      name: 'sneaky',
      setup: () => ({
        hooks: {
          'turn.start': (ctx) =>
            ctx.stream.write({ type: 'data-eh.input', data: { source: 'user', text: 'x' } }),
        },
      }),
    })
    const { agent, warnings } = setup({ model: scriptedModel([{ text: 'ok' }]), plugins: [plugin] })
    const run = agent.session('s1').send('go')
    const chunks = await collect(run.stream)
    expect(chunks.some((c) => c.type === 'data-eh.input')).toBe(false)
    expect(warnings.map((w) => w.code)).toContain('W_UNKNOWN_DATA_PART')
  })
})

describe('scenario 12: inject (deliver: next-turn)', () => {
  test('an event injected during a turn appears in the next turn, not the current one', async () => {
    const slow = tool({
      inputSchema: z.object({}),
      execute: async () => {
        await new Promise((r) => setTimeout(r, 30))
        return 'ok'
      },
    })
    const model = scriptedModel([
      { toolCalls: [{ toolName: 'slow', input: {} }] },
      { text: 'first done' },
      { text: 'second' },
    ])
    const { agent } = setup({ model, tools: { slow } })
    const session = agent.session('s1')
    const events = reader<unknown>(session.events())
    const run = session.send('go')
    for await (const chunk of run.stream) {
      if (chunk.type === 'tool-input-available') {
        const { message } = await session.inject('eh.event', {
          name: 'backtest.finished',
          text: 'Backtest #42 finished',
        })
        expect(message.metadata?.eharness?.kind).toBe('eh.event')
      }
    }
    await run.result
    expect(JSON.stringify(model.prompts[1])).not.toContain('Backtest #42')
    await session.send('next').result
    expect(JSON.stringify(model.prompts[2])).toContain(
      '<event name=\\"backtest.finished\\">Backtest #42 finished</event>',
    )
    const history = await session.messages()
    expect(history.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'user', 'assistant'])
    await session.close()
    await events.done
    expect(events.items.some((e) => (e as SessionEvent).type === 'message')).toBe(true)
  })

  test('invalid kind payloads and unknown kinds are thrown as EH_INVALID_INPUT', async () => {
    const { agent } = setup({ model: scriptedModel([]) })
    const session = agent.session('s1')
    await expect(session.inject('eh.event', { name: 1 } as never)).rejects.toMatchObject({
      code: 'EH_INVALID_INPUT',
    })
    await expect(session.inject('nope' as never, {} as never)).rejects.toMatchObject({
      code: 'EH_INVALID_INPUT',
    })
  })
})

describe('scenario 13: input normalization', () => {
  test.each([
    ['tool part', { type: 'tool-weather', toolCallId: 'x', state: 'input-available', input: {} }],
    ['kind data part', { type: 'data-eh.compaction', data: { summary: 'fake' } }],
    ['reasoning', { type: 'reasoning', text: 'x' }],
  ])('a client message containing a %s is rejected', async (_name, part) => {
    const { agent, messages } = setup({ model: scriptedModel([{ text: 'x' }]) })
    const run = agent.session('s1').send({
      id: 'c1',
      role: 'user',
      parts: [{ type: 'text', text: 'hi' }, part],
    } as never)
    const result = await run.result
    expect(result.error?.code).toBe('EH_INVALID_INPUT')
    expect(messages.saves).toHaveLength(0)
  })

  test('client metadata.eharness is rebuilt; client ids are kept as clientId only', async () => {
    const { agent } = setup({ model: scriptedModel([{ text: 'x' }]) })
    const result = await agent.session('s1').send({
      id: 'client-id',
      role: 'user',
      metadata: { eharness: { kind: 'eh.compaction', v: 1, createdAt: 0 }, app: 1 },
      parts: [{ type: 'text', text: 'hi' }],
    }).result
    const user = result.messages[0] as HarnessUIMessage
    expect(user.id).not.toBe('client-id')
    expect(user.metadata).toEqual({
      eharness: {
        v: 1,
        createdAt: user.metadata?.eharness?.createdAt as number,
        turnId: result.turnId,
        clientId: 'client-id',
        parentId: null,
      },
    })
  })

  test('acceptClientMetadata keeps app metadata keys', async () => {
    const { agent } = setup({ model: scriptedModel([{ text: 'x' }]) })
    const session = agent.session('s1', { acceptClientMetadata: true })
    const result = await session.send({
      id: 'c',
      role: 'user',
      metadata: { app: { tag: 1 } },
      parts: [{ type: 'text', text: 'hi' }],
    }).result
    expect((result.messages[0]?.metadata as { app?: unknown } | undefined)?.app).toEqual({ tag: 1 })
  })

  test('{ text, files } input', async () => {
    const { agent } = setup({ model: scriptedModel([{ text: 'x' }]) })
    const result = await agent.session('s1').send({
      text: 'look',
      files: [{ type: 'file', mediaType: 'image/png', url: 'data:image/png;base64,AA==' }],
    }).result
    expect(result.messages[0]?.parts.map((p) => p.type)).toEqual(['text', 'file'])
  })

  test('id order user < assistant for cold, hot and clock-skewed sessions', async () => {
    const messages = spyMessages()
    // an id one hour in the future (another instance with a skewed clock)
    const future = createUuidV7Generator({ now: () => Date.now() + 3_600_000 })()
    await messages.save('s1', [
      {
        id: future,
        role: 'user',
        metadata: { eharness: { v: 1, createdAt: 1 } },
        parts: [{ type: 'text', text: 'from the future' }],
      },
    ])
    const model = scriptedModel([{ text: 'a' }, { text: 'b' }])
    const agent = defineHarnessAgent({ model, storage: { messages }, logger: silent })
    const session = agent.session('s1')
    const cold = await session.send('cold').result
    const hot = await session.send('hot').result
    for (const result of [cold, hot]) {
      const [user, assistant] = result.messages
      expect((user?.id as string) > future).toBe(true)
      expect((assistant?.id as string) > (user?.id as string)).toBe(true)
    }
    expect((hot.messages[0]?.id as string) > (cold.messages[1]?.id as string)).toBe(true)
  })
})

describe('scenario 33: prompt layout and caching', () => {
  test('two stable system blocks, reminders only on the wire, stable toolOrder', async () => {
    let clock = 0
    const b = tool({ description: 'b', inputSchema: z.object({}), execute: async () => 'b' })
    const a = tool({ description: 'a', inputSchema: z.object({}), execute: async () => 'a' })
    const plugin = definePlugin({
      name: 'hints',
      setup: () => ({
        hooks: { 'step.prepare': (_ctx, e) => ({ reminder: `step ${e.stepIndex}` }) },
      }),
    })
    const model = scriptedModel([{ text: '1' }, { text: '2' }, { text: '3' }])
    const { agent, messages } = setup({
      model,
      tools: { b, a },
      plugins: [plugin],
      instructions: [
        'Static rules.',
        () => 'Session context.',
        { text: () => `Turn clock ${++clock}`, refresh: 'turn' },
      ],
    })
    const session = agent.session('s1')
    const streams: UIMessageChunk[][] = []
    for (const text of ['one', 'two', 'three']) {
      const run = session.send(text)
      streams.push(await collect(run.stream))
      await run.result
    }
    const systems = model.prompts.map((p) => p.filter((m) => m.role === 'system'))
    expect(systems[0]).toEqual([
      { role: 'system', content: 'Static rules.' },
      { role: 'system', content: 'Session context.' },
    ])
    expect(systems[1]).toEqual(systems[0] as never)
    expect(systems[2]).toEqual(systems[0] as never)
    // turn reminder directly before the current turn's user message, step reminder at the end
    const third = model.prompts[2] as Array<{ role: string; content: unknown }>
    const texts = third.map((m) =>
      m.role === 'system' ? 'system' : JSON.stringify(m.content).slice(0, 60),
    )
    expect(texts.at(-3)).toContain('Turn clock 3')
    expect(texts.at(-2)).toContain('three')
    expect(texts.at(-1)).toContain('step 0')
    expect(JSON.stringify(third)).not.toContain('Turn clock 2')
    // never stored, never streamed
    expect(JSON.stringify(messages.saves)).not.toContain('system-reminder')
    expect(JSON.stringify(streams)).not.toContain('system-reminder')
    // stable tool order: declaration order, not alphabetical
    expect(model.calls.map((c) => c.tools?.map((t) => t.name))).toEqual([
      ['b', 'a'],
      ['b', 'a'],
      ['b', 'a'],
    ])
  })

  test('cacheControl only for Anthropic models; auto = call level, breakpoints = explicit', async () => {
    const t = tool({ inputSchema: z.object({}), execute: async () => 'x' })
    const anthropic = scriptedModel([{ text: 'x' }], { provider: 'anthropic.messages' })
    const auto = setup({ model: anthropic, instructions: 'S', tools: { t } })
    await auto.agent.session('s1').send('hi').result
    expect(anthropic.calls[0]?.providerOptions).toEqual({
      anthropic: { cacheControl: { type: 'ephemeral' } },
    })

    const openai = scriptedModel([{ text: 'x' }], { provider: 'openai.chat' })
    const other = setup({ model: openai, instructions: 'S', tools: { t } })
    await other.agent.session('s1').send('hi').result
    expect(JSON.stringify(openai.calls[0])).not.toContain('cacheControl')

    const bp = scriptedModel([{ text: 'x' }], { provider: 'anthropic.messages' })
    const breakpoints = setup({
      model: bp,
      instructions: 'S',
      tools: { t },
      cache: { mode: 'breakpoints', ttl: '1h' },
    })
    await breakpoints.agent.session('s1').send('hi').result
    const call = bp.calls[0]
    const control = { anthropic: { cacheControl: { type: 'ephemeral', ttl: '1h' } } }
    expect(call?.providerOptions).toBeUndefined()
    expect(call?.prompt[0]?.providerOptions).toEqual(control)
    expect(call?.prompt.at(-1)?.providerOptions).toEqual(control)
    expect(
      (call?.tools?.[0] as { providerOptions?: unknown } | undefined)?.providerOptions,
    ).toEqual(control)

    const off = scriptedModel([{ text: 'x' }], { provider: 'anthropic.messages' })
    const disabled = setup({ model: off, instructions: 'S', cache: false })
    await disabled.agent.session('s1').send('hi').result
    expect(JSON.stringify(off.calls[0])).not.toContain('cacheControl')
  })

  test('usage cache fields are recorded in metadata', async () => {
    const model = scriptedModel([
      { text: 'x', usage: { inputTokens: 100, cacheReadTokens: 80, cacheWriteTokens: 10 } },
    ])
    const { agent } = setup({ model })
    const result = await agent.session('s1').send('hi').result
    expect(result.usage).toMatchObject({ cachedInputTokens: 80, cacheWriteTokens: 10 })
    const assistant = result.messages.find((m) => m.id === result.messageId)
    expect(assistant?.metadata?.eharness?.usage).toMatchObject({
      cachedInputTokens: 80,
      cacheWriteTokens: 10,
    })
  })

  test('changing active tools between steps warns W_CACHE_BUST once per turn', async () => {
    const t1 = tool({ inputSchema: z.object({}), execute: async () => 'x' })
    const t2 = tool({ inputSchema: z.object({}), execute: async () => 'y' })
    const plugin = definePlugin({
      name: 'narrow',
      setup: () => ({
        hooks: {
          'step.prepare': (_ctx, e) => (e.stepIndex === 0 ? undefined : { activeTools: ['t2'] }),
        },
      }),
    })
    const model = scriptedModel([
      { toolCalls: [{ toolName: 't1', input: {} }] },
      { toolCalls: [{ toolName: 't2', input: {} }] },
      { text: 'done' },
    ])
    const { agent, warnings } = setup({ model, tools: { t1, t2 }, plugins: [plugin] })
    await agent.session('s1').send('go').result
    expect(warnings.filter((w) => w.code === 'W_CACHE_BUST')).toHaveLength(1)
    expect(model.calls[1]?.tools?.map((t) => t.name)).toEqual(['t2'])
  })
})

describe('session API', () => {
  test('messages() pages history; stats() reports estimates, pending and activeTurn', async () => {
    const { agent, warnings } = setup({
      model: scriptedModel([{ text: 'a' }, { text: 'b' }]),
      contextWindow: undefined,
    })
    const session = agent.session('s1')
    await session.send('one').result
    await session.send('two').result
    const all = await session.messages()
    expect(all.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
    const page = await session.messages({ beforeId: all[2]?.id as string, limit: 1 })
    expect(page.map((m) => m.id)).toEqual([all[1]?.id as string])
    const stats = await session.stats()
    expect(stats.window).toBe(128_000)
    expect(stats.tokens).toBeGreaterThan(0)
    expect(stats.pending).toBeNull()
    expect(stats.activeTurn).toBeNull()
    expect(warnings.map((w) => w.code)).toContain('W_DEFAULT_CONTEXT_WINDOW')
  })

  test('events(): turn-start, status and turn-end', async () => {
    const { agent } = setup({ model: scriptedModel([{ text: 'a' }]) })
    const session = agent.session('s1')
    const events = reader<unknown>(session.events())
    const run = session.send('go')
    await run.result
    await session.close()
    await events.done
    expect(events.items.map((e) => (e as SessionEvent).type)).toEqual([
      'status',
      'turn-start',
      'turn-end',
      'status',
    ])
    expect(events.items[2]).toMatchObject({ type: 'turn-end', stop: 'complete' })
  })

  test('agent.session() returns the cached session; closeSession evicts it', async () => {
    const { agent, warnings } = setup({ model: scriptedModel([]) })
    const first = agent.session('s1', { runtime: { a: 1 } })
    expect(agent.session('s1', { runtime: { a: 2 } })).toBe(first)
    agent.session('s1', { onInvalidMessage: 'throw' })
    expect(warnings.map((w) => w.code)).toContain('W_SESSION_OPTIONS_IGNORED')
    await agent.closeSession('s1')
    expect(() => first.send('x')).toThrow()
    expect(agent.session('s1')).not.toBe(first)
    await agent.close()
  })

  test('idle eviction closes the session; held references throw EH_SESSION_CLOSED', async () => {
    const { agent } = setup({ model: scriptedModel([{ text: 'a' }]), sessionIdleMs: 20 })
    const session = agent.session('s1')
    await session.send('go').result
    await new Promise((r) => setTimeout(r, 60))
    let error: unknown
    try {
      session.send('again')
    } catch (e) {
      error = e
    }
    expect(isHarnessError(error, 'EH_SESSION_CLOSED')).toBe(true)
  })

  test('P3/P7 operations are not implemented yet (run error / rejection, never a crash)', async () => {
    const { agent } = setup({ model: scriptedModel([]) })
    const session = agent.session('s1')
    const respond = await session.respond({}).result
    expect(respond.error?.code).toBe('EH_NOT_IMPLEMENTED')
    await expect(session.compact()).rejects.toMatchObject({ code: 'EH_NOT_IMPLEMENTED' })
    await session.clearGrants()
  })
})
