import { describe, expect, test } from 'bun:test'
import { utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { lookupModel } from 'eharness'
import { loadModelCatalog } from '../src/app/models.ts'
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
