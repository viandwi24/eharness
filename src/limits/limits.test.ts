import { describe, expect, test } from 'bun:test'
import { tool } from 'ai'
import { z } from 'zod'
import { defineHarnessAgent, type HarnessAgentConfig, isKindMessage } from '../index.ts'
import { inMemoryBudgetLedger, inMemoryMessages, inMemoryState } from '../storage/memory.ts'
import { scriptedModel } from '../testing/scripted-model.ts'
import { budgetNotice, defaultBudgetText, stepBudget, trackRefusals } from './index.ts'

const silent = { debug() {}, info() {}, warn() {}, error() {} }

function agentWith(
  config: Omit<Partial<HarnessAgentConfig>, 'model'> & Pick<HarnessAgentConfig, 'model'>,
) {
  return defineHarnessAgent({
    contextWindow: 100_000,
    storage: { messages: inMemoryMessages(), state: inMemoryState() },
    logger: silent,
    ...config,
  })
}

let counter = 0
const nope = tool({
  description: 'noop',
  inputSchema: z.object({ n: z.number() }),
  execute: async () => `result ${counter++}`,
})
const call = (n: number) => ({ toolCalls: [{ toolName: 'nope', input: { n } }] })

describe('stepBudget', () => {
  test('extends maxSteps in chunks up to the cap', async () => {
    const steps = Array.from({ length: 12 }, (_, i) => call(i))
    const model = scriptedModel([...steps, { text: 'done' }])
    const agent = agentWith({
      model,
      tools: { nope },
      loop: { maxSteps: 2, wrapUp: false, progress: false },
      plugins: [stepBudget({ chunk: 3, cap: 8 })],
    })
    const result = await agent.session('s').send('go').result
    expect(result.stop).toBe('max-steps')
    expect(model.calls.length).toBe(8)
  })

  test('cap as a function; 0 never extends', async () => {
    const model = scriptedModel(Array.from({ length: 10 }, (_, i) => call(i)))
    const agent = agentWith({
      model,
      tools: { nope },
      loop: { maxSteps: 2, wrapUp: false, progress: false },
      plugins: [stepBudget({ cap: (ctx) => (ctx.session.id === 'long' ? 5 : 0) })],
    })
    await agent.session('short').send('go').result
    expect(model.calls.length).toBe(2)
  })

  test('wrapUp adds a reminder near the cap', async () => {
    const model = scriptedModel([call(0), call(1), call(2), call(3), { text: 'ok' }])
    const agent = agentWith({
      model,
      tools: { nope },
      loop: { maxSteps: 2, wrapUp: false, progress: false },
      plugins: [stepBudget({ chunk: 10, cap: 4, wrapUp: 'WRAP NOW' })],
    })
    await agent.session('s').send('go').result
    const text = (i: number): string => JSON.stringify(model.calls[i]?.prompt)
    expect(text(3)).toContain('WRAP NOW')
  })
})

describe('budgetNotice', () => {
  test('a cost-cap turn stores a readable notice', async () => {
    const tracker = trackRefusals(inMemoryBudgetLedger({ limits: { 'user:a': 0 } }))
    const agent = agentWith({
      model: scriptedModel([{ text: 'never' }]),
      budget: { ledger: { adapter: tracker.ledger, scopes: () => ['user:a'] } },
      plugins: [budgetNotice({ refusals: tracker })],
    })
    const result = await agent.session('s').send('hi').result
    expect(result.stop).toBe('cost-cap')
    const stored = await agent.session('s').messages()
    const notice = stored.find((m) => isKindMessage(m, 'eh.notice'))
    expect(JSON.stringify(notice)).toContain('user:a')
  })

  test('text option replaces the message; empty string stores nothing', async () => {
    const tracker = trackRefusals(inMemoryBudgetLedger({ limits: { x: 0 } }))
    const agent = agentWith({
      model: scriptedModel([{ text: 'never' }]),
      budget: { ledger: { adapter: tracker.ledger, scopes: () => ['x'] } },
      plugins: [budgetNotice({ refusals: tracker, text: () => '' })],
    })
    await agent.session('s').send('hi').result
    const stored = await agent.session('s').messages()
    expect(stored.some((m) => isKindMessage(m, 'eh.notice'))).toBe(false)
  })

  test('defaultBudgetText without a refusal is generic', () => {
    expect(defaultBudgetText(undefined)).toContain('spending limit')
  })
})
