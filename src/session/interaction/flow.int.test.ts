import { describe, expect, test } from 'bun:test'
import { tool, type UIMessage, type UIMessageChunk } from 'ai'
import { z } from 'zod/v4'
import { defineHarnessAgent } from '../../agent/define-agent.ts'
import type { SessionEvent, StateAdapter } from '../../agent/session-types.ts'
import type { HarnessAgentConfig } from '../../agent/types.ts'
import { summarizerModel, summarizerPromptText } from '../../compaction/test-kit.ts'
import type { HarnessWarning } from '../../errors.ts'
import { isKindMessage } from '../../messages/kinds.ts'
import type { HarnessUIMessage } from '../../messages/types.ts'
import { definePlugin } from '../../plugin/define-plugin.ts'
import { type ScriptedPrompt, scriptedModel } from '../../testing/scripted-model.ts'
import { collect, normalizeVolatile, spyMessages, spyState } from '../int-kit.ts'

const silent = { debug() {}, info() {}, warn() {}, error() {} }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function setup(
  config: Partial<HarnessAgentConfig> & Pick<HarnessAgentConfig, 'model'>,
  storage: { messages?: ReturnType<typeof spyMessages>; state?: StateAdapter } = {},
) {
  const messages = storage.messages ?? spyMessages()
  const state = storage.state ?? spyState()
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

/** Texts of a provider prompt, one entry per message: `role: text…`. */
function texts(prompt: ScriptedPrompt | undefined): string[] {
  return (prompt ?? []).map((m) => {
    const content =
      typeof m.content === 'string'
        ? m.content
        : (m.content as Array<{ type: string; text?: string; output?: { value?: unknown } }>)
            .map((p) =>
              p.type === 'text' ? p.text : p.type === 'tool-result' ? `[result]` : `[${p.type}]`,
            )
            .join('')
    return `${m.role}: ${content}`
  })
}

async function all(messages: ReturnType<typeof spyMessages>): Promise<HarnessUIMessage[]> {
  return (await messages.load({ sessionId: 's1' })) as HarnessUIMessage[]
}

function slowTool(log: string[], ms = 40) {
  return tool({
    description: 'Slow work',
    inputSchema: z.object({ n: z.number() }),
    execute: async ({ n }) => {
      await sleep(ms)
      log.push(`work:${n}`)
      return `worked ${n}`
    },
  })
}

function textOf(message: HarnessUIMessage | undefined): string {
  return (message?.parts ?? []).map((p) => (p.type === 'text' ? p.text : '')).join('')
}

describe('scenario 23: regenerate / edit / rewind', () => {
  test('regenerate: eh.rewind saved, the old answer hidden from projection and messages(); reload matches', async () => {
    const run = async (reload: boolean) => {
      const messages = spyMessages()
      const state = spyState()
      const model = scriptedModel([{ text: 'A1' }, { text: 'A1b' }, { text: 'next' }])
      const env = setup({ model }, { messages, state })
      let session = env.agent.session('s1')
      await session.send('Q1').result
      const regen = session.regenerate()
      expect(regen.kind).toBe('regenerate')
      const result = await regen.result
      expect(result.stop).toBe('complete')
      expect(texts(model.prompts[1])).toEqual(['user: Q1'])
      const rewind = result.messages[0] as HarnessUIMessage
      expect(isKindMessage(rewind, 'eh.rewind')).toBe(true)
      expect(result.messages.map((m) => m.id)).toEqual([rewind.id, result.messageId as string])
      expect(rewind.id < (result.messageId as string)).toBe(true)
      const stored = await all(messages)
      expect(stored.map((m) => textOf(m) || 'R')).toEqual(['Q1', 'A1', 'R', 'A1b'])
      expect((rewind.parts[0] as { data: unknown }).data).toEqual({
        afterId: stored[0]?.id,
        reason: 'regenerate',
      })
      expect((await state.get('s1'))?.core.rewinds).toEqual([
        { afterId: stored[0]?.id as string, rewindId: rewind.id },
      ])
      const visible = await session.messages()
      expect(visible.map((m) => textOf(m as HarnessUIMessage) || 'R')).toEqual(['Q1', 'R', 'A1b'])
      expect(await session.messages({ includeHidden: true })).toHaveLength(4)
      if (reload) {
        await env.agent.close()
        session = setup({ model }, { messages, state }).agent.session('s1')
        const cold = await session.messages()
        expect(cold.map((m) => textOf(m as HarnessUIMessage) || 'R')).toEqual(['Q1', 'R', 'A1b'])
      }
      await session.send('Q2').result
      return model.prompts[2]
    }
    const hot = await run(false)
    const cold = await run(true)
    expect(texts(hot)).toEqual(['user: Q1', 'assistant: A1b', 'user: Q2'])
    expect(normalizeVolatile(cold)).toEqual(normalizeVolatile(hot))
  })

  test('edit: rewind before the replaced message, clientId carried over, id order rewind < user < assistant', async () => {
    const model = scriptedModel([{ text: 'A1' }, { text: 'A2' }, { text: 'A1-edited' }])
    const { agent, messages } = setup({ model })
    const session = agent.session('s1')
    await session.send({ id: 'client-1', role: 'user', parts: [{ type: 'text', text: 'Q1' }] })
      .result
    await session.send('Q2').result
    const run = session.edit('client-1', {
      id: 'client-1',
      role: 'user',
      parts: [{ type: 'text', text: 'Q1 edited' }],
    } as UIMessage)
    expect(run.kind).toBe('edit')
    const result = await run.result
    expect(result.stop).toBe('complete')
    expect(texts(model.prompts[2])).toEqual(['user: Q1 edited'])
    const [rewind, user, assistant] = result.messages as HarnessUIMessage[]
    expect(isKindMessage(rewind as HarnessUIMessage, 'eh.rewind')).toBe(true)
    expect((rewind?.parts[0] as { data: unknown } | undefined)?.data).toEqual({
      afterId: null,
      reason: 'edit',
    })
    expect(user?.metadata?.eharness?.clientId).toBe('client-1')
    expect((rewind?.id as string) < (user?.id as string)).toBe(true)
    expect((user?.id as string) < (assistant?.id as string)).toBe(true)
    const visible = await session.messages()
    expect(visible.map((m) => textOf(m as HarnessUIMessage) || 'R')).toEqual([
      'R',
      'Q1 edited',
      'A1-edited',
    ])
    expect(await all(messages)).toHaveLength(7)
  })

  test('edit of a later message keeps the earlier turns; wrong targets are not-found', async () => {
    const model = scriptedModel([{ text: 'A1' }, { text: 'A2' }, { text: 'A2b' }])
    const { agent } = setup({ model })
    const session = agent.session('s1')
    const first = await session.send('Q1').result
    const second = await session.send('Q2').result
    const q2 = second.messages[0] as HarnessUIMessage
    const reason = async (run: {
      result: Promise<{ error?: { details?: { reason?: unknown } } }>
    }) => (await run.result).error?.details?.reason
    expect(await reason(session.regenerate({ messageId: 'nope' }))).toBe('not-found')
    expect(await reason(session.edit(first.messageId as string, 'x'))).toBe('not-found')
    await session.edit(q2.id, 'Q2 edited').result
    expect(texts(model.prompts[2])).toEqual(['user: Q1', 'assistant: A1', 'user: Q2 edited'])
    // the old answer is hidden now: regenerating it is not-found
    expect(await reason(session.regenerate({ messageId: second.messageId as string }))).toBe(
      'not-found',
    )
  })

  test('beyond-compaction; hidden messages never reach the summarizer', async () => {
    const summarizer = summarizerModel(
      (call) => `SUM(${summarizerPromptText(call).includes('HIDDEN') ? 'leak' : 'ok'})`,
    )
    const model = scriptedModel([
      { text: 'HIDDEN answer' },
      { text: 'A1' },
      { text: 'A2' },
      { text: 'A3' },
      { text: 'A3b' },
    ])
    const { agent } = setup({
      model,
      compaction: { model: summarizer, keepLast: 1, maxSummaryTokens: 100 },
    })
    const session = agent.session('s1')
    await session.send('Q1').result
    await session.regenerate().result
    await session.send('Q2').result
    const third = await session.send('Q3').result
    const marker = (await session.compact()) as HarnessUIMessage
    expect(marker).not.toBeNull()
    expect(summarizerPromptText(summarizer.calls[0] as never)).not.toContain('HIDDEN')
    const q3 = third.messages[0] as HarnessUIMessage
    const edit = await session.edit(q3.id, 'Q3 edited').result
    expect(edit.error?.details?.reason).toBe('beyond-compaction')
    // regenerating A3 rewinds to Q3, which is inside the view
    const regen = await session.regenerate().result
    expect(regen.stop).toBe('complete')
  })
})

describe('scenario 24: steer', () => {
  test('delivered as data-eh.input at the step boundary; the model sees it before step 1; reload identical', async () => {
    const run = async (reload: boolean) => {
      const messages = spyMessages()
      const state = spyState()
      const log: string[] = []
      const model = scriptedModel([
        { toolCalls: [{ toolName: 'work', input: { n: 1 } }] },
        { text: 'ok, also that' },
        { text: 'next' },
      ])
      const env = setup({ model, tools: { work: slowTool(log) } }, { messages, state })
      let session = env.agent.session('s1')
      const main = session.send('start')
      await sleep(10)
      const steer = session.send(
        { id: 'c-steer', role: 'user', parts: [{ type: 'text', text: 'STEER' }] } as UIMessage,
        {
          ifBusy: 'steer',
        },
      )
      expect(steer.turnId).toBe(main.turnId)
      const chunks = await collect<UIMessageChunk>(steer.stream)
      const result = await main.result
      expect(result.stop).toBe('complete')
      expect(result.steps).toBe(2)
      expect(chunks.filter((c) => c.type === 'data-eh.input')).toEqual([
        { type: 'data-eh.input', data: { source: 'user', text: 'STEER', clientId: 'c-steer' } },
      ])
      expect(texts(model.prompts[1])).toEqual([
        'user: start',
        'assistant: [tool-call]',
        'tool: [result]',
        'user: STEER',
      ])
      const assistant = result.messages.find((m) => m.id === result.messageId)
      const types = assistant?.parts.map((p) => p.type) ?? []
      expect(types.indexOf('data-eh.input')).toBeGreaterThan(types.indexOf('tool-work'))
      if (reload) {
        await env.agent.close()
        session = setup(
          { model, tools: { work: slowTool(log) } },
          { messages, state },
        ).agent.session('s1')
      }
      await session.send('more').result
      return model.prompts[2]
    }
    const hot = await run(false)
    const cold = await run(true)
    expect(texts(hot)).toEqual([
      'user: start',
      'assistant: [tool-call]',
      'tool: [result]',
      'user: STEER',
      'assistant: ok, also that',
      'user: more',
    ])
    expect(normalizeVolatile(cold)).toEqual(normalizeVolatile(hot))
  })

  test('a would-be complete continues; several steers are delivered together in order', async () => {
    const model = scriptedModel([{ text: 'first', delayMs: 10 }, { text: 'second' }])
    const { agent } = setup({ model })
    const session = agent.session('s1')
    const main = session.send('go')
    await sleep(5)
    session.send('S1', { ifBusy: 'steer' })
    session.send('S2', { ifBusy: 'steer' })
    const result = await main.result
    expect(result.stop).toBe('complete')
    expect(result.steps).toBe(2)
    expect(texts(model.prompts[1])).toEqual([
      'user: go',
      'assistant: first',
      'user: S1',
      'user: S2',
    ])
  })

  test('input.submit runs with via steer; a block drops only that input', async () => {
    const vias: string[] = []
    const guard = definePlugin({
      name: 'guard',
      setup: () => ({
        hooks: {
          'input.submit': (_ctx, e) => {
            vias.push(e.via)
            const text = e.message.parts.map((p) => (p.type === 'text' ? p.text : '')).join('')
            return text === 'BAD' ? { block: { reason: 'no' } } : { context: [`ctx:${text}`] }
          },
        },
      }),
    })
    const model = scriptedModel([{ text: 'first', delayMs: 10 }, { text: 'second' }])
    const { agent } = setup({ model, plugins: [guard] })
    const session = agent.session('s1')
    const events: SessionEvent[] = []
    const reader = session.events().getReader()
    const main = session.send('go')
    await sleep(5)
    session.send('BAD', { ifBusy: 'steer' })
    session.send('GOOD', { ifBusy: 'steer' })
    const result = await main.result
    expect(result.steps).toBe(2)
    expect(vias).toEqual(['send', 'steer', 'steer'])
    const last = texts(model.prompts[1]).at(-1)
    expect(last).toBe('user: GOOD\n\nctx:GOOD')
    await session.close()
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      events.push(next.value)
    }
    expect(events.find((e) => e.type === 'input-dropped')).toEqual({
      type: 'input-dropped',
      reason: 'blocked',
      text: 'BAD',
    })
  })

  test('steer on an idle session behaves like send()', async () => {
    const model = scriptedModel([{ text: 'hi' }])
    const { agent } = setup({ model })
    const result = await agent.session('s1').send('hello', { ifBusy: 'steer' }).result
    expect(result.stop).toBe('complete')
    expect(result.kind).toBe('send')
  })

  test('invalid steer input is a run error, never a throw', async () => {
    const model = scriptedModel([{ text: 'slow', delayMs: 10 }])
    const { agent } = setup({ model })
    const session = agent.session('s1')
    const main = session.send('go')
    const bad = session.send({ role: 'assistant', parts: [] } as never, { ifBusy: 'steer' })
    expect((await bad.result).error?.code).toBe('EH_INVALID_INPUT')
    await main.result
  })
})

describe('scenario 25: queue', () => {
  test('queued sends run in order after the current turn (turn-start queued: true)', async () => {
    const model = scriptedModel([{ text: 'A', delayMs: 5 }, { text: 'B' }, { text: 'C' }])
    const { agent } = setup({ model })
    const session = agent.session('s1')
    const events: SessionEvent[] = []
    const reader = session.events().getReader()
    const r1 = session.send('one')
    const r2 = session.send('two', { ifBusy: 'queue' })
    const r3 = session.send('three', { ifBusy: 'queue' })
    expect(typeof r2.turnId).toBe('string')
    const chunks2 = await collect<UIMessageChunk>(r2.stream)
    const [a, b, c] = await Promise.all([r1.result, r2.result, r3.result])
    expect([a.stop, b.stop, c.stop]).toEqual(['complete', 'complete', 'complete'])
    expect(b.turnId).toBe(r2.turnId)
    expect(chunks2[0]).toMatchObject({ type: 'start', messageId: b.messageId as string })
    expect(await r2.messageId).toBe(b.messageId as string)
    expect(texts(model.prompts[2])).toEqual([
      'user: one',
      'assistant: A',
      'user: two',
      'assistant: B',
      'user: three',
    ])
    await session.close()
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      events.push(next.value)
    }
    const starts = events.filter((e) => e.type === 'turn-start') as Array<{ queued: boolean }>
    expect(starts.map((e) => e.queued)).toEqual([false, true, true])
  })

  test('abort() drops the queue: stop aborted, start → abort stream, nothing persisted', async () => {
    const model = scriptedModel([{ text: 'slow answer', delayMs: 20 }])
    const { agent, messages } = setup({ model })
    const session = agent.session('s1')
    const r1 = session.send('one')
    const queued = session.send('two', { ifBusy: 'queue' })
    await sleep(5)
    session.abort()
    const chunks = await collect<UIMessageChunk>(queued.stream)
    const result = await queued.result
    expect(result.stop).toBe('aborted')
    expect(chunks.map((c) => c.type)).toEqual(['start', 'abort'])
    expect((await r1.result).stop).toBe('aborted')
    const stored = await all(messages)
    expect(stored.some((m) => textOf(m) === 'two')).toBe(false)
  })

  test('a queued run aborted before it starts is dropped alone', async () => {
    const model = scriptedModel([{ text: 'A', delayMs: 5 }, { text: 'C' }])
    const { agent } = setup({ model })
    const session = agent.session('s1')
    const r1 = session.send('one')
    const r2 = session.send('two', { ifBusy: 'queue' })
    const r3 = session.send('three', { ifBusy: 'queue' })
    r2.abort()
    expect((await r2.result).stop).toBe('aborted')
    expect((await r1.result).stop).toBe('complete')
    expect((await r3.result).stop).toBe('complete')
    expect(texts(model.prompts[1]).at(-1)).toBe('user: three')
  })

  test('a steer waiting when the turn stops with tool-pending is dropped with input-dropped', async () => {
    const client = tool({ description: 'client', inputSchema: z.object({}) })
    const model = scriptedModel([{ toolCalls: [{ toolName: 'client', input: {} }], delayMs: 10 }])
    const { agent } = setup({ model, tools: { client } })
    const session = agent.session('s1')
    const events: SessionEvent[] = []
    const reader = session.events().getReader()
    const main = session.send('go')
    await sleep(5)
    session.send({ id: 'c9', role: 'user', parts: [{ type: 'text', text: 'LATE' }] } as UIMessage, {
      ifBusy: 'steer',
    })
    const result = await main.result
    expect(result.stop).toBe('tool-pending')
    await session.close()
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      events.push(next.value)
    }
    expect(events.find((e) => e.type === 'input-dropped')).toEqual({
      type: 'input-dropped',
      reason: 'tool-pending',
      text: 'LATE',
      clientId: 'c9',
    })
    expect(model.prompts).toHaveLength(1)
  })

  test('a steer waiting when the turn stops otherwise becomes a queued send turn', async () => {
    const log: string[] = []
    const model = scriptedModel([
      { toolCalls: [{ toolName: 'work', input: { n: 1 } }] },
      { text: 'answer to steer' },
    ])
    const { agent } = setup({ model, tools: { work: slowTool(log) }, loop: { maxSteps: 1 } })
    const session = agent.session('s1')
    const events: SessionEvent[] = []
    const reader = session.events().getReader()
    const main = session.send('go')
    await sleep(10)
    session.send('STEER', { ifBusy: 'steer' })
    expect((await main.result).stop).toBe('max-steps')
    await sleep(20)
    while (session.running) await sleep(5)
    expect(texts(model.prompts[1]).at(-1)).toBe('user: STEER')
    await session.close()
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      events.push(next.value)
    }
    const starts = events.filter((e) => e.type === 'turn-start') as Array<{ queued: boolean }>
    expect(starts.map((e) => e.queued)).toEqual([false, true])
  })
})

describe('scenario 26: inject delivery and wake', () => {
  test('wake on an idle session starts a no-input turn', async () => {
    const model = scriptedModel([{ text: 'saw it' }])
    const { agent } = setup({ model })
    const session = agent.session('s1')
    const { message, run } = await session.inject(
      'eh.event',
      { name: 'build', text: 'Build finished' },
      { wake: true },
    )
    expect(run).toBeDefined()
    expect(run?.kind).toBe('wake')
    const result = await run?.result
    expect(result?.stop).toBe('complete')
    expect(texts(model.prompts[0])).toEqual(['user: <event name="build">Build finished</event>'])
    expect(message.id < (result?.messageId as string)).toBe(true)
  })

  test('next-step delivery during a turn: delivered once (deliveredIn), never projected twice', async () => {
    const run = async (reload: boolean) => {
      const messages = spyMessages()
      const state = spyState()
      const log: string[] = []
      const model = scriptedModel([
        { toolCalls: [{ toolName: 'work', input: { n: 1 } }] },
        { text: 'noted' },
        { text: 'next' },
      ])
      const env = setup({ model, tools: { work: slowTool(log) } }, { messages, state })
      let session = env.agent.session('s1')
      const main = session.send('go')
      await sleep(10)
      const { message } = await session.inject(
        'eh.event',
        { name: 'ci', text: 'CI red' },
        { deliver: 'next-step' },
      )
      const result = await main.result
      expect(result.steps).toBe(2)
      expect(texts(model.prompts[1]).at(-1)).toBe('user: <event name="ci">CI red</event>')
      const stored = (await all(messages)).find((m) => m.id === message.id)
      expect(stored?.metadata?.eharness?.deliveredIn).toBe(result.messageId as string)
      const assistant = result.messages.find((m) => m.id === result.messageId)
      expect(assistant?.parts.find((p) => p.type === 'data-eh.input')).toEqual({
        type: 'data-eh.input',
        data: { source: 'event', text: '<event name="ci">CI red</event>' },
      })
      if (reload) {
        await env.agent.close()
        session = setup(
          { model, tools: { work: slowTool(log) } },
          { messages, state },
        ).agent.session('s1')
      }
      await session.send('more').result
      const prompt = model.prompts[2]
      expect(JSON.stringify(prompt).split('CI red').length - 1).toBe(1)
      return prompt
    }
    const hot = await run(false)
    const cold = await run(true)
    expect(normalizeVolatile(cold)).toEqual(normalizeVolatile(hot))
  })

  test('wake while a turn runs implies next-step; wake while pending starts nothing', async () => {
    const client = tool({ description: 'client', inputSchema: z.object({}) })
    const model = scriptedModel([{ toolCalls: [{ toolName: 'client', input: {} }] }])
    const { agent } = setup({ model, tools: { client } })
    const session = agent.session('s1')
    await session.send('go').result
    const { run } = await session.inject('eh.event', { name: 'x', text: 'y' }, { wake: true })
    expect(run).toBeUndefined()
    expect(model.prompts).toHaveLength(1)
  })
})
