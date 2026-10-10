/** `sqliteProfileStore`: list order is creation order, so editing a profile keeps the default. */
import { describe, expect, test } from 'bun:test'
import type { ConfigProfile } from 'eharness/providers'
import { openDatabase } from '../src/infra/db/client.ts'
import { sqliteProfileStore } from '../src/infra/eh/profile-store.ts'

const profile = (id: string, updatedAt: number): ConfigProfile =>
  ({
    id,
    kind: 'provider',
    definitionId: 'openrouter',
    label: id,
    settings: {},
    enabled: true,
    source: 'store',
    updatedAt,
  }) as ConfigProfile

describe('sqliteProfileStore ordering', () => {
  test('editing the first profile does not reorder the list (the default stays)', async () => {
    const store = sqliteProfileStore(openDatabase(':memory:').sqlite)
    await store.put(profile('a', 1))
    await store.put(profile('b', 2))
    await store.put({ ...profile('a', 3), label: 'A edited' })
    expect((await store.list({ kind: 'provider' })).map((p) => p.id)).toEqual(['a', 'b'])
    expect((await store.list()).map((p) => p.id)).toEqual(['a', 'b'])
  })
})
