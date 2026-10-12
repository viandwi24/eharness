/**
 * The people directory of a connection (docs/plans/P41-team-channels.md, phase L6): the role and
 * divisions the team gave an identity (`ch_people`), keyed by the platform user id (never by
 * username). Written only by authorized actions (the People tab, an import the owner confirmed),
 * never by chat text. The platform's own admin status (`ch_memberships`, imported from
 * `getChatAdministrators` / `chat_member` events) is only a suggestion until somebody confirms it.
 */
import type { Database } from 'bun:sqlite'
import { ROLES, type Role } from './roles.ts'

export interface PersonEntry {
  identityId: string
  connectionId: string
  role: Role
  /** Node ids (topics or rooms) the person belongs to. */
  divisions: string[]
  setBy: string | null
  updatedAt: number
}

interface PeopleDb {
  identity_id: string
  connection_id: string
  role: string
  divisions: string
  set_by: string | null
  updated_at: number
}

const isRole = (value: string): value is Role => (ROLES as readonly string[]).includes(value)

const toEntry = (r: PeopleDb): PersonEntry => ({
  identityId: r.identity_id,
  connectionId: r.connection_id,
  role: isRole(r.role) ? r.role : 'guest',
  divisions: JSON.parse(r.divisions) as string[],
  setBy: r.set_by,
  updatedAt: r.updated_at,
})

export interface PeopleStore {
  get(identityId: string): PersonEntry | undefined
  list(connectionId: string): PersonEntry[]
  /** Create or replace the entry; `divisions` undefined keeps the stored ones. */
  set(
    connectionId: string,
    identityId: string,
    input: { role: Role; divisions?: string[] | undefined; setBy?: string | undefined },
    now: number,
  ): PersonEntry
  /** Change the divisions of an entry (created as `member` when the person has none yet). */
  setDivisions(
    connectionId: string,
    identityId: string,
    divisions: string[],
    now: number,
    setBy?: string,
  ): PersonEntry
  /** Back to the default role of the connection. */
  remove(identityId: string): boolean
  clear(connectionId: string): void
}

export function sqlitePeopleStore(sqlite: Database): PeopleStore {
  const getQ = sqlite.query<PeopleDb, [string]>('SELECT * FROM ch_people WHERE identity_id = ?')
  const get = (identityId: string): PersonEntry | undefined => {
    const r = getQ.get(identityId)
    return r === null ? undefined : toEntry(r)
  }
  const unique = (ids: readonly string[]): string[] => [...new Set(ids)]
  return {
    get,
    list(connectionId) {
      return sqlite
        .query<PeopleDb, [string]>(
          'SELECT * FROM ch_people WHERE connection_id = ? ORDER BY updated_at DESC',
        )
        .all(connectionId)
        .map(toEntry)
    },
    set(connectionId, identityId, input, now) {
      const existing = get(identityId)
      const divisions = unique(input.divisions ?? existing?.divisions ?? [])
      sqlite
        .query(
          `INSERT INTO ch_people (identity_id, connection_id, role, divisions, set_by, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (identity_id) DO UPDATE SET role = excluded.role, divisions = excluded.divisions,
             set_by = excluded.set_by, updated_at = excluded.updated_at`,
        )
        .run(
          identityId,
          connectionId,
          input.role,
          JSON.stringify(divisions),
          input.setBy ?? null,
          now,
        )
      return get(identityId) as PersonEntry
    },
    setDivisions(connectionId, identityId, divisions, now, setBy) {
      const existing = get(identityId)
      return this.set(
        connectionId,
        identityId,
        { role: existing?.role ?? 'member', divisions, ...(setBy === undefined ? {} : { setBy }) },
        now,
      )
    },
    remove(identityId) {
      return sqlite.query('DELETE FROM ch_people WHERE identity_id = ?').run(identityId).changes > 0
    },
    clear(connectionId) {
      sqlite.query('DELETE FROM ch_people WHERE connection_id = ?').run(connectionId)
    },
  }
}
