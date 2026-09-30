import { describe, expect, test } from 'bun:test'
import { tool } from 'ai'
import { z } from 'zod/v4'
import { defineHarnessAgent } from '../agent/define-agent.ts'
import type { HarnessAgentConfig } from '../agent/types.ts'
import type { HarnessWarning } from '../errors.ts'
import { isHarnessError } from '../errors.ts'
import { MAX_STEPS_WRAP_UP } from '../messages/texts.ts'
import type { HarnessUIMessage } from '../messages/types.ts'
import { definePlugin } from '../plugin/define-plugin.ts'
import type { HarnessContext, StepEndEvent } from '../plugin/types.ts'
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

const userTexts = (prompt: unknown): string[] => {
  const out: string[] = []
  for (const message of prompt as Array<{ role: string; content: unknown }>) {
    if (message.role !== 'user' || !Array.isArray(message.content)) continue
    for (const part of message.content as Array<{ type: string; text?: string }>) {
      if (part.type === 'text' && part.text !== undefined) out.push(part.text)
    }
  }
  return out
}

describe('scenario 10: plugin services', () => {
  test('ctx.services inside tools; ToolInput functions see every service', async () => {
    const provider = definePlugin({
      name: 'store',
      provides: ['kv'],
      session: () => ({ services: { kv: new Map([['greeting', 'hello']]) } as never }),
    })
    let disposed = 0
    const user = definePlugin({
      name: 'user',
      requires: ['kv'],
      session: (ctx) => ({
        tools: {
          read_kv: tool({
            inputSchema: z.object({ key: z.string() }),
            execute: async ({ key }) =>
              (ctx.services as unknown as Record<string, Map<string, string>>).kv?.get(key) ??
              'none',
          }),
        },
        dispose: () => void disposed++,
      }),
    })
    const model = scriptedModel([
      { toolCalls: [{ toolName: 'read_kv', input: { key: 'greeting' } }] },
      { text: 'ok' },
    ])
    const { agent } = setup({ model, plugins: [provider, user] })
    const session = agent.session('s1')
    const result = await session.send('go').result
    const part = result.messages
      .find((m) => m.id === result.messageId)
      ?.parts.find((p) => p.type === 'tool-read_kv') as { output: unknown }
    expect(part.output).toBe('hello')
    await agent.closeSession('s1')
    expect(disposed).toBe(1)
  })

  test('a provider that does not return its declared service fails open (EH_SERVICE_MISSING)', async () => {
    const provider = definePlugin({ name: 'store', provides: ['kv'], session: () => ({}) })
    const { agent } = setup({ model: scriptedModel([]), plugins: [provider] })
    let error: unknown
    try {
      await agent.session('s1').ready()
    } catch (e) {
      error = e
    }
    expect(isHarnessError(error, 'EH_SERVICE_MISSING')).toBe(true)
  })

  test('accessing a service nobody provides throws EH_SERVICE_MISSING', async () => {
    let error: unknown
    const probe = definePlugin({
      name: 'probe',
      session: (ctx) => {
        try {
          void (ctx.services as unknown as Record<string, unknown>).missing
        } catch (e) {
          error = e
        }
      },
    })
    const { agent } = setup({ model: scriptedModel([]), plugins: [probe] })
    await agent.session('s1').ready()
    expect(isHarnessError(error, 'EH_SERVICE_MISSING')).toBe(true)
  })

  test('a session-phase tool colliding with a static tool → EH_DUPLICATE_TOOL at open', async () => {
    const t = tool({ inputSchema: z.object({}), execute: async () => 'x' })
    const dup = definePlugin({ name: 'dup', session: () => ({ tools: { same: t } }) })
    const { agent } = setup({ model: scriptedModel([]), tools: { same: t }, plugins: [dup] })
    let error: unknown
    try {
      await agent.session('s1').ready()
    } catch (e) {
      error = e
    }
    expect(isHarnessError(error, 'EH_DUPLICATE_TOOL')).toBe(true)
  })

  test('session.start / session.close hooks and ctx.signal', async () => {
    const calls: string[] = []
    let signal: AbortSignal | undefined
    const plugin = definePlugin({
      name: 'life',
      setup: () => ({
        hooks: {
          'session.start': (ctx) => {
            calls.push('start')
            signal = ctx.signal
          },
          'session.close': () => void calls.push('close'),
        },
      }),
    })
    const { agent } = setup({ model: scriptedModel([]), plugins: [plugin] })
    const session = agent.session('s1')
    await session.ready()
    await session.ready()
    expect(calls).toEqual(['start'])
    await session.close()
    expect(calls).toEqual(['start', 'close'])
    expect(signal?.aborted).toBe(true)
  })
})

describe('hook order and context', () => {
  test('plugin order (root first), setup before session; ctx.turn/step are live', async () => {
    const order: string[] = []
    const seen: Array<{ turn?: string; step?: number }> = []
    const mk = (name: string) =>
      definePlugin({
        name,
        setup: () => ({ hooks: { 'turn.start': () => void order.push(`${name}:setup`) } }),
        session: () => ({ hooks: { 'turn.start': () => void order.push(`${name}:session`) } }),
      })
    const probe = definePlugin({
      name: 'probe',
      setup: () => ({
        hooks: {
          'step.prepare': (ctx: HarnessContext) => {
            seen.push({ turn: ctx.turn?.id, ...(ctx.step ? { step: ctx.step.index } : {}) })
          },
          'step.end': (ctx: HarnessContext) => {
            seen.push({ turn: ctx.turn?.id })
          },
        },
      }),
    })
    const { agent } = setup({
      model: scriptedModel([{ text: 'hi' }]),
      plugins: [mk('a'), mk('b'), probe],
    })
    const run = agent.session('s1').send('go')
    await run.result
    expect(order).toEqual(['a:setup', 'a:session', 'b:setup', 'b:session'])
    expect(seen.every((s) => s.turn === run.turnId)).toBe(true)
    expect(seen.some((s) => 'step' in s)).toBe(false) // step is set during the model call only
  })

  test('a throwing hook raises W_HOOK_FAILED and is skipped', async () => {
    const plugin = definePlugin({
      name: 'bad',
      setup: () => ({
        hooks: {
          'turn.start': () => {
            throw new Error('oops')
          },
        },
      }),
    })
    const { agent, warnings } = setup({ model: scriptedModel([{ text: 'hi' }]), plugins: [plugin] })
    const result = await agent.session('s1').send('go').result
    expect(result.stop).toBe('complete')
    expect(warnings.map((w) => w.code)).toContain('W_HOOK_FAILED')
  })

  test('message.beforeSave transforms every save; tool.before/after rewrite input and output', async () => {
    const echo = tool({
      inputSchema: z.object({ text: z.string() }),
      execute: async ({ text }) => text,
    })
    const plugin = definePlugin({
      name: 'tx',
      setup: () => ({
        hooks: {
          'tool.before': (_ctx, e) => ({
            input: { text: String((e.input as { text: string }).text).toUpperCase() },
          }),
          'tool.after': (_ctx, e) => ({ output: `${String(e.output)}!` }),
          'message.beforeSave': (_ctx, message) => ({
            ...message,
            metadata: { ...(message.metadata ?? {}), audited: true },
          }),
        },
      }),
    })
    const model = scriptedModel([
      { toolCalls: [{ toolName: 'echo', input: { text: 'hi' } }] },
      { text: 'done' },
    ])
    const { agent, messages } = setup({ model, tools: { echo }, plugins: [plugin] })
    const result = await agent.session('s1').send('go').result
    const part = result.messages
      .find((m) => m.id === result.messageId)
      ?.parts.find((p) => p.type === 'tool-echo') as { input: unknown; output: unknown }
    expect(part.input).toEqual({ text: 'HI' })
    expect(part.output).toBe('HI!')
    expect(messages.saves.flat().every((m) => (m.metadata as { audited?: boolean }).audited)).toBe(
      true,
    )
  })

  test('tool.approve denial (and a throwing approve hook) deny the call', async () => {
    let executed = 0
    const danger = tool({
      inputSchema: z.object({}),
      execute: async () => {
        executed++
        return 'done'
      },
    })
    const plugin = definePlugin({
      name: 'guard',
      setup: () => ({
        hooks: {
          'tool.approve': () => {
            throw new Error('no')
          },
        },
      }),
    })
    const model = scriptedModel([
      { toolCalls: [{ toolName: 'danger', input: {} }] },
      { text: 'ok' },
    ])
    const { agent } = setup({
      model,
      tools: { danger },
      plugins: [plugin],
      approval: { policy: { danger: 'approved' } },
    })
    const result = await agent.session('s1').send('go').result
    expect(executed).toBe(0)
    expect(result.stop).toBe('complete')
    const part = result.messages
      .find((m) => m.id === result.messageId)
      ?.parts.find((p) => p.type === 'tool-danger') as { state: string }
    expect(part.state).toBe('output-denied')
  })

  test('step.end stop ends the turn with plugin:<name>:<reason>; context is delivered', async () => {
    const model = scriptedModel([
      { toolCalls: [{ toolName: 'noop', input: {} }] },
      { toolCalls: [{ toolName: 'noop', input: {} }] },
      { text: 'never' },
    ])
    const noop = tool({ inputSchema: z.object({}), execute: async () => 'ok' })
    let steps = 0
    const plugin = definePlugin({
      name: 'budget',
      setup: () => ({
        hooks: {
          'step.end': () => {
            steps++
            return steps === 1 ? { context: 'Hurry up.' } : { stop: 'enough' }
          },
        },
      }),
    })
    const { agent } = setup({ model, tools: { noop }, plugins: [plugin] })
    const run = agent.session('s1').send('go')
    const chunks = await collect(run.stream)
    const result = await run.result
    expect(result.stop).toBe('plugin:budget:enough')
    expect(chunks.filter((c) => c.type === 'data-eh.input')).toEqual([
      { type: 'data-eh.input', data: { source: 'plugin:budget', text: 'Hurry up.' } },
    ])
    expect(userTexts(model.prompts[1])).toContain('Hurry up.')
  })
})

describe('step.end event (spec 01 §5)', () => {
  test('exposes the AI SDK StepResult as `step`; toolCalls/toolResults are derived from it', async () => {
    const model = scriptedModel([
      {
        toolCalls: [
          { toolName: 'slow', input: { n: 1 } },
          { toolName: 'fails', input: {} },
        ],
      },
      { text: 'done' },
    ])
    const slow = tool({
      inputSchema: z.object({ n: z.number() }),
      execute: async ({ n }) => {
        await new Promise((resolve) => setTimeout(resolve, 20))
        return n + 1
      },
    })
    const fails = tool({
      inputSchema: z.object({}),
      execute: async (): Promise<string> => {
        throw new Error('boom')
      },
    })
    const events: StepEndEvent[] = []
    const plugin = definePlugin({
      name: 'spy',
      setup: () => ({ hooks: { 'step.end': (_ctx, event) => void events.push(event) } }),
    })
    const { agent } = setup({ model, tools: { slow, fails }, plugins: [plugin] })
    expect((await agent.session('s1').send('go').result).stop).toBe('complete')
    expect(events).toHaveLength(2)
    const [first, second] = events as [StepEndEvent, StepEndEvent]
    expect(first.step).toBeDefined()
    expect(first.step?.toolCalls.map((c) => [c.toolName, c.input])).toEqual([
      ['slow', { n: 1 }],
      ['fails', {}],
    ])
    expect(first.step?.toolResults.map((r) => [r.toolName, r.output])).toEqual([['slow', 2]])
    expect(first.step?.content.some((p) => p.type === 'tool-error')).toBe(true)
    expect(first.step?.finishReason).toBe(first.finishReason)
    // call order, not completion order ('fails' finishes first)
    expect(first.toolCalls.map((c) => c.toolName)).toEqual(['slow', 'fails'])
    expect(first.toolResults).toEqual([
      { toolName: 'slow', toolCallId: first.toolCalls[0]?.toolCallId ?? '', status: 'output' },
      { toolName: 'fails', toolCallId: first.toolCalls[1]?.toolCallId ?? '', status: 'error' },
    ])
    expect(second.step?.text).toBe('done')
    expect(second.toolCalls).toEqual([])
    expect(second.toolResults).toEqual([])
  })

  test('an aborted step fires no step.end', async () => {
    const model = scriptedModel([{ text: 'slow', delayMs: 200 }])
    let calls = 0
    const plugin = definePlugin({
      name: 'spy',
      setup: () => ({ hooks: { 'step.end': () => void calls++ } }),
    })
    const { agent } = setup({ model, plugins: [plugin] })
    const session = agent.session('s1')
    const run = session.send('go')
    await run.messageId
    session.abort()
    expect((await run.result).stop).toBe('aborted')
    expect(calls).toBe(0)
  })
})

describe('waiting input and limits', () => {
  test('step.end context cannot run past the step budget (max-steps)', async () => {
    const model = scriptedModel(Array.from({ length: 40 }, () => ({ text: 'again' })))
    const plugin = definePlugin({
      name: 'chatty',
      setup: () => ({ hooks: { 'step.end': () => ({ context: 'one more thing' }) } }),
    })
    const { agent } = setup({ model, plugins: [plugin], loop: { maxSteps: 3, wrapUp: false } })
    const result = await agent.session('s1').send('go').result
    expect(result.stop).toBe('max-steps')
    expect(model.calls).toHaveLength(3)
  })

  test('step.end context cannot run past the cost cap', async () => {
    const model = scriptedModel(
      Array.from({ length: 40 }, () => ({ text: 'again', usage: { outputTokens: 30 } })),
    )
    const plugin = definePlugin({
      name: 'chatty',
      setup: () => ({ hooks: { 'step.end': () => ({ context: 'one more thing' }) } }),
    })
    const { agent } = setup({ model, plugins: [plugin], loop: { maxTurnOutputTokens: 50 } })
    const result = await agent.session('s1').send('go').result
    expect(result.stop).toBe('cost-cap')
    expect(model.calls).toHaveLength(2)
  })

  test('extendSteps for a non-max-steps stop is ignored silently (no W_CONTINUE_LIMIT)', async () => {
    const plugin = definePlugin({
      name: 'ext',
      setup: () => ({ hooks: { 'turn.beforeEnd': () => ({ extendSteps: 3 }) } }),
    })
    const { agent, warnings } = setup({
      model: scriptedModel([{ text: 'done' }]),
      plugins: [plugin],
      loop: { maxContinues: 0 },
    })
    const result = await agent.session('s1').send('go').result
    expect(result.stop).toBe('complete')
    expect(warnings.map((w) => w.code)).not.toContain('W_CONTINUE_LIMIT')
  })
})

describe('progress guard (spec 05 §3.2)', () => {
  const repeating = () =>
    scriptedModel(
      Array.from({ length: 12 }, () => ({ toolCalls: [{ toolName: 'look', input: {} }] })),
    )
  const look = tool({ inputSchema: z.object({}), execute: async () => 'same' })

  test('a repeated call gets one reminder (W_LOOP_STUCK), then the turn stops with stuck', async () => {
    const model = repeating()
    const { agent, warnings } = setup({ model, tools: { look } })
    const result = await agent.session('s1').send('go').result
    expect(result.stop).toBe('stuck')
    // 3 repeats → nudge (window reset) → 3 more repeats → stuck
    expect(result.steps).toBe(6)
    expect(warnings.filter((w) => w.code === 'W_LOOP_STUCK')).toHaveLength(1)
    expect(JSON.stringify(model.calls[3]?.prompt)).toContain('You are not making progress')
    expect(JSON.stringify(model.calls[4]?.prompt)).not.toContain('You are not making progress')
  })

  test('nudges: 0 stops at the first detection; progress: false disables it', async () => {
    const first = setup({ model: repeating(), tools: { look }, loop: { progress: { nudges: 0 } } })
    expect((await first.agent.session('s1').send('go').result).stop).toBe('stuck')
    const off = setup({
      model: repeating(),
      tools: { look },
      loop: { progress: false, maxSteps: 8, wrapUp: false },
    })
    const result = await off.agent.session('s1').send('go').result
    expect(result.stop).toBe('max-steps')
    expect(off.warnings.map((w) => w.code)).not.toContain('W_LOOP_STUCK')
  })

  test('continuations without progress are refused after maxIdleContinues', async () => {
    const model = scriptedModel(Array.from({ length: 10 }, () => ({ text: 'thinking' })))
    const seen: number[] = []
    const plugin = definePlugin({
      name: 'nag',
      setup: () => ({
        hooks: {
          'turn.beforeEnd': (_ctx, e) => {
            seen.push(e.idleContinues)
            return { continue: { reason: 'keep going' } }
          },
        },
      }),
    })
    const { agent, warnings } = setup({ model, plugins: [plugin], loop: { maxIdleContinues: 2 } })
    const result = await agent.session('s1').send('go').result
    expect(result.stop).toBe('complete')
    expect(result.steps).toBe(3) // first continue is free, then 1 idle one, then refused
    expect(seen).toEqual([0, 1, 2])
    const limit = warnings.find((w) => w.code === 'W_CONTINUE_LIMIT')
    expect(limit?.details).toMatchObject({ reason: 'no-progress', idleContinues: 2 })
  })

  test('continuations that lead to new tool results are not idle', async () => {
    let n = 0
    const work = tool({ inputSchema: z.object({}), execute: async () => `result ${n++}` })
    const model = scriptedModel([
      { text: 'a' },
      { toolCalls: [{ toolName: 'work', input: {} }] },
      { text: 'b' },
      { toolCalls: [{ toolName: 'work', input: {} }] },
      { text: 'c' },
      { toolCalls: [{ toolName: 'work', input: {} }] },
      { text: 'd' },
    ])
    let continues = 0
    const plugin = definePlugin({
      name: 'nag',
      setup: () => ({
        hooks: {
          'turn.beforeEnd': () => (continues++ < 3 ? { continue: { reason: 'next' } } : undefined),
        },
      }),
    })
    const { agent, warnings } = setup({
      model,
      tools: { work },
      plugins: [plugin],
      loop: { maxIdleContinues: 1 },
    })
    const result = await agent.session('s1').send('go').result
    expect(result.steps).toBe(7)
    expect(warnings.map((w) => w.code)).not.toContain('W_CONTINUE_LIMIT')
  })
})

describe('cost and budgets (spec 12)', () => {
  // input 10 + output 5 tokens per scripted step; $1 per 1k output tokens → $0.005 per step
  const models = () => ({ pricing: { input: 0, output: 1_000 } })
  const work = tool({ inputSchema: z.object({ n: z.number() }), execute: async ({ n }) => `r${n}` })
  const looping = (n: number) =>
    scriptedModel(
      Array.from({ length: n }, (_, i) => ({ toolCalls: [{ toolName: 'work', input: { n: i } }] })),
    )

  test('cost is recorded in the turn result, message metadata and session state', async () => {
    const model = scriptedModel([{ text: 'a' }, { text: 'b' }])
    const { agent, state } = setup({ model, models })
    const session = agent.session('s1')
    const first = await session.send('one').result
    expect(first.usage.costUsd).toBeCloseTo(0.005, 10)
    const assistant = first.messages.find((m) => m.role === 'assistant')
    expect(assistant?.metadata?.eharness?.usage?.costUsd).toBeCloseTo(0.005, 10)
    await session.send('two').result
    expect(state.writes.at(-1)?.core.usage?.costUsd).toBeCloseTo(0.01, 10)
  })

  test('maxTurnUsd stops with cost-cap after the step that crossed it (W_BUDGET)', async () => {
    const { agent, warnings } = setup({
      model: looping(10),
      tools: { work },
      models,
      budget: { maxTurnUsd: 0.012 },
    })
    const result = await agent.session('s1').send('go').result
    expect(result.stop).toBe('cost-cap')
    expect(result.steps).toBe(3)
    const budget = warnings.filter((w) => w.code === 'W_BUDGET').map((w) => w.details)
    expect(budget).toEqual([
      expect.objectContaining({ scope: 'turn', exceeded: false }),
      expect.objectContaining({ scope: 'turn', exceeded: true }),
    ])
  })

  test('a used-up session budget stops the next turn before any model call', async () => {
    const model = scriptedModel([{ text: 'a' }, { text: 'b' }])
    const { agent } = setup({ model, models, budget: { maxSessionUsd: 0.004 } })
    const session = agent.session('s1')
    expect((await session.send('one').result).stop).toBe('complete')
    const second = await session.send('two').result
    expect(second.stop).toBe('cost-cap')
    expect(second.steps).toBe(0)
    expect(model.calls).toHaveLength(1)
  })

  test('addUsage counts costUsd or prices a model; unpriced models warn once', async () => {
    const nested = tool({
      inputSchema: z.object({}),
      execute: async () => 'done',
    })
    let seen: unknown
    const plugin = definePlugin({
      name: 'sub',
      setup: () => ({
        hooks: {
          'step.end': (ctx, e) => {
            if (e.stepIndex === 0) {
              const u = { inputTokens: 0, outputTokens: 0, totalTokens: 0 } as never
              ctx.turn?.addUsage(u, { costUsd: 0.5, source: 'gateway' })
            }
            seen = e.costUsd
          },
        },
      }),
    })
    const model = scriptedModel([
      { toolCalls: [{ toolName: 'nested', input: {} }] },
      { text: 'ok' },
    ])
    const priced = setup({ model, tools: { nested }, models, plugins: [plugin] })
    const result = await priced.agent.session('s1').send('go').result
    expect(result.usage.costUsd).toBeCloseTo(0.51, 10)
    expect(seen).toBeCloseTo(0.51, 10)

    const unpriced = setup({ model: scriptedModel([{ text: 'x' }]), budget: { maxTurnUsd: 1 } })
    const r = await unpriced.agent.session('s1').send('go').result
    expect(r.usage.costUsd).toBeUndefined()
    expect(unpriced.warnings.map((w) => w.code)).toContain('W_MODEL_UNPRICED')
  })

  test('the models catalog supplies the context window when contextWindow is not set', async () => {
    const { resolveWindow } = await import('../compaction/tokens.ts')
    expect(resolveWindow({ models: { 'a/b': { contextWindow: 42_000 } } }, 'a/b')).toBe(42_000)
    expect(
      resolveWindow({ contextWindow: 7, models: { 'a/b': { contextWindow: 42_000 } } }, 'a/b'),
    ).toBe(7)
  })
})

describe('scenario 27: turn.beforeEnd', () => {
  test('continue runs one more step with data-eh.input { source: plugin:… }', async () => {
    const model = scriptedModel([{ text: 'first' }, { text: 'second' }])
    let calls = 0
    const plugin = definePlugin({
      name: 'todo',
      setup: () => ({
        hooks: {
          'turn.beforeEnd': (_ctx, e) => {
            calls++
            return e.continues === 0 ? { continue: { reason: 'Finish the todo list.' } } : undefined
          },
        },
      }),
    })
    const { agent } = setup({ model, plugins: [plugin] })
    const run = agent.session('s1').send('go')
    const chunks = await collect(run.stream)
    const result = await run.result
    expect(result.steps).toBe(2)
    expect(result.stop).toBe('complete')
    expect(calls).toBe(2)
    expect(chunks.find((c) => c.type === 'data-eh.input')).toEqual({
      type: 'data-eh.input',
      data: { source: 'plugin:todo', text: 'Finish the todo list.' },
    })
    expect(userTexts(model.prompts[1]).at(-1)).toBe('Finish the todo list.')
    // stored where the model saw it
    const assistant = result.messages.find((m) => m.id === result.messageId) as HarnessUIMessage
    expect(assistant.parts.map((p) => p.type)).toEqual([
      'step-start',
      'text',
      'data-eh.input',
      'step-start',
      'text',
    ])
  })

  test('maxContinues bounds forced continuations (W_CONTINUE_LIMIT)', async () => {
    const model = scriptedModel(Array.from({ length: 5 }, () => ({ text: 'again' })))
    const plugin = definePlugin({
      name: 'nag',
      setup: () => ({
        hooks: { 'turn.beforeEnd': () => ({ continue: { reason: 'more' } }) },
      }),
    })
    const { agent, warnings } = setup({ model, plugins: [plugin], loop: { maxContinues: 2 } })
    const result = await agent.session('s1').send('go').result
    expect(result.steps).toBe(3)
    expect(result.stop).toBe('complete')
    expect(warnings.map((w) => w.code)).toContain('W_CONTINUE_LIMIT')
  })

  test('extendSteps lifts max-steps', async () => {
    const noop = tool({ inputSchema: z.object({}), execute: async () => 'ok' })
    const model = scriptedModel([
      { toolCalls: [{ toolName: 'noop', input: {} }] },
      { toolCalls: [{ toolName: 'noop', input: {} }] },
      { text: 'done' },
    ])
    const plugin = definePlugin({
      name: 'ext',
      setup: () => ({
        hooks: {
          'turn.beforeEnd': (_ctx, e) => (e.stop === 'max-steps' ? { extendSteps: 5 } : undefined),
        },
      }),
    })
    const { agent } = setup({ model, tools: { noop }, plugins: [plugin], loop: { maxSteps: 1 } })
    const result = await agent.session('s1').send('go').result
    expect(result.stop).toBe('complete')
    expect(result.steps).toBe(3)
  })

  test('without hooks max-steps stops the loop (wrapUp: false)', async () => {
    const noop = tool({ inputSchema: z.object({}), execute: async () => 'ok' })
    const model = scriptedModel([{ toolCalls: [{ toolName: 'noop', input: {} }] }])
    const { agent } = setup({ model, tools: { noop }, loop: { wrapUp: false } })
    const result = await agent.session('s1').send('go', { maxSteps: 1 }).result
    expect(result.stop).toBe('max-steps')
    expect(model.calls).toHaveLength(1)
  })

  test('max-steps runs one wrap-up step without tools (default wrapUp)', async () => {
    const noop = tool({ inputSchema: z.object({}), execute: async () => 'ok' })
    const model = scriptedModel([
      { toolCalls: [{ toolName: 'noop', input: {} }] },
      { text: 'Done: called noop. Left: nothing.' },
    ])
    const { agent } = setup({ model, tools: { noop } })
    const result = await agent.session('s1').send('go', { maxSteps: 1 }).result
    expect(result.stop).toBe('max-steps')
    expect(result.steps).toBe(2)
    expect(model.calls).toHaveLength(2)
    expect(model.calls[1]?.toolChoice).toEqual({ type: 'none' })
    expect(JSON.stringify(model.calls[1]?.prompt)).toContain(MAX_STEPS_WRAP_UP)
  })

  test('cost-cap stops the loop when output tokens exceed maxTurnOutputTokens', async () => {
    const noop = tool({ inputSchema: z.object({}), execute: async () => 'ok' })
    const model = scriptedModel([
      { toolCalls: [{ toolName: 'noop', input: {} }], usage: { outputTokens: 50 } },
    ])
    const { agent } = setup({ model, tools: { noop }, loop: { maxTurnOutputTokens: 10 } })
    const result = await agent.session('s1').send('go').result
    expect(result.stop).toBe('cost-cap')
  })
})

describe('scenario 28: input.submit', () => {
  const run = async (hook: NonNullable<Parameters<typeof definePlugin>[0]['setup']>) => {
    const model = scriptedModel([{ text: 'ok' }])
    const plugin = definePlugin({ name: 'gate', setup: hook })
    const env = setup({ model, plugins: [plugin] })
    const r = env.agent
      .session('s1')
      .send({ id: 'client-1', role: 'user', parts: [{ type: 'text', text: 'hello' }] })
    const chunks = await collect(r.stream)
    return { ...env, model, chunks, result: await r.result }
  }

  test('a rewrite is normalized again', async () => {
    const { result, model } = await run(() => ({
      hooks: {
        'input.submit': (_ctx, e) => ({
          message: { ...e.message, parts: [{ type: 'text', text: 'rewritten' }] },
        }),
      },
    }))
    expect(result.messages[0]?.parts).toEqual([{ type: 'text', text: 'rewritten' }])
    expect(result.messages[0]?.metadata?.eharness?.clientId).toBe('client-1')
    expect(userTexts(model.prompts[0])).toEqual(['rewritten'])
  })

  test('a rewrite that adds a tool part is rejected (EH_INVALID_INPUT)', async () => {
    const { result } = await run(() => ({
      hooks: {
        'input.submit': (_ctx, e) => ({
          message: {
            ...e.message,
            parts: [{ type: 'data-eh.compaction', data: {} } as never],
          },
        }),
      },
    }))
    expect(result.error?.code).toBe('EH_INVALID_INPUT')
  })

  test('context adds trailing text parts and metadata.eharness.augmented', async () => {
    const { result } = await run(() => ({
      hooks: { 'input.submit': () => ({ context: ['Today is Monday.', 'User is admin.'] }) },
    }))
    const user = result.messages[0] as HarnessUIMessage
    expect(user.parts.map((p) => (p as { text: string }).text)).toEqual([
      'hello',
      'Today is Monday.',
      'User is admin.',
    ])
    expect(user.metadata?.eharness?.augmented).toBe(2)
  })

  test('block → stop blocked, no model call, nothing persisted', async () => {
    const { result, model, messages, state, chunks } = await run(() => ({
      hooks: { 'input.submit': () => ({ block: { reason: 'not allowed' } }) },
    }))
    expect(result.stop).toBe('blocked')
    expect(result.messageId).toBeUndefined()
    expect(model.calls).toHaveLength(0)
    expect(messages.saves).toHaveLength(0)
    expect(state.writes).toHaveLength(0)
    expect(chunks.map((c) => c.type)).toEqual(['start', 'message-metadata', 'finish'])
  })

  test('block with persist saves the user message and an EH_INPUT_BLOCKED notice', async () => {
    const { result, model, messages } = await run(() => ({
      hooks: { 'input.submit': () => ({ block: { reason: 'not allowed', persist: true } }) },
    }))
    expect(result.stop).toBe('blocked')
    expect(model.calls).toHaveLength(0)
    const saved = messages.saves.flat()
    expect(saved.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(saved[1]?.parts[0]).toMatchObject({
      type: 'data-eh.notice',
      data: { level: 'warning', code: 'EH_INPUT_BLOCKED', message: 'not allowed' },
    })
    expect(result.messages).toHaveLength(2)
  })

  test('state changes of a turn that ends before its commit point are discarded', async () => {
    let block = true
    const plugin = definePlugin({
      name: 'gate',
      setup: () => ({
        hooks: {
          'input.submit': (ctx) => {
            if (!block) return undefined
            ctx.state.set('leak', true)
            return { block: { reason: 'no' } }
          },
        },
      }),
    })
    const { agent, state } = setup({ model: scriptedModel([{ text: 'ok' }]), plugins: [plugin] })
    const session = agent.session('s1')
    expect((await session.send('first').result).stop).toBe('blocked')
    block = false
    expect((await session.send('second').result).stop).toBe('complete')
    expect(state.writes.some((w) => w.plugins.gate !== undefined)).toBe(false)
  })

  test('a blocked turn (persist) does not count as a model turn in state usage', async () => {
    const { state } = await run(() => ({
      hooks: { 'input.submit': () => ({ block: { reason: 'no', persist: true } }) },
    }))
    expect(state.writes.at(-1)?.core.usage?.turns).toBe(0)
  })

  test('a throwing input.submit hook blocks (fail closed)', async () => {
    const { result, model } = await run(() => ({
      hooks: {
        'input.submit': () => {
          throw new Error('validator down')
        },
      },
    }))
    expect(result.stop).toBe('blocked')
    expect(model.calls).toHaveLength(0)
  })
})

describe('scenario 35: per-turn overrides', () => {
  test('send({ model, settings, options }) validated by callOptions; turn.prepare can switch', async () => {
    const a = scriptedModel([{ text: 'from a' }], { provider: 'openai.chat', modelId: 'a' })
    const b = scriptedModel([{ text: 'from b' }], { provider: 'mock', modelId: 'b' })
    const c = scriptedModel([{ text: 'from c' }], { provider: 'mock', modelId: 'c' })
    const seen: unknown[] = []
    const plugin = definePlugin({
      name: 'router',
      setup: () => ({
        hooks: {
          'turn.prepare': (ctx, e) => {
            seen.push(e.options, ctx.turn?.options)
            return (e.options as { tier: string }).tier === 'cheap' ? { model: c } : undefined
          },
        },
      }),
    })
    const { agent } = setup({
      model: a,
      plugins: [plugin],
      callOptions: z.object({ tier: z.enum(['cheap', 'best']) }),
    })
    const session = agent.session('s1')
    const invalid = await session.send('x', { options: { tier: 'free' } }).result
    expect(invalid.error?.code).toBe('EH_INVALID_INPUT')

    const viaSend = await session.send('x', {
      model: b,
      options: { tier: 'best' },
      settings: { temperature: 0.2 },
    }).result
    expect(viaSend.stop).toBe('complete')
    expect(b.calls[0]?.temperature).toBe(0.2)
    expect(a.calls).toHaveLength(0)

    const viaHook = await session.send('y', { options: { tier: 'cheap' } }).result
    expect(viaHook.stop).toBe('complete')
    expect(c.calls).toHaveLength(1)
    expect(seen).toContainEqual({ tier: 'best' })
    const assistant = viaHook.messages.find((m) => m.id === viaHook.messageId)
    expect(assistant?.metadata?.eharness?.model).toBe('mock/c')
  })

  test('a model switch drops foreign-provider reasoning in projection', async () => {
    const a = scriptedModel([{ reasoning: 'secret chain', text: 'answer a' }], {
      provider: 'anthropic.messages',
      modelId: 'x',
    })
    const b = scriptedModel([{ text: 'answer b' }], { provider: 'openai.chat', modelId: 'y' })
    const { agent } = setup({ model: a })
    const session = agent.session('s1')
    await session.send('one').result
    await session.send('two', { model: b }).result
    expect(JSON.stringify(b.prompts[0])).not.toContain('secret chain')
  })

  test('toolsContext is validated against contextSchema up front', async () => {
    const priced = tool({
      inputSchema: z.object({}),
      contextSchema: z.object({ apiKey: z.string() }),
      execute: async () => 'ok',
    })
    const { agent } = setup({ model: scriptedModel([{ text: 'ok' }]), tools: { priced } })
    const session = agent.session('s1')
    const bad = await session.send('x', { toolsContext: { priced: { apiKey: 1 } } }).result
    expect(bad.error?.code).toBe('EH_INVALID_INPUT')
    const good = await session.send('x', { toolsContext: { priced: { apiKey: 'k' } } }).result
    expect(good.stop).toBe('complete')
  })
})
