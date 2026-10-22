/**
 * The stored secrets as the workspace export carries them: provider profiles, connections with
 * their credentials, and OAuth client credentials, read from and written to the SEALED profile
 * store (so plain values exist in memory only while an export or a restore runs, and every write is
 * sealed again with this server's key).
 *
 * Built-in connections hold no secrets and are never included. Nothing here logs a value.
 */
import type { Database } from 'bun:sqlite'
import type { ConfigProfile, ProfileStore } from 'eharness/providers'
import type { SecretsPort } from '../../app/ports.ts'
import type { SecretRecord, SecretRow } from '../../domain/workspace-secrets.ts'

const PROVIDER = 'provider'
const CONNECTION = 'connection'
const CREDENTIALS = 'connection-credentials'
const CLIENT = 'connector-client'
/** A row of `api_keys` (only the hash of a key is stored) and the share token of an artifact. */
const API_KEY = 'api_key'
const ARTIFACT_SHARE = 'artifact_share'

const isBuiltin = (id: string): boolean => id.startsWith('builtin:')
const rowOf = (p: ConfigProfile): SecretRow => ({
  kind: p.kind,
  id: p.id,
  profile: JSON.parse(JSON.stringify(p)) as Record<string, unknown>,
})

const quote = (name: string): string => `"${name.replaceAll('"', '""')}"`

export function createSecretsPort(options: {
  profiles: ProfileStore
  /** Called after a restore wrote rows: the provider manager reloads its profiles. */
  reload?: () => Promise<void>
  /** The database of the API keys and artifact share tokens (absent: those are not part of the secrets). */
  sqlite?: Database
}): SecretsPort {
  const { profiles, sqlite } = options
  const columnsOf = (table: string): string[] =>
    (sqlite as Database)
      .query<{ name: string }, []>(`PRAGMA table_info(${quote(table)})`)
      .all()
      .map((c) => c.name)
  return {
    async connectionRows() {
      const out: Array<{ id: string; profile: Record<string, unknown> }> = []
      for (const c of await profiles.list({ kind: CONNECTION })) {
        if (isBuiltin(c.id)) continue
        const { settings: _settings, ...rest } = JSON.parse(JSON.stringify(c)) as Record<
          string,
          unknown
        >
        out.push({ id: c.id, profile: rest })
      }
      return out
    },
    async list() {
      const out: SecretRecord[] = []
      for (const p of await profiles.list({ kind: PROVIDER })) {
        out.push({ key: `${PROVIDER}/${p.id}`, label: p.label, rows: [rowOf(p)] })
      }
      const credentials = new Map<string, ConfigProfile>()
      for (const c of await profiles.list({ kind: CREDENTIALS })) credentials.set(c.id, c)
      for (const c of await profiles.list({ kind: CONNECTION })) {
        if (isBuiltin(c.id)) continue
        const creds = credentials.get(c.id)
        out.push({
          key: `${CONNECTION}/${c.id}`,
          label: c.label,
          rows: creds === undefined ? [rowOf(c)] : [rowOf(c), rowOf(creds)],
        })
      }
      for (const c of await profiles.list({ kind: CLIENT })) {
        out.push({ key: `${CLIENT}/${c.id}`, label: c.label, rows: [rowOf(c)] })
      }
      if (sqlite !== undefined) {
        for (const r of sqlite
          .query<Record<string, unknown> & { id: string; name: string }, []>(
            'SELECT * FROM api_keys ORDER BY created_at, id',
          )
          .all()) {
          out.push({
            key: `api-key/${r.id}`,
            label: r.name,
            rows: [{ kind: API_KEY, id: r.id, profile: { ...r } }],
          })
        }
        for (const r of sqlite
          .query<
            { id: string; title: string; share_token: string; share_version: number | null },
            []
          >(
            'SELECT id, title, share_token, share_version FROM artifacts WHERE share_token IS NOT NULL ORDER BY created_at, id',
          )
          .all()) {
          out.push({
            key: `artifact-share/${r.id}`,
            label: r.title,
            rows: [
              {
                kind: ARTIFACT_SHARE,
                id: r.id,
                profile: { id: r.id, share_token: r.share_token, share_version: r.share_version },
              },
            ],
          })
        }
      }
      return out.sort((a, b) => (a.key < b.key ? -1 : 1))
    },
    async put(record) {
      // a connection before its credentials; only the kinds this port exports may be written
      const order = [PROVIDER, CONNECTION, CLIENT, CREDENTIALS, API_KEY, ARTIFACT_SHARE]
      for (const row of [...record.rows].sort(
        (a, b) => order.indexOf(a.kind) - order.indexOf(b.kind),
      )) {
        if (row.kind === API_KEY || row.kind === ARTIFACT_SHARE) {
          if (sqlite === undefined)
            throw new Error(`a secret of kind "${row.kind}" cannot be restored`)
          if (row.kind === API_KEY) {
            const columns = columnsOf('api_keys').filter((c) => c in row.profile)
            sqlite
              .query(
                `INSERT OR REPLACE INTO api_keys (${columns.map(quote).join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
              )
              .run(
                ...(columns.map((c) => {
                  const v = row.profile[c]
                  return v !== null && typeof v === 'object' ? JSON.stringify(v) : (v ?? null)
                }) as never[]),
              )
          } else {
            const done = sqlite
              .query('UPDATE artifacts SET share_token = ?, share_version = ? WHERE id = ?')
              .run(
                String(row.profile.share_token),
                (row.profile.share_version as number | null) ?? null,
                row.id,
              )
            if (done.changes === 0) throw new Error('the artifact of this share link is not here')
          }
          continue
        }
        if (!order.includes(row.kind) || (row.kind !== PROVIDER && isBuiltin(row.id))) {
          throw new Error(`a secret of kind "${row.kind}" cannot be restored`)
        }
        await profiles.put({
          ...row.profile,
          id: row.id,
          kind: row.kind,
          source: 'store',
          updatedAt: Date.now(),
        } as ConfigProfile)
      }
    },
    async changed() {
      await options.reload?.()
    },
  }
}
