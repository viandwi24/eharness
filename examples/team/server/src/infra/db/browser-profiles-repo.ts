/**
 * `BrowserProfileStore` (eharness/browser, spec 35 §3) over the `browser_profiles` table, plain
 * SQL on the shared connection. It stores whatever settings it is given: secret fields are
 * sealed one layer up (`sealedBrowserProfiles`), so this table only ever holds ciphertext.
 */
import type { Database } from 'bun:sqlite'
import { HarnessError, uuidv7 } from 'eharness'
import type {
  BrowserProfile,
  BrowserProfileInput,
  BrowserProfilePatch,
  BrowserProfileStore,
} from 'eharness/browser'

interface Row {
  id: string
  name: string
  adapter: string
  mode: string
  settings_json: string
  allow_domains: string
  trusted: number
  metadata_json: string | null
  created_by: string | null
  created_at: number
  updated_at: number
}

const fold = (name: string): string => name.trim().toLowerCase()

const taken = (name: string): HarnessError =>
  new HarnessError('EH_CONFIG_INVALID', `A browser profile named "${name}" already exists.`, {
    details: { plugin: 'browser', reason: 'name-taken' },
  })

function toProfile(r: Row): BrowserProfile {
  const allow = JSON.parse(r.allow_domains) as string[]
  const metadata =
    r.metadata_json === null ? undefined : (JSON.parse(r.metadata_json) as Record<string, unknown>)
  return {
    id: r.id,
    name: r.name,
    adapter: r.adapter,
    mode: r.mode as BrowserProfile['mode'],
    settings: JSON.parse(r.settings_json) as Record<string, unknown>,
    ...(allow.length === 0 ? {} : { allowDomains: allow }),
    ...(r.trusted === 1 ? { trusted: true } : {}),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    ...(metadata === undefined ? {} : { metadata }),
  }
}

/** Who created the profile, from `metadata.createdBy` (the routes set it). */
const createdBy = (metadata: Record<string, unknown> | undefined): string | null =>
  typeof metadata?.createdBy === 'string' ? metadata.createdBy : null

export function sqliteBrowserProfiles(
  sqlite: Database,
  options: { now?: () => number } = {},
): BrowserProfileStore {
  const now = options.now ?? Date.now
  const byId = sqlite.query<Row, [string]>('SELECT * FROM browser_profiles WHERE id = ?')
  const all = sqlite.query<Row, []>('SELECT * FROM browser_profiles ORDER BY created_at, rowid')
  const nameTaken = (name: string, except?: string): boolean =>
    all.all().some((r) => r.id !== except && fold(r.name) === fold(name))

  return {
    async create(input: BrowserProfileInput) {
      const name = input.name.trim()
      if (name === '') {
        throw new HarnessError('EH_CONFIG_INVALID', 'A browser profile needs a name.', {
          details: { plugin: 'browser', reason: 'name-empty' },
        })
      }
      const id = input.id ?? uuidv7()
      const at = now()
      const insert = sqlite.transaction(() => {
        if (nameTaken(name) || byId.get(id) !== null) throw taken(name)
        sqlite
          .query(
            `INSERT INTO browser_profiles (id, name, adapter, mode, settings_json, allow_domains, trusted, metadata_json, created_by, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            id,
            name,
            input.adapter,
            input.mode,
            JSON.stringify(input.settings),
            JSON.stringify(input.allowDomains ?? []),
            input.trusted === true ? 1 : 0,
            input.metadata === undefined ? null : JSON.stringify(input.metadata),
            createdBy(input.metadata),
            at,
            at,
          )
      })
      insert.immediate()
      return toProfile(byId.get(id) as Row)
    },
    async get(id) {
      const r = byId.get(id)
      return r === null ? null : toProfile(r)
    },
    async list(query = {}) {
      const rows = all.all()
      const start = query.cursor === undefined ? 0 : Math.max(0, Number(query.cursor) || 0)
      const limit = Math.max(1, query.limit ?? rows.length)
      const next = start + limit
      return {
        items: rows.slice(start, next).map(toProfile),
        ...(next < rows.length ? { nextCursor: String(next) } : {}),
      }
    },
    async update(id, patch: BrowserProfilePatch, ifUpdatedAt) {
      const run = sqlite.transaction(
        (): ReturnType<BrowserProfileStore['update']> extends Promise<infer R> ? R : never => {
          const current = byId.get(id)
          if (current === null) return { ok: false, reason: 'not-found' }
          if (ifUpdatedAt !== undefined && current.updated_at !== ifUpdatedAt) {
            return { ok: false, reason: 'conflict' }
          }
          if (patch.name !== undefined && nameTaken(patch.name, id)) throw taken(patch.name.trim())
          const name = patch.name === undefined ? current.name : patch.name.trim()
          const settings =
            patch.settings === undefined ? current.settings_json : JSON.stringify(patch.settings)
          const allow =
            patch.allowDomains === undefined
              ? current.allow_domains
              : JSON.stringify(patch.allowDomains)
          const trusted = patch.trusted === undefined ? current.trusted : patch.trusted ? 1 : 0
          const metadata =
            patch.metadata === undefined ? current.metadata_json : JSON.stringify(patch.metadata)
          // a change always moves the version, even within the same millisecond
          const at = Math.max(now(), current.updated_at + 1)
          sqlite
            .query(
              `UPDATE browser_profiles SET name = ?, settings_json = ?, allow_domains = ?, trusted = ?, metadata_json = ?, updated_at = ? WHERE id = ?`,
            )
            .run(name, settings, allow, trusted, metadata, at, id)
          return { ok: true, profile: toProfile(byId.get(id) as Row) }
        },
      )
      return run.immediate()
    },
    async delete(id) {
      return sqlite.query('DELETE FROM browser_profiles WHERE id = ?').run(id).changes > 0
    },
  }
}
