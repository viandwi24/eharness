/**
 * `ProfileStore` of `eharness/providers` on SQLite (`config_profiles`): the ONE table of provider
 * profiles, connections, their credentials and OAuth app credentials. This store does not
 * encrypt: `compose` wraps it in `sealedProfileStore` with the server's vault (`secret-vault.ts`),
 * so `settings` holds `{ "~sealed": blob }` for every secret-bearing kind. A row written before
 * that (the whole column was a `v1:` blob) reads as `{ "~sealed": "v1:…" }` and the vault's legacy
 * reader opens it; `reseal()` rewrites it. Adapters return copies (spec 23 §3).
 *
 * `onChange` fires after a local put / delete (the caller appends the change event);
 * `subscribe` is the in-process half.
 */
import type { Database } from 'bun:sqlite'
import type { ConfigProfile, ProfileStore } from 'eharness/providers'

interface Row {
  kind: string
  id: string
  definition_id: string
  label: string
  settings: string
  models: string | null
  extra: string | null
  enabled: number
  updated_at: number
}

export interface ProfileStoreOptions {
  /** Called after a put / delete (append the change event here). */
  onChange?: (change: { kind: string; id: string; action: 'put' | 'delete' }) => void
}

export function sqliteProfileStore(
  sqlite: Database,
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
  const unrow = (row: Row): ConfigProfile => {
    // a pre-vault provider row: the whole column is one `v1:` blob
    const settings = row.settings.startsWith('v1:')
      ? { '~sealed': row.settings }
      : (JSON.parse(row.settings) as Record<string, unknown>)
    return {
      ...(row.extra === null ? {} : (JSON.parse(row.extra) as Record<string, unknown>)),
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
    // creation order (rowid survives an upsert): editing a profile must not reorder the list, the
    // default profile is the first enabled one
    async list(query) {
      const rows =
        query?.kind === undefined
          ? sqlite.query<Row, []>('SELECT * FROM config_profiles ORDER BY rowid').all()
          : sqlite
              .query<Row, [string]>('SELECT * FROM config_profiles WHERE kind = ? ORDER BY rowid')
              .all(query.kind)
      return rows.map(unrow)
    },
    async get(kind, id) {
      const row = sqlite
        .query<Row, [string, string]>('SELECT * FROM config_profiles WHERE kind = ? AND id = ?')
        .get(kind, id)
      return row === null ? undefined : unrow(row)
    },
    async put(profile) {
      const text = JSON.stringify(profile.settings ?? {})
      const {
        id,
        kind,
        definitionId,
        label,
        settings: _s,
        enabled,
        updatedAt,
        models,
        ...rest
      } = profile as ConfigProfile & Record<string, unknown>
      const extra = Object.keys(rest).length === 0 ? null : JSON.stringify(rest)
      sqlite
        .query(
          `INSERT INTO config_profiles (kind, id, definition_id, label, settings, models, extra, enabled, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (kind, id) DO UPDATE SET definition_id = excluded.definition_id,
             label = excluded.label, settings = excluded.settings, models = excluded.models,
             extra = excluded.extra,
             enabled = excluded.enabled, updated_at = excluded.updated_at`,
        )
        .run(
          kind,
          id,
          definitionId,
          label,
          text,
          models === undefined ? null : JSON.stringify(models),
          extra,
          enabled ? 1 : 0,
          updatedAt,
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
