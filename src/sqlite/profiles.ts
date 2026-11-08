/**
 * `ProfileStore` (spec 23 §3) on `<prefix>profiles`, plus the sealed variant (spec 23 §8). The
 * store does not encrypt: {@link sqliteSealedProfileStore} puts `sealedProfileStore` in front of it
 * with the vault the app passes, so `settings` holds `{ "~sealed": blob }` at rest. Adapters return
 * copies. `subscribe` fires after a local put or delete at once and, for changes made by another
 * process on the same file, by polling (`pollMs`, gated by `PRAGMA data_version`).
 */
import {
  type ConfigProfile,
  type ProfileStore,
  type SealedProfileStore,
  type SealedProfileStoreOptions,
  sealedProfileStore,
} from '../providers/index.ts'
import type { SqlDriver } from './driver.ts'
import { type AdapterOptions, createWatcher, one, tables } from './util.ts'

/** Options of {@link sqliteProfileStore}. */
export interface SqliteProfileStoreOptions extends AdapterOptions {
  /** Called after a local put / delete (append a change event here). */
  onChange?: (change: { kind: string; id: string; action: 'put' | 'delete' }) => void
  /** Polling of `subscribe` for changes of other processes (ms). Default 250. */
  pollMs?: number
}

/** Options of {@link sqliteSealedProfileStore}: the sealing options without `inner`. */
export type SqliteSealedProfileStoreOptions = SqliteProfileStoreOptions &
  Omit<SealedProfileStoreOptions, 'inner'>

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

const unrow = (row: Row): ConfigProfile =>
  ({
    ...(row.extra === null ? {} : (JSON.parse(row.extra) as Record<string, unknown>)),
    id: row.id,
    kind: row.kind,
    definitionId: row.definition_id,
    label: row.label,
    settings: JSON.parse(row.settings) as Record<string, unknown>,
    enabled: row.enabled === 1,
    source: 'store',
    updatedAt: row.updated_at,
    ...(row.models === null ? {} : { models: JSON.parse(row.models) }),
  }) as ConfigProfile

export function sqliteProfileStore(
  driver: SqlDriver,
  options: SqliteProfileStoreOptions = {},
): ProfileStore {
  const t = tables(options.prefix).profiles
  const rows = (): Row[] => driver.query<Row>(`SELECT * FROM ${t} ORDER BY rowid`)

  // change detection for other processes: `data_version` moves only on commits of OTHER connections
  let lastVersion = -1
  let cached = ''
  let stale = true
  const signature = (): string => {
    const version = Number(
      driver.query<{ data_version: number }>('PRAGMA data_version')[0]?.data_version ?? 0,
    )
    if (version !== lastVersion || stale) {
      lastVersion = version
      stale = false
      cached = JSON.stringify(rows())
    }
    return cached
  }
  const watcher = createWatcher(signature, options.pollMs ?? 250)
  const changed = (): void => {
    stale = true
    watcher.fire()
  }

  return {
    // creation order (rowid survives an upsert): editing a profile must not reorder the list, the
    // default profile is the first enabled one
    async list(query) {
      const found =
        query?.kind === undefined
          ? rows()
          : driver.query<Row>(`SELECT * FROM ${t} WHERE kind = ? ORDER BY rowid`, [query.kind])
      return found.map(unrow)
    },
    async get(kind, id) {
      const row = one<Row>(driver, `SELECT * FROM ${t} WHERE kind = ? AND id = ?`, [kind, id])
      return row === undefined ? undefined : unrow(row)
    },
    async put(profile) {
      const {
        id,
        kind,
        definitionId,
        label,
        settings,
        enabled,
        updatedAt,
        models,
        source: _source,
        ...rest
      } = profile as ConfigProfile & Record<string, unknown>
      driver.run(
        `INSERT INTO ${t} (kind, id, definition_id, label, settings, models, extra, enabled, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (kind, id) DO UPDATE SET definition_id = excluded.definition_id,
           label = excluded.label, settings = excluded.settings, models = excluded.models,
           extra = excluded.extra, enabled = excluded.enabled, updated_at = excluded.updated_at`,
        [
          kind,
          id,
          definitionId,
          label,
          JSON.stringify(settings ?? {}),
          models === undefined ? null : JSON.stringify(models),
          Object.keys(rest).length === 0 ? null : JSON.stringify(rest),
          enabled ? 1 : 0,
          updatedAt,
        ],
      )
      options.onChange?.({ kind, id, action: 'put' })
      changed()
    },
    async delete(kind, id) {
      driver.run(`DELETE FROM ${t} WHERE kind = ? AND id = ?`, [kind, id])
      options.onChange?.({ kind, id, action: 'delete' })
      changed()
    },
    subscribe(listener) {
      return watcher.add(listener)
    },
  }
}

/**
 * A {@link SealedProfileStore}: {@link sqliteProfileStore} behind `sealedProfileStore`, so secrets
 * are encrypted with `vault` before they reach the table.
 */
export function sqliteSealedProfileStore(
  driver: SqlDriver,
  options: SqliteSealedProfileStoreOptions,
): SealedProfileStore {
  const { prefix, now, onChange, pollMs, ...sealing } = options
  return sealedProfileStore({
    ...sealing,
    inner: sqliteProfileStore(driver, {
      ...(prefix === undefined ? {} : { prefix }),
      ...(now === undefined ? {} : { now }),
      ...(onChange === undefined ? {} : { onChange }),
      ...(pollMs === undefined ? {} : { pollMs }),
    }),
  })
}
