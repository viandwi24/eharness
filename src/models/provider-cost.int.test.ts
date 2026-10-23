/**
 * Provider-reported cost and upstream provider (spec 12 §3, §7): the billed cost wins over the
 * catalog estimate, the estimate is the fallback, the ledger settles with the real figure, and
 * the model-call event names the upstream provider.
 */
import { describe, expect, test } from 'bun:test'
import { generateText } from 'ai'
import { defineHarnessAgent } from '../agent/define-agent.ts'
import { definePlugin } from '../plugin/define-plugin.ts'
import { inMemoryBudgetLedger } from '../storage/memory.ts'
import { scriptedModel } from '../testing/scripted-model.ts'
import { providerReportedCost, settledCostOf } from './cost.ts'
import type { ModelCallEvent } from './observe.ts'
import { observeModel } from './observe.ts'

const silent = { debug() {}, info() {}, warn() {}, error() {} }
const settle = () => new Promise((r) => setTimeout(r, 10))
const billed = (cost: number | string, provider = 'Anthropic') => ({
  openrouter: { provider, usage: { cost } },
})

describe('providerReportedCost', () => {
  test('reads openrouter usage.cost and gateway cost; ignores junk', () => {
    expect(providerReportedCost({ openrouter: { usage: { cost: 0.0123 } } })).toBe(0.0123)
    expect(providerReportedCost({ gateway: { cost: '0.5' } })).toBe(0.5)
    expect(providerReportedCost({ openrouter: { usage: { cost: 0 } } })).toBe(0)
    expect(providerReportedCost({ openrouter: { usage: { cost: -1 } } })).toBeUndefined()
    expect(providerReportedCost({ openrouter: { usage: { cost: 'x' } } })).toBeUndefined()
    expect(providerReportedCost({ openrouter: {} })).toBeUndefined()
    expect(providerReportedCost(undefined)).toBeUndefined()
  })

  test('settledCostOf: provider wins, estimate falls back, unknown is undefined', () => {
    const usage = { inputTokens: 1000, outputTokens: 1000 } as never
    const model = scriptedModel([], { provider: 'p', modelId: 'm' })
    const models = { 'p/m': { contextWindow: 1e5, pricing: { input: 1_000, output: 1_000 } } }
    expect(settledCostOf(models, model, usage, billed(0.25))).toEqual({
      costUsd: 0.25,
      source: 'provider',
    })
    expect(settledCostOf(models, model, usage, {})).toEqual({ costUsd: 2, source: 'estimate' })
    expect(settledCostOf(undefined, model, usage, {})).toBeUndefined()
  })
})

describe('step cost and ledger', () => {
  test('the ledger commits the provider-reported cost; reservation stays the estimate', async () => {
    const ledger = inMemoryBudgetLedger()
    const reserved: number[] = []
    const spy = {
      ...ledger,
      reserve: async (r: never) => {
        reserved.push((r as { amountUsd: number }).amountUsd)
        return ledger.reserve(r)
      },
    }
    const model = scriptedModel(
      [{ text: 'a', usage: { inputTokens: 10, outputTokens: 5 }, providerMetadata: billed(0.5) }],
      { provider: 'p', modelId: 'm' },
    )
    const agent = defineHarnessAgent({
      model,
      contextWindow: 100_000,
      logger: silent,
      models: { 'p/m': { contextWindow: 1e5, pricing: { input: 0, output: 1_000 } } },
      budget: { ledger: { adapter: spy as never, scopes: () => ['u'], estimate: () => 0.01 } },
    } as never)
    const result = await agent.session('s1').send('hi').result
    expect(result.usage.costUsd).toBeCloseTo(0.5, 10)
    expect(reserved).toEqual([0.01])
    const status = (await ledger.check(['u'])).scopes[0]
    expect(status?.spentUsd).toBeCloseTo(0.5, 10)
    expect(status?.reservedUsd).toBe(0)
  })

  test('without a reported cost the estimate settles', async () => {
    const model = scriptedModel([{ text: 'a', usage: { inputTokens: 10, outputTokens: 5 } }], {
      provider: 'p',
      modelId: 'm',
    })
    const agent = defineHarnessAgent({
      model,
      contextWindow: 100_000,
      logger: silent,
      models: { 'p/m': { contextWindow: 1e5, pricing: { input: 0, output: 1_000 } } },
    } as never)
    const result = await agent.session('s1').send('hi').result
    expect(result.usage.costUsd).toBeCloseTo(0.005, 10)
  })
})

describe('model.call event', () => {
  test('costSource, costUsd and upstreamProvider come from the response metadata', async () => {
    const events: ModelCallEvent[] = []
    const probe = definePlugin({
      name: 'probe',
      setup: () => ({ hooks: { 'model.call': (_ctx, e) => void events.push(e) } }),
    })
    const model = scriptedModel(
      [{ text: 'a', providerMetadata: billed(0.5, 'Amazon Bedrock') }, { text: 'b' }],
      { provider: 'p', modelId: 'm' },
    )
    const agent = defineHarnessAgent({
      model,
      contextWindow: 100_000,
      logger: silent,
      plugins: [probe],
      models: { 'p/m': { contextWindow: 1e5, pricing: { input: 0, output: 1_000 } } },
    } as never)
    await agent.session('s1').send('one').result
    await agent.session('s2').send('two').result
    await settle()
    expect(events[0]).toMatchObject({
      costUsd: 0.5,
      costSource: 'provider',
      upstreamProvider: 'Amazon Bedrock',
    })
    expect(events[1]).toMatchObject({ costSource: 'estimate' })
    expect(events[1]?.upstreamProvider).toBeUndefined()
  })

  test('observeModel records upstreamProvider for generate calls', async () => {
    const records: { upstreamProvider?: string }[] = []
    const model = observeModel(
      scriptedModel([{ text: 'a', providerMetadata: billed(0.1, 'Fireworks') }]),
      (r) => void records.push(r),
    )
    await generateText({ model, prompt: 'hi' })
    expect(records[0]?.upstreamProvider).toBe('Fireworks')
  })
})
