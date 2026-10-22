/**
 * The stored secrets as the workspace export carries them: provider profiles, connections with
 * their credentials, and OAuth client credentials, read from and written to the SEALED profile
 * store (so plain values exist in memory only while an export or a restore runs, and every write is
 * sealed again with this server's key).
 *
 * Built-in connections hold no secrets and are never included. Nothing here logs a value.
 */
import type { ConfigProfile, ProfileStore } from 'eharness/providers'
import type { SecretsPort } from '../../app/ports.ts'
import type { SecretRecord, SecretRow } from '../../domain/workspace-secrets.ts'

const PROVIDER = 'provider'
const CONNECTION = 'connection'
const CREDENTIALS = 'connection-credentials'
const CLIENT = 'connector-client'

const isBuiltin = (id: string): boolean => id.startsWith('builtin:')
const rowOf = (p: ConfigProfile): SecretRow => ({
  kind: p.kind,
  id: p.id,
  profile: JSON.parse(JSON.stringify(p)) as Record<string, unknown>,
})

export function createSecretsPort(options: {
  profiles: ProfileStore
  /** Called after a restore wrote rows: the provider manager reloads its profiles. */
  reload?: () => Promise<void>
}): SecretsPort {
  const { profiles } = options
  return {
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
      return out.sort((a, b) => (a.key < b.key ? -1 : 1))
    },
    async put(record) {
      // a connection before its credentials; only the kinds this port exports may be written
      const order = [PROVIDER, CONNECTION, CLIENT, CREDENTIALS]
      for (const row of [...record.rows].sort(
        (a, b) => order.indexOf(a.kind) - order.indexOf(b.kind),
      )) {
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
