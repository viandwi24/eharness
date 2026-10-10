import { assertJsonEqual, assertTrue } from './assert.ts'
import type { ConformanceCase } from './types.ts'

/** Structural shape of a connection (`eharness/connectors` `ConnectionRecord`). */
interface ConnectionLike {
  id: string
  kind: string
  definitionId: string
  label: string
  settings: Record<string, unknown>
  enabled: boolean
  updatedAt: number
  scope: string
  scopeId?: string
  status: string
  defaultEnabled: boolean
  createdAt: number
}

/** Structural shape of a `ConnectionStore` (`eharness/connectors`). */
export interface ConnectionStoreUnderTest {
  list(query?: {
    scope?: string
    scopeId?: string
    definitionId?: string
  }): Promise<ConnectionLike[]>
  get(id: string): Promise<ConnectionLike | undefined>
  put(record: ConnectionLike): Promise<void>
  delete(id: string): Promise<void>
  subscribe?(listener: () => void): () => void
}

const connection = (
  id: string,
  extra: Partial<ConnectionLike> & Record<string, unknown> = {},
): ConnectionLike => ({
  id,
  kind: 'connection',
  definitionId: 'github',
  label: `Connection ${id}`,
  settings: { token: 'ghp-test-ø ✓ 😀', headers: { a: 'b' } },
  enabled: true,
  updatedAt: 1_790_000_000_000,
  scope: 'workspace',
  status: 'connected',
  defaultEnabled: false,
  createdAt: 1_790_000_000_000,
  ...extra,
})

/**
 * Conformance cases for a `ConnectionStore` (`eharness/connectors`): empty store, JSON
 * round-trip, copies on read and write, replace by id, filtering by scope, scope id and
 * definition, idempotent delete and, when implemented, change notifications.
 *
 * @example
 * ```ts
 * for (const c of connectionStoreConformance(() => sqliteConnections(db))) test(c.name, c.run)
 * ```
 * @see docs/specs/24-connectors.md#6-stores
 */
export function connectionStoreConformance(
  factory: () => ConnectionStoreUnderTest | Promise<ConnectionStoreUnderTest>,
): ConformanceCase[] {
  return [
    {
      name: 'get returns undefined and list is empty for an empty store',
      run: async () => {
        const store = await factory()
        assertTrue((await store.get('nope')) === undefined, 'get should be undefined')
        assertJsonEqual(await store.list(), [], 'list')
      },
    },
    {
      name: 'put then get round-trips the record',
      run: async () => {
        const store = await factory()
        const record = connection('a', { scopeId: undefined, choices: { repos: ['x'] } })
        await store.put(record)
        assertJsonEqual(await store.get('a'), record, 'get')
      },
    },
    {
      name: 'put replaces by id',
      run: async () => {
        const store = await factory()
        await store.put(connection('a'))
        await store.put(connection('a', { label: 'changed', status: 'needs-auth' }))
        const rows = await store.list()
        assertTrue(rows.length === 1, 'one row')
        assertTrue(rows[0]?.label === 'changed' && rows[0].status === 'needs-auth', 'replaced')
      },
    },
    {
      name: 'stores and returns copies',
      run: async () => {
        const store = await factory()
        const record = connection('a')
        await store.put(record)
        record.settings.token = 'mutated-after-put'
        const first = await store.get('a')
        assertTrue(first?.settings.token === 'ghp-test-ø ✓ 😀', 'input mutation leaked')
        if (first !== undefined) first.settings.token = 'mutated-after-get'
        const second = await store.get('a')
        assertTrue(second?.settings.token === 'ghp-test-ø ✓ 😀', 'output mutation leaked')
      },
    },
    {
      name: 'list filters by scope, scope id and definition',
      run: async () => {
        const store = await factory()
        await store.put(connection('w1'))
        await store.put(connection('w2', { definitionId: 'slack' }))
        await store.put(connection('a1', { scope: 'agent', scopeId: 'agent-1' }))
        await store.put(connection('a2', { scope: 'agent', scopeId: 'agent-2' }))
        assertTrue((await store.list()).length === 4, 'all')
        assertTrue((await store.list({ scope: 'workspace' })).length === 2, 'workspace')
        assertTrue(
          (await store.list({ scope: 'agent', scopeId: 'agent-2' })).length === 1,
          'agent-2',
        )
        assertTrue((await store.list({ definitionId: 'slack' })).length === 1, 'slack')
      },
    },
    {
      name: 'delete is idempotent',
      run: async () => {
        const store = await factory()
        await store.put(connection('a'))
        await store.delete('a')
        await store.delete('a')
        assertTrue((await store.get('a')) === undefined, 'deleted')
      },
    },
    {
      name: 'subscribe notifies about puts and deletes (when implemented)',
      run: async () => {
        const store = await factory()
        if (store.subscribe === undefined) return
        let calls = 0
        const off = store.subscribe(() => {
          calls++
        })
        await store.put(connection('a'))
        await store.delete('a')
        off()
        await store.put(connection('b'))
        assertTrue(calls >= 2, 'listener should be called')
        assertTrue(calls === 2, 'no calls after unsubscribe')
      },
    },
  ]
}

/** Structural shape of a `CredentialStore` (`eharness/connectors`). */
export interface CredentialStoreUnderTest {
  get(connectionId: string): Promise<object | undefined>
  put(connectionId: string, credentials: never): Promise<void>
  delete(connectionId: string): Promise<void>
}

const tokensOf = (value: Record<string, unknown> | undefined): Record<string, unknown> =>
  (value?.tokens ?? {}) as Record<string, unknown>

const credentials = (): Record<string, unknown> => ({
  tokens: {
    accessToken: 'at-ø ✓ 😀',
    tokenType: 'Bearer',
    refreshToken: 'rt',
    expiresAt: 1_790_000_000_000,
  },
  client: { clientId: 'cid', clientSecret: 'secret', dynamic: true },
  endpoints: { tokenUrl: 'https://auth.example.com/token', resource: 'https://mcp.example.com' },
})

/**
 * Conformance cases for a `CredentialStore`: JSON round-trip, copies, replace, per-connection
 * isolation and idempotent delete.
 *
 * @see docs/specs/24-connectors.md#6-stores
 */
export function credentialStoreConformance(
  factory: () => CredentialStoreUnderTest | Promise<CredentialStoreUnderTest>,
): ConformanceCase[] {
  return [
    {
      name: 'get returns undefined for an unknown connection',
      run: async () => {
        const store = await factory()
        assertTrue((await store.get('nope')) === undefined, 'get should be undefined')
      },
    },
    {
      name: 'put then get round-trips the credentials',
      run: async () => {
        const store = await factory()
        await store.put('c1', credentials() as never)
        assertJsonEqual(await store.get('c1'), credentials(), 'get')
      },
    },
    {
      name: 'put replaces and connections are isolated',
      run: async () => {
        const store = await factory()
        await store.put('c1', credentials() as never)
        await store.put('c2', { tokens: { accessToken: 'other', tokenType: 'Bearer' } } as never)
        await store.put('c1', { tokens: { accessToken: 'new', tokenType: 'Bearer' } } as never)
        assertJsonEqual(
          await store.get('c1'),
          { tokens: { accessToken: 'new', tokenType: 'Bearer' } },
          'c1',
        )
        assertJsonEqual(
          await store.get('c2'),
          { tokens: { accessToken: 'other', tokenType: 'Bearer' } },
          'c2',
        )
      },
    },
    {
      name: 'stores and returns copies',
      run: async () => {
        const store = await factory()
        const value = credentials()
        await store.put('c1', value as never)
        ;(value.tokens as Record<string, unknown>).accessToken = 'mutated'
        const first = (await store.get('c1')) as Record<string, unknown> | undefined
        assertTrue(tokensOf(first).accessToken === 'at-ø ✓ 😀', 'input mutation leaked')
        tokensOf(first).accessToken = 'mutated-again'
        const second = (await store.get('c1')) as Record<string, unknown> | undefined
        assertTrue(tokensOf(second).accessToken === 'at-ø ✓ 😀', 'output mutation leaked')
      },
    },
    {
      name: 'delete is idempotent',
      run: async () => {
        const store = await factory()
        await store.put('c1', credentials() as never)
        await store.delete('c1')
        await store.delete('c1')
        assertTrue((await store.get('c1')) === undefined, 'deleted')
      },
    },
  ]
}

/** Structural shape of one `ConnectionEnablement`. */
interface EnablementEntry {
  enabled?: string
}

/** Structural shape of an `EnablementStore` (`eharness/connectors`). */
export interface EnablementStoreUnderTest {
  get(agentId: string): Promise<Record<string, EnablementEntry>>
  set(
    agentId: string,
    connectionId: string,
    value: Record<string, unknown> | undefined,
  ): Promise<void>
  removeConnection(connectionId: string): Promise<void>
  removeAgent(agentId: string): Promise<void>
}

/**
 * Conformance cases for an `EnablementStore`: empty agents, set and replace, removal with
 * `undefined`, copies, `removeConnection` across agents and `removeAgent`.
 *
 * @see docs/specs/24-connectors.md#6-stores
 */
export function enablementStoreConformance(
  factory: () => EnablementStoreUnderTest | Promise<EnablementStoreUnderTest>,
): ConformanceCase[] {
  const entry = {
    enabled: 'on',
    capabilities: { read: 'allow', write: 'ask' },
    tools: { delete_x: 'off' },
    choices: { repos: ['a', 'b'] },
  }
  return [
    {
      name: 'an agent without entries has an empty enablement',
      run: async () => {
        const store = await factory()
        assertJsonEqual(await store.get('agent-1'), {}, 'get')
      },
    },
    {
      name: 'set then get round-trips and set replaces',
      run: async () => {
        const store = await factory()
        await store.set('agent-1', 'c1', entry)
        assertJsonEqual(await store.get('agent-1'), { c1: entry }, 'get')
        await store.set('agent-1', 'c1', { enabled: 'off' })
        assertJsonEqual(await store.get('agent-1'), { c1: { enabled: 'off' } }, 'replaced')
      },
    },
    {
      name: 'set with undefined removes the entry; agents are isolated',
      run: async () => {
        const store = await factory()
        await store.set('agent-1', 'c1', entry)
        await store.set('agent-2', 'c1', { enabled: 'off' })
        await store.set('agent-1', 'c1', undefined)
        assertJsonEqual(await store.get('agent-1'), {}, 'agent-1')
        assertJsonEqual(await store.get('agent-2'), { c1: { enabled: 'off' } }, 'agent-2')
      },
    },
    {
      name: 'stores and returns copies',
      run: async () => {
        const store = await factory()
        const value = structuredClone(entry)
        await store.set('agent-1', 'c1', value)
        value.enabled = 'mutated'
        const first = await store.get('agent-1')
        assertTrue(first.c1?.enabled === 'on', 'input mutation leaked')
        if (first.c1 !== undefined) first.c1.enabled = 'mutated'
        assertTrue((await store.get('agent-1')).c1?.enabled === 'on', 'output mutation leaked')
      },
    },
    {
      name: 'removeConnection removes the connection from every agent',
      run: async () => {
        const store = await factory()
        await store.set('agent-1', 'c1', entry)
        await store.set('agent-1', 'c2', entry)
        await store.set('agent-2', 'c1', entry)
        await store.removeConnection('c1')
        await store.removeConnection('c1')
        assertJsonEqual(Object.keys(await store.get('agent-1')), ['c2'], 'agent-1')
        assertJsonEqual(await store.get('agent-2'), {}, 'agent-2')
      },
    },
    {
      name: 'removeAgent removes only that agent and is idempotent',
      run: async () => {
        const store = await factory()
        await store.set('agent-1', 'c1', entry)
        await store.set('agent-2', 'c1', entry)
        await store.removeAgent('agent-1')
        await store.removeAgent('agent-1')
        assertJsonEqual(await store.get('agent-1'), {}, 'agent-1')
        assertTrue(Object.keys(await store.get('agent-2')).length === 1, 'agent-2 kept')
      },
    },
  ]
}

/** Structural shape of a `FlowState` as the store keeps it. */
interface FlowLike {
  id: string
  status: string
  stateHash?: string
  expiresAt: number
  sealed: string
  rev?: number
  definitionId?: string
  step?: string
  view?: unknown
  createdAt?: number
  updatedAt?: number
}

/** Structural shape of a `FlowStore` (`eharness/connectors`). */
export interface FlowStoreUnderTest {
  get(id: string): Promise<FlowLike | undefined>
  put(state: FlowLike): Promise<void>
  delete(id: string): Promise<void>
  findByStateHash(stateHash: string): Promise<FlowLike | undefined>
  deleteExpired(now: number): Promise<number>
}

const flow = (id: string, extra: Partial<FlowLike> & Record<string, unknown> = {}): FlowLike => ({
  id,
  definitionId: 'github',
  status: 'active',
  step: 'authorize',
  rev: 1,
  view: { type: 'status', state: 'running', message: 'ø ✓ 😀', viewId: 'v', step: 'authorize' },
  createdAt: 1000,
  updatedAt: 1000,
  expiresAt: 10_000,
  sealed: 'sealed-blob',
  ...extra,
})

/**
 * Conformance cases for a `FlowStore`: round-trip, copies, replace, lookup by state hash (active
 * flows only), idempotent delete and expiry sweep.
 *
 * @see docs/specs/24-connectors.md#6-stores
 */
export function flowStoreConformance(
  factory: () => FlowStoreUnderTest | Promise<FlowStoreUnderTest>,
): ConformanceCase[] {
  return [
    {
      name: 'get returns undefined for an unknown flow',
      run: async () => {
        const store = await factory()
        assertTrue((await store.get('nope')) === undefined, 'get should be undefined')
      },
    },
    {
      name: 'put then get round-trips, put replaces by id',
      run: async () => {
        const store = await factory()
        await store.put(flow('f1'))
        assertJsonEqual(await store.get('f1'), flow('f1'), 'get')
        await store.put(flow('f1', { rev: 2 }))
        assertTrue((await store.get('f1'))?.rev === 2, 'replaced')
      },
    },
    {
      name: 'stores and returns copies',
      run: async () => {
        const store = await factory()
        const value = flow('f1')
        await store.put(value)
        value.sealed = 'mutated'
        const first = await store.get('f1')
        assertTrue(first?.sealed === 'sealed-blob', 'input mutation leaked')
        if (first !== undefined) first.sealed = 'mutated'
        assertTrue((await store.get('f1'))?.sealed === 'sealed-blob', 'output mutation leaked')
      },
    },
    {
      name: 'findByStateHash finds the active flow with that hash only',
      run: async () => {
        const store = await factory()
        await store.put(flow('f1', { stateHash: 'h1' }))
        await store.put(flow('f2', { stateHash: 'h2', status: 'done' }))
        assertTrue((await store.findByStateHash('h1'))?.id === 'f1', 'h1')
        assertTrue(
          (await store.findByStateHash('h2')) === undefined,
          'a finished flow is not found',
        )
        assertTrue((await store.findByStateHash('nope')) === undefined, 'unknown hash')
      },
    },
    {
      name: 'delete is idempotent',
      run: async () => {
        const store = await factory()
        await store.put(flow('f1'))
        await store.delete('f1')
        await store.delete('f1')
        assertTrue((await store.get('f1')) === undefined, 'deleted')
      },
    },
    {
      name: 'deleteExpired removes flows expired before now and counts them',
      run: async () => {
        const store = await factory()
        await store.put(flow('old', { expiresAt: 100 }))
        await store.put(flow('older', { expiresAt: 50 }))
        await store.put(flow('fresh', { expiresAt: 5000 }))
        assertTrue((await store.deleteExpired(1000)) === 2, 'two expired')
        assertTrue((await store.get('old')) === undefined, 'old gone')
        assertTrue((await store.get('fresh')) !== undefined, 'fresh kept')
      },
    },
  ]
}
