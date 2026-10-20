/**
 * Context window per agent: the model's own window by default, a custom limit that never exceeds
 * it, a smaller model clamps it, the summarize-at percent, and the new limits reaching an
 * existing chat session at its next turn (stats of the session).
 */
import { afterEach, describe, expect, test } from 'bun:test'
import {
  clampPercent,
  compactRatio,
  customWindowProblem,
  effectiveWindow,
} from '../src/domain/context-window.ts'
import { generateSecretKey, parseSecretKey, teamVault } from '../src/infra/eh/secret-vault.ts'
import { compose, type Server } from '../src/main.ts'

describe('window rules', () => {
  test('default follows the model; custom is at most the model; unknown models use the number', () => {
    expect(effectiveWindow({ modelWindow: 1_000_000, custom: null })).toBe(1_000_000)
    expect(effectiveWindow({ modelWindow: 1_000_000, custom: 256_000 })).toBe(256_000)
    expect(effectiveWindow({ modelWindow: 32_000, custom: 256_000 })).toBe(32_000)
    expect(effectiveWindow({ modelWindow: undefined, custom: null })).toBe(200_000)
    expect(effectiveWindow({ modelWindow: undefined, custom: 500_000 })).toBe(500_000)
    expect(effectiveWindow({ modelWindow: 1_000_000, custom: null, ceiling: 128_000 })).toBe(
      128_000,
    )
  })

  test('validation and percent', () => {
    expect(customWindowProblem(500_000, 1_000_000)).toBeUndefined()
    expect(customWindowProblem(1_000_001, 1_000_000)).toContain('larger than')
    expect(customWindowProblem(100, 1_000_000)).toContain('at least')
    expect(customWindowProblem(2_000_000, undefined)).toBeUndefined()
    expect(compactRatio(80)).toBe(0.8)
    expect(clampPercent(10)).toBe(50)
    expect(clampPercent(99)).toBe(95)
  })
})

const servers: Server[] = []
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close()
})

const LIST = {
  data: [
    {
      id: 'big/model',
      name: 'Big',
      context_length: 1_000_000,
      pricing: { prompt: '0.000003', completion: '0.000015' },
      supported_parameters: ['tools'],
    },
    {
      id: 'small/model',
      name: 'Small',
      context_length: 32_000,
      pricing: { prompt: '0', completion: '0' },
      supported_parameters: [],
    },
  ],
}

const send = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
})

async function boot(): Promise<Server> {
  const server = compose({
    dbFile: ':memory:',
    env: {},
    offline: false,
    fetch: (async (url: string | URL | Request) =>
      String(url).endsWith('/key')
        ? new Response('{}')
        : new Response(JSON.stringify(LIST))) as unknown as typeof fetch,
    vault: teamVault([parseSecretKey(generateSecretKey())]),
    changePollMs: 0,
    models: undefined,
    reconcile: { onBoot: false, everyMs: 0 },
    routines: { tickMs: 0 },
  })
  servers.push(server)
  await server.providersReady
  const created = await server.app.request(
    '/providers/profiles',
    send('POST', {
      providerId: 'openrouter',
      id: 'work',
      settings: { apiKey: 'sk-or-v1-test-0123456789' },
    }),
  )
  expect(created.status).toBe(201)
  await server.providers.manager.loadCatalogs()
  return server
}

interface Stats {
  model: { contextWindow?: number }
  context: { window: number; summarizeAt: number }
}

async function create(
  server: Server,
  extra: Record<string, unknown> = {},
): Promise<{ id: string; status: number; body: Record<string, unknown> }> {
  const res = await server.app.request(
    '/agents',
    send('POST', {
      name: 'Worker',
      instructions: 'x',
      modelProfile: 'work',
      model: 'big/model',
      ...extra,
    }),
  )
  const body = (await res.json()) as Record<string, unknown>
  return { id: String(body.id), status: res.status, body }
}

const statsOf = async (server: Server, id: string): Promise<Stats> =>
  (await (await server.app.request(`/agents/${id}/stats`)).json()) as Stats

describe('agent context window over HTTP', () => {
  test('default is the full window of the model, summarized at 80 %', async () => {
    const server = await boot()
    const a = await create(server)
    expect(a.status).toBe(201)
    expect(a.body).toMatchObject({ contextWindow: null, compactAtPercent: 80 })
    const stats = await statsOf(server, a.id)
    expect(stats.context.window).toBe(1_000_000)
    expect(stats.context.summarizeAt).toBe(800_000)
  })

  test('a custom limit up to the model window is used; one above it is rejected', async () => {
    const server = await boot()
    const a = await create(server, { contextWindow: 256_000 })
    expect(a.status).toBe(201)
    expect((await statsOf(server, a.id)).context.window).toBe(256_000)
    const tooBig = await create(server, { name: 'Other', contextWindow: 1_000_001 })
    expect(tooBig.status).toBe(400)
    const patched = await server.app.request(
      `/agents/${a.id}`,
      send('PATCH', { contextWindow: 2_000_000 }),
    )
    expect(patched.status).toBe(400)
    expect((await statsOf(server, a.id)).context.window).toBe(256_000)
    // back to the model's window
    const reset = await server.app.request(
      `/agents/${a.id}`,
      send('PATCH', { contextWindow: null }),
    )
    expect(reset.status).toBe(200)
    expect((await statsOf(server, a.id)).context.window).toBe(1_000_000)
  })

  test('the threshold percent is validated and applied to the effective window', async () => {
    const server = await boot()
    const a = await create(server, { contextWindow: 500_000, compactAtPercent: 60 })
    expect(a.status).toBe(201)
    const stats = await statsOf(server, a.id)
    expect(stats.context.window).toBe(500_000)
    expect(stats.context.summarizeAt).toBe(300_000)
    for (const bad of [49, 96]) {
      const res = await server.app.request(
        `/agents/${a.id}`,
        send('PATCH', { compactAtPercent: bad }),
      )
      expect(res.status).toBe(400)
    }
  })

  test('a switch to a smaller model clamps a stored custom limit', async () => {
    const server = await boot()
    const a = await create(server, { contextWindow: 500_000 })
    expect((await statsOf(server, a.id)).context.window).toBe(500_000)
    const res = await server.app.request(`/agents/${a.id}`, send('PATCH', { model: 'small/model' }))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ contextWindow: 500_000 })
    const stats = await statsOf(server, a.id)
    expect(stats.model.contextWindow).toBe(32_000)
    expect(stats.context.window).toBe(32_000)
  })

  test('an existing chat session uses new limits at its next turn: agent edits and the workspace default model', async () => {
    const server = await boot()
    const a = await create(server)
    const thread = (await (
      await server.app.request(`/agents/${a.id}/threads`, send('POST', {}))
    ).json()) as { id: string }
    const at = `/agents/${a.id}/stats?thread=${thread.id}`
    const read = async (): Promise<Stats> => (await (await server.app.request(at)).json()) as Stats
    const first = await read()
    expect(first.context).toMatchObject({ window: 1_000_000, summarizeAt: 800_000 })
    await server.app.request(
      `/agents/${a.id}`,
      send('PATCH', { contextWindow: 200_000, compactAtPercent: 50 }),
    )
    const second = await read()
    expect(second.context).toMatchObject({ window: 200_000, summarizeAt: 100_000 })
    // an agent on the workspace default model follows a change of that default
    const w = await create(server, { name: 'Follower', model: null, modelProfile: null })
    expect(w.status).toBe(201)
    await server.app.request(
      '/settings',
      send('PATCH', { defaultProfile: 'work', defaultModel: 'big/model' }),
    )
    expect((await statsOf(server, w.id)).context.window).toBe(1_000_000)
    await server.app.request(
      '/settings',
      send('PATCH', { defaultProfile: 'work', defaultModel: 'small/model' }),
    )
    expect((await statsOf(server, w.id)).context.window).toBe(32_000)
  })
})
