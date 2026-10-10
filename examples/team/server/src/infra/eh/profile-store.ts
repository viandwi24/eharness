/**
 * `ProfileStore` of `eharness/providers` on SQLite (`config_profiles`). The whole `settings`
 * object (API keys, header values) is sealed with AES-GCM (`secret-box.ts`) before it touches the
 * database; every other column is plain. Adapters return copies (spec 23 §3).
 *
 * Changes made on any instance append a `providers-changed` event; the provider service tails
 * the event feed and reloads the manager (`infra/eh/providers.ts`). `subscribe` is the in-process
 * half: it fires after a local put / delete.
 */
import type { Database } from 'bun:sqlite'
import type { ConfigProfile, ProfileStore } from 'eharness/providers'
import type { SealOpen } from './secret-box.ts'

interface Row {
  kind: string
  id: string
  definition_id: string
  label: string
  settings: string
  models: string | null
  enabled: number
  updated_at: number
}

export interface ProfileStoreOptions {
  /** Called after a put / delete (append the `providers-changed` event here). */
  onChange?: (change: { kind: string; id: string; action: 'put' | 'delete' }) => void
  /** A row that cannot be opened (lost key, corrupted) is skipped; say why (never the value). */
  warn?: (message: string) => void
}

export function sqliteProfileStore(
  sqlite: Database,
  box: SealOpen,
  options: ProfileStoreOptions = {},
): ProfileStore {
  const listeners = new Set<() => void>()
  const notify = (): void => {
    for (const l of [...listeners]) {
      try {
        l()
      } catch {
        // a listener must not break a write
      }
    }
  }
  const unrow = async (row: Row): Promise<ConfigProfile | undefined> => {
    let settings: Record<string, unknown>
    try {
      settings = JSON.parse(await box.open(row.settings)) as Record<string, unknown>
    } catch (error) {
      options.warn?.(
        `profile "${row.id}" is unreadable and was skipped: ${error instanceof Error ? error.message : String(error)}`,
      )
      return undefined
    }
    return {
      id: row.id,
      kind: row.kind,
      definitionId: row.definition_id,
      label: row.label,
      settings,
      enabled: row.enabled === 1,
      source: 'store',
      updatedAt: row.updated_at,
      ...(row.models === null ? {} : { models: JSON.parse(row.models) }),
    } as ConfigProfile
  }
  return {
    async list(query) {
      const rows =
        query?.kind === undefined
          ? sqlite.query<Row, []>('SELECT * FROM config_profiles ORDER BY updated_at, id').all()
          : sqlite
              .query<Row, [string]>(
                'SELECT * FROM config_profiles WHERE kind = ? ORDER BY updated_at, id',
              )
              .all(query.kind)
      const out: ConfigProfile[] = []
      for (const row of rows) {
        const p = await unrow(row)
        if (p !== undefined) out.push(p)
      }
      return out
    },
    async get(kind, id) {
      const row = sqlite
        .query<Row, [string, string]>('SELECT * FROM config_profiles WHERE kind = ? AND id = ?')
        .get(kind, id)
      return row === null ? undefined : unrow(row)
    },
    async put(profile) {
      const sealed = await box.seal(JSON.stringify(profile.settings ?? {}))
      const models = (profile as { models?: unknown }).models
      sqlite
        .query(
          `INSERT INTO config_profiles (kind, id, definition_id, label, settings, models, enabled, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (kind, id) DO UPDATE SET definition_id = excluded.definition_id,
             label = excluded.label, settings = excluded.settings, models = excluded.models,
             enabled = excluded.enabled, updated_at = excluded.updated_at`,
        )
        .run(
          profile.kind,
          profile.id,
          profile.definitionId,
          profile.label,
          sealed,
          models === undefined ? null : JSON.stringify(models),
          profile.enabled ? 1 : 0,
          profile.updatedAt,
        )
      options.onChange?.({ kind: profile.kind, id: profile.id, action: 'put' })
      notify()
    },
    async delete(kind, id) {
      sqlite.query('DELETE FROM config_profiles WHERE kind = ? AND id = ?').run(kind, id)
      options.onChange?.({ kind, id, action: 'delete' })
      notify()
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}
