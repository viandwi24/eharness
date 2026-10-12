/**
 * What a person asked to be called or how they like answers ("call me Pak Vian", "short answers
 * please"): one short note on their directory profile (docs/plans/P42-team-persona.md, layer 4),
 * keyed by the platform identity. It is a stated preference. It never changes the persona, a role or
 * what anybody may do, and it reaches the model as a turn reminder about the person who is asking,
 * never in `instructions`.
 */
import type { Database } from 'bun:sqlite'

export interface PersonNote {
  identityId: string
  connectionId: string
  note: string
  setBy: string | null
  updatedAt: number
}

interface Row {
  identity_id: string
  connection_id: string
  note: string
  set_by: string | null
  updated_at: number
}

const toNote = (r: Row): PersonNote => ({
  identityId: r.identity_id,
  connectionId: r.connection_id,
  note: r.note,
  setBy: r.set_by,
  updatedAt: r.updated_at,
})

export interface PeopleNotes {
  get(identityId: string): PersonNote | undefined
  list(connectionId: string): PersonNote[]
  set(
    connectionId: string,
    identityId: string,
    note: string,
    setBy: string | undefined,
    now: number,
  ): PersonNote
  clear(identityId: string): boolean
}

export function sqlitePeopleNotes(sqlite: Database): PeopleNotes {
  const getQ = sqlite.query<Row, [string]>('SELECT * FROM ch_people_notes WHERE identity_id = ?')
  const get = (identityId: string): PersonNote | undefined => {
    const r = getQ.get(identityId)
    return r === null ? undefined : toNote(r)
  }
  return {
    get,
    list: (connectionId) =>
      sqlite
        .query<Row, [string]>('SELECT * FROM ch_people_notes WHERE connection_id = ?')
        .all(connectionId)
        .map(toNote),
    set(connectionId, identityId, note, setBy, now) {
      sqlite
        .query(
          `INSERT INTO ch_people_notes (identity_id, connection_id, note, set_by, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(identity_id) DO UPDATE SET note = excluded.note, set_by = excluded.set_by,
             updated_at = excluded.updated_at`,
        )
        .run(identityId, connectionId, note, setBy ?? null, now)
      return get(identityId) as PersonNote
    },
    clear(identityId) {
      return (
        sqlite.query('DELETE FROM ch_people_notes WHERE identity_id = ?').run(identityId).changes >
        0
      )
    },
  }
}
