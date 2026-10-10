import { assertJsonEqual, assertTrue } from './assert.ts'
import type { ConformanceCase } from './types.ts'

/** Structural shape of a profile (`eharness/providers` `ConfigProfile`). */
interface ProfileLike {
  id: string
  kind: string
  definitionId: string
  label: string
  settings: Record<string, unknown>
  enabled: boolean
  source?: 'env' | 'store'
  updatedAt: number
}

/** Structural shape of a `ProfileStore` (`eharness/providers`). */
export interface ProfileStoreUnderTest {
  list(query?: { kind?: string }): Promise<ProfileLike[]>
  get(kind: string, id: string): Promise<ProfileLike | undefined>
  put(profile: ProfileLike): Promise<void>
  delete(kind: string, id: string): Promise<void>
  subscribe?(listener: () => void): () => void
}

/** Options of {@link profileStoreConformance}. */
export interface ProfileStoreConformanceOptions {
  /** Require `subscribe`. Default false: the case runs only when present. */
  requireSubscribe?: boolean
}

const profile = (id: string, kind = 'provider', extra: Partial<ProfileLike> = {}): ProfileLike => ({
  id,
  kind,
  definitionId: 'openrouter',
  label: `Profile ${id}`,
  settings: { apiKey: 'sk-test-ø ✓ 😀', headers: { a: 'b' } },
  enabled: true,
  updatedAt: 1_790_000_000_000,
  ...extra,
})

/**
 * Conformance cases for a `ProfileStore` (`eharness/providers`): empty list, JSON round-trip,
 * copies on read and write, replace by `(kind, id)`, kind isolation and filtering, idempotent
 * delete and, when implemented (or required), change notifications.
 *
 * @example
 * ```ts
 * for (const c of profileStoreConformance(() => sqliteProfiles(db))) test(c.name, c.run)
 * ```
 * @see docs/specs/23-providers.md#3-profiles-and-the-store
 */
export function profileStoreConformance(
  factory: () => ProfileStoreUnderTest | Promise<ProfileStoreUnderTest>,
  options: ProfileStoreConformanceOptions = {},
): ConformanceCase[] {
  return [
    {
      name: 'get returns undefined and list is empty for an empty store',
      run: async () => {
        const store = await factory()
        assertTrue((await store.get('provider', 'nope')) === undefined, 'get should be undefined')
        assertJsonEqual(await store.list({ kind: 'provider' }), [], 'list')
      },
    },
    {
      name: 'put then get round-trips the profile',
      run: async () => {
        const store = await factory()
        const p = profile('a', 'provider', { source: 'store' })
        await store.put(p)
        assertJsonEqual(await store.get('provider', 'a'), p, 'get')
      },
    },
    {
      name: 'put replaces by kind and id',
      run: async () => {
        const store = await factory()
        await store.put(profile('a'))
        await store.put(profile('a', 'provider', { label: 'changed', enabled: false }))
        const rows = await store.list({ kind: 'provider' })
        assertTrue(rows.length === 1, 'one row')
        assertTrue(rows[0]?.label === 'changed' && rows[0].enabled === false, 'replaced')
      },
    },
    {
      name: 'stores and returns copies',
      run: async () => {
        const store = await factory()
        const p = profile('a')
        await store.put(p)
        p.settings.apiKey = 'mutated-after-put'
        const first = await store.get('provider', 'a')
        assertTrue(first?.settings.apiKey === 'sk-test-ø ✓ 😀', 'input mutation leaked')
        if (first !== undefined) first.settings.apiKey = 'mutated-after-get'
        const second = await store.get('provider', 'a')
        assertTrue(second?.settings.apiKey === 'sk-test-ø ✓ 😀', 'output mutation leaked')
      },
    },
    {
      name: 'kinds are isolated and list filters by kind',
      run: async () => {
        const store = await factory()
        await store.put(profile('a', 'provider'))
        await store.put(profile('a', 'connector', { label: 'connector a' }))
        await store.put(profile('b', 'connector'))
        assertTrue((await store.get('provider', 'a'))?.label === 'Profile a', 'provider a')
        assertTrue((await store.get('connector', 'a'))?.label === 'connector a', 'connector a')
        assertTrue((await store.list({ kind: 'connector' })).length === 2, 'connector count')
        assertTrue((await store.list({ kind: 'provider' })).length === 1, 'provider count')
        assertTrue((await store.list()).length === 3, 'all')
      },
    },
    {
      name: 'delete removes one profile and is idempotent',
      run: async () => {
        const store = await factory()
        await store.put(profile('a'))
        await store.put(profile('b'))
        await store.delete('provider', 'a')
        await store.delete('provider', 'a')
        await store.delete('provider', 'never-existed')
        const ids = (await store.list({ kind: 'provider' })).map((p) => p.id)
        assertJsonEqual(ids, ['b'], 'remaining')
      },
    },
    {
      name: 'subscribe notifies about put and delete and can unsubscribe',
      run: async () => {
        const store = await factory()
        if (store.subscribe === undefined) {
          assertTrue(options.requireSubscribe !== true, 'subscribe is required but not implemented')
          return
        }
        let calls = 0
        const off = store.subscribe(() => {
          calls += 1
        })
        await store.put(profile('a'))
        await store.delete('provider', 'a')
        assertTrue(calls >= 2, `expected at least 2 notifications, got ${calls}`)
        off()
        const before = calls
        await store.put(profile('b'))
        assertTrue(calls === before, 'notified after unsubscribe')
      },
    },
  ]
}
