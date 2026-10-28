import { describe, expect, test } from 'bun:test'
import type { LanguageModelUsage } from 'ai'
import { scriptedModel } from '../testing/scripted-model.ts'
import { lookupModel, modelsDevCatalog, openRouterCatalog } from './catalog.ts'
import { computeCost } from './cost.ts'

const usage = (u: Partial<LanguageModelUsage>): LanguageModelUsage =>
  ({
    inputTokens: undefined,
    outputTokens: undefined,
    totalTokens: undefined,
    inputTokenDetails: {
      noCacheTokens: undefined,
      cacheReadTokens: undefined,
      cacheWriteTokens: undefined,
    },
    outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined },
    ...u,
  }) as LanguageModelUsage

describe('computeCost', () => {
  test('uncached, cache read/write, text and reasoning at their rates (USD per 1M)', () => {
    const cost = computeCost(
      usage({
        inputTokens: 1_000_000,
        inputTokenDetails: {
          noCacheTokens: 600_000,
          cacheReadTokens: 300_000,
          cacheWriteTokens: 100_000,
        },
        outputTokens: 200_000,
        outputTokenDetails: { textTokens: 150_000, reasoningTokens: 50_000 },
      }),
      { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    )
    // 0.6×3 + 0.3×0.3 + 0.1×3.75 + 0.15×15 + 0.05×15 (reasoning = output rate)
    expect(cost).toBeCloseTo(1.8 + 0.09 + 0.375 + 2.25 + 0.75, 10)
  })

  test('missing details: uncached = input − cache; defaults 1× read, 1.25× write', () => {
    const cost = computeCost(
      usage({
        inputTokens: 1_000_000,
        inputTokenDetails: {
          noCacheTokens: undefined,
          cacheReadTokens: 200_000,
          cacheWriteTokens: 200_000,
        },
        outputTokens: 0,
      }),
      { input: 1, output: 2 },
    )
    expect(cost).toBeCloseTo(0.6 + 0.2 + 0.25, 10)
  })

  test('a tier reprices the whole call once the prompt is above its threshold', () => {
    const pricing = { input: 1, output: 2, tiers: [{ above: 200_000, input: 2, output: 4 }] }
    expect(computeCost(usage({ inputTokens: 200_000, outputTokens: 1_000 }), pricing)).toBeCloseTo(
      0.2 + 0.002,
      10,
    )
    expect(computeCost(usage({ inputTokens: 200_001, outputTokens: 1_000 }), pricing)).toBeCloseTo(
      (200_001 * 2 + 1_000 * 4) / 1e6,
      10,
    )
  })

  test('the highest matching tier wins regardless of array order', () => {
    const tiers = [
      { above: 250_000, input: 3, output: 6 },
      { above: 200_000, input: 2, output: 4 },
    ]
    const pricing = { input: 1, output: 2, tiers }
    expect(computeCost(usage({ inputTokens: 300_000, outputTokens: 0 }), pricing)).toBeCloseTo(
      0.9,
      10,
    )
    expect(computeCost(usage({ inputTokens: 220_000, outputTokens: 0 }), pricing)).toBeCloseTo(
      0.44,
      10,
    )
  })

  test('NaN and negative counts are ignored', () => {
    expect(
      computeCost(usage({ inputTokens: Number.NaN, outputTokens: -5 }), { input: 1, output: 1 }),
    ).toBe(0)
  })
})

describe('catalog', () => {
  const data = {
    anthropic: {
      models: {
        'claude-x': {
          limit: { context: 200_000, output: 64_000 },
          cost: {
            input: 3,
            output: 15,
            cache_read: 0.3,
            cache_write: 3.75,
            context_over_200k: { input: 6, output: 22.5 },
          },
        },
      },
    },
    openai: {
      models: {
        'gpt-y': {
          limit: { context: 400_000, output: 128_000 },
          cost: {
            input: 1.25,
            output: 10,
            tiers: [{ input: 2.5, output: 20, tier: { type: 'context', size: 272_000 } }],
          },
        },
        'claude-x': { limit: { context: 1 } },
        broken: 'nope',
      },
    },
  }

  test('modelsDevCatalog maps limits, prices and tiers; the short key keeps the first provider', () => {
    const catalog = modelsDevCatalog(data)
    expect(catalog['anthropic/claude-x']).toEqual({
      contextWindow: 200_000,
      maxOutputTokens: 64_000,
      pricing: {
        input: 3,
        output: 15,
        cacheRead: 0.3,
        cacheWrite: 3.75,
        tiers: [{ input: 6, output: 22.5, above: 200_000 }],
      },
    })
    expect(catalog['gpt-y']?.pricing?.tiers).toEqual([{ input: 2.5, output: 20, above: 272_000 }])
    expect(catalog['claude-x']?.contextWindow).toBe(200_000)
    expect(catalog.broken).toBeUndefined()
    expect(modelsDevCatalog(null)).toEqual({})
  })

  test('lookup: gateway id, provider family + model id, then model id; functions may throw', () => {
    const catalog = modelsDevCatalog(data)
    expect(lookupModel(catalog, 'anthropic/claude-x')?.contextWindow).toBe(200_000)
    const instance = scriptedModel([])
    Object.assign(instance, { provider: 'openai.responses', modelId: 'gpt-y' })
    expect(lookupModel(catalog, instance)?.contextWindow).toBe(400_000)
    expect(lookupModel(catalog, 'unknown/model')).toBeUndefined()
    expect(
      lookupModel(() => {
        throw new Error('x')
      }, 'a/b'),
    ).toBeUndefined()
    expect(lookupModel(undefined, 'a/b')).toBeUndefined()
  })
})

describe('thinking in catalogs', () => {
  test('OpenRouter: supported efforts, mandatory and default; reasoning parameter alone', () => {
    const c = openRouterCatalog({
      data: [
        {
          id: 'a/flash',
          supported_parameters: ['reasoning', 'tools'],
          reasoning: {
            mandatory: false,
            supported_efforts: ['max', 'high', 'low', 'none', 'turbo'],
            default_effort: 'high',
          },
        },
        {
          id: 'b/opus',
          reasoning: { mandatory: true, supported_efforts: ['xhigh', 'low'] },
        },
        { id: 'c/plain', supported_parameters: ['reasoning'] },
        { id: 'd/none', supported_parameters: ['tools'] },
      ],
    })
    expect(c['a/flash']?.thinking).toEqual({
      levels: ['max', 'high', 'low', 'none'],
      defaultLevel: 'high',
    })
    expect(c['b/opus']?.thinking).toEqual({ levels: ['xhigh', 'low'], mandatory: true })
    expect(c['c/plain']?.thinking).toEqual({})
    expect(c['d/none']?.thinking).toBeUndefined()
  })

  test('models.dev: reasoning true means it thinks, levels unknown', () => {
    const c = modelsDevCatalog({
      p: { models: { r: { reasoning: true }, n: { reasoning: false, limit: { context: 1000 } } } },
    })
    expect(c['p/r']?.thinking).toEqual({})
    expect(c['p/n']?.thinking).toBeUndefined()
  })
})

describe('openRouterCatalog', () => {
  test('maps limits and per-token prices to rates per 1M tokens', () => {
    const catalog = openRouterCatalog({
      data: [
        {
          id: 'anthropic/claude-x',
          context_length: 200_000,
          top_provider: { max_completion_tokens: 64_000 },
          pricing: { prompt: '0.000003', completion: '0.000015', input_cache_read: '0.0000003' },
        },
        {
          id: 'openrouter/auto',
          context_length: 2_000_000,
          pricing: { prompt: '-1', completion: '-1' },
        },
        { id: '' },
        null,
        { name: 'no id' },
      ],
    })
    expect(Object.keys(catalog)).toEqual(['anthropic/claude-x', 'openrouter/auto'])
    expect(catalog['anthropic/claude-x']).toEqual({
      contextWindow: 200_000,
      maxOutputTokens: 64_000,
      pricing: { input: 3, output: 15, cacheRead: 0.3 },
    })
    expect(catalog['openrouter/auto']).toEqual({ contextWindow: 2_000_000 })
    expect(lookupModel(catalog, 'anthropic/claude-x')?.contextWindow).toBe(200_000)
  })

  test('garbage input gives an empty catalog', () => {
    expect(openRouterCatalog(undefined)).toEqual({})
    expect(openRouterCatalog({ data: 'x' })).toEqual({})
  })
})

describe('input modalities', () => {
  test('modelsDevCatalog reads modalities.input, openRouterCatalog architecture.input_modalities', () => {
    const dev = modelsDevCatalog({
      p: { models: { m: { modalities: { input: ['Text', 'image', 7] } }, n: {} } },
    })
    expect(dev['p/m']?.inputModalities).toEqual(['text', 'image'])
    expect(dev['p/n']?.inputModalities).toBeUndefined()
    const or = openRouterCatalog({
      data: [{ id: 'a/b', architecture: { input_modalities: ['text', 'file'] } }, { id: 'a/c' }],
    })
    expect(or['a/b']?.inputModalities).toEqual(['text', 'file'])
    expect(or['a/c']?.inputModalities).toBeUndefined()
  })
})
