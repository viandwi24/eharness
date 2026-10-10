import { describe, expect, test } from 'bun:test'
import {
  memoryProfileStore,
  plaintextVault,
  sealedProfileStore,
  webCryptoVault,
} from '../providers/index.ts'
import {
  connectionStoreConformance,
  credentialStoreConformance,
  enablementStoreConformance,
  flowStoreConformance,
} from '../testing/connectors.conformance.ts'
import { createCredentialManager, memoryRefreshLock } from './credentials.ts'
import {
  CONNECTION_KIND,
  CREDENTIALS_KIND,
  connectionStoreFromProfiles,
  credentialStoreFromProfiles,
  memoryConnectionStore,
  memoryCredentialStore,
  memoryEnablementStore,
  memoryFlowStore,
} from './store.ts'
import { asFetch, fakeAuthServer } from './test-kit.ts'
import type { ConnectionRecord } from './types.ts'

describe('memory stores conformance', () => {
  for (const c of connectionStoreConformance(() => memoryConnectionStore()))
    test(`connection: ${c.name}`, c.run)
  for (const c of credentialStoreConformance(() => memoryCredentialStore()))
    test(`credentials: ${c.name}`, c.run)
  for (const c of credentialStoreConformance(() =>
    memoryCredentialStore({ vault: plaintextVault() }),
  ))
    test(`sealed credentials: ${c.name}`, c.run)
  for (const c of enablementStoreConformance(() => memoryEnablementStore()))
    test(`enablement: ${c.name}`, c.run)
  for (const c of flowStoreConformance(() => memoryFlowStore())) test(`flow: ${c.name}`, c.run)
  // composition over a sealed profile store with AES-GCM
  for (const c of connectionStoreConformance(() =>
    connectionStoreFromProfiles(
      sealedProfileStore(memoryProfileStore(), webCryptoVault(new Uint8Array(32)), {
        kinds: [CONNECTION_KIND],
      }),
    ),
  ))
    test(`sealed connections: ${c.name}`, c.run)
})

describe('one profile store holds providers, connections and credentials', () => {
  test('kinds are isolated, secrets are ciphertext in the inner store, subscribe is shared', async () => {
    const inner = memoryProfileStore()
    const vault = webCryptoVault(new Uint8Array(32).fill(1))
    const profiles = sealedProfileStore(inner, vault, {
      kinds: [CONNECTION_KIND, CREDENTIALS_KIND],
    })
    const connections = connectionStoreFromProfiles(profiles)
    const credentials = credentialStoreFromProfiles(profiles)
    let events = 0
    connections.subscribe?.(() => events++)
    await profiles.put({
      id: 'p1',
      kind: 'provider',
      definitionId: 'openrouter',
      label: 'P',
      settings: { apiKey: 'sk-provider' },
      enabled: true,
      updatedAt: 1,
    })
    const record: ConnectionRecord = {
      id: 'c1',
      kind: 'connection',
      definitionId: 'x',
      label: 'X',
      settings: { apiKey: 'sk-connection' },
      enabled: true,
      updatedAt: 1,
      scope: 'workspace',
      status: 'connected',
      defaultEnabled: false,
      createdAt: 1,
    }
    await connections.put(record)
    await credentials.put('c1', { tokens: { accessToken: 'at-secret', tokenType: 'Bearer' } })
    const raw = JSON.stringify(await inner.list())
    expect(raw).toContain('sk-provider') // not a sealed kind here
    expect(raw).not.toContain('sk-connection')
    expect(raw).not.toContain('at-secret')
    expect((await connections.get('c1'))?.settings).toEqual({ apiKey: 'sk-connection' })
    expect((await connections.list()).length).toBe(1)
    expect((await credentials.get('c1'))?.tokens?.accessToken).toBe('at-secret')
    expect(events).toBeGreaterThan(0)
  })

  test('a blob is bound to its row: moving it fails to open', async () => {
    const inner = memoryProfileStore()
    const profiles = sealedProfileStore(inner, webCryptoVault(new Uint8Array(32).fill(2)))
    await profiles.put({
      id: 'a',
      kind: 'k',
      definitionId: 'd',
      label: 'l',
      settings: { s: 'v' },
      enabled: true,
      updatedAt: 1,
    })
    const row = await inner.get('k', 'a')
    await inner.put({ ...(row as NonNullable<typeof row>), id: 'b' })
    await expect(profiles.get('k', 'b')).rejects.toMatchObject({
      details: { reason: 'vault-open' },
    })
  })

  test('secret-field mode seals only secret fields; rotation re-seals', async () => {
    const { z } = await import('zod/v4')
    const { ehMeta } = await import('../providers/index.ts')
    const schema = z.object({ apiKey: z.string().meta(ehMeta({ secret: true })), url: z.string() })
    const inner = memoryProfileStore()
    const oldKey = new Uint8Array(32).fill(3)
    const newKey = new Uint8Array(32).fill(4)
    const v1 = webCryptoVault({ keys: { k1: oldKey }, current: 'k1' })
    const s1 = sealedProfileStore(inner, v1, { schemaOf: () => schema })
    await s1.put({
      id: 'a',
      kind: 'provider',
      definitionId: 'd',
      label: 'l',
      settings: { apiKey: 'sk-1', url: 'https://x' },
      enabled: true,
      updatedAt: 1,
    })
    const raw = (await inner.get('provider', 'a'))?.settings as Record<string, unknown>
    expect(raw.url).toBe('https://x')
    expect(JSON.stringify(raw.apiKey)).not.toContain('sk-1')
    const v2 = webCryptoVault({ keys: { k1: oldKey, k2: newKey }, current: 'k2' })
    const s2 = sealedProfileStore(inner, v2, { schemaOf: () => schema })
    expect((await s2.get('provider', 'a'))?.settings.apiKey).toBe('sk-1')
    expect(await s2.reseal()).toBe(1)
    expect(await s2.reseal()).toBe(0)
    expect(JSON.stringify(await inner.get('provider', 'a'))).toContain('v2.k2.')
    const onlyNew = sealedProfileStore(
      inner,
      webCryptoVault({ keys: { k2: newKey }, current: 'k2' }),
      { schemaOf: () => schema },
    )
    expect((await onlyNew.get('provider', 'a'))?.settings.apiKey).toBe('sk-1')
  })
})

describe('credential manager', () => {
  const seed = async (expiresAt: number | undefined) => {
    const credentials = memoryCredentialStore()
    const connections = memoryConnectionStore()
    await credentials.put('c1', {
      tokens: {
        accessToken: 'old',
        tokenType: 'Bearer',
        refreshToken: 'refresh-0',
        ...(expiresAt === undefined ? {} : { expiresAt }),
      },
      client: { clientId: 'cid' },
      endpoints: {
        tokenUrl: 'https://auth.example.com/token',
        resource: 'https://mcp.example.com/mcp',
      },
    })
    await connections.put({
      id: 'c1',
      kind: 'connection',
      definitionId: 'x',
      label: 'X',
      settings: {},
      enabled: true,
      updatedAt: 1,
      scope: 'workspace',
      status: 'connected',
      defaultEnabled: false,
      createdAt: 1,
    })
    return { credentials, connections }
  }

  test('a valid token is returned without a request; an expired one is refreshed once under the lock', async () => {
    const server = fakeAuthServer()
    const { credentials, connections } = await seed(10_000_000)
    const now = { t: 1000 }
    const mgr = createCredentialManager({
      credentials,
      connections,
      fetch: server.fetch,
      now: () => now.t,
    })
    expect(await mgr.getAccessToken('c1')).toBe('old')
    expect(server.requests.length).toBe(0)
    now.t = 10_000_000 // expired
    const [a, b, c] = await Promise.all([
      mgr.getAccessToken('c1'),
      mgr.getAccessToken('c1'),
      mgr.getAccessToken('c1'),
    ])
    expect([a, b, c]).toEqual(['access-1', 'access-1', 'access-1'])
    expect(server.tokenRequests.length).toBe(1)
    expect(server.tokenRequests[0]?.get('resource')).toBe('https://mcp.example.com/mcp')
    const stored = await credentials.get('c1')
    expect(stored?.tokens?.refreshToken).toBe('refresh-1') // rotated
    expect(stored?.client?.clientId).toBe('cid') // not lost
  })

  test('a rejected refresh token marks the connection needs-auth and rejects', async () => {
    const server = fakeAuthServer()
    server.rejectRefresh = true
    const { credentials, connections } = await seed(1)
    const mgr = createCredentialManager({
      credentials,
      connections,
      fetch: server.fetch,
      now: () => 5_000_000,
    })
    await expect(mgr.getAccessToken('c1')).rejects.toMatchObject({
      details: { reason: 'needs-auth' },
    })
    expect((await connections.get('c1'))?.status).toBe('needs-auth')
  })

  test('no credentials rejects needs-auth; a network failure does not mark the connection', async () => {
    const { credentials, connections } = await seed(1)
    const failing = asFetch(async () => {
      throw new Error('offline')
    })
    const mgr = createCredentialManager({
      credentials,
      connections,
      fetch: failing,
      now: () => 5_000_000,
    })
    await expect(mgr.getAccessToken('c1')).rejects.toThrow('offline')
    expect((await connections.get('c1'))?.status).toBe('connected')
    await expect(mgr.getAccessToken('nope')).rejects.toMatchObject({
      details: { reason: 'needs-auth' },
    })
  })

  test('the memory lock serializes work per key', async () => {
    const lock = memoryRefreshLock()
    const order: string[] = []
    await Promise.all([
      lock('k', async () => {
        order.push('a1')
        await new Promise((r) => setTimeout(r, 5))
        order.push('a2')
      }),
      lock('k', async () => {
        order.push('b1')
        order.push('b2')
      }),
    ])
    expect(order).toEqual(['a1', 'a2', 'b1', 'b2'])
  })
})
