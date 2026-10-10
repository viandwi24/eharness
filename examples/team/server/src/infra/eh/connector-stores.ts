/**
 * SQLite adapters of the connector ports that are not profile rows: the flow store, the
 * enablement store (`agent_connectors`) and a refresh lock shared by every instance (the
 * `eh_locks` lease table the turn lock uses). Connections and credentials are rows of
 * `config_profiles` (`profile-store.ts`).
 */
import type { Database } from 'bun:sqlite'
import type { SessionLock } from 'eharness'
import type {
  AgentEnablement,
  ConnectionEnablement,
  EnablementStore,
  FlowState,
  FlowStore,
  RefreshLock,
} from 'eharness/connectors'
import { memoryRefreshLock } from 'eharness/connectors'

export function sqliteFlowStore(sqlite: Database): FlowStore {
  const write = (state: FlowState): void => {
    sqlite
      .query(
        `INSERT INTO connector_flows (id, state_hash, status, expires_at, data) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET state_hash = excluded.state_hash, status = excluded.status,
           expires_at = excluded.expires_at, data = excluded.data`,
      )
      .run(state.id, state.stateHash ?? null, state.status, state.expiresAt, JSON.stringify(state))
  }
  return {
    async get(id) {
      const row = sqlite
        .query<{ data: string }, [string]>('SELECT data FROM connector_flows WHERE id = ?')
        .get(id)
      return row === null ? undefined : (JSON.parse(row.data) as FlowState)
    },
    async put(state) {
      write(state)
    },
    async delete(id) {
      sqlite.query('DELETE FROM connector_flows WHERE id = ?').run(id)
    },
    async findByStateHash(stateHash) {
      const row = sqlite
        .query<{ data: string }, [string]>(
          "SELECT data FROM connector_flows WHERE state_hash = ? AND status = 'active'",
        )
        .get(stateHash)
      return row === null ? undefined : (JSON.parse(row.data) as FlowState)
    },
    async deleteExpired(now) {
      return sqlite.query('DELETE FROM connector_flows WHERE expires_at < ?').run(now).changes
    },
  }
}

export interface EnablementOptions {
  /** Called after a write (append `connectors-changed`, bump the local revision). */
  onChange?: () => void
  now?: () => number
}

export function sqliteEnablementStore(
  sqlite: Database,
  options: EnablementOptions = {},
): EnablementStore {
  const now = options.now ?? Date.now
  return {
    async get(agentId) {
      const rows = sqlite
        .query<{ connection_id: string; choices: string }, [string]>(
          'SELECT connection_id, choices FROM agent_connectors WHERE agent_id = ?',
        )
        .all(agentId)
      const out: AgentEnablement = {}
      for (const r of rows) out[r.connection_id] = JSON.parse(r.choices) as ConnectionEnablement
      return out
    },
    async set(agentId, connectionId, value) {
      if (value === undefined) {
        sqlite
          .query('DELETE FROM agent_connectors WHERE agent_id = ? AND connection_id = ?')
          .run(agentId, connectionId)
      } else {
        sqlite
          .query(
            `INSERT INTO agent_connectors (agent_id, connection_id, choices, updated_at) VALUES (?, ?, ?, ?)
             ON CONFLICT (agent_id, connection_id) DO UPDATE SET choices = excluded.choices, updated_at = excluded.updated_at`,
          )
          .run(agentId, connectionId, JSON.stringify(value), now())
      }
      options.onChange?.()
    },
    async removeConnection(connectionId) {
      sqlite.query('DELETE FROM agent_connectors WHERE connection_id = ?').run(connectionId)
      options.onChange?.()
    },
    async removeAgent(agentId) {
      sqlite.query('DELETE FROM agent_connectors WHERE agent_id = ?').run(agentId)
      options.onChange?.()
    },
  }
}

/**
 * Token refresh lock across instances: serialized in this process first, then a lease row in
 * `eh_locks` (key `connector:<key>`) so two instances never refresh one single-use refresh token
 * at once. A crashed holder's lease expires.
 */
export function sqliteRefreshLock(
  lock: SessionLock,
  options: { waitMs?: number; pollMs?: number } = {},
): RefreshLock {
  const local = memoryRefreshLock()
  const waitMs = options.waitMs ?? 15_000
  const pollMs = options.pollMs ?? 50
  return (key, fn) =>
    local(key, async () => {
      const deadline = Date.now() + waitMs
      let release: (() => Promise<void>) | undefined
      for (;;) {
        try {
          release = await lock.acquire(`connector:${key}`, { signal: new AbortController().signal })
          break
        } catch (error) {
          if (Date.now() >= deadline) throw error
          await new Promise((r) => setTimeout(r, pollMs))
        }
      }
      try {
        return await fn()
      } finally {
        await release()
      }
    })
}
