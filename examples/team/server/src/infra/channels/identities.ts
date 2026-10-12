/**
 * SQLite store of identities (docs/plans/P41-team-channels.md, phase L5): the people, bots and
 * channels one connection has seen, their aliases, per-space profiles and memberships, and the
 * link of an identity to a team member (`personId`, set only by an authorized action). The
 * "Not linked yet" list is the direct-message counters of identities without a link: who and how
 * often, never what.
 */
import type { Database } from 'bun:sqlite'
import { uuidv7 } from 'eharness'
import type { IdentityKind, IdentityRow } from './model.ts'
import { likePattern, orderBy, windowOf } from './paging.ts'
import type { Identity } from './types.ts'

interface IdentityDb {
  id: string
  connection_id: string
  native_id: string
  kind: string
  person_id: string | null
  linked_at: number | null
  is_self: number
  display_name: string | null
  username: string | null
  avatar: string | null
  meta: string
  first_seen_at: number
  last_seen_at: number
  dm_first_at: number | null
  dm_last_at: number | null
  dm_count: number
  ignored: number
}

const toIdentity = (r: IdentityDb): IdentityRow => ({
  id: r.id,
  connectionId: r.connection_id,
  nativeId: r.native_id,
  kind: r.kind as IdentityKind,
  personId: r.person_id,
  linkedAt: r.linked_at,
  isSelf: r.is_self === 1,
  displayName: r.display_name,
  username: r.username,
  avatar: r.avatar,
  meta: JSON.parse(r.meta) as Record<string, unknown>,
  firstSeenAt: r.first_seen_at,
  lastSeenAt: r.last_seen_at,
  dmFirstAt: r.dm_first_at,
  dmLastAt: r.dm_last_at,
  dmCount: r.dm_count,
  ignored: r.ignored === 1,
})

/** An identity as the gateway's callers use it again (`Identity` of the contract). */
export function identityDtoOf(row: IdentityRow): Identity {
  return {
    id: row.nativeId,
    ...(row.displayName === null ? {} : { name: row.displayName }),
    ...(row.username === null ? {} : { username: row.username }),
    ...(row.kind === 'bot' ? { isBot: true } : {}),
    ...(row.isSelf ? { isSelf: true } : {}),
    kind: row.kind,
  }
}

export interface UpsertIdentityOptions {
  now: number
  /** The adapter says this identity is the connection itself. */
  isSelf?: boolean | undefined
  /** The space or room a `profile` of the identity belongs to. */
  scopeNodeId?: string | undefined
}

export interface IdentityStore {
  /** Create or refresh (a missing field keeps what is stored; empty names never overwrite). */
  upsert(connectionId: string, info: Identity, options: UpsertIdentityOptions): IdentityRow
  get(id: string): IdentityRow | undefined
  byNative(connectionId: string, nativeId: string): IdentityRow | undefined
  /** An identity by an alias (`username`, `phone`, ...). */
  byAlias(connectionId: string, kind: string, value: string): IdentityRow | undefined
  aliases(identityId: string): Array<{ kind: string; value: string }>
  profile(
    identityId: string,
    scopeNodeId: string,
  ): { nick: string | null; roles: string[] } | undefined
  /** Identities that are linked to a team member, oldest link first. */
  linked(connectionId: string): IdentityRow[]
  /** The identity linked to a member (the newest link), to message them. */
  ofPerson(connectionId: string, personId: string): IdentityRow | undefined
  /** Link an identity to a team member (creating it when only its id is known); resets the "not linked" counters. */
  link(
    connectionId: string,
    nativeId: string,
    personId: string,
    options: { name?: string | undefined; now: number },
  ): IdentityRow
  unlink(connectionId: string, nativeId: string): boolean
  /** A direct message from an identity that is not linked: count it (who, never what). */
  noteDirect(identityId: string, at: number): IdentityRow
  /** People who wrote directly and are not linked; ignored ones only with `includeIgnored`. Newest first. */
  unlinked(connectionId: string, options?: { includeIgnored?: boolean }): IdentityRow[]
  setIgnored(connectionId: string, nativeId: string, ignored: boolean): boolean
  setMembership(
    nodeId: string,
    identityId: string,
    membership: { role?: string; joinedAt?: number | null; leftAt?: number | null },
  ): void
  members(nodeId: string): Array<{ identityId: string; role: string }>
  /** The places an identity is a member of (it has not left), with its platform role there. */
  memberships(identityId: string): Array<{ nodeId: string; role: string }>
  /** Identities of a connection, most recently seen first (the self identity is left out). */
  list(connectionId: string, limit: number): IdentityRow[]
  /**
   * One page of the people of a connection (the connection itself left out): filtered, sorted and
   * counted in SQL. `role` is the role the team set in the directory; `q` searches name, username
   * and platform id.
   */
  table(
    connectionId: string,
    query: {
      q?: string | undefined
      sort?: string | undefined
      order?: 'asc' | 'desc' | undefined
      role?: string | undefined
      linked?: boolean | undefined
      kind?: string | undefined
      ignored?: boolean | undefined
      page: number
      limit: number
    },
  ): { items: IdentityRow[]; total: number }
  /**
   * Find people by what is known about them: the platform user id (exact), a username (with or
   * without `@`), or a part of the name. Newest first, the connection's own identity left out.
   */
  search(connectionId: string, query: string, limit: number): IdentityRow[]
  clear(connectionId: string): void
}

export function sqliteIdentityStore(sqlite: Database): IdentityStore {
  const byIdQ = sqlite.query<IdentityDb, [string]>('SELECT * FROM ch_identities WHERE id = ?')
  const byNativeQ = sqlite.query<IdentityDb, [string, string]>(
    'SELECT * FROM ch_identities WHERE connection_id = ? AND native_id = ?',
  )
  const get = (id: string): IdentityRow | undefined => {
    const r = byIdQ.get(id)
    return r === null ? undefined : toIdentity(r)
  }
  const byNative = (connectionId: string, nativeId: string): IdentityRow | undefined => {
    const r = byNativeQ.get(connectionId, nativeId)
    return r === null ? undefined : toIdentity(r)
  }
  const kindOf = (info: Identity): IdentityKind =>
    info.kind ?? (info.isBot === true ? 'bot' : 'human')

  const store: IdentityStore = {
    upsert(connectionId, info, options) {
      const existing = byNative(connectionId, info.id)
      let id: string
      if (existing === undefined) {
        id = uuidv7()
        sqlite
          .query(
            `INSERT INTO ch_identities (id, connection_id, native_id, kind, is_self, display_name, username, first_seen_at, last_seen_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            id,
            connectionId,
            info.id,
            kindOf(info),
            options.isSelf === true || info.isSelf === true ? 1 : 0,
            info.name === undefined || info.name === '' ? null : info.name,
            info.username ?? null,
            options.now,
            options.now,
          )
      } else {
        id = existing.id
        const sets: string[] = ['last_seen_at = MAX(last_seen_at, ?)']
        const args: Array<string | number | null> = [options.now]
        if (info.name !== undefined && info.name !== '' && info.name !== existing.displayName) {
          sets.push('display_name = ?')
          args.push(info.name)
        }
        if (info.username !== undefined && info.username !== existing.username) {
          sets.push('username = ?')
          args.push(info.username)
        }
        if (info.kind !== undefined && info.kind !== existing.kind) {
          sets.push('kind = ?')
          args.push(info.kind)
        } else if (info.isBot === true && existing.kind === 'human') {
          sets.push("kind = 'bot'")
        }
        if ((options.isSelf === true || info.isSelf === true) && !existing.isSelf) {
          sets.push('is_self = 1')
        }
        sqlite
          .query(`UPDATE ch_identities SET ${sets.join(', ')} WHERE id = ?`)
          .run(...(args as never[]), id)
      }
      for (const a of [
        ...(info.aliases ?? []),
        ...(info.username === undefined ? [] : [{ kind: 'username', value: info.username }]),
      ]) {
        sqlite
          .query(
            'INSERT OR IGNORE INTO ch_identity_aliases (identity_id, connection_id, kind, value) VALUES (?, ?, ?, ?)',
          )
          .run(id, connectionId, a.kind, a.value)
      }
      if (info.profile !== undefined && options.scopeNodeId !== undefined) {
        sqlite
          .query(
            `INSERT INTO ch_identity_profiles (identity_id, scope_node_id, nick, roles) VALUES (?, ?, ?, ?)
             ON CONFLICT (identity_id, scope_node_id) DO UPDATE SET nick = COALESCE(excluded.nick, nick), roles = excluded.roles`,
          )
          .run(
            id,
            options.scopeNodeId,
            info.profile.nick ?? null,
            JSON.stringify(info.profile.roles ?? []),
          )
      }
      return get(id) as IdentityRow
    },
    get,
    byNative,
    byAlias(connectionId, kind, value) {
      const r = sqlite
        .query<IdentityDb, [string, string, string]>(
          `SELECT i.* FROM ch_identity_aliases a JOIN ch_identities i ON i.id = a.identity_id
             WHERE a.connection_id = ? AND a.kind = ? AND a.value = ? LIMIT 1`,
        )
        .get(connectionId, kind, value)
      return r === null ? undefined : toIdentity(r)
    },
    aliases(identityId) {
      return sqlite
        .query<{ kind: string; value: string }, [string]>(
          'SELECT kind, value FROM ch_identity_aliases WHERE identity_id = ? ORDER BY kind, value',
        )
        .all(identityId)
    },
    profile(identityId, scopeNodeId) {
      const r = sqlite
        .query<{ nick: string | null; roles: string }, [string, string]>(
          'SELECT nick, roles FROM ch_identity_profiles WHERE identity_id = ? AND scope_node_id = ?',
        )
        .get(identityId, scopeNodeId)
      return r === null ? undefined : { nick: r.nick, roles: JSON.parse(r.roles) as string[] }
    },
    linked(connectionId) {
      return sqlite
        .query<IdentityDb, [string]>(
          'SELECT * FROM ch_identities WHERE connection_id = ? AND person_id IS NOT NULL ORDER BY linked_at, id',
        )
        .all(connectionId)
        .map(toIdentity)
    },
    ofPerson(connectionId, personId) {
      const r = sqlite
        .query<IdentityDb, [string, string]>(
          `SELECT * FROM ch_identities WHERE connection_id = ? AND person_id = ?
             ORDER BY linked_at DESC, id DESC LIMIT 1`,
        )
        .get(connectionId, personId)
      return r === null ? undefined : toIdentity(r)
    },
    link(connectionId, nativeId, personId, { name, now }) {
      const existing = byNative(connectionId, nativeId)
      const identity =
        existing ??
        store.upsert(
          connectionId,
          { id: nativeId, ...(name === undefined ? {} : { name }) },
          { now },
        )
      sqlite
        .query(
          `UPDATE ch_identities SET person_id = ?, linked_at = ?, dm_count = 0, dm_first_at = NULL, dm_last_at = NULL,
             display_name = COALESCE(display_name, ?) WHERE id = ?`,
        )
        .run(personId, now, name ?? null, identity.id)
      return get(identity.id) as IdentityRow
    },
    unlink(connectionId, nativeId) {
      return (
        sqlite
          .query(
            'UPDATE ch_identities SET person_id = NULL, linked_at = NULL WHERE connection_id = ? AND native_id = ? AND person_id IS NOT NULL',
          )
          .run(connectionId, nativeId).changes > 0
      )
    },
    noteDirect(identityId, at) {
      sqlite
        .query(
          `UPDATE ch_identities SET dm_count = dm_count + 1, dm_first_at = COALESCE(dm_first_at, ?),
             dm_last_at = MAX(COALESCE(dm_last_at, 0), ?) WHERE id = ?`,
        )
        .run(at, at, identityId)
      return get(identityId) as IdentityRow
    },
    unlinked(connectionId, options) {
      return sqlite
        .query<IdentityDb, [string]>(
          `SELECT * FROM ch_identities WHERE connection_id = ? AND person_id IS NULL AND dm_count > 0${options?.includeIgnored === true ? '' : ' AND ignored = 0'}
             ORDER BY dm_last_at DESC, native_id`,
        )
        .all(connectionId)
        .map(toIdentity)
    },
    setIgnored(connectionId, nativeId, ignored) {
      return (
        sqlite
          .query(
            'UPDATE ch_identities SET ignored = ? WHERE connection_id = ? AND native_id = ? AND dm_count > 0',
          )
          .run(ignored ? 1 : 0, connectionId, nativeId).changes > 0
      )
    },
    setMembership(nodeId, identityId, m) {
      sqlite
        .query(
          `INSERT INTO ch_memberships (node_id, identity_id, role, joined_at, left_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (node_id, identity_id) DO UPDATE SET role = COALESCE(?, role),
             joined_at = COALESCE(?, joined_at), left_at = ?`,
        )
        .run(
          nodeId,
          identityId,
          m.role ?? 'member',
          m.joinedAt ?? null,
          m.leftAt ?? null,
          m.role ?? null,
          m.joinedAt ?? null,
          m.leftAt ?? null,
        )
    },
    members(nodeId) {
      return sqlite
        .query<{ identity_id: string; role: string }, [string]>(
          'SELECT identity_id, role FROM ch_memberships WHERE node_id = ? AND left_at IS NULL',
        )
        .all(nodeId)
        .map((r) => ({ identityId: r.identity_id, role: r.role }))
    },
    memberships(identityId) {
      return sqlite
        .query<{ node_id: string; role: string }, [string]>(
          'SELECT node_id, role FROM ch_memberships WHERE identity_id = ? AND left_at IS NULL',
        )
        .all(identityId)
        .map((r) => ({ nodeId: r.node_id, role: r.role }))
    },
    list(connectionId, limit) {
      return sqlite
        .query<IdentityDb, [string, number]>(
          'SELECT * FROM ch_identities WHERE connection_id = ? AND is_self = 0 ORDER BY last_seen_at DESC, id DESC LIMIT ?',
        )
        .all(connectionId, limit)
        .map(toIdentity)
    },
    table(connectionId, q) {
      const where = ['i.connection_id = ?', 'i.is_self = 0']
      const args: Array<string | number> = [connectionId]
      if (q.role !== undefined) {
        where.push('p.role = ?')
        args.push(q.role)
      }
      if (q.linked !== undefined) where.push(`(i.person_id IS NOT NULL) = ${q.linked ? 1 : 0}`)
      if (q.kind !== undefined) {
        where.push('i.kind = ?')
        args.push(q.kind)
      }
      if (q.ignored !== undefined) where.push(`i.ignored = ${q.ignored ? 1 : 0}`)
      if (q.q !== undefined && q.q.trim() !== '') {
        const like = likePattern(q.q.trim().replace(/^@/, ''))
        where.push(
          `(i.display_name LIKE ? ESCAPE '\\' OR i.username LIKE ? ESCAPE '\\' OR i.native_id LIKE ? ESCAPE '\\')`,
        )
        args.push(like, like, like)
      }
      const from = `FROM ch_identities i LEFT JOIN ch_people p ON p.identity_id = i.id WHERE ${where.join(' AND ')}`
      const order = orderBy(
        {
          name: {
            expr: 'COALESCE(i.display_name, i.username, i.native_id) COLLATE NOCASE',
            defaultOrder: 'asc',
          },
          lastSeen: { expr: 'i.last_seen_at', defaultOrder: 'desc' },
          firstSeen: { expr: 'i.first_seen_at', defaultOrder: 'desc' },
          role: {
            expr: `CASE p.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'member' THEN 2 WHEN 'guest' THEN 3 ELSE 4 END`,
            defaultOrder: 'asc',
          },
          messages: { expr: 'i.dm_count', defaultOrder: 'desc' },
        },
        q.sort,
        q.order,
        'lastSeen',
        'i.id',
      )
      const total =
        sqlite
          .query<{ n: number }, Array<string | number>>(`SELECT COUNT(*) AS n ${from}`)
          .get(...args)?.n ?? 0
      const rows = sqlite
        .query<IdentityDb, Array<string | number>>(`SELECT i.* ${from} ${order} LIMIT ? OFFSET ?`)
        .all(...args, ...windowOf(q.page, q.limit))
      return { items: rows.map(toIdentity), total }
    },
    search(connectionId, query, limit) {
      const q = query.trim().replace(/^@/, '')
      if (q === '') return []
      const like = `%${q.replace(/[\\%_]/g, '\\$&')}%`
      return sqlite
        .query<IdentityDb, [string, string, string, string, string, number]>(
          `SELECT DISTINCT i.* FROM ch_identities i
             LEFT JOIN ch_identity_aliases a ON a.identity_id = i.id AND a.kind = 'username'
             WHERE i.connection_id = ? AND i.is_self = 0
               AND (i.native_id = ? OR lower(i.username) = lower(?) OR lower(a.value) = lower(?)
                    OR lower(i.display_name) LIKE lower(?) ESCAPE '\\')
             ORDER BY i.last_seen_at DESC, i.id DESC LIMIT ?`,
        )
        .all(connectionId, q, q, q, like, limit)
        .map(toIdentity)
    },
    clear(connectionId) {
      const ids = sqlite
        .query<{ id: string }, [string]>('SELECT id FROM ch_identities WHERE connection_id = ?')
        .all(connectionId)
        .map((r) => r.id)
      for (const id of ids) {
        sqlite.query('DELETE FROM ch_identity_aliases WHERE identity_id = ?').run(id)
        sqlite.query('DELETE FROM ch_identity_profiles WHERE identity_id = ?').run(id)
        sqlite.query('DELETE FROM ch_memberships WHERE identity_id = ?').run(id)
      }
      sqlite.query('DELETE FROM ch_people WHERE connection_id = ?').run(connectionId)
      sqlite.query('DELETE FROM ch_identities WHERE connection_id = ?').run(connectionId)
    },
  }
  return store
}
