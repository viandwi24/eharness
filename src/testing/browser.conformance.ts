import type { BrowserProfileStore } from '../browser/index.ts'
import { assertTrue, uniqueSessionId } from './assert.ts'
import type { ConformanceCase } from './types.ts'

/**
 * Conformance cases for a {@link BrowserProfileStore} (spec 35 §3): create assigns an id and
 * timestamps; names are unique case-insensitively (`EH_CONFIG_INVALID`); `get` and `list` return
 * copies; `list` pages in creation order with a cursor; `update` merges fields, moves `updatedAt`
 * and honours `ifUpdatedAt`; `delete` is idempotent.
 *
 * @example
 * ```ts
 * for (const c of browserProfileStoreConformance(() => dbProfiles(db))) test(c.name, c.run)
 * ```
 * @see docs/specs/35-browser.md#3-profiles
 */
export function browserProfileStoreConformance(
  factory: () => BrowserProfileStore | Promise<BrowserProfileStore>,
): ConformanceCase[] {
  /** A name no other case (or an earlier run in a shared database) uses. */
  const unique = (name: string): string => `${name}-${uniqueSessionId('p')}`
  const input = (
    name: string,
  ): {
    name: string
    adapter: string
    mode: 'manual'
    settings: Record<string, unknown>
  } => ({
    name,
    adapter: 'chrome',
    mode: 'manual',
    settings: { cdpUrl: 'ws://127.0.0.1:9222/devtools/browser/x', headers: { a: 'ø ✓ 😀' } },
  })
  const rejectsConfigInvalid = async (run: () => Promise<unknown>): Promise<boolean> => {
    try {
      await run()
      return false
    } catch (error) {
      return (error as { code?: string }).code === 'EH_CONFIG_INVALID'
    }
  }

  return [
    {
      name: 'create assigns an id and timestamps, and get round-trips the settings',
      run: async () => {
        const store = await factory()
        const work = input(unique('Work'))
        const created = await store.create({
          ...work,
          allowDomains: ['*.example.com'],
          trusted: true,
          metadata: { owner: 'ana' },
        })
        assertTrue(created.id !== '' && created.createdAt > 0, 'id and createdAt')
        assertTrue(created.updatedAt >= created.createdAt, 'updatedAt')
        const got = await store.get(created.id)
        assertTrue(got !== null, 'get finds it')
        assertTrue(
          JSON.stringify(got?.settings) === JSON.stringify(work.settings),
          'settings round-trip',
        )
        assertTrue(got?.allowDomains?.[0] === '*.example.com', 'allowDomains')
        assertTrue(got?.trusted === true, 'trusted')
        assertTrue(got?.metadata?.owner === 'ana', 'metadata')
        assertTrue((await store.get('nope')) === null, 'unknown id is null')
      },
    },
    {
      name: 'names are unique case-insensitively on create and update',
      run: async () => {
        const store = await factory()
        const shop = unique('Shop')
        const a = await store.create(input(shop))
        assertTrue(
          await rejectsConfigInvalid(() => store.create(input(`  ${shop.toLowerCase()} `))),
          'duplicate name on create',
        )
        const b = await store.create(input(unique('Other')))
        assertTrue(
          await rejectsConfigInvalid(() => store.update(b.id, { name: shop.toUpperCase() })),
          'duplicate name on update',
        )
        const same = await store.update(a.id, { name: shop.toUpperCase() })
        assertTrue(same.ok, 'renaming to its own name (other case) is fine')
      },
    },
    {
      name: 'get and list return copies',
      run: async () => {
        const store = await factory()
        const created = await store.create(input(unique('Copy')))
        created.settings.cdpUrl = 'changed'
        const got = await store.get(created.id)
        assertTrue(got?.settings.cdpUrl !== 'changed', 'create result is a copy')
        if (got !== null) got.settings.cdpUrl = 'changed too'
        assertTrue(
          (await store.get(created.id))?.settings.cdpUrl !== 'changed too',
          'get result is a copy',
        )
        const listed = await store.list()
        const first = listed.items[0]
        if (first !== undefined) first.settings.cdpUrl = 'x'
        assertTrue((await store.get(created.id))?.settings.cdpUrl !== 'x', 'list result is a copy')
      },
    },
    {
      name: 'list pages in creation order with a cursor',
      run: async () => {
        const store = await factory()
        const names = ['One', 'Two', 'Three', 'Four', 'Five'].map(unique)
        for (const name of names) await store.create(input(name))
        const seen: string[] = []
        let cursor: string | undefined
        let pages = 0
        do {
          const page = await store.list({ limit: 2, ...(cursor === undefined ? {} : { cursor }) })
          assertTrue(page.items.length <= 2, 'page size')
          seen.push(...page.items.map((p) => p.name).filter((n) => names.includes(n)))
          cursor = page.nextCursor
          pages++
        } while (cursor !== undefined && pages < 1000)
        assertTrue(JSON.stringify(seen) === JSON.stringify(names), `order: ${seen.join(',')}`)
        assertTrue(pages >= 3, `at least three pages, got ${pages}`)
      },
    },
    {
      name: 'update merges fields, moves updatedAt and honours ifUpdatedAt',
      run: async () => {
        const store = await factory()
        const created = await store.create(input(unique('Edit')))
        const missing = await store.update('nope', { name: 'x' })
        assertTrue(!missing.ok && missing.reason === 'not-found', 'not-found')
        const stale = await store.update(created.id, { trusted: true }, created.updatedAt - 1)
        assertTrue(!stale.ok && stale.reason === 'conflict', 'conflict on a wrong ifUpdatedAt')
        const done = await store.update(
          created.id,
          { trusted: true, allowDomains: ['a.test'] },
          created.updatedAt,
        )
        assertTrue(done.ok, 'update with the right ifUpdatedAt')
        if (!done.ok) return
        assertTrue(done.profile.updatedAt > created.updatedAt, 'updatedAt moved')
        assertTrue(
          done.profile.trusted === true && done.profile.name === created.name,
          'fields merged',
        )
        const cleared = await store.update(created.id, { allowDomains: [], trusted: false })
        assertTrue(
          cleared.ok &&
            (cleared.profile.allowDomains === undefined ||
              cleared.profile.allowDomains.length === 0) &&
            cleared.profile.trusted !== true,
          'allowDomains and trusted can be cleared',
        )
        const again = await store.update(created.id, { trusted: true }, created.updatedAt)
        assertTrue(!again.ok && again.reason === 'conflict', 'the old version conflicts now')
      },
    },
    {
      name: 'delete is idempotent',
      run: async () => {
        const store = await factory()
        const gone = unique('Gone')
        const created = await store.create(input(gone))
        assertTrue((await store.delete(created.id)) === true, 'first delete')
        assertTrue((await store.delete(created.id)) === false, 'second delete')
        assertTrue((await store.get(created.id)) === null, 'gone')
        const again = await store.create(input(gone))
        assertTrue(again.id !== created.id, 'a name can be reused after delete')
      },
    },
  ]
}
