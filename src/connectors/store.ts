/**
 * Memory adapters of the connector ports: connections, credentials, enablement and flows.
 *
 * @see docs/specs/24-connectors.md#6-stores
 */
import { memoryProfileStore, type ProfileStore, sealedProfileStore } from '../providers/index.ts'
import type {
  AgentEnablement,
  ConnectionCredentials,
  ConnectionEnablement,
  ConnectionRecord,
  ConnectionStore,
  CredentialStore,
  EnablementStore,
  FlowState,
  FlowStore,
  SecretVault,
} from './types.ts'

/** `kind` of connection rows in a {@link ProfileStore}. */
export const CONNECTION_KIND = 'connection'
/** `kind` of the OAuth credential rows (tokens, client, endpoints) in a {@link ProfileStore}. */
export const CREDENTIALS_KIND = 'connection-credentials'

/**
 * A {@link ConnectionStore} over any `ProfileStore` (the same store, kind and `subscribe` shape
 * providers use): a connection is a profile with `kind: 'connection'`. The store must keep the
 * extra fields of {@link ConnectionRecord} (JSON stores do). Wrap the profile store with
 * `sealedProfileStore` to encrypt settings.
 */
export function connectionStoreFromProfiles(profiles: ProfileStore): ConnectionStore {
  return {
    list: async (query) =>
      ((await profiles.list({ kind: CONNECTION_KIND })) as ConnectionRecord[]).filter(
        (r) =>
          (query?.scope === undefined || r.scope === query.scope) &&
          (query?.scopeId === undefined || r.scopeId === query.scopeId) &&
          (query?.definitionId === undefined || r.definitionId === query.definitionId),
      ),
    get: async (id) => (await profiles.get(CONNECTION_KIND, id)) as ConnectionRecord | undefined,
    put: (record) => profiles.put(record),
    delete: (id) => profiles.delete(CONNECTION_KIND, id),
    ...(profiles.subscribe === undefined
      ? {}
      : {
          subscribe: (l: () => void) =>
            (profiles.subscribe as NonNullable<ProfileStore['subscribe']>)(l),
        }),
  }
}

/**
 * A {@link CredentialStore} over any `ProfileStore`: credentials are rows of kind
 * `connection-credentials` (id = connection id), separate from the connection row, so a token
 * refresh never rewrites the connection. Wrap the profile store with `sealedProfileStore` so
 * tokens are encrypted.
 */
export function credentialStoreFromProfiles(profiles: ProfileStore): CredentialStore {
  return {
    get: async (connectionId) =>
      (await profiles.get(CREDENTIALS_KIND, connectionId))?.settings as
        | ConnectionCredentials
        | undefined,
    put: (connectionId, credentials) =>
      profiles.put({
        id: connectionId,
        kind: CREDENTIALS_KIND,
        definitionId: '',
        label: '',
        settings: credentials as unknown as Record<string, unknown>,
        enabled: true,
        updatedAt: Date.now(),
      }),
    delete: (connectionId) => profiles.delete(CREDENTIALS_KIND, connectionId),
  }
}

/** A {@link ConnectionStore} in memory (tests, single-process apps). Stores copies. */
export function memoryConnectionStore(initial: ConnectionRecord[] = []): ConnectionStore {
  return connectionStoreFromProfiles(memoryProfileStore(initial))
}

/**
 * A {@link CredentialStore} in memory. With a `vault` the credentials are kept sealed (through
 * `sealedProfileStore`, as a database adapter would keep them encrypted).
 */
export function memoryCredentialStore(options: { vault?: SecretVault } = {}): CredentialStore {
  const profiles = memoryProfileStore()
  return credentialStoreFromProfiles(
    options.vault === undefined
      ? profiles
      : sealedProfileStore(profiles, options.vault, { kinds: [CREDENTIALS_KIND] }),
  )
}

/** An {@link EnablementStore} in memory. Stores copies. */
export function memoryEnablementStore(): EnablementStore {
  const agents = new Map<string, AgentEnablement>()
  return {
    get: async (agentId) => structuredClone(agents.get(agentId) ?? {}),
    set: async (agentId, connectionId, value: ConnectionEnablement | undefined) => {
      const current = agents.get(agentId) ?? {}
      if (value === undefined) delete current[connectionId]
      else current[connectionId] = structuredClone(value)
      if (Object.keys(current).length === 0) agents.delete(agentId)
      else agents.set(agentId, current)
    },
    removeConnection: async (connectionId) => {
      for (const [agentId, entries] of agents) {
        delete entries[connectionId]
        if (Object.keys(entries).length === 0) agents.delete(agentId)
      }
    },
    removeAgent: async (agentId) => {
      agents.delete(agentId)
    },
  }
}

/** A {@link FlowStore} in memory. Stores copies. */
export function memoryFlowStore(): FlowStore {
  const map = new Map<string, FlowState>()
  return {
    get: async (id) => {
      const state = map.get(id)
      return state === undefined ? undefined : structuredClone(state)
    },
    put: async (state) => {
      map.set(state.id, structuredClone(state))
    },
    delete: async (id) => {
      map.delete(id)
    },
    findByStateHash: async (stateHash) => {
      for (const state of map.values()) {
        if (state.stateHash === stateHash && state.status === 'active')
          return structuredClone(state)
      }
      return undefined
    },
    deleteExpired: async (now) => {
      let count = 0
      for (const [id, state] of map) {
        if (state.expiresAt < now) {
          map.delete(id)
          count++
        }
      }
      return count
    },
  }
}
