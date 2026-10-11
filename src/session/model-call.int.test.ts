import { describe, expect, test } from 'bun:test'
import { generateText, tool } from 'ai'
import { z } from 'zod/v4'
import { defineHarnessAgent } from '../agent/define-agent.ts'
import { summarizerModel } from '../compaction/test-kit.ts'
import type { HarnessWarning } from '../errors.ts'
import { isUuidV7 } from '../messages/ids.ts'
import { observeForSession } from '../models/model-calls.ts'
import type { ModelCallEvent } from '../models/observe.ts'
import { observeModel } from '../models/observe.ts'
import { definePlugin } from '../plugin/define-plugin.ts'
import { scriptedModel } from '../testing/scripted-model.ts'

const silent = { debug() {}, info() {}, warn() {}, error() {} }

function setup(
  model: ReturnType<typeof scriptedModel>,
  config: Record<string, unknown> = {},
  listen = true,
) {
  const events: ModelCallEvent[] = []
  const warnings: HarnessWarning[] = []
  const probe = definePlugin({
    name: 'probe',
    setup: () => ({
      hooks: listen ? { 'model.call': (_ctx, e) => void events.push(e) } : {},
    }),
  })
  const agent = defineHarnessAgent({
    model,
    contextWindow: 100_000,
    logger: silent,
    onWarning: (w: HarnessWarning) => warnings.push(w),
    plugins: [probe],
    tools: {
      echo: tool({ inputSchema: z.object({ a: z.string() }), execute: async ({ a }) => a }),
    },
    ...config,
  } as never)
  return { agent, events, warnings }
}

const settle = () => new Promise((r) => setTimeout(r, 10))

describe('model.call hook', () => {
  test('one event per step with options, body, output, usage, timings and cost', async () => {
    const model = scriptedModel(
      [
        {
          reasoning: 'thinking',
          text: 'calling',
          toolCalls: [{ toolName: 'echo', input: { a: 'x' }, toolCallId: 'c1' }],
          usage: { inputTokens: 1000, outputTokens: 500 },
          requestBody: { model: 'scripted', messages: ['m'] },
          responseHeaders: { 'x-request-id': 'r1', 'set-cookie': 'secret', authorization: 'k' },
          delayMs: 5,
        },
        { text: 'done', usage: { inputTokens: 10, outputTokens: 5 } },
      ],
      { provider: 'p', modelId: 'm' },
    )
    const { agent, events, warnings } = setup(model, {
      models: { 'p/m': { contextWindow: 1e5, pricing: { input: 1, output: 2 } } },
    })
    const run = agent.session('s1').send('hi')
    const result = await run.result
    await settle()
    expect(warnings).toEqual([])
    expect(events).toHaveLength(2)
    const [a, b] = events as [ModelCallEvent, ModelCallEvent]
    expect(isUuidV7(a.id)).toBe(true)
    expect(a).toMatchObject({
      kind: 'step',
      sessionId: 's1',
      stepIndex: 0,
      model: { provider: 'p', modelId: 'm' },
      status: 'ok',
      finishReason: 'tool-calls',
      output: {
        text: 'calling',
        reasoning: 'thinking',
        toolCalls: [{ toolCallId: 'c1', toolName: 'echo', input: { a: 'x' } }],
      },
      request: { body: { model: 'scripted', messages: ['m'] } },
      response: { headers: { 'x-request-id': 'r1' } },
    })
    expect(a.turnId).toBe(result.turnId)
    expect(a.messageId).toBeDefined()
    expect(a.usage.inputTokens).toBe(1000)
    expect(a.usage.outputTokens).toBe(500)
    expect(a.costUsd).toBeCloseTo((1000 * 1 + 500 * 2) / 1e6)
    expect(a.firstChunkMs).toBeGreaterThanOrEqual(0)
    expect(a.durationMs).toBeGreaterThanOrEqual(5)
    const options = a.request.options as {
      prompt: unknown[]
      tools: unknown[]
      abortSignal?: unknown
    }
    expect(options.abortSignal).toBeUndefined()
    expect(Array.isArray(options.prompt)).toBe(true)
    expect(options.tools.length).toBeGreaterThan(0)
    expect(() => JSON.stringify(a)).not.toThrow()
    expect(b.stepIndex).toBe(1)
    expect(b.id > a.id).toBe(true)
    expect(b.output.text).toBe('done')
  })

  test('hook errors are warned and never affect the turn', async () => {
    const model = scriptedModel([{ text: 'ok' }])
    const warnings: HarnessWarning[] = []
    const agent = defineHarnessAgent({
      model,
      contextWindow: 100_000,
      logger: silent,
      onWarning: (w) => warnings.push(w),
      plugins: [
        definePlugin({
          name: 'bad',
          setup: () => ({
            hooks: {
              'model.call': () => {
                throw new Error('boom')
              },
            },
          }),
        }),
      ],
    })
    const result = await agent.session('s1').send('hi').result
    await settle()
    expect(result.stop).toBe('complete')
    expect(warnings.some((w) => w.code === 'W_HOOK_FAILED')).toBe(true)
  })

  test('provider error is reported with status error', async () => {
    const model = scriptedModel([{ throws: new Error('provider down') }])
    const { agent, events } = setup(model, { retry: { maxRetries: 0 } })
    await agent.session('s1').send('hi').result
    await settle()
    expect(events[0]).toMatchObject({
      kind: 'step',
      status: 'error',
      error: { name: 'Error', message: 'provider down' },
    })
  })

  test('abort mid-stream is reported with status aborted', async () => {
    const model = scriptedModel([
      {
        parts: [
          { type: 'stream-start', warnings: [] },
          { type: 'text-start', id: 't' },
          { type: 'text-delta', id: 't', delta: 'Partial' },
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
    const { agent, events } = setup(model)
    const run = agent.session('s1').send('hi')
    for await (const chunk of run.stream) {
      if (chunk.type === 'text-delta') run.abort('stop')
    }
    await run.result
    await settle()
    expect(events).toHaveLength(1)
    expect(events[0]?.status).toBe('aborted')
    expect(events[0]?.output.text).toBe('Partial')
  })

  test('compaction summarizer and flush are reported with their kind', async () => {
    const model = scriptedModel([{ text: 'a1' }, { text: 'a2' }, { text: 'a3' }])
    const summarizer = summarizerModel(['SUMMARY'])
    const { agent, events } = setup(model, {
      compaction: { model: summarizer, keepLast: 1, maxSummaryTokens: 100 },
    })
    const session = agent.session('s1')
    for (const q of ['q1', 'q2', 'q3']) await session.send(q).result
    await session.compact()
    await settle()
    const kinds = events.map((e) => e.kind)
    expect(kinds.filter((k) => k === 'step')).toHaveLength(3)
    const summary = events.find((e) => e.kind === 'compaction')
    expect(summary).toBeDefined()
    expect(summary?.model.modelId).toBe('summarizer')
    expect(summary?.output.text).toBe('SUMMARY')
    expect(summary?.stepIndex).toBeUndefined()
  })

  test('no wrapping when no plugin listens', async () => {
    const model = scriptedModel([{ text: 'ok' }])
    const { agent, events } = setup(model, {}, false)
    await agent.session('s1').send('hi').result
    expect(events).toEqual([])
    expect(model.calls).toHaveLength(1)
    // the core hands AI SDK the very same model object: no middleware, no assembly, no cost work
    const rt = { open: { hooks: { has: () => false } } } as never
    expect(observeForSession(rt, model, { kind: 'step' })).toBe(model)
  })

  test('ctx.observeModel reports other calls; observeModel works standalone', async () => {
    const events: ModelCallEvent[] = []
    const judge = scriptedModel([{ text: 'verdict' }])
    const model = scriptedModel([{ text: 'ok' }])
    const agent = defineHarnessAgent({
      model,
      contextWindow: 100_000,
      logger: silent,
      plugins: [
        definePlugin({
          name: 'judge',
          setup: () => ({
            hooks: {
              'model.call': (_ctx, e) => void events.push(e),
              'turn.start': async (ctx) => {
                await generateText({ model: ctx.observeModel(judge), prompt: 'judge this' })
              },
            },
          }),
        }),
      ],
    })
    await agent.session('s1').send('hi').result
    await settle()
    const other = events.find((e) => e.kind === 'other')
    expect(other).toMatchObject({ sessionId: 's1', output: { text: 'verdict' } })

    const records: unknown[] = []
    const standalone = observeModel(scriptedModel([{ text: 'x' }]), (r) => void records.push(r))
    await generateText({ model: standalone, prompt: 'p' })
    expect(records).toHaveLength(1)
  })
})
