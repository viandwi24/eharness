/** Workspace settings in the `settings` table: one row `workspace` holding the overrides. */
import type { Database } from 'bun:sqlite'
import type { SettingsStore } from '../../app/ports.ts'
import {
  RETIRED_SETTINGS,
  type SettingsPatch,
  toSettingsMode,
  type WorkspaceSettings,
} from '../../domain/settings.ts'

const KEY = 'workspace'

export interface SettingsStoreOptions {
  /** Values used until a person changes them (the server's environment configuration). */
  defaults: WorkspaceSettings
  /** Called after every stored change, on the instance that handled it. */
  onChange?: (settings: WorkspaceSettings) => void
}

export function sqliteSettingsStore(
  sqlite: Database,
  options: SettingsStoreOptions,
): SettingsStore {
  const read = (): { overrides: SettingsPatch; updatedAt: number } => {
    const row = sqlite
      .query<{ value: string; updated_at: number }, [string]>(
        'SELECT value, updated_at FROM settings WHERE key = ?',
      )
      .get(KEY)
    if (row === null) return { overrides: {}, updatedAt: 0 }
    const overrides = JSON.parse(row.value) as Record<string, unknown>
    for (const k of RETIRED_SETTINGS) delete overrides[k]
    return { overrides: overrides as SettingsPatch, updatedAt: row.updated_at }
  }
  const merged = (): WorkspaceSettings & { updatedAt: number } => {
    const { overrides, updatedAt } = read()
    const all = { ...options.defaults, ...overrides, updatedAt }
    // rows written before the three modes may hold a legacy value
    return { ...all, defaultPermissionMode: toSettingsMode(all.defaultPermissionMode) }
  }
  return {
    get: merged,
    patch(patch, now) {
      sqlite
        .transaction(() => {
          const { overrides } = read()
          const next = { ...overrides, ...patch }
          sqlite
            .query(
              `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
               ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
            )
            .run(KEY, JSON.stringify(next), now)
        })
        .immediate()
      const settings = merged()
      options.onChange?.(settings)
      return settings
    },
  }
}
