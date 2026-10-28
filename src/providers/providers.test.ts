import { describe, expect, test } from 'bun:test'
import { generateText, streamText } from 'ai'
import { z } from 'zod/v4'
import { defineHarnessAgent, isHarnessError, lookupModel } from '../index.ts'
import { profileStoreConformance } from '../testing/profile-store.conformance.ts'
import { scriptedModel } from '../testing/scripted-model.ts'
import { scriptedProvider } from '../testing/scripted-provider.ts'
import { until } from '../testing/test-utils.ts'
import {
  anthropicProvider,
  defineProvider,
  gatewayProvider,
  openAICompatibleProvider,
  openAIProvider,
  openRouterProvider,
} from './builtin.ts'
import {
  inMemoryCatalogCache,
  loadCachedJson,
  loadModelsDev,
  loadOpenRouterModels,
  parseOpenRouterModels,
} from './catalog-loader.ts'
import { fromEnv } from './env.ts'
import {
  ehMeta,
  endpointChanged,
  formSpec,
  mergeSecretPatch,
  redactProfile,
  validateSettings,
} from './form.ts'
import { createProviderManager, formatModelRef, parseModelRef } from './manager.ts'
import { inMemoryProfileStore } from './store.ts'
import type { ConfigProfile, ProviderDefinition, ProviderProfile } from './types.ts'

const schema = z.object({
  mode: z
    .enum(['key', 'oauth'])
    .default('key')
    .meta({ title: 'Mode', ...ehMeta({ group: 'auth', widget: 'radio' }) }),
  apiKey: z
    .string()
    .min(1)
    .meta({
      title: 'API key',
      ...ehMeta({ secret: true, showWhen: { field: 'mode', equals: 'key' } }),
    }),
  baseURL: z
    .url()
    .optional()
    .meta({
      description: 'Endpoint',
      ...ehMeta({ group: 'endpoint', placeholder: 'https://x', envHint: 'X_URL' }),
    }),
  headers: z
    .record(z.string(), z.string())
    .optional()
    .meta(ehMeta({ group: 'advanced', widget: 'keyvalue', secretValues: true })),
  retries: z.number().int().optional(),
  nested: z.object({ flag: z.boolean().default(false) }).optional(),
})

const KEY = 'sk-super-secret-1234567890'

describe('form spec', () => {
  test('enum option labels come from optionLabels, else the value', () => {
    const labelled = z.object({
      auth: z
        .enum(['none', 'oauth'])
        .meta({ ...ehMeta({ optionLabels: { none: 'No authentication' } }) }),
    })
    const [field] = formSpec(labelled).fields
    expect(field?.options).toEqual([
      { value: 'none', label: 'No authentication' },
      { value: 'oauth', label: 'oauth' },
    ])
  })
  const spec = formSpec(schema)
  const byPath = Object.fromEntries(spec.fields.map((f) => [f.path, f]))
  test('fields, kinds, labels and groups', () => {
    expect(spec.fields.map((f) => f.path)).toEqual([
      'mode',
      'apiKey',
      'baseURL',
      'headers',
      'retries',
      'nested.flag',
    ])
    expect(byPath.mode).toMatchObject({
      kind: 'enum',
      widget: 'radio',
      group: 'auth',
      default: 'key',
      required: false,
    })
    expect(byPath.mode?.options?.map((o) => o.value)).toEqual(['key', 'oauth'])
    expect(byPath.apiKey).toMatchObject({
      secret: true,
      widget: 'password',
      group: 'auth',
      required: true,
      label: 'API key',
    })
    expect(byPath.apiKey?.showWhen).toEqual({ field: 'mode', equals: 'key' })
    expect(byPath.baseURL).toMatchObject({
      label: 'Base URL',
      format: 'uri',
      placeholder: 'https://x',
      envHint: 'X_URL',
      group: 'endpoint',
      description: 'Endpoint',
    })
    expect(byPath.headers).toMatchObject({
      kind: 'record',
      widget: 'keyvalue',
      secretValues: true,
      group: 'advanced',
    })
    expect(byPath.retries?.kind).toBe('integer')
    expect(byPath['nested.flag']).toMatchObject({ kind: 'boolean', default: false })
    expect(spec.jsonSchema.type).toBe('object')
  })
})

describe('redaction and merge', () => {
  const profile: ConfigProfile = {
    id: 'p',
    kind: 'provider',
    definitionId: 'x',
    label: 'P',
    enabled: true,
    updatedAt: 1,
    settings: {
      mode: 'key',
      apiKey: KEY,
      headers: { Authorization: 'Bearer abcdefghijkl' },
      junk: KEY,
    },
  }
  test('public profile holds no secret', () => {
    const pub = redactProfile(schema, profile)
    const text = JSON.stringify(pub)
    expect(text).not.toContain(KEY)
    expect(text).not.toContain('abcdefghijkl')
    expect(text).not.toContain('junk')
    expect(Bun.inspect(pub)).not.toContain(KEY)
    expect(pub.settings.apiKey).toEqual({ set: true, hint: '…7890' })
    expect((pub.settings.headers as Record<string, unknown>).Authorization).toEqual({
      set: true,
      hint: '…ijkl',
    })
    expect(redactProfile(schema, { ...profile, settings: {} }).settings.apiKey).toEqual({
      set: false,
    })
  })
  test('mergeSecretPatch keeps, replaces and clears', () => {
    const stored = profile.settings
    expect(mergeSecretPatch(schema, stored, {}).apiKey).toBe(KEY)
    expect(mergeSecretPatch(schema, stored, { apiKey: { keep: true } }).apiKey).toBe(KEY)
    expect(mergeSecretPatch(schema, stored, { apiKey: '' }).apiKey).toBe(KEY)
    expect(mergeSecretPatch(schema, stored, { apiKey: 'new' }).apiKey).toBe('new')
    expect(mergeSecretPatch(schema, stored, { apiKey: null }).apiKey).toBeUndefined()
    const h = mergeSecretPatch(schema, stored, {
      headers: { Authorization: { keep: true }, 'X-A': 'v' },
    }).headers
    expect(h).toEqual({ Authorization: 'Bearer abcdefghijkl', 'X-A': 'v' })
    expect(mergeSecretPatch(schema, stored, { headers: {} }).headers).toEqual({})
    expect(mergeSecretPatch(schema, stored, { bogus: 1 }).bogus).toBeUndefined()
  })
  test('changing an endpoint drops the kept secrets', () => {
    const stored = { ...profile.settings, baseURL: 'https://api.example/v1' }
    const patch = { baseURL: 'https://attacker.example/v1' }
    expect(endpointChanged(schema, stored, patch)).toBe(true)
    expect(endpointChanged(schema, stored, { baseURL: 'https://api.example/v1' })).toBe(false)
    expect(endpointChanged(schema, stored, {})).toBe(false)
    expect(endpointChanged(schema, stored, { baseURL: null })).toBe(true)
    const merged = mergeSecretPatch(schema, stored, {
      ...patch,
      apiKey: { keep: true },
      headers: { Authorization: { keep: true } },
    })
    expect(merged.baseURL).toBe('https://attacker.example/v1')
    expect(merged.apiKey).toBeUndefined()
    expect(merged.headers).toEqual({})
    // resent secrets are accepted
    const resent = mergeSecretPatch(schema, stored, { ...patch, apiKey: 'fresh-key-1' })
    expect(resent.apiKey).toBe('fresh-key-1')
    // an unchanged endpoint keeps everything
    expect(mergeSecretPatch(schema, stored, { baseURL: stored.baseURL }).apiKey).toBe(KEY)
  })

  test('the endpoint flag comes from format uri or the meta, and can opt out', () => {
    const s = z.object({
      u: z.url().optional(),
      v: z
        .string()
        .optional()
        .meta(ehMeta({ endpoint: true })),
      w: z
        .url()
        .optional()
        .meta(ehMeta({ endpoint: false })),
      t: z
        .string()
        .meta(ehMeta({ secret: true }))
        .optional(),
    })
    const eps = formSpec(s)
      .fields.filter((f) => f.endpoint === true)
      .map((f) => f.path)
    expect(eps).toEqual(['u', 'v'])
    expect(mergeSecretPatch(s, { t: 'x1', w: 'https://a.b' }, { w: 'https://c.d' }).t).toBe('x1')
    expect(mergeSecretPatch(s, { t: 'x1', v: 'a' }, { v: 'b' }).t).toBeUndefined()
  })

  test('validateSettings throws EH_CONFIG_INVALID without values', () => {
    try {
      validateSettings(schema, { apiKey: 5 })
      throw new Error('no throw')
    } catch (e) {
      expect(isHarnessError(e, 'EH_CONFIG_INVALID')).toBe(true)
      expect((e as Error).message).toContain('apiKey')
    }
  })
})

describe('fromEnv', () => {
  const def = openRouterProvider({ createOpenRouter: () => () => 'x' })
  test('creates read-only env profiles; skips incomplete ones', () => {
    const out = fromEnv(
      [def, gatewayProvider()],
      { OPENROUTER_API_KEY: KEY, OPENROUTER_BASE_URL: 'https://p.example/v1' },
      { now: () => 5 },
    )
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      id: 'openrouter',
      kind: 'provider',
      source: 'env',
      settings: { apiKey: KEY, baseURL: 'https://p.example/v1' },
      updatedAt: 5,
    })
    expect(fromEnv([def], { OPENROUTER_BASE_URL: 'https://p.example/v1' })).toEqual([])
    expect(fromEnv([def], { OPENROUTER_API_KEY: '' })).toEqual([])
  })
})

describe('inMemoryProfileStore conformance', () => {
  for (const c of profileStoreConformance(() => inMemoryProfileStore(), {
    requireSubscribe: true,
  })) {
    test(c.name, c.run)
  }
})

const orList = {
  data: [
    {
      id: 'meta-llama/llama-3.1-8b-instruct:free',
      name: 'Llama 3.1 8B (free)',
      context_length: 131072,
      pricing: { prompt: '0', completion: '0' },
      supported_parameters: ['tools'],
      top_provider: { max_completion_tokens: 4096 },
    },
    {
      id: 'anthropic/claude-sonnet-4.6',
      name: 'Claude Sonnet 4.6',
      context_length: 1_000_000,
      pricing: { prompt: '0.000003', completion: '0.000015' },
      supported_parameters: ['tools', 'reasoning'],
    },
  ],
}

function fakeFetch(
  map: Record<string, unknown | (() => Response)>,
): typeof fetch & { calls: string[] } {
  const calls: string[] = []
  const f = (async (input: RequestInfo | URL) => {
    const url = String(input)
    calls.push(url)
    const hit = map[url]
    if (hit === undefined) return new Response('nope', { status: 404 })
    if (typeof hit === 'function') return (hit as () => Response)()
    return new Response(JSON.stringify(hit), { status: 200 })
  }) as typeof fetch & { calls: string[] }
  f.calls = calls
  return f
}

describe('catalog loader', () => {
  const url = 'https://c.example/list.json'
  test('fetches a missing cache, serves fresh cache, refreshes stale in the background', async () => {
    let t = 0
    const cache = inMemoryCatalogCache()
    const f = fakeFetch({ [url]: { a: 1 } })
    const base = { key: 'k', url, fetch: f, cache, now: () => t, ttlMs: 100 }
    const first = await loadCachedJson(base)
    expect(first).toMatchObject({ data: { a: 1 }, source: 'network', stale: false })
    t = 50
    expect((await loadCachedJson(base)).source).toBe('cache')
    expect(f.calls).toHaveLength(1)
    t = 500
    const stale = await loadCachedJson(base)
    expect(stale).toMatchObject({ source: 'cache', stale: true })
    expect(await stale.refresh).toEqual({ a: 1 })
    expect(f.calls).toHaveLength(2)
    expect((await cache.get('k'))?.fetchedAt).toBe(500)
  })
  test('keeps stale data when the refresh fails; offline never fetches', async () => {
    const cache = inMemoryCatalogCache()
    await cache.set('k', { data: { old: true }, fetchedAt: 0 })
    const f = fakeFetch({})
    const forced = await loadCachedJson({
      key: 'k',
      url,
      fetch: f,
      cache,
      now: () => 10,
      ttlMs: 1,
      force: true,
    })
    expect(forced).toMatchObject({ data: { old: true }, stale: true, source: 'cache' })
    const calls = f.calls.length
    const off = await loadCachedJson({ key: 'k', url, fetch: f, cache, offline: true })
    expect(off.data).toEqual({ old: true })
    expect(f.calls).toHaveLength(calls)
    expect(
      await loadCachedJson({ key: 'none', url, fetch: f, cache, offline: true }),
    ).toMatchObject({ source: 'none', data: undefined })
  })
  test('a failing fetch with no cache yields none; a throwing fetch never throws', async () => {
    const f = (async () => {
      throw new Error('boom')
    }) as unknown as typeof fetch
    expect((await loadCachedJson({ key: 'k', url, fetch: f })).source).toBe('none')
  })
  test('an invalid or empty download never overwrites a valid cache and is reported', async () => {
    const cache = inMemoryCatalogCache()
    const good = { anthropic: { models: { m: { name: 'M' } } } }
    await cache.set('models.dev', { data: good, fetchedAt: 0 })
    const warnings: string[] = []
    for (const bad of [{}, { anthropic: 'nope' }, { data: 1 }]) {
      const loaded = await loadModelsDev({
        fetch: fakeFetch({ 'https://models.dev/api.json': bad }),
        cache,
        now: () => 10,
        force: true,
        onWarning: (m) => warnings.push(m),
      })
      expect(loaded.data).toEqual(good)
    }
    expect((await cache.get('models.dev'))?.data).toEqual(good)
    expect(warnings.length).toBeGreaterThanOrEqual(2)
    const empty = await loadOpenRouterModels({
      fetch: fakeFetch({ 'https://openrouter.ai/api/v1/models': { data: [] } }),
      onWarning: (m) => warnings.push(m),
    })
    expect(empty.source).toBe('none')
  })
  test('a body over maxBytes is refused', async () => {
    const warnings: string[] = []
    const big = JSON.stringify({ a: 'x'.repeat(1000) })
    const f = (async () => new Response(big)) as unknown as typeof fetch
    const r = await loadCachedJson({
      key: 'k',
      url,
      fetch: f,
      maxBytes: 100,
      onWarning: (m) => warnings.push(m),
    })
    expect(r.source).toBe('none')
    expect(warnings[0]).toContain('larger than 100')
  })
  test('helpers build catalogs', async () => {
    const f = fakeFetch({
      'https://openrouter.ai/api/v1/models': orList,
      'https://models.dev/api.json': {
        anthropic: {
          models: {
            'claude-x': {
              name: 'X',
              limit: { context: 10, output: 5 },
              cost: { input: 1, output: 2 },
            },
          },
        },
      },
    })
    const or = await loadOpenRouterModels({ fetch: f })
    expect(or.catalog['anthropic/claude-sonnet-4.6']?.pricing?.input).toBe(3)
    expect(or.models).toHaveLength(2)
    expect((await loadModelsDev({ fetch: f })).catalog['anthropic/claude-x']?.contextWindow).toBe(
      10,
    )
    expect(parseOpenRouterModels(orList)[1]).toMatchObject({ reasoning: true, tools: true })
  })
})

function orDef(): ProviderDefinition {
  return openRouterProvider({
    createOpenRouter:
      ({ apiKey }) =>
      (id: string) =>
        scriptedModel([{ text: 'ok' }], { provider: 'openrouter.chat', modelId: `${id}` }) && {
          __key: apiKey,
          id,
        },
  })
}

describe('manager', () => {
  const profile = (id: string, extra: Partial<ProviderProfile> = {}): ProviderProfile => ({
    id,
    kind: 'provider',
    definitionId: 'openrouter',
    label: id,
    settings: { apiKey: KEY },
    enabled: true,
    updatedAt: 1,
    ...extra,
  })

  test('an older overlapping reload never replaces a newer snapshot', async () => {
    const inner = inMemoryProfileStore()
    const listeners = new Set<() => void>()
    let slowFirstList = true
    let slowListDone = false
    const store: typeof inner = {
      ...inner,
      // the first list after a change is slow, so it finishes after the second change was written
      list: async (q) => {
        const rows = await inner.list(q)
        if (slowFirstList && rows.length === 1) {
          slowFirstList = false
          await new Promise((r) => setTimeout(r, 40))
          slowListDone = true
        }
        return rows
      },
      put: async (p) => {
        await inner.put(p)
        for (const l of listeners) l()
      },
      subscribe: (l) => {
        listeners.add(l)
        return () => listeners.delete(l)
      },
    }
    const def = defineProvider({
      id: 'p',
      label: 'P',
      settings: z.object({ apiKey: z.string().meta(ehMeta({ secret: true })) }),
      create: () => ({ languageModel: (id: string) => id }),
    })
    const manager = createProviderManager({ definitions: [def], store })
    await manager.ready()
    await manager.putProfile({ providerId: 'p', settings: { apiKey: 'k1-aaaaaaaaaaaa' } })
    await manager.putProfile({ providerId: 'p', settings: { apiKey: 'k2-aaaaaaaaaaaa' } })
    // the slow (older) reload has finished and must not have replaced the newer snapshot
    await until('the slow reload finished', () => slowListDone)
    await until('reloads settled', async () => (await manager.listProfiles()).length === 2)
    await Promise.resolve()
    expect((await manager.listProfiles()).map((p) => p.id)).toEqual(['p', 'p-2'])
    manager.dispose()
  })

  test('first-colon split', () => {
    expect(parseModelRef('openrouter-2:meta-llama/llama-3.1-8b-instruct:free')).toEqual({
      profile: 'openrouter-2',
      model: 'meta-llama/llama-3.1-8b-instruct:free',
    })
    expect(formatModelRef('a', 'b:c')).toBe('a:b:c')
    expect(() => parseModelRef('nocolon')).toThrow()
    expect(parseModelRef({ profile: 'a', model: 'b:c' })).toEqual({ profile: 'a', model: 'b:c' })
  })

  test('resolve caches per profile+settings, invalidates on change, errors are clear', async () => {
    const created: string[] = []
    const def = defineProvider({
      id: 'p',
      label: 'P',
      settings: z.object({
        apiKey: z
          .string()
          .min(1)
          .meta(ehMeta({ secret: true })),
      }),
      create: (s) => ({
        languageModel: (id) => {
          created.push(`${s.apiKey}:${id}`)
          return scriptedModel([], { provider: 'p', modelId: id })
        },
      }),
    })
    const store = inMemoryProfileStore({ initial: [{ ...profile('a'), definitionId: 'p' }] })
    const m = createProviderManager({ definitions: [def], store })
    expect(() => m.resolve('a:x')).toThrow(/ready/)
    await m.ready()
    const one = m.resolve('a:x:y/z')
    expect(m.resolve('a:x:y/z')).toBe(one)
    expect(created).toEqual([`${KEY}:x:y/z`])
    await m.putProfile({ id: 'a', settings: { apiKey: 'other-key' } })
    expect(m.resolve('a:x:y/z')).not.toBe(one)
    expect(created.at(-1)).toBe('other-key:x:y/z')
    // external change through the store's feed
    await store.put({ ...profile('a'), definitionId: 'p', settings: { apiKey: 'third' } })
    await until('external change applied', () => {
      try {
        m.resolve('a:q')
        return created.at(-1) === 'third:q'
      } catch {
        return false
      }
    })
    expect(m.resolve('a:q')).toBeDefined()
    expect(created.at(-1)).toBe('third:q')
    for (const [ref, reason] of [['zzz:x', 'profile-not-found']] as const) {
      try {
        m.resolve(ref)
        throw new Error('no throw')
      } catch (e) {
        expect(isHarnessError(e, 'EH_CONFIG_INVALID')).toBe(true)
        expect((e as { details?: { reason?: string } }).details?.reason).toBe(reason)
      }
    }
    await m.putProfile({ id: 'a', enabled: false })
    expect(() => m.resolve('a:x')).toThrow(/disabled/)
    await m.putProfile({ id: 'a', enabled: true, models: { deny: ['bad*'] } })
    expect(() => m.resolve('a:bad-model')).toThrow(/not allowed/)
    m.dispose()
  })

  test('putProfile redacts, validates, generates ids; env profiles are read-only', async () => {
    const def = orDef()
    const m = createProviderManager({ definitions: [def], env: { OPENROUTER_API_KEY: KEY } })
    await m.ready()
    const created = await m.putProfile({
      providerId: 'openrouter',
      settings: { apiKey: 'k-2-aaaaaaaaaaaa' },
      label: 'Second',
    })
    expect(created.id).toBe('openrouter-2')
    expect(JSON.stringify(created)).not.toContain('k-2-aaaaaaaaaaaa')
    // editing only the baseURL must not carry the stored key to the new host
    await m.putProfile({
      id: 'moved',
      providerId: 'openrouter',
      settings: { apiKey: 'k-3-aaaaaaaaaaaa', baseURL: 'https://api.example/v1' },
    })
    await expect(
      m.putProfile({ id: 'moved', settings: { baseURL: 'https://attacker.example/v1' } }),
    ).rejects.toThrow(/apiKey/)
    const moved = await m.putProfile({
      id: 'moved',
      settings: { baseURL: 'https://other.example/v1', apiKey: 'k-4-aaaaaaaaaaaa' },
    })
    expect(moved.settings.apiKey).toMatchObject({ set: true })
    await m.putProfile({ id: 'moved', label: 'kept' })
    expect((await m.getProfile('moved'))?.settings.apiKey).toMatchObject({ set: true })
    await expect(m.putProfile({ id: 'openrouter', label: 'x' })).rejects.toThrow(/read-only/)
    await expect(m.deleteProfile('openrouter')).rejects.toThrow(/read-only/)
    await expect(m.putProfile({ providerId: 'openrouter', settings: {} })).rejects.toThrow(/apiKey/)
    await expect(
      m.putProfile({ providerId: 'openrouter', id: 'a:b', settings: { apiKey: 'k' } }),
    ).rejects.toThrow(/Invalid profile id/)
    const all = await m.listProfiles()
    expect(all.map((p) => p.id).sort()).toEqual(['moved', 'openrouter', 'openrouter-2'])
    expect(JSON.stringify(all)).not.toContain(KEY)
    const d = await m.describe()
    expect(d.providers[0]?.form.fields.some((f) => f.path === 'apiKey' && f.secret)).toBe(true)
    await m.deleteProfile('openrouter-2')
    await m.deleteProfile('moved')
    expect((await m.listProfiles()).map((p) => p.id)).toEqual(['openrouter'])
  })

  test('seed persists once into an empty store', async () => {
    const store = inMemoryProfileStore()
    const def = orDef()
    const m = createProviderManager({ definitions: [def], store, seed: [profile('seeded')] })
    await m.ready()
    expect((await store.list({ kind: 'provider' })).map((p) => p.id)).toEqual(['seeded'])
    expect((await store.get('provider', 'seeded'))?.source).toBe('store')
  })

  test('model list merge order: extra > live > catalog; allow/deny', async () => {
    const def = defineProvider({
      id: 'live',
      label: 'Live',
      settings: z.object({}),
      catalog: { kind: 'openrouter' },
      create: () => ({ languageModel: (id) => id }),
      listModels: async () => [
        { id: 'anthropic/claude-sonnet-4.6', name: 'Live Sonnet', info: { contextWindow: 123 } },
        { id: 'only-live' },
        { id: 'hidden-x' },
      ],
    })
    const f = fakeFetch({ 'https://openrouter.ai/api/v1/models': orList })
    const store = inMemoryProfileStore({
      initial: [
        profile('l', {
          definitionId: 'live',
          settings: {},
          models: {
            deny: ['hidden-*'],
            extra: [
              { id: 'anthropic/claude-sonnet-4.6', pricing: { input: 9, output: 9 } },
              { id: 'custom', name: 'Custom', contextWindow: 5 },
            ],
          },
        }),
      ],
    })
    const m = createProviderManager({ definitions: [def], store, fetch: f })
    const list = await m.models('l')
    expect(list.map((e) => e.id)).toEqual(['anthropic/claude-sonnet-4.6', 'custom', 'only-live'])
    const sonnet = list[0]
    expect(sonnet?.source).toBe('extra')
    expect(sonnet?.name).toBe('Live Sonnet')
    // extra pricing wins, live contextWindow beats catalog (1_000_000), catalog supplies maxOutput-less rest
    expect(sonnet?.info).toMatchObject({ contextWindow: 123, pricing: { input: 9, output: 9 } })
    expect(list[2]?.source).toBe('live')
  })

  test('includeDisabled lists the models allow/deny hides, marked enabled', async () => {
    const def = defineProvider({
      id: 'live',
      label: 'Live',
      settings: z.object({}),
      create: () => ({ languageModel: (id) => id }),
      listModels: async () => [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
    })
    const store = inMemoryProfileStore({
      initial: [
        profile('l', { definitionId: 'live', settings: {}, models: { allow: ['a', 'c'] } }),
      ],
    })
    const m = createProviderManager({ definitions: [def], store })
    expect((await m.models('l')).map((e) => e.id)).toEqual(['a', 'c'])
    const all = await m.models('l', { includeDisabled: true })
    expect(all.map((e) => [e.id, e.enabled])).toEqual([
      ['a', true],
      ['b', false],
      ['c', true],
    ])
  })

  test('catalog-derived list when there is no live listing (OpenRouter), flags and sort', async () => {
    const f = fakeFetch({ 'https://openrouter.ai/api/v1/models': orList })
    const m = createProviderManager({
      definitions: [orDef()],
      fetch: f,
      env: { OPENROUTER_API_KEY: KEY },
    })
    const list = await m.models('openrouter')
    expect(list.map((e) => e.id)).toEqual([
      'anthropic/claude-sonnet-4.6',
      'meta-llama/llama-3.1-8b-instruct:free',
    ])
    expect(list[0]).toMatchObject({ source: 'catalog', reasoning: true, tools: true })
    expect(f.calls).toHaveLength(1)
    await m.models('openrouter')
    expect(f.calls).toHaveLength(1)
  })

  test('failed live listing falls back to the catalog and warns without secrets', async () => {
    const warnings: string[] = []
    const def = defineProvider({
      id: 'live',
      label: 'Live',
      settings: z.object({ apiKey: z.string().meta(ehMeta({ secret: true })) }),
      catalog: { modelsDevKey: 'anthropic' },
      create: () => ({ languageModel: (id) => id }),
      listModels: async (s) => {
        throw new Error(`denied for ${s.apiKey}`)
      },
    })
    const f = fakeFetch({
      'https://models.dev/api.json': {
        anthropic: { models: { 'claude-x': { name: 'X', tool_call: true } } },
      },
    })
    const m = createProviderManager({
      definitions: [def],
      store: inMemoryProfileStore({ initial: [{ ...profile('l'), definitionId: 'live' }] }),
      fetch: f,
      onWarning: (w) => warnings.push(w),
    })
    expect((await m.models('l')).map((e) => e.id)).toEqual(['claude-x'])
    expect(warnings.join()).toContain('denied for ***')
    expect(warnings.join()).not.toContain(KEY)
    const t = await m.test('l')
    expect(t.ok).toBe(false)
    expect(t.message).not.toContain(KEY)
  })

  test('catalog prices the models the manager created, through an agent run', async () => {
    const scripted = scriptedProvider({
      id: 'scripted',
      models: { 'm:1': [{ text: 'hi', usage: { inputTokens: 1000, outputTokens: 500 } }] },
    })
    const f = fakeFetch({})
    const store = inMemoryProfileStore({
      initial: [{ ...profile('s'), definitionId: 'scripted', settings: {} }],
    })
    const m = createProviderManager({
      definitions: [scripted],
      store,
      fetch: f,
      catalogs: { offline: true },
    })
    await m.ready()
    await m.putProfile({
      id: 's',
      models: {
        extra: [{ id: 'm:1', contextWindow: 42_000, pricing: { input: 1000, output: 2000 } }],
      },
    })
    const model = m.resolve('s:m:1')
    expect(lookupModel(m.catalog(), model)).toMatchObject({ contextWindow: 42_000 })
    const warnings: string[] = []
    const agent = defineHarnessAgent({
      model,
      models: m.catalog(),
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      onWarning: (w: { code: string }) => warnings.push(w.code),
    } as never)
    const result = await agent.session('s1').send('hi').result
    // 1000 * 1000/1M + 500 * 2000/1M = 2
    expect(result.usage.costUsd).toBeCloseTo(2, 6)
    expect(warnings).not.toContain('W_DEFAULT_CONTEXT_WINDOW')
  })

  test('catalog falls back to loaded catalogs for unknown model objects and gateway strings', async () => {
    const f = fakeFetch({ 'https://openrouter.ai/api/v1/models': orList })
    const m = createProviderManager({
      definitions: [orDef()],
      fetch: f,
      env: { OPENROUTER_API_KEY: KEY },
    })
    await m.loadCatalogs()
    const foreign = scriptedModel([], {
      provider: 'openrouter.chat',
      modelId: 'anthropic/claude-sonnet-4.6',
    })
    expect(lookupModel(m.catalog(), foreign)?.pricing).toMatchObject({ input: 3, output: 15 })
    const gw = createProviderManager({
      definitions: [gatewayProvider()],
      env: { AI_GATEWAY_API_KEY: KEY },
      catalogs: {
        offline: true,
        data: {
          modelsDev: {
            anthropic: {
              models: {
                'claude-x': { limit: { context: 9, output: 1 }, cost: { input: 1, output: 2 } },
              },
            },
          },
        },
      },
    })
    await gw.ready()
    const model = gw.resolve('gateway:anthropic/claude-x')
    expect(model).toBe('anthropic/claude-x')
    expect(lookupModel(gw.catalog(), model)?.contextWindow).toBe(9)
  })
})

describe('built-in definitions', () => {
  test('forms and envMaps', () => {
    const noop = () => () => 'x'
    const defs = [
      openRouterProvider({ createOpenRouter: noop }),
      gatewayProvider(),
      openAICompatibleProvider({
        createOpenAICompatible: noop,
        defaultBaseURL: 'http://localhost:11434/v1',
        apiKeyOptional: true,
      }),
      openAIProvider({ createOpenAI: noop }),
      anthropicProvider({ createAnthropic: noop }),
    ]
    for (const d of defs) {
      const spec = formSpec(d.settings)
      expect(spec.fields.find((f) => f.path === 'apiKey')?.secret).toBe(true)
      expect(spec.fields.find((f) => f.path === 'headers')?.secretValues).toBe(true)
    }
    // the AI SDK gateway has no base-URL environment variable: only the key is mapped
    expect(defs[1]?.envMap).toEqual({ apiKey: 'AI_GATEWAY_API_KEY' })
    expect(defs.map((d) => d.id)).toEqual([
      'openrouter',
      'gateway',
      'openai-compatible',
      'openai',
      'anthropic',
    ])
    expect(
      formSpec((defs[2] as ProviderDefinition).settings).fields.find((f) => f.path === 'apiKey')
        ?.required,
    ).toBe(false)
  })

  test('openai-compatible lists /models with auth and tests the connection', async () => {
    const seen: Array<{ url: string; headers: unknown }> = []
    const f = (async (url: string, init?: RequestInit) => {
      seen.push({ url, headers: init?.headers })
      return new Response(JSON.stringify({ data: [{ id: 'llama3' }, { id: 'qwen' }] }))
    }) as unknown as typeof fetch
    const def = openAICompatibleProvider({
      createOpenAICompatible: (o) => (id: string) =>
        ({ name: o.name, base: o.baseURL, id }) as never,
    })
    const m = createProviderManager({
      definitions: [def],
      fetch: f,
      store: inMemoryProfileStore({
        initial: [
          {
            id: 'local',
            kind: 'provider',
            definitionId: 'openai-compatible',
            label: 'L',
            enabled: true,
            updatedAt: 1,
            settings: { baseURL: 'http://h/v1/', apiKey: KEY },
          },
        ],
      }),
    })
    expect((await m.models('local')).map((e) => e.id)).toEqual(['llama3', 'qwen'])
    expect(seen[0]?.url).toBe('http://h/v1/models')
    expect(seen[0]?.headers).toMatchObject({ authorization: `Bearer ${KEY}` })
    expect(await m.test('local')).toMatchObject({ ok: true })
    expect(m.resolve('local:llama3') as unknown).toEqual({
      name: 'openai-compatible',
      base: 'http://h/v1/',
      id: 'llama3',
    })
  })
})

describe('openRouterProvider routing and usage accounting', () => {
  const setupRouting = (settings: Record<string, unknown>) => {
    const seen: Array<{ id: string; settings: unknown }> = []
    const model = scriptedModel(
      [
        { text: 'a', providerMetadata: { openrouter: { provider: 'Amazon Bedrock' } } },
        { text: 'b', providerMetadata: { openrouter: { provider: 'Amazon Bedrock' } } },
        { text: 'c' },
      ],
      { provider: 'openrouter.chat', modelId: 'm' },
    )
    const def = openRouterProvider({
      createOpenRouter: () => (id: string, modelSettings?: Record<string, unknown>) => {
        seen.push({ id, settings: modelSettings })
        return model
      },
    })
    const instance = def.create(validateSettings(def.settings, { apiKey: KEY, ...settings }))
    return { seen, model, instance }
  }

  test('usage accounting is always on; no routing keys by default', () => {
    const { seen, instance } = setupRouting({})
    instance.languageModel('m')
    expect(seen[0]?.settings).toEqual({ usage: { include: true } })
  })

  test('preferred order and no-fallback reach the model settings', () => {
    const { seen, instance } = setupRouting({
      providerOrder: ' Anthropic, amazon-bedrock ,',
      allowFallbacks: false,
    })
    instance.languageModel('m')
    expect(seen[0]?.settings).toEqual({
      usage: { include: true },
      provider: { order: ['anthropic', 'amazon-bedrock'], allow_fallbacks: false },
    })
  })

  test('the form describes the routing fields with their defaults', () => {
    const def = openRouterProvider({ createOpenRouter: () => () => 'x' })
    const fields = formSpec(def.settings as never).fields
    const byPath = Object.fromEntries(fields.map((f) => [f.path, f]))
    expect(byPath.providerOrder?.group).toBe('advanced')
    expect(byPath.allowFallbacks).toMatchObject({ kind: 'boolean', default: true })
    expect(byPath.stickyProvider).toMatchObject({ kind: 'boolean', default: false })
  })

  test('the AI SDK reasoning option becomes OpenRouter reasoning effort; provider-default sends none', async () => {
    const { instance, model } = setupRouting({})
    const wrapped = instance.languageModel('m')
    const messages = [{ role: 'user' as const, content: 'hi' }]
    await generateText({ model: wrapped, messages, reasoning: 'none' })
    await generateText({ model: wrapped, messages, reasoning: 'provider-default' })
    await generateText({
      model: wrapped,
      messages,
      reasoning: 'high',
      providerOptions: { openrouter: { reasoning: { max_tokens: 2000 } } },
    })
    const call = (i: number) =>
      model.doGenerateCalls[i] as {
        reasoning?: unknown
        providerOptions?: { openrouter?: { reasoning?: unknown } }
      }
    expect(call(0).providerOptions?.openrouter?.reasoning).toEqual({ effort: 'none' })
    expect(call(0).reasoning).toBeUndefined()
    expect(call(1).providerOptions?.openrouter?.reasoning).toBeUndefined()
    // OpenRouter's own options win
    expect(call(2).providerOptions?.openrouter?.reasoning).toEqual({ max_tokens: 2000 })
  })

  test('sticky provider: the upstream of the previous call leads the next order', async () => {
    const { instance, model } = setupRouting({ stickyProvider: true, providerOrder: 'anthropic' })
    const wrapped = instance.languageModel('m')
    const call = (text: string) =>
      generateText({ model: wrapped, messages: [{ role: 'user', content: text }] })
    await call('hello')
    await call('hello')
    await call('another conversation')
    const providerOf = (i: number): unknown =>
      (
        model.doGenerateCalls[i]?.providerOptions as
          | { openrouter?: { provider?: unknown } }
          | undefined
      )?.openrouter?.provider
    expect(providerOf(0)).toBeUndefined()
    expect(providerOf(1)).toEqual({ order: ['amazon-bedrock', 'anthropic'] })
    expect(providerOf(2)).toBeUndefined()
  })

  const stickySetup = (steps: Parameters<typeof scriptedModel>[0]) => {
    const model = scriptedModel(steps, { provider: 'openrouter.chat', modelId: 'm' })
    const def = openRouterProvider({ createOpenRouter: () => () => model })
    const instance = def.create(
      validateSettings(def.settings, { apiKey: KEY, stickyProvider: true }),
    )
    const providerOf = (calls: Array<{ providerOptions?: unknown }>, i: number): unknown =>
      (calls[i]?.providerOptions as { openrouter?: { provider?: unknown } } | undefined)?.openrouter
        ?.provider
    return { model, wrapped: instance.languageModel('m'), providerOf }
  }
  const bedrock = { openrouter: { provider: 'Amazon Bedrock' } }

  test('sticky provider: a failed call forgets the provider, the next is routed normally', async () => {
    const { model, wrapped, providerOf } = stickySetup([
      { text: 'a', providerMetadata: bedrock },
      { text: 'b', throws: new Error('Upstream error: Internal server error') },
      { text: 'c', providerMetadata: bedrock },
    ])
    const call = () => generateText({ model: wrapped, messages: [{ role: 'user', content: 'hi' }] })
    await call()
    await expect(call()).rejects.toThrow('Internal server error')
    await call()
    expect(providerOf(model.doGenerateCalls, 1)).toEqual({ order: ['amazon-bedrock'] })
    expect(providerOf(model.doGenerateCalls, 2)).toBeUndefined()
  })

  test('sticky provider: a stream error part forgets the provider', async () => {
    const { model, wrapped, providerOf } = stickySetup([
      { text: 'a', providerMetadata: bedrock },
      {
        text: 'b',
        streamError: new Error('Upstream returned HTTP 502'),
        providerMetadata: bedrock,
      },
      { text: 'c', providerMetadata: bedrock },
    ])
    const call = async () => {
      const result = streamText({
        model: wrapped,
        messages: [{ role: 'user', content: 'hi' }],
        onError: () => {},
      })
      await result.consumeStream()
    }
    await call()
    await call()
    await call()
    expect(providerOf(model.doStreamCalls, 1)).toEqual({ order: ['amazon-bedrock'] })
    expect(providerOf(model.doStreamCalls, 2)).toBeUndefined()
  })

  test('sticky provider: an abort keeps the provider', async () => {
    const { model, wrapped, providerOf } = stickySetup([
      { text: 'a', providerMetadata: bedrock },
      { text: 'b', throws: Object.assign(new Error('aborted'), { name: 'AbortError' }) },
      { text: 'c', providerMetadata: bedrock },
    ])
    const call = () => generateText({ model: wrapped, messages: [{ role: 'user', content: 'hi' }] })
    await call()
    await expect(call()).rejects.toThrow('aborted')
    await call()
    expect(providerOf(model.doGenerateCalls, 2)).toEqual({ order: ['amazon-bedrock'] })
  })
})
