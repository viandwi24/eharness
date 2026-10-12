/**
 * SQLite store of the channels connection configuration (plain SQL on the shared connection).
 * Nodes, identities, messages, events and sessions have their own modules (`nodes.ts`,
 * `identities.ts`, `messages.ts`, `events.ts`, `sessions.ts`).
 */
import type { Database } from 'bun:sqlite'
import { type ConnectionConfig, ConnectionConfigSchema } from './policy.ts'

// --- connection configuration ------------------------------------------------------------------

export interface ConfigStore {
  list(): ConnectionConfig[]
  get(connectionId: string): ConnectionConfig | undefined
  put(config: ConnectionConfig, now: number): void
  remove(connectionId: string): void
}

export function sqliteConfigStore(sqlite: Database): ConfigStore {
  return {
    list() {
      const rows = sqlite
        .query<{ config: string }, []>(
          'SELECT config FROM channel_connections ORDER BY connection_id',
        )
        .all()
      const out: ConnectionConfig[] = []
      for (const row of rows) {
        const parsed = ConnectionConfigSchema.safeParse(JSON.parse(row.config))
        if (parsed.success) out.push(parsed.data)
      }
      return out
    },
    get(connectionId) {
      const row = sqlite
        .query<{ config: string }, [string]>(
          'SELECT config FROM channel_connections WHERE connection_id = ?',
        )
        .get(connectionId)
      if (row === null) return undefined
      const parsed = ConnectionConfigSchema.safeParse(JSON.parse(row.config))
      return parsed.success ? parsed.data : undefined
    },
    put(config, now) {
      sqlite
        .query(
          `INSERT INTO channel_connections (connection_id, config, updated_at) VALUES (?, ?, ?)
           ON CONFLICT (connection_id) DO UPDATE SET config = excluded.config, updated_at = excluded.updated_at`,
        )
        .run(config.connectionId, JSON.stringify(config), now)
    },
    remove(connectionId) {
      sqlite.query('DELETE FROM channel_connections WHERE connection_id = ?').run(connectionId)
    },
  }
}
