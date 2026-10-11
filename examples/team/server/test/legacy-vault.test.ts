import { describe, expect, test } from 'bun:test'
import {
  inMemoryProfileStore,
  plaintextVault,
  sealedProfileStore,
  webCryptoVault,
} from 'eharness/providers'
import { withLegacyVault } from '../src/infra/eh/legacy-vault.ts'

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
    const inner = inMemoryProfileStore({
      initial: [
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
      ],
    })
    const vault = withLegacyVault(webCryptoVault(key()), {
      matches: (s) => s.startsWith('old:'),
      open: async (s) => s.slice(4),
    })
    const store = sealedProfileStore({ inner, vault })
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
