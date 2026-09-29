import { describe, expect, test } from 'bun:test'
import { tool } from 'ai'
import { z } from 'zod/v4'
import { defineHarnessAgent } from '../agent/define-agent.ts'
import type { HarnessAgentConfig } from '../agent/types.ts'
import type { HarnessWarning } from '../errors.ts'
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

describe('tool wrapping', () => {
  test('preliminary (AsyncIterable) results pass through; tool.after runs on the final value', async () => {
    const progress = tool({
      inputSchema: z.object({}),
      async *execute() {
        yield { status: 'working', pct: 50 }
        yield { status: 'done', pct: 100 }
      },
    })
    const afterSeen: unknown[] = []
    const plugin = definePlugin({
      name: 'post',
      setup: () => ({
        hooks: {
          'tool.after': (_ctx, e) => {
            afterSeen.push(e.output)
            return { output: { ...(e.output as object), checked: true } }
          },
        },
      }),
    })
    const model = scriptedModel([
      { toolCalls: [{ toolName: 'progress', input: {} }] },
      { text: 'ok' },
    ])
    const { agent } = setup({ model, tools: { progress }, plugins: [plugin] })
    const run = agent.session('s1').send('go')
    const chunks = await collect(run.stream)
    const result = await run.result
    const outputs = chunks.filter((c) => c.type === 'tool-output-available')
    // every yielded value streams as preliminary; the tool.after result is the final output
    expect(outputs.map((c) => (c as { preliminary?: boolean }).preliminary)).toEqual([
      true,
      true,
      true,
      undefined,
    ])
    expect(afterSeen).toEqual([{ status: 'done', pct: 100 }])
    const part = result.messages
      .find((m) => m.id === result.messageId)
      ?.parts.find((p) => p.type === 'tool-progress') as { output: unknown; preliminary?: boolean }
    expect(part.output).toEqual({ status: 'done', pct: 100, checked: true })
    expect(part.preliminary).toBeUndefined()
    expect(JSON.stringify(model.prompts[1])).toContain('"checked":true')
  })

  test('ctx.turn.addUsage counts toward usage and the cost cap', async () => {
    const sub = tool({
      inputSchema: z.object({}),
      execute: async () => 'ok',
    })
    const agentTool = definePlugin({
      name: 'sub',
      session: (ctx) => ({
        tools: {
          subagent: tool({
            inputSchema: z.object({}),
            execute: async () => {
              ctx.turn?.addUsage({
                inputTokens: 100,
                inputTokenDetails: {
                  noCacheTokens: undefined,
                  cacheReadTokens: undefined,
                  cacheWriteTokens: undefined,
                },
                outputTokens: 500,
                outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined },
                totalTokens: 600,
              })
              return 'child done'
            },
          }),
        },
      }),
    })
    const model = scriptedModel([
      { toolCalls: [{ toolName: 'subagent', input: {} }] },
      { text: 'never' },
    ])
    const { agent } = setup({
      model,
      tools: { sub },
      plugins: [agentTool],
      loop: { maxTurnOutputTokens: 200 },
    })
    const result = await agent.session('s1').send('go').result
    expect(result.stop).toBe('cost-cap')
    expect(result.usage).toMatchObject({ inputTokens: 110, outputTokens: 505, totalTokens: 615 })
    const assistant = result.messages.find((m) => m.id === result.messageId)
    expect(assistant?.metadata?.eharness?.usage?.nested).toBe(600)
  })

  test('policy user-approval ends the turn tool-pending with the approval in pending state', async () => {
    let executed = 0
    const pay = tool({
      inputSchema: z.object({ amount: z.number() }),
      execute: async () => {
        executed++
        return 'paid'
      },
    })
    const model = scriptedModel([{ toolCalls: [{ toolName: 'pay', input: { amount: 5 } }] }])
    const { agent } = setup({
      model,
      tools: { pay },
      approval: { policy: { pay: 'user-approval' } },
    })
    const result = await agent.session('s1').send('pay').result
    expect(executed).toBe(0)
    expect(result.stop).toBe('tool-pending')
    expect(result.pending?.approvals).toHaveLength(1)
    expect(result.pending?.approvals[0]).toMatchObject({ toolCallId: 'call-0-0', toolName: 'pay' })
    const part = result.messages
      .find((m) => m.id === result.messageId)
      ?.parts.find((p) => p.type === 'tool-pay') as { state: string }
    expect(part.state).toBe('approval-requested')
  })
})

describe('deprecations', () => {
  test('a tool with needsApproval warns W_DEPRECATED', async () => {
    const legacy = tool({
      inputSchema: z.object({}),
      needsApproval: false,
      execute: async () => 'ok',
    })
    const { agent, warnings } = setup({ model: scriptedModel([{ text: 'x' }]), tools: { legacy } })
    await agent.session('s1').send('go').result
    expect(warnings.map((w) => w.code)).toContain('W_DEPRECATED')
  })
})

describe('persistence', () => {
  test('persistEachStep: false saves the assistant message once, at the end', async () => {
    const noop = tool({ inputSchema: z.object({}), execute: async () => 'ok' })
    const model = scriptedModel([{ toolCalls: [{ toolName: 'noop', input: {} }] }, { text: 'ok' }])
    const { agent, messages } = setup({ model, tools: { noop }, loop: { persistEachStep: false } })
    const result = await agent.session('s1').send('go').result
    const assistantSaves = messages.saves.flat().filter((m) => m.id === result.messageId)
    expect(assistantSaves).toHaveLength(1)
    expect(assistantSaves[0]?.metadata?.eharness?.stop).toBe('complete')
  })

  test('a hot session reloads state and messages when lastId changed (other instance)', async () => {
    const messages = spyMessages()
    const state = spyState()
    const base = { contextWindow: 100_000, storage: { messages, state }, logger: silent }
    const modelA = scriptedModel([{ text: 'a1' }, { text: 'a2' }])
    const modelB = scriptedModel([{ text: 'b1' }])
    const a = defineHarnessAgent({ ...base, model: modelA })
    const b = defineHarnessAgent({ ...base, model: modelB })
    const sessionA = a.session('s1')
    await sessionA.send('from A').result
    await b.session('s1').send('from B').result
    const loadsBefore = messages.loads.length
    await sessionA.send('A again').result
    expect(messages.loads.length).toBeGreaterThan(loadsBefore)
    const prompt = JSON.stringify(modelA.prompts[1])
    expect(prompt).toContain('from B')
    expect(prompt).toContain('b1')
    // without a foreign write the hot path performs no reads
    const loads = messages.loads.length
    await b.session('s1').close()
    const modelC = scriptedModel([{ text: 'c1' }, { text: 'c2' }])
    const c = defineHarnessAgent({ ...base, model: modelC })
    const sessionC = c.session('s1')
    await sessionC.send('one').result
    const afterFirst = messages.loads.length
    await sessionC.send('two').result
    expect(messages.loads.length).toBe(afterFirst)
    expect(afterFirst).toBeGreaterThan(loads)
  })

  test('a custom generateId that does not respect the floor is logged', async () => {
    const warned: string[] = []
    let n = 0
    const messages = spyMessages()
    await messages.save('s1', [
      {
        id: 'zzzz',
        role: 'user',
        metadata: { eharness: { v: 1, createdAt: 1 } },
        parts: [{ type: 'text', text: 'x' }],
      } as HarnessUIMessage,
    ])
    const agent = defineHarnessAgent({
      model: scriptedModel([{ text: 'ok' }]),
      contextWindow: 100_000,
      storage: { messages },
      generateId: () => `id-${String(++n).padStart(4, '0')}`,
      logger: { ...silent, warn: (m) => void warned.push(m) },
    })
    const result = await agent.session('s1').send('hi').result
    expect(result.stop).toBe('complete')
    expect(warned.some((m) => m.includes('does not sort after'))).toBe(true)
  })
})

describe('HarnessRun', () => {
  test('pipeTo writes the SSE stream to a Node-style response', async () => {
    const { agent } = setup({ model: scriptedModel([{ text: 'hello' }]) })
    const run = agent.session('s1').send('go')
    const written: string[] = []
    let ended = false
    const response = {
      setHeaders: () => response,
      writeHead: () => response,
      write: (chunk: string | Uint8Array) => {
        written.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk))
        return true
      },
      end: () => {
        ended = true
      },
      on: () => response,
      once: () => response,
      off: () => response,
      removeListener: () => response,
      emit: () => true,
      flushHeaders: () => {},
    }
    await run.pipeTo(response as never)
    await run.result
    await new Promise((r) => setTimeout(r, 10))
    expect(written.join('')).toContain('"type":"finish"')
    expect(ended).toBe(true)
  })
})
