/** The model catalog: cached loader (offline-safe) and real costs/windows from `GET /stats`. */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scriptedModel } from 'eharness/testing'
import { loadModelCatalog } from '../src/infra/eh/model-catalog.ts'
import { scriptedModelConfig } from '../src/infra/eh/provider.ts'
import { compose, type Server } from '../src/main.ts'

const dirs: string[] = []
const servers: Server[] = []
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'team-catalog-'))
  dirs.push(d)
  return d
}

const LIST = {
  data: [
    {
      id: 'anthropic/claude-x',
      context_length: 1_000_000,
      pricing: { prompt: '0.000003', completion: '0.000015' },
    },
  ],
}
const okFetch = (calls: string[]): typeof fetch =>
  (async (url: string) => {
    calls.push(String(url))
    return new Response(JSON.stringify(LIST))
  }) as unknown as typeof fetch

describe('loadModelCatalog', () => {
  test('scripted provider and offline mode never fetch', async () => {
    const calls: string[] = []
    expect(
      (await loadModelCatalog('scripted', tmp(), { fetch: okFetch(calls) })).catalog,
    ).toBeUndefined()
    expect(
      (await loadModelCatalog('openrouter', tmp(), { fetch: okFetch(calls), offline: true }))
        .catalog,
    ).toBeUndefined()
    expect(calls).toEqual([])
  })

  test('fetches, caches, and survives a failing network', async () => {
    const dir = tmp()
    const calls: string[] = []
    const first = await loadModelCatalog('openrouter', dir, {
      fetch: okFetch(calls),
      offline: false,
    })
    expect(
      (first.catalog as Record<string, { contextWindow?: number }>)['anthropic/claude-x']
        ?.contextWindow,
    ).toBe(1_000_000)
    // fresh cache: no second fetch, and a dead network does not matter
    const dead = (async () => {
      throw new Error('offline')
    }) as unknown as typeof fetch
    const second = await loadModelCatalog('openrouter', dir, { fetch: dead, offline: false })
    expect(second.catalog).toBeDefined()
    expect(second.refresh).toBeUndefined()
    expect(calls.length).toBe(1)
    // nothing cached and no network: no catalog, no throw
    expect(
      (await loadModelCatalog('openrouter', tmp(), { fetch: dead, offline: false })).catalog,
    ).toBeUndefined()
  })

  test('a stale cache is used and refreshed in the background', async () => {
    const dir = tmp()
    const file = join(dir, 'openrouter-models.json')
    writeFileSync(file, JSON.stringify(LIST))
    const old = new Date(Date.now() - 48 * 3600_000)
    utimesSync(file, old, old)
    const calls: string[] = []
    const r = await loadModelCatalog('openrouter', dir, { fetch: okFetch(calls), offline: false })
    expect(r.catalog).toBeDefined()
    await r.refresh
    expect(calls.length).toBe(1)
  })
})

describe('catalog in chats', () => {
  test('stats carry the model entry and the ledger gets a real cost', async () => {
    const dir = tmp()
    const server = compose({
      dbFile: join(dir, 'team.db'),
      models: scriptedModelConfig(
        scriptedModel([{ text: 'hi', usage: { inputTokens: 1000, outputTokens: 1000 } }]) as never,
      ),
      catalog: { scripted: { contextWindow: 123_456, pricing: { input: 1000, output: 2000 } } },
    })
    servers.push(server)
    const res = await server.app.request('/agents/researcher/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        messages: [{ id: 'c', role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
      }),
    })
    await res.text()
    const stats = (await (await server.app.request('/agents/researcher/stats')).json()) as {
      model: { id: string; contextWindow?: number; pricing?: { input: number } }
      context: { window: number }
      usage: { costUsd: number }
    }
    expect(stats.model.id).toBe('scripted')
    expect(stats.model.contextWindow).toBe(123_456)
    expect(stats.model.pricing?.input).toBe(1000)
    expect(stats.context.window).toBe(123_456)
    expect(stats.usage.costUsd).toBeCloseTo(3, 5)
  })
})
