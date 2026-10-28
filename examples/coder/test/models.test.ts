import { describe, expect, test } from 'bun:test'
import { readFile, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { lookupModel } from 'eharness'
import { createCoderProviders } from '../src/app/provider.ts'
import { tempDir } from './helpers.ts'

const data = {
  anthropic: {
    models: {
      'claude-x': {
        name: 'Claude X',
        tool_call: true,
        reasoning: true,
        limit: { context: 123_456, output: 8000 },
        cost: { input: 3, output: 15, cache_read: 0.3 },
      },
    },
  },
  other: { models: { y: { name: 'Y', tool_call: true } } },
}
const okFetch = (async () => new Response(JSON.stringify(data))) as unknown as typeof fetch
const downFetch = (async () => {
  throw new Error('network down')
}) as unknown as typeof fetch
const counting = (body: unknown): { fetch: typeof fetch; urls: string[] } => {
  const urls: string[] = []
  const f = (async (url: string) => {
    urls.push(String(url))
    return new Response(JSON.stringify(body))
  }) as unknown as typeof fetch
  return { fetch: f, urls }
}

describe('gateway catalog (models.dev, <userDir>/models.json)', () => {
  test('offline without a cache: no options, no fetch', async () => {
    const dir = await tempDir()
    const { fetch: f, urls } = counting({})
    const p = createCoderProviders({
      provider: 'gateway',
      userDir: dir,
      env: {},
      fetch: f,
      offline: true,
    })
    await p.load()
    expect(await p.options()).toEqual([])
    expect(urls).toEqual([])
  })

  test('CODER_OFFLINE=1 in the environment is the default offline switch', async () => {
    const dir = await tempDir()
    const { fetch: f, urls } = counting(data)
    const p = createCoderProviders({
      provider: 'gateway',
      userDir: dir,
      env: { CODER_OFFLINE: '1' },
      fetch: f,
    })
    await p.load()
    expect(urls).toEqual([])
  })

  test('first run fetches and caches at models.json; later runs read the fresh cache', async () => {
    const dir = await tempDir()
    const first = createCoderProviders({
      provider: 'gateway',
      userDir: dir,
      env: {},
      fetch: okFetch,
      offline: false,
    })
    await first.load()
    expect(JSON.parse(await readFile(join(dir, 'models.json'), 'utf8'))).toEqual(data)
    const { fetch: f, urls } = counting({})
    const second = createCoderProviders({
      provider: 'gateway',
      userDir: dir,
      env: {},
      fetch: f,
      offline: false,
    })
    await second.load()
    expect(urls).toEqual([])
    expect(lookupModel(second.catalog(), 'anthropic/claude-x')?.pricing?.input).toBe(3)
    expect(lookupModel(second.catalog(), 'anthropic/claude-x')?.contextWindow).toBe(123_456)
  })

  test('a stale cache is used at once and refreshed in the background; failures keep it', async () => {
    const dir = await tempDir()
    const file = join(dir, 'models.json')
    await writeFile(file, JSON.stringify(data))
    const old = new Date(Date.now() - 48 * 3600 * 1000)
    await utimes(file, old, old)
    const p = createCoderProviders({
      provider: 'gateway',
      userDir: dir,
      env: {},
      fetch: downFetch,
      offline: false,
    })
    await p.load()
    expect(lookupModel(p.catalog(), 'anthropic/claude-x')?.contextWindow).toBe(123_456)
    const again = createCoderProviders({
      provider: 'gateway',
      userDir: dir,
      env: {},
      offline: true,
    })
    await again.load()
    expect(lookupModel(again.catalog(), 'anthropic/claude-x')).toBeDefined()
  })

  test('picker options come from the models.dev data, only for the gateway providers', async () => {
    const dir = await tempDir()
    await writeFile(join(dir, 'models.json'), JSON.stringify(data))
    const p = createCoderProviders({ provider: 'gateway', userDir: dir, env: {}, offline: true })
    await p.load()
    expect(await p.options()).toEqual([
      {
        id: 'anthropic/claude-x',
        name: 'Claude X',
        provider: 'gateway',
        contextWindow: 123_456,
        maxOutputTokens: 8000,
        pricing: { input: 3, output: 15, cacheRead: 0.3 },
        reasoning: true,
        tools: true,
      },
    ])
  })

  test('models are plain ids; the catalog prices them by string', async () => {
    const dir = await tempDir()
    await writeFile(join(dir, 'models.json'), JSON.stringify(data))
    const p = createCoderProviders({ provider: 'gateway', userDir: dir, env: {}, offline: true })
    await p.load()
    expect(p.resolve('anthropic/claude-x')).toBe('anthropic/claude-x')
    expect(lookupModel(p.catalog(), 'anthropic/claude-x')?.contextWindow).toBe(123_456)
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

describe('OpenRouter catalog (<userDir>/openrouter-models.json)', () => {
  const env = { OPENROUTER_API_KEY: 'k' }

  test('picker: limits, prices per 1M tokens and capability flags; tool-capable models first', async () => {
    const dir = await tempDir()
    await writeFile(join(dir, 'openrouter-models.json'), JSON.stringify(openRouterFixture))
    const p = createCoderProviders({ provider: 'openrouter', userDir: dir, env, offline: true })
    await p.load()
    const options = await p.options()
    expect(options.map((o) => o.id)).toEqual([
      'anthropic/claude-sonnet-5.5',
      'openrouter/auto',
      'vendor/no-tools',
    ])
    expect(options[0]).toEqual({
      id: 'anthropic/claude-sonnet-5.5',
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
  })

  test('the catalog prices the resolved OpenRouter model instance; offline never fetches', async () => {
    const dir = await tempDir()
    await writeFile(join(dir, 'openrouter-models.json'), JSON.stringify(openRouterFixture))
    const { fetch: f, urls } = counting({})
    const p = createCoderProviders({
      provider: 'openrouter',
      userDir: dir,
      env,
      fetch: f,
      offline: true,
    })
    await p.load()
    expect(urls).toEqual([])
    const model = p.resolve('anthropic/claude-sonnet-5.5') as { modelId: string }
    expect(model.modelId).toBe('anthropic/claude-sonnet-5.5')
    expect(lookupModel(p.catalog(), model as never)).toEqual({
      contextWindow: 1_000_000,
      maxOutputTokens: 128_000,
      pricing: { input: 2, output: 10, cacheRead: 0.1 },
      // the fixture lists the `reasoning` parameter: it thinks, levels unknown
      thinking: {},
    })
  })

  test('offline without a cache is empty; a first online run fetches and caches', async () => {
    const dir = await tempDir()
    const offline = createCoderProviders({
      provider: 'openrouter',
      userDir: dir,
      env,
      offline: true,
    })
    await offline.load()
    expect(await offline.options()).toEqual([])
    const { fetch: f, urls } = counting(openRouterFixture)
    const online = createCoderProviders({
      provider: 'openrouter',
      userDir: dir,
      env,
      fetch: f,
      offline: false,
    })
    await online.load()
    expect(await online.options()).toHaveLength(3)
    expect(urls).toEqual(['https://openrouter.ai/api/v1/models'])
    expect(JSON.parse(await readFile(join(dir, 'openrouter-models.json'), 'utf8'))).toEqual(
      openRouterFixture,
    )
  })

  test('a failing fetch leaves an empty list', async () => {
    const dir = await tempDir()
    const p = createCoderProviders({
      provider: 'openrouter',
      userDir: dir,
      env,
      fetch: downFetch,
      offline: false,
    })
    await p.load()
    expect(await p.options()).toEqual([])
  })

  test('only the selected provider catalog is fetched, even with both keys set', async () => {
    const dir = await tempDir()
    const { fetch: f, urls } = counting(openRouterFixture)
    const p = createCoderProviders({
      provider: 'openrouter',
      userDir: dir,
      env: { OPENROUTER_API_KEY: 'k', AI_GATEWAY_API_KEY: 'g' },
      fetch: f,
      offline: false,
    })
    await p.load()
    expect(urls).toEqual(['https://openrouter.ai/api/v1/models'])
  })
})

describe('provider profile from the environment', () => {
  test('the OpenRouter key and OPENROUTER_BASE_URL become the profile', async () => {
    const dir = await tempDir()
    const p = createCoderProviders({
      provider: 'openrouter',
      userDir: dir,
      env: { OPENROUTER_API_KEY: 'sk-secret', OPENROUTER_BASE_URL: 'http://localhost:1/api/v1' },
      offline: true,
    })
    await p.manager.ready()
    const profile = await p.manager.getProfile('openrouter')
    expect(profile?.source).toBe('env')
    const model = p.resolve('a/b') as { provider: string; modelId: string }
    expect(model.provider).toContain('openrouter')
    expect(JSON.stringify(profile)).not.toContain('sk-secret')
  })

  test('without a key resolving fails with the startup hint, never with a key', async () => {
    const dir = await tempDir()
    const p = createCoderProviders({
      provider: 'openrouter',
      userDir: dir,
      env: { AI_GATEWAY_API_KEY: 'gw-secret' },
      offline: true,
    })
    expect(() => p.resolve('a/b')).toThrow(/OPENROUTER_API_KEY.*--provider gateway/)
    expect(() => p.resolve('a/b')).not.toThrow(/gw-secret/)
  })
})
