/**
 * Heartbeat configuration, beat history and the digest buffer, as rows of the `settings` table
 * (`key` / `value` JSON): `heartbeat:<agentId>:config`, `heartbeat:<agentId>:state`,
 * `digest:config`, `digest:state`. No table of their own: the data is small, owned by one
 * feature, and read-modify-write under an immediate transaction (safe across instances).
 */
import type { Database } from 'bun:sqlite'
import type { HeartbeatStore } from '../../app/ports.ts'
import {
  DEFAULT_DIGEST,
  type DigestConfig,
  type DigestState,
  EMPTY_DIGEST_STATE,
  EMPTY_HEARTBEAT_STATE,
  type HeartbeatConfig,
  type HeartbeatState,
} from '../../domain/heartbeat.ts'

export function sqliteHeartbeatStore(sqlite: Database): HeartbeatStore {
  const read = <T>(key: string): T | undefined => {
    const row = sqlite
      .query<{ value: string }, [string]>('SELECT value FROM settings WHERE key = ?')
      .get(key)
    return row === null ? undefined : (JSON.parse(row.value) as T)
  }
  const write = (key: string, value: unknown, now: number): void => {
    sqlite
      .query(
        `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, JSON.stringify(value), now)
  }
  const update = <T>(key: string, empty: T, fn: (current: T) => T, now: number): T =>
    sqlite
      .transaction((): T => {
        const next = fn(read<T>(key) ?? structuredClone(empty))
        write(key, next, now)
        return next
      })
      .immediate()

  return {
    config: (agentId) => read<HeartbeatConfig>(`heartbeat:${agentId}:config`),
    setConfig: (agentId, config, now) => write(`heartbeat:${agentId}:config`, config, now),
    state: (agentId) =>
      read<HeartbeatState>(`heartbeat:${agentId}:state`) ?? structuredClone(EMPTY_HEARTBEAT_STATE),
    updateState: (agentId, fn, now) =>
      update(`heartbeat:${agentId}:state`, EMPTY_HEARTBEAT_STATE, fn, now),
    digestConfig: () => ({ ...DEFAULT_DIGEST, ...read<Partial<DigestConfig>>('digest:config') }),
    setDigestConfig: (config, now) => write('digest:config', config, now),
    digest: () => read<DigestState>('digest:state') ?? structuredClone(EMPTY_DIGEST_STATE),
    updateDigest: (fn, now) => update('digest:state', EMPTY_DIGEST_STATE, fn, now),
  }
}
