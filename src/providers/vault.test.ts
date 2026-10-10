import { describe, expect, test } from 'bun:test'
import { sealedProfileStore } from './sealed.ts'
import { memoryProfileStore } from './store.ts'
import { plaintextVault, webCryptoVault, withLegacyVault } from './vault.ts'

const key = (): Uint8Array => crypto.getRandomValues(new Uint8Array(32))

describe('withLegacyVault', () => {
  const legacy = {
    matches: (s: string) => s.startsWith('old:'),
    open: async (s: string, context: string) => `${s.slice(4)}@${context}`,
  }

  test('routes legacy blobs to the legacy opener and seals with the current vault', async () => {
    const vault = withLegacyVault(webCryptoVault(key()), legacy)
    expect(await vault.open('old:abc', 'ctx')).toBe('abc@ctx')
    const blob = await vault.seal('secret', 'ctx')
    expect(blob.startsWith('v2.')).toBe(true)
    expect(await vault.open(blob, 'ctx')).toBe('secret')
    expect(vault.needsReseal?.('old:abc')).toBe(true)
    expect(vault.needsReseal?.(blob)).toBe(false)
  })

  test('reseal() rewrites a legacy row in the current format', async () => {
    const inner = memoryProfileStore([
      {
        id: 'p',
        kind: 'connection',
        definitionId: 'd',
        label: 'P',
        settings: { '~sealed': 'old:{"token":"t"}' },
        enabled: true,
        source: 'store',
        updatedAt: 1,
      },
    ])
    const vault = withLegacyVault(webCryptoVault(key()), {
      matches: (s) => s.startsWith('old:'),
      open: async (s) => s.slice(4),
    })
    const store = sealedProfileStore(inner, vault)
    expect((await store.get('connection', 'p'))?.settings).toEqual({ token: 't' })
    expect(await store.reseal()).toBe(1)
    const raw = (await inner.get('connection', 'p'))?.settings['~sealed'] as string
    expect(raw.startsWith('v2.')).toBe(true)
    expect((await store.get('connection', 'p'))?.settings).toEqual({ token: 't' })
    expect(await store.reseal()).toBe(0)
  })

  test('a plaintext vault keeps working behind it', async () => {
    const vault = withLegacyVault(plaintextVault(), legacy)
    expect(await vault.open(await vault.seal('x', 'c'), 'c')).toBe('x')
  })
})

describe('sealedProfileStore onUnreadable', () => {
  test('list skips a row that cannot be opened and reports it; get still rejects', async () => {
    const inner = memoryProfileStore()
    const a = sealedProfileStore(inner, webCryptoVault(key()))
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
    const b = sealedProfileStore(inner, webCryptoVault(key()), {
      onUnreadable: (r) => skipped.push(`${r.kind}:${r.id}`),
    })
    await b.put(profile('two'))
    expect((await b.list()).map((p) => p.id)).toEqual(['two'])
    expect(skipped).toEqual(['provider:one'])
    await expect(b.get('provider', 'one')).rejects.toThrow()
    await expect(sealedProfileStore(inner, webCryptoVault(key())).list()).rejects.toThrow()
  })
})
