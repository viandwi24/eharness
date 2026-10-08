import { describe, expect, test } from 'bun:test'
import { utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { lookupModel } from 'eharness'
import {
  gatewayModelOptions,
  loadModelCatalog,
  loadOpenRouterModels,
  loadProviderModels,
  parseOpenRouterModels,
} from '../src/app/models.ts'
import { tempDir } from './helpers.ts'

const data = {
  anthropic: {
    models: {
      'claude-x': {
        limit: { context: 123_456, output: 8000 },
        cost: { input: 3, output: 15 },
      },
    },
  },
}
const okFetch = (async () => new Response(JSON.stringify(data))) as unknown as typeof fetch

describe('models catalog', () => {
  test('offline without a cache: no catalog and no fetch', async () => {
    const dir = await tempDir()
    let called = false
    const f = (async () => {
      called = true
      return new Response('{}')
    }) as unknown as typeof fetch
    const { catalog } = await loadModelCatalog(dir, { offline: true, fetch: f })
    expect(catalog).toBeUndefined()
    expect(called).toBe(false)
  })

  test('first run fetches and caches; later runs read the fresh cache without fetching', async () => {
    const dir = await tempDir()
    const first = await loadModelCatalog(dir, { offline: false, fetch: okFetch })
    expect(lookupModel(first.catalog, 'anthropic/claude-x')?.contextWindow).toBe(123_456)
    let called = false
    const f = (async () => {
      called = true
      return new Response('{}')
    }) as unknown as typeof fetch
    const second = await loadModelCatalog(dir, { offline: false, fetch: f })
    expect(called).toBe(false)
    expect(lookupModel(second.catalog, 'anthropic/claude-x')?.pricing?.input).toBe(3)
  })

  test('a stale cache is used at once and refreshed in the background; failures keep it', async () => {
    const dir = await tempDir()
    const file = join(dir, 'models.json')
    await writeFile(file, JSON.stringify(data))
    const old = new Date(Date.now() - 48 * 3600 * 1000)
    await utimes(file, old, old)
    const failing = (async () => {
      throw new Error('network down')
    }) as unknown as typeof fetch
    const r = await loadModelCatalog(dir, { offline: false, fetch: failing })
    expect(lookupModel(r.catalog, 'anthropic/claude-x')?.contextWindow).toBe(123_456)
    await r.refresh
    const again = await loadModelCatalog(dir, { offline: true })
    expect(lookupModel(again.catalog, 'anthropic/claude-x')).toBeDefined()
  })
})

const openRouterFixture = {
  data: [
    {
      id: 'vendor/no-tools',
      name: 'Zeta No Tools',
      context_length: 8000,
      pricing: { prompt: '0.000001', completion: '0.000002' },
      supported_parameters: ['max_tokens'],
    },
    {
      id: 'anthropic/claude-sonnet-5.5',
      name: 'Anthropic: Claude Sonnet 5.5',
      description: 'A model.',
      context_length: 1_000_000,
      top_provider: { max_completion_tokens: 128_000 },
      pricing: { prompt: '0.000002', completion: '0.00001', input_cache_read: '0.0000001' },
      supported_parameters: ['tools', 'reasoning', 'max_tokens'],
    },
    {
      id: 'openrouter/auto',
      name: 'Auto Router',
      context_length: 2_000_000,
      pricing: { prompt: '-1', completion: '-1' },
      supported_parameters: ['tools'],
    },
    { name: 'no id' },
    null,
  ],
}

describe('OpenRouter catalog', () => {
  test('parses limits, prices per 1M tokens and capability flags; tool-capable models come first', () => {
    const { catalog, options } = parseOpenRouterModels(openRouterFixture)
    expect(options.map((o) => o.id)).toEqual([
      'anthropic/claude-sonnet-5.5',
      'openrouter/auto',
      'vendor/no-tools',
    ])
    expect(options[0]).toMatchObject({
      provider: 'openrouter',
      name: 'Anthropic: Claude Sonnet 5.5',
      contextWindow: 1_000_000,
      maxOutputTokens: 128_000,
      pricing: { input: 2, output: 10, cacheRead: 0.1 },
      reasoning: true,
      tools: true,
      description: 'A model.',
    })
    expect(options[1]?.pricing).toBeUndefined()
    expect(options[2]).toMatchObject({ reasoning: false, tools: false })
    expect(catalog['anthropic/claude-sonnet-5.5']).toEqual({
      contextWindow: 1_000_000,
      maxOutputTokens: 128_000,
      pricing: { input: 2, output: 10, cacheRead: 0.1 },
    })
    expect(parseOpenRouterModels('garbage').options).toEqual([])
  })

  test('the catalog resolves an OpenRouter model instance by its id', () => {
    const { catalog } = parseOpenRouterModels(openRouterFixture)
    const instance = { provider: 'openrouter.chat', modelId: 'anthropic/claude-sonnet-5.5' }
    expect(lookupModel(catalog, instance as never)?.contextWindow).toBe(1_000_000)
  })

  test('loads from a cache file offline without touching the network', async () => {
    const dir = await tempDir()
    await writeFile(join(dir, 'openrouter-models.json'), JSON.stringify(openRouterFixture))
    let called = false
    const f = (async () => {
      called = true
      return new Response('{}')
    }) as unknown as typeof fetch
    const r = await loadProviderModels('openrouter', dir, { offline: true, fetch: f })
    expect(called).toBe(false)
    expect(r.options).toHaveLength(3)
    expect(lookupModel(r.catalog, 'anthropic/claude-sonnet-5.5')?.pricing?.output).toBe(10)
  })

  test('offline without a cache is empty; a first online run fetches and caches', async () => {
    const dir = await tempDir()
    expect((await loadOpenRouterModels(dir, { offline: true })).options).toEqual([])
    const urls: string[] = []
    const f = (async (url: string) => {
      urls.push(url)
      return new Response(JSON.stringify(openRouterFixture))
    }) as unknown as typeof fetch
    expect((await loadOpenRouterModels(dir, { offline: false, fetch: f })).options).toHaveLength(3)
    expect(urls).toEqual(['https://openrouter.ai/api/v1/models'])
    expect((await loadOpenRouterModels(dir, { offline: true })).options).toHaveLength(3)
  })

  test('a failing fetch leaves an empty list', async () => {
    const dir = await tempDir()
    const f = (async () => {
      throw new Error('down')
    }) as unknown as typeof fetch
    expect((await loadOpenRouterModels(dir, { offline: false, fetch: f })).options).toEqual([])
  })

  test('gateway options come from the models.dev data', () => {
    const options = gatewayModelOptions({
      anthropic: {
        models: {
          'claude-x': {
            name: 'Claude X',
            tool_call: true,
            reasoning: true,
            limit: { context: 200_000, output: 8000 },
            cost: { input: 3, output: 15, cache_read: 0.3 },
          },
        },
      },
      other: { models: { y: { name: 'Y', tool_call: true } } },
    })
    expect(options).toEqual([
      {
        id: 'anthropic/claude-x',
        name: 'Claude X',
        provider: 'gateway',
        contextWindow: 200_000,
        maxOutputTokens: 8000,
        pricing: { input: 3, output: 15, cacheRead: 0.3 },
        reasoning: true,
        tools: true,
      },
    ])
  })
})
