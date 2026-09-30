import { describe, expect, test } from 'bun:test'
import { APICallError, tool, type UIMessageChunk } from 'ai'
import { z } from 'zod/v4'
import { defineHarnessAgent } from '../agent/define-agent.ts'
import type { HarnessAgentConfig } from '../agent/types.ts'
import { isHarnessError } from '../errors.ts'
import { defineDataPart } from '../messages/data-parts.ts'
import type { HarnessUIMessage } from '../messages/types.ts'
import { definePlugin } from '../plugin/define-plugin.ts'
import { scriptedModel } from '../testing/scripted-model.ts'
import { chunkTypes, collect, normalizeVolatile, spyMessages, spyState } from './int-kit.ts'

const weather = tool({
  description: 'Weather for a city',
  inputSchema: z.object({ city: z.string() }),
  execute: async ({ city }) => ({ city, temp: 20 }),
})

function twoStepModel() {
  return scriptedModel([
    { toolCalls: [{ toolName: 'weather', input: { city: 'Oslo' } }] },
    { text: 'It is 20 degrees.', usage: { inputTokens: 30, outputTokens: 7 } },
  ])
}

function makeAgent(config: Partial<HarnessAgentConfig> = {}) {
  const messages = spyMessages()
  const state = spyState()
  const agent = defineHarnessAgent({
    model: twoStepModel(),
    contextWindow: 100_000,
    instructions: 'You are helpful.',
    tools: { weather },
    storage: { messages, state },
    ...config,
  })
  return { agent, messages, state }
}

async function expectGolden(name: string, value: unknown): Promise<void> {
  const file = Bun.file(new URL(`./__golden__/${name}.json`, import.meta.url))
  const actual = JSON.parse(JSON.stringify(value))
  if (process.env.UPDATE_GOLDEN === '1') {
    await Bun.write(file, `${JSON.stringify(actual, null, 2)}\n`)
    return
  }
  if (!(await file.exists())) throw new Error(`missing golden ${name}.json (UPDATE_GOLDEN=1)`)
  expect(actual).toEqual(await file.json())
}

describe('scenario 1: two-step turn (tool call → answer)', () => {
  test('exact chunk order (golden), three saves of one assistant id, final metadata', async () => {
    const { agent, messages } = makeAgent()
    const run = agent.session('s1').send('Weather in Oslo?')
    const chunks = await collect(run.stream)
    const result = await run.result
    await expectGolden('two-step-turn.chunks', normalizeVolatile(chunks))

    expect(result.stop).toBe('complete')
    expect(result.steps).toBe(2)
    expect(result.usage).toEqual({ inputTokens: 40, outputTokens: 12, totalTokens: 52 })
    const assistantId = await run.messageId
    expect(result.messageId).toBe(assistantId)

    // user once, then the assistant message 3 times (step 0, step 1, final) with the same id
    const saved = messages.saves.map((batch) => batch.map((m) => m.id))
    expect(saved).toHaveLength(4)
    expect(saved.slice(1)).toEqual([[assistantId], [assistantId], [assistantId]])
    const final = messages.saves[3]?.[0] as HarnessUIMessage
    expect(final.metadata?.eharness).toMatchObject({
      v: 1,
      model: 'mock/scripted',
      usage: { inputTokens: 40, outputTokens: 12, totalTokens: 52 },
      stop: 'complete',
      steps: 2,
    })
    expect(typeof final.metadata?.eharness?.durationMs).toBe('number')
    expect(messages.saves[1]?.[0]?.metadata?.eharness?.stop).toBeUndefined()
  })

  test('the golden chunk sequence is stable over 100 runs', async () => {
    const file = Bun.file(new URL('./__golden__/two-step-turn.chunks.json', import.meta.url))
    const golden = await file.json()
    for (let i = 0; i < 100; i++) {
      const { agent } = makeAgent()
      const run = agent.session(`s${i}`).send('Weather in Oslo?')
      const chunks = await collect(run.stream)
      await run.result
      expect(normalizeVolatile(chunks)).toEqual(golden)
    }
  })

  test('run.result resolves even when nobody reads run.stream', async () => {
    const { agent, messages } = makeAgent()
    const result = await agent.session('s1').send('Weather in Oslo?').result
    expect(result.stop).toBe('complete')
    expect(messages.saves).toHaveLength(4)
  })

  test('toResponse() serves the stream as SSE', async () => {
    const { agent } = makeAgent()
    const response = agent.session('s1').send('Weather in Oslo?').toResponse()
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    const text = await response.text()
    expect(text).toContain('"type":"finish"')
  })
})

describe('scenario 2: reload round-trip', () => {
  test('a new agent on the same adapters reproduces history and the next wire', async () => {
    const messages = spyMessages()
    const state = spyState()
    const base = {
      contextWindow: 100_000,
      instructions: 'You are helpful.',
      tools: { weather },
      storage: { messages, state },
    }
    const hotModel = scriptedModel([
      { toolCalls: [{ toolName: 'weather', input: { city: 'Oslo' } }] },
      { text: 'It is 20 degrees.' },
      { text: 'Second answer.' },
    ])
    const hot = defineHarnessAgent({ ...base, model: hotModel })
    const session = hot.session('s1')
    await session.send('Weather in Oslo?').result

    // copy the storage as it is between turn 1 and turn 2
    const copyMessages = spyMessages()
    const copyState = spyState()
    await copyMessages.save('s1', await messages.load({ sessionId: 's1' }))
    const snapshot = await state.get('s1')
    if (snapshot !== null) await copyState.set('s1', snapshot)

    const hotSecond = await session.send('And tomorrow?').result
    expect(hotSecond.stop).toBe('complete')

    const coldModel = scriptedModel([{ text: 'Second answer.' }])
    const cold = defineHarnessAgent({
      ...base,
      model: coldModel,
      storage: { messages: copyMessages, state: copyState },
    })
    const coldSession = cold.session('s1')
    const history = await coldSession.messages()
    expect(history as unknown[]).toEqual(await copyMessages.load({ sessionId: 's1' }))
    const coldSecond = await coldSession.send('And tomorrow?').result
    expect(coldSecond.stop).toBe('complete')
    expect(JSON.parse(JSON.stringify(coldModel.prompts[0]))).toEqual(
      JSON.parse(JSON.stringify(hotModel.prompts[2])),
    )
  })
})

describe('scenario 3: abort mid-step', () => {
  test('partial assistant saved with stop aborted; stream ends with abort', async () => {
    const model = scriptedModel([
      {
        parts: [
          { type: 'stream-start', warnings: [] },
          { type: 'text-start', id: 't' },
          { type: 'text-delta', id: 't', delta: 'Partial' },
          { type: 'text-delta', id: 't', delta: ' answer' },
          { type: 'text-end', id: 't' },
          {
            type: 'finish',
            finishReason: { unified: 'stop', raw: 'stop' },
            usage: {
              inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
              outputTokens: { total: 1, text: 1, reasoning: undefined },
            },
          },
        ],
        delayMs: 40,
      },
    ])
    const { agent, messages } = makeAgent({ model })
    const run = agent.session('s1').send('Hi')
    const chunks: UIMessageChunk[] = []
    for await (const chunk of run.stream) {
      chunks.push(chunk)
      if (chunk.type === 'text-delta') run.abort('user stop')
    }
    const result = await run.result
    expect(result.stop).toBe('aborted')
    expect(chunks.at(-1)).toEqual({ type: 'abort', reason: 'user stop' })
    expect(chunks.filter((c) => c.type === 'finish')).toHaveLength(0)
    const final = messages.saves.at(-1)?.[0] as HarnessUIMessage
    expect(final.role).toBe('assistant')
    expect(final.metadata?.eharness?.stop).toBe('aborted')
    expect(JSON.stringify(final.parts)).toContain('Partial')
    // aborts save no notice
    expect(messages.saves.flat().some((m) => m.metadata?.eharness?.kind === 'eh.notice')).toBe(
      false,
    )
  })

  test('session.abort() aborts the running turn', async () => {
    const model = scriptedModel([{ text: 'slow', delayMs: 200 }])
    const { agent } = makeAgent({ model })
    const session = agent.session('s1')
    const run = session.send('Hi')
    await run.messageId
    session.abort()
    expect((await run.result).stop).toBe('aborted')
  })
})

describe('scenario 4: provider error', () => {
  test('429 → stop error, eh.notice saved with the describeError text', async () => {
    const model = scriptedModel([
      {
        throws: new APICallError({
          message: 'Too many requests',
          url: 'https://example.test',
          requestBodyValues: { secret: 'do-not-leak' },
          statusCode: 429,
          isRetryable: true,
        }),
      },
    ])
    const { agent, messages } = makeAgent({ model, settings: { maxRetries: 0 } })
    const run = agent.session('s1').send('Hi')
    const chunks = await collect(run.stream)
    const result = await run.result
    expect(result.stop).toBe('error')
    expect(result.error?.message).toBe('Rate limited: Too many requests')
    const error = chunks.find((c) => c.type === 'error')
    expect(error).toEqual({ type: 'error', errorText: 'Rate limited: Too many requests' })
    expect(JSON.stringify(chunks)).not.toContain('do-not-leak')
    const notice = messages.saves.flat().find((m) => m.metadata?.eharness?.kind === 'eh.notice')
    expect(notice?.role).toBe('assistant')
    expect(notice?.parts[0]).toMatchObject({
      type: 'data-eh.notice',
      data: { level: 'error', message: 'Rate limited: Too many requests' },
    })
    const assistant = result.messages.find((m) => m.id === result.messageId)
    expect(assistant?.metadata).toMatchObject({ eharness: { stop: 'error' } })
    expect(chunks.at(-1)?.type).toBe('finish')
  })

  test('a stream error part ends the turn with stop error after the step', async () => {
    const model = scriptedModel([{ text: 'x', streamError: new Error('mid-stream') }])
    const { agent } = makeAgent({ model })
    const result = await agent.session('s1').send('Hi').result
    expect(result.stop).toBe('error')
  })
})

describe('scenario 14: tool-pending', () => {
  test('a tool without execute ends the turn with tool-pending instead of looping', async () => {
    const model = scriptedModel([
      { toolCalls: [{ toolName: 'ask_user', input: { question: 'Which city?' } }] },
    ])
    const ask_user = tool({ inputSchema: z.object({ question: z.string() }) })
    const { agent, state } = makeAgent({ model, tools: { weather, ask_user } })
    const session = agent.session('s1')
    const run = session.send('Weather?')
    const result = await run.result
    expect(result.stop).toBe('tool-pending')
    expect(result.steps).toBe(1)
    expect(result.pending).toEqual({
      messageId: result.messageId as string,
      approvals: [],
      clientTools: [{ toolCallId: 'call-0-0', toolName: 'ask_user' }],
    })
    expect((await state.get('s1'))?.core.pending).toEqual(result.pending)
    const assistant = result.messages.find((m) => m.id === result.messageId)
    const part = assistant?.parts.find((p) => p.type === 'tool-ask_user') as { state: string }
    expect(part.state).toBe('input-available') // pending parts are left as they are
    expect(assistant?.metadata?.eharness?.pending).toEqual(result.pending)
    expect((await session.stats()).pending).toEqual(result.pending ?? null)
  })
})

describe('scenario 15: failure semantics', () => {
  const expectEarlyFailure = (chunks: UIMessageChunk[]) => {
    expect(chunkTypes(chunks)).toEqual(['start', 'error', 'message-metadata', 'finish'])
  }

  test('session open failure: valid stream, resolved result, nothing persisted', async () => {
    const broken = definePlugin({
      name: 'broken',
      session: () => {
        throw new Error('cannot connect')
      },
    })
    const { agent, messages, state } = makeAgent({ plugins: [broken] })
    const session = agent.session('s1')
    const run = session.send('Hi')
    const chunks = await collect(run.stream)
    const result = await run.result
    expectEarlyFailure(chunks)
    expect(result.stop).toBe('error')
    expect(result.error?.code).toBe('EH_CONFIG_INVALID')
    expect(result.messageId).toBeUndefined()
    expect(messages.saves).toHaveLength(0)
    expect(state.writes).toHaveLength(0)
    await expect(session.ready()).rejects.toThrow('cannot connect')
  })

  test('lock rejection → EH_SESSION_BUSY as a run error, nothing persisted', async () => {
    const { agent, messages, state } = makeAgent()
    const lock = {
      acquire: async () => {
        throw new Error('locked elsewhere')
      },
    }
    const run = agent.session('s1', { lock }).send('Hi')
    const chunks = await collect(run.stream)
    const result = await run.result
    expectEarlyFailure(chunks)
    expect(result.error?.code).toBe('EH_SESSION_BUSY')
    expect(messages.saves).toHaveLength(0)
    expect(state.writes).toHaveLength(0)
  })

  test('the lock is released at the end of a turn', async () => {
    const { agent } = makeAgent()
    let released = 0
    const lock = { acquire: async () => async () => void released++ }
    await agent.session('s1', { lock }).send('Hi').result
    expect(released).toBe(1)
  })

  test('load failure → EH_STORAGE run error', async () => {
    const { agent, messages, state } = makeAgent()
    messages.failLoad = true
    const run = agent.session('s1').send('Hi')
    expectEarlyFailure(await collect(run.stream))
    expect((await run.result).error?.code).toBe('EH_STORAGE')
    expect(state.writes).toHaveLength(0)
  })

  test('commit-point state write failure → nothing persisted', async () => {
    const { agent, messages, state } = makeAgent()
    state.failWrite = true
    const run = agent.session('s1').send('Hi')
    expectEarlyFailure(await collect(run.stream))
    expect((await run.result).error?.code).toBe('EH_STORAGE')
    expect(messages.saves).toHaveLength(0)
  })

  test('user message save failure → stop error EH_STORAGE before any model call', async () => {
    const model = twoStepModel()
    const { agent, messages } = makeAgent({ model })
    messages.failSave = (batch) => batch.some((m) => m.role === 'user')
    const result = await agent.session('s1').send('Hi').result
    expect(result.stop).toBe('error')
    expect(result.error?.code).toBe('EH_STORAGE')
    expect(model.calls).toHaveLength(0)
  })

  test('final save failure → stop error / EH_STORAGE in run.result', async () => {
    const { agent, messages } = makeAgent()
    messages.failSave = (batch) => batch.some((m) => m.metadata?.eharness?.stop === 'complete')
    const run = agent.session('s1').send('Hi')
    await collect(run.stream)
    const result = await run.result
    expect(result.stop).toBe('error')
    expect(result.error?.code).toBe('EH_STORAGE')
  })

  test('only EH_SESSION_BUSY and EH_SESSION_CLOSED throw from send()', async () => {
    const model = scriptedModel([{ text: 'slow', delayMs: 30 }])
    const { agent } = makeAgent({ model })
    const session = agent.session('s1')
    const run = session.send('Hi')
    let busy: unknown
    try {
      session.send('Again')
    } catch (error) {
      busy = error
    }
    expect(isHarnessError(busy, 'EH_SESSION_BUSY')).toBe(true)
    expect(session.running).toBe(true)
    await run.result
    expect(session.running).toBe(false)
    await session.close()
    let closed: unknown
    try {
      session.send('After close')
    } catch (error) {
      closed = error
    }
    expect(isHarnessError(closed, 'EH_SESSION_CLOSED')).toBe(true)
    // invalid input is a run error, never thrown
    const fresh = agent.session('s1')
    const invalid = fresh.send({ id: 'x', role: 'assistant', parts: [] } as never)
    expect((await invalid.result).error?.code).toBe('EH_INVALID_INPUT')
  })

  test('a model error never rejects run.result', async () => {
    const model = scriptedModel([{ throws: new Error('boom') }])
    const { agent } = makeAgent({ model, settings: { maxRetries: 0 } })
    const result = await agent.session('s1').send('Hi').result
    expect(result.stop).toBe('error')
    expect(result.error?.message).toBe('Unexpected error (see server logs)')
  })
})

describe('scenario 31: tool errors', () => {
  test('invalid tool input and unknown tools: UI, stored part and wire carry the same text', async () => {
    const typed = tool({
      inputSchema: z.object({ n: z.number() }),
      execute: async ({ n }) => n,
    })
    const model = scriptedModel([
      {
        toolCalls: [
          { toolName: 'typed', input: { n: 'x' } },
          { toolName: 'ghost', input: {} },
        ],
      },
      { text: 'Sorry.' },
    ])
    const { agent } = makeAgent({ model, tools: { typed } })
    const run = agent.session('s1').send('Go')
    const chunks = await collect(run.stream)
    const result = await run.result
    const ui = chunks
      .filter((c) => c.type === 'tool-output-error')
      .map((c) => (c as { errorText: string }).errorText)
    expect(ui).toHaveLength(2)
    expect(ui[0]).toStartWith('AI_InvalidToolInputError: Invalid input for tool typed:')
    expect(ui[1]).toStartWith('AI_NoSuchToolError:')
    const assistant = result.messages.find((m) => m.id === result.messageId)
    const stored = (assistant?.parts ?? [])
      .filter((p) => (p as { state?: string }).state === 'output-error')
      .map((p) => (p as { errorText: string }).errorText)
    expect(stored).toEqual(ui)
    const wire = JSON.stringify(model.prompts[1])
    for (const text of ui) expect(wire).toContain(JSON.stringify(text).slice(1, -1))
    expect(result.stop).toBe('complete')
  })

  test('UI errorText, stored part and model wire carry the same String(error)', async () => {
    const fails = tool({
      inputSchema: z.object({}),
      execute: async (): Promise<string> => {
        throw new TypeError('no network')
      },
    })
    const model = scriptedModel([
      { toolCalls: [{ toolName: 'fails', input: {} }] },
      { text: 'Sorry.' },
    ])
    const { agent } = makeAgent({ model, tools: { fails } })
    const run = agent.session('s1').send('Go')
    const chunks = await collect(run.stream)
    const result = await run.result
    const ui = chunks.find((c) => c.type === 'tool-output-error') as { errorText: string }
    expect(ui.errorText).toBe('TypeError: no network')
    const assistant = result.messages.find((m) => m.id === result.messageId)
    const part = assistant?.parts.find((p) => p.type === 'tool-fails') as { errorText: string }
    expect(part.errorText).toBe('TypeError: no network')
    expect(JSON.stringify(model.prompts[1])).toContain('TypeError: no network')
    expect(result.stop).toBe('complete')
  })
})

describe('scenario 36: chunk cloning', () => {
  test('attach() replays chunks exactly as the first reader saw them', async () => {
    const progress = defineDataPart({ schema: z.object({ n: z.number() }) })
    const reporter = definePlugin({
      name: 'rep',
      dataParts: { progress },
      setup: () => ({
        hooks: {
          'step.end': (ctx) => {
            ctx.stream.data('progress', { n: 1 }, { id: 'p' })
            ctx.stream.data('progress', { n: 2 }, { id: 'p' })
          },
        },
      }),
    })
    const { agent } = makeAgent({ plugins: [reporter] })
    const session = agent.session('s1')
    const run = session.send('Weather in Oslo?')
    const attached = session.attach()
    expect(attached).toBeDefined()
    const [first, replay] = await Promise.all([
      collect(run.stream),
      collect(attached?.stream ?? new ReadableStream()),
    ])
    const progressData = (chunks: UIMessageChunk[]) =>
      chunks.filter((c) => c.type === 'data-rep.progress').map((c) => (c as { data: unknown }).data)
    expect(progressData(first).slice(0, 2)).toEqual([{ n: 1 }, { n: 2 }])
    expect(replay).toEqual(first)
    // attach after the turn replays nothing
    await run.result
    expect(session.attach()).toBeUndefined()
  })
})
