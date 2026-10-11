import { describe, expect, test } from 'bun:test'
import { sealedProfileStore } from './sealed.ts'
import { inMemoryProfileStore } from './store.ts'
import { webCryptoVault } from './vault.ts'

const key = (): Uint8Array => crypto.getRandomValues(new Uint8Array(32))

describe('sealedProfileStore onUnreadable', () => {
  test('list skips a row that cannot be opened and reports it; get still rejects', async () => {
    const inner = inMemoryProfileStore()
    const a = sealedProfileStore({ inner, vault: webCryptoVault(key()) })
    const profile = (id: string) => ({
      id,
      kind: 'provider',
      definitionId: 'd',
      label: id,
      settings: { apiKey: id },
      enabled: true,
      source: 'store' as const,
      updatedAt: 1,
    })
    await a.put(profile('one'))
    const skipped: string[] = []
    const b = sealedProfileStore({
      inner,
      vault: webCryptoVault(key()),
      onUnreadable: (r) => skipped.push(`${r.kind}:${r.id}`),
    })
    await b.put(profile('two'))
    expect((await b.list()).map((p) => p.id)).toEqual(['two'])
    expect(skipped).toEqual(['provider:one'])
    await expect(b.get('provider', 'one')).rejects.toThrow()
    await expect(
      sealedProfileStore({ inner, vault: webCryptoVault(key()) }).list(),
    ).rejects.toThrow()
  })
})
