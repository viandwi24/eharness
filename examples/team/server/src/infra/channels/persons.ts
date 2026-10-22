/**
 * The team's people directory (docs/plans/P43-team-people.md): a Person with any number of
 * platform accounts, keyed by the platform's stable user id. Role and divisions belong to the
 * person, so every account of one human has the same rights. Usernames and names are display data
 * of the identities (`ch_identities`), refreshed by every message; they are never keys.
 *
 * Linking an account is an authority decision: only the owner (web app, or a confirmed chat
 * request) or a pairing code sent from the new account by the person themselves links one. An
 * account belongs to one person; moving it needs an unlink first. Every change is an event.
 */
import type { Database } from 'bun:sqlite'
import {
  generatePairingCode,
  hashPairingCode,
  IdentityError,
  type PersonPatch as LibPatch,
  type Person as LibPerson,
  type PersonStore as LibPersonStore,
  MAX_PENDING_CODES,
  PERSON_STATUSES,
  type PersonAccount,
  type PersonEvent,
  type PersonStatus,
} from 'eharness/identity'
import { ROLES, type Role } from './roles.ts'

// the model of the directory is the library's (`eharness/identity`); the team narrows the role
export { PERSON_STATUSES, type PersonAccount, type PersonEvent, type PersonStatus }

export interface Person extends Omit<LibPerson, 'role'> {
  /** null = the connection or chat default. */
  role: Role | null
}

export interface PersonPatch extends Omit<LibPatch, 'role'> {
  role?: Role | null | undefined
}

export interface PersonStore {
  get(id: string): Person | undefined
  /** Newest first; `q` matches name, nickname, field values and account ids. */
  list(query?: { q?: string; limit?: number; offset?: number }): { items: Person[]; total: number }
  create(
    input: {
      /** A given id (a restore keeps ids); used only when no person has it. */
      id?: string
      displayName: string
      nickname?: string | null
      role?: Role | null
      divisions?: string[]
      fields?: Record<string, string>
      notes?: string
      memberId?: string | null
    },
    actor: string | null,
    now: number,
  ): Person
  update(id: string, patch: PersonPatch, actor: string | null, now: number): Person
  /** The linked account of a platform user id, with its person. */
  byAccount(
    platform: string,
    nativeId: string,
  ): { person: Person; account: PersonAccount } | undefined
  accounts(personId: string, includeRevoked?: boolean): PersonAccount[]
  /**
   * Link an account to a person. Refused (throws) when it is linked to somebody else; linking it
   * again to the same person only updates the label.
   */
  link(
    personId: string,
    account: { platform: string; nativeId: string; label?: string | null },
    via: 'owner' | 'pairing' | 'migration',
    actor: string | null,
    now: number,
  ): PersonAccount
  unlink(accountId: string, actor: string | null, now: number): PersonAccount | undefined
  setLabel(
    accountId: string,
    label: string | null,
    actor: string | null,
    now: number,
  ): PersonAccount | undefined
  /**
   * Remove a person: its accounts belong to nobody again (their rows go), pending pairing codes
   * go; the events stay as the audit trail with a final `delete` event. False when unknown.
   */
  delete(id: string, actor: string | null, now: number): boolean
  events(personId: string, limit?: number): PersonEvent[]
  /** A pairing code for the person (stored hashed); the plain code is returned once. */
  issueCode(
    personId: string,
    now: number,
    ttlMs?: number,
  ): Promise<{ code: string; expiresAt: number } | { error: string }>
  /** The person a valid unused code belongs to; the code is consumed. */
  redeemCode(code: string, now: number): Promise<string | undefined>
}

/** Thrown for a refused directory change; the message is a sentence for people and models. */
export { IdentityError as PersonError }

interface PersonDb {
  id: string
  display_name: string
  nickname: string | null
  status: string
  role: string | null
  divisions: string
  fields: string
  notes: string
  member_id: string | null
  created_by: string | null
  created_at: number
  updated_at: number
}

interface AccountDb {
  id: string
  person_id: string
  platform: string
  native_id: string
  label: string | null
  status: string
  linked_via: string
  linked_by: string | null
  linked_at: number
  revoked_at: number | null
}

const isRole = (v: unknown): v is Role =>
  typeof v === 'string' && (ROLES as readonly string[]).includes(v)
const parse = <T>(text: string, fallback: T): T => {
  try {
    return JSON.parse(text) as T
  } catch {
    return fallback
  }
}

const toPerson = (r: PersonDb): Person => ({
  id: r.id,
  displayName: r.display_name,
  nickname: r.nickname,
  status: (PERSON_STATUSES as readonly string[]).includes(r.status)
    ? (r.status as PersonStatus)
    : 'active',
  role: isRole(r.role) ? r.role : null,
  divisions: parse<string[]>(r.divisions, []),
  fields: parse<Record<string, string>>(r.fields, {}),
  notes: r.notes,
  memberId: r.member_id,
  createdBy: r.created_by,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

const toAccount = (r: AccountDb): PersonAccount => ({
  id: r.id,
  personId: r.person_id,
  platform: r.platform,
  nativeId: r.native_id,
  label: r.label,
  status: r.status === 'revoked' ? 'revoked' : 'linked',
  linkedVia:
    r.linked_via === 'pairing' ? 'pairing' : r.linked_via === 'migration' ? 'migration' : 'owner',
  linkedBy: r.linked_by,
  linkedAt: r.linked_at,
  revokedAt: r.revoked_at,
})

export function sqlitePersonStore(sqlite: Database, ids: { next(): string }): PersonStore {
  const getQ = sqlite.query<PersonDb, [string]>('SELECT * FROM people WHERE id = ?')
  const get = (id: string): Person | undefined => {
    const r = getQ.get(id)
    return r === null ? undefined : toPerson(r)
  }
  const accountQ = sqlite.query<AccountDb, [string]>('SELECT * FROM people_accounts WHERE id = ?')
  const event = (
    personId: string,
    kind: string,
    actor: string | null,
    detail: Record<string, unknown>,
    now: number,
  ): void => {
    sqlite
      .query(
        'INSERT INTO people_events (id, person_id, kind, actor, detail, at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(ids.next(), personId, kind, actor, JSON.stringify(detail), now)
  }

  const store: PersonStore = {
    get,
    list(query = {}) {
      const limit = Math.min(Math.max(query.limit ?? 50, 1), 500)
      const offset = Math.max(query.offset ?? 0, 0)
      const q = query.q?.trim().toLowerCase()
      const where =
        q === undefined || q === ''
          ? ''
          : `WHERE lower(p.display_name) LIKE $q OR lower(coalesce(p.nickname, '')) LIKE $q OR lower(p.fields) LIKE $q
             OR EXISTS (SELECT 1 FROM people_accounts a WHERE a.person_id = p.id AND a.status = 'linked' AND a.native_id LIKE $q)`
      const params = q === undefined || q === '' ? {} : { q: `%${q}%` }
      const total =
        (
          sqlite.query(`SELECT COUNT(*) AS n FROM people p ${where}`).get(params as never) as {
            n: number
          } | null
        )?.n ?? 0
      const items = (
        sqlite
          .query(
            `SELECT p.* FROM people p ${where} ORDER BY p.updated_at DESC LIMIT ${limit} OFFSET ${offset}`,
          )
          .all(params as never) as PersonDb[]
      ).map(toPerson)
      return { items, total }
    },
    create(input, actor, now) {
      const name = input.displayName.trim()
      if (name === '') throw new IdentityError('A person needs a name.', 'INVALID_PERSON')
      const id =
        input.id !== undefined && input.id !== '' && get(input.id) === undefined
          ? input.id
          : ids.next()
      sqlite
        .query(
          `INSERT INTO people (id, display_name, nickname, status, role, divisions, fields, notes, member_id, created_by, created_at, updated_at)
           VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          name.slice(0, 120),
          input.nickname?.trim().slice(0, 60) || null,
          input.role ?? null,
          JSON.stringify([...new Set(input.divisions ?? [])]),
          JSON.stringify(input.fields ?? {}),
          (input.notes ?? '').slice(0, 4000),
          input.memberId ?? null,
          actor,
          now,
          now,
        )
      event(
        id,
        'create',
        actor,
        { displayName: name, ...(input.role == null ? {} : { role: input.role }) },
        now,
      )
      return get(id) as Person
    },
    update(id, patch, actor, now) {
      const p = get(id)
      if (p === undefined) throw new IdentityError('No such person.', 'PERSON_NOT_FOUND')
      const next: Person = { ...p }
      const changed: Record<string, unknown> = {}
      if (
        patch.displayName !== undefined &&
        patch.displayName.trim() !== '' &&
        patch.displayName.trim() !== p.displayName
      ) {
        next.displayName = patch.displayName.trim().slice(0, 120)
        changed.displayName = next.displayName
      }
      if (patch.nickname !== undefined) {
        const n = patch.nickname?.trim().slice(0, 60) || null
        if (n !== p.nickname) {
          next.nickname = n
          changed.nickname = n
        }
      }
      if (patch.status !== undefined && patch.status !== p.status) {
        next.status = patch.status
        changed.status = patch.status
      }
      if (patch.role !== undefined && patch.role !== p.role) {
        next.role = patch.role
        changed.role = patch.role
      }
      if (patch.divisions !== undefined) {
        next.divisions = [...new Set(patch.divisions)]
        changed.divisions = next.divisions
      }
      if (patch.fields !== undefined) {
        const f = { ...p.fields }
        for (const [k, v] of Object.entries(patch.fields)) {
          const key = k.trim().slice(0, 60)
          if (key === '') continue
          if (v === null || v.trim() === '') delete f[key]
          else f[key] = v.trim().slice(0, 500)
        }
        next.fields = f
        changed.fields = patch.fields
      }
      if (patch.notes !== undefined && patch.notes !== p.notes) {
        next.notes = patch.notes.slice(0, 4000)
        changed.notes = true
      }
      if (patch.memberId !== undefined && patch.memberId !== p.memberId) {
        next.memberId = patch.memberId
        changed.memberId = patch.memberId
      }
      if (Object.keys(changed).length === 0) return p
      sqlite
        .query(
          `UPDATE people SET display_name = ?, nickname = ?, status = ?, role = ?, divisions = ?, fields = ?, notes = ?, member_id = ?, updated_at = ? WHERE id = ?`,
        )
        .run(
          next.displayName,
          next.nickname,
          next.status,
          next.role,
          JSON.stringify(next.divisions),
          JSON.stringify(next.fields),
          next.notes,
          next.memberId,
          now,
          id,
        )
      const kind = 'role' in changed ? 'role' : 'status' in changed ? 'status' : 'update'
      event(id, kind, actor, changed, now)
      return get(id) as Person
    },
    byAccount(platform, nativeId) {
      const r = sqlite
        .query<AccountDb, [string, string]>(
          "SELECT * FROM people_accounts WHERE platform = ? AND native_id = ? AND status = 'linked' LIMIT 1",
        )
        .get(platform, nativeId)
      if (r === null) return undefined
      const person = get(r.person_id)
      return person === undefined ? undefined : { person, account: toAccount(r) }
    },
    accounts(personId, includeRevoked = false) {
      return sqlite
        .query<AccountDb, [string]>(
          `SELECT * FROM people_accounts WHERE person_id = ? ${includeRevoked ? '' : "AND status = 'linked'"} ORDER BY linked_at`,
        )
        .all(personId)
        .map(toAccount)
    },
    link(personId, account, via, actor, now) {
      if (get(personId) === undefined)
        throw new IdentityError('No such person.', 'PERSON_NOT_FOUND')
      const existing = store.byAccount(account.platform, account.nativeId)
      if (existing !== undefined) {
        if (existing.person.id !== personId) {
          throw new IdentityError(
            `That ${account.platform} account already belongs to ${existing.person.displayName}. Unlink it there first.`,
            'ACCOUNT_LINKED_ELSEWHERE',
          )
        }
        if (account.label !== undefined && account.label !== existing.account.label) {
          return store.setLabel(existing.account.id, account.label, actor, now) ?? existing.account
        }
        return existing.account
      }
      const id = ids.next()
      sqlite
        .query(
          `INSERT INTO people_accounts (id, person_id, platform, native_id, label, status, linked_via, linked_by, linked_at)
           VALUES (?, ?, ?, ?, ?, 'linked', ?, ?, ?)`,
        )
        .run(
          id,
          personId,
          account.platform,
          account.nativeId,
          account.label?.trim().slice(0, 120) || null,
          via,
          actor,
          now,
        )
      sqlite.query('UPDATE people SET updated_at = ? WHERE id = ?').run(now, personId)
      event(
        personId,
        'link',
        actor,
        { platform: account.platform, nativeId: account.nativeId, via },
        now,
      )
      return toAccount(accountQ.get(id) as AccountDb)
    },
    unlink(accountId, actor, now) {
      const r = accountQ.get(accountId)
      if (r === null || r.status === 'revoked') return undefined
      sqlite
        .query("UPDATE people_accounts SET status = 'revoked', revoked_at = ? WHERE id = ?")
        .run(now, accountId)
      sqlite.query('UPDATE people SET updated_at = ? WHERE id = ?').run(now, r.person_id)
      event(r.person_id, 'unlink', actor, { platform: r.platform, nativeId: r.native_id }, now)
      return toAccount(accountQ.get(accountId) as AccountDb)
    },
    delete(id, actor, now) {
      const p = get(id)
      if (p === undefined) return false
      const accounts = store.accounts(id)
      sqlite.transaction(() => {
        sqlite.query('DELETE FROM people_accounts WHERE person_id = ?').run(id)
        sqlite.query('DELETE FROM people_link_codes WHERE person_id = ?').run(id)
        sqlite.query('DELETE FROM people WHERE id = ?').run(id)
        event(
          id,
          'delete',
          actor,
          {
            displayName: p.displayName,
            accounts: accounts.map((a) => ({ platform: a.platform, nativeId: a.nativeId })),
          },
          now,
        )
      })()
      return true
    },
    setLabel(accountId, label, actor, now) {
      const r = accountQ.get(accountId)
      if (r === null) return undefined
      const next = label?.trim().slice(0, 120) || null
      sqlite.query('UPDATE people_accounts SET label = ? WHERE id = ?').run(next, accountId)
      event(r.person_id, 'update', actor, { account: accountId, label: next }, now)
      return toAccount(accountQ.get(accountId) as AccountDb)
    },
    events(personId, limit = 50) {
      return sqlite
        .query<
          {
            id: string
            person_id: string
            kind: string
            actor: string | null
            detail: string
            at: number
          },
          [string, number]
        >('SELECT * FROM people_events WHERE person_id = ? ORDER BY at DESC LIMIT ?')
        .all(personId, Math.min(Math.max(limit, 1), 500))
        .map((r) => ({
          id: r.id,
          personId: r.person_id,
          kind: r.kind,
          actor: r.actor,
          detail: parse<Record<string, unknown>>(r.detail, {}),
          at: r.at,
        }))
    },
    async issueCode(personId, now, ttlMs = 3_600_000) {
      if (get(personId) === undefined) return { error: 'No such person.' }
      const pending =
        (
          sqlite
            .query(
              'SELECT COUNT(*) AS n FROM people_link_codes WHERE person_id = ? AND used_at IS NULL AND expires_at > ?',
            )
            .get(personId, now) as { n: number } | null
        )?.n ?? 0
      if (pending >= MAX_PENDING_CODES) {
        return {
          error: `There are already ${MAX_PENDING_CODES} unused codes for this person; use one or wait until they expire (1 hour).`,
        }
      }
      const code = generatePairingCode()
      const expiresAt = now + ttlMs
      sqlite
        .query(
          'INSERT INTO people_link_codes (id, person_id, code_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)',
        )
        .run(ids.next(), personId, await hashPairingCode(code), expiresAt, now)
      event(personId, 'pair', null, { issued: true, expiresAt }, now)
      return { code, expiresAt }
    },
    async redeemCode(code, now) {
      const hash = await hashPairingCode(code)
      const r = sqlite
        .query<{ id: string; person_id: string }, [string, number]>(
          'SELECT id, person_id FROM people_link_codes WHERE code_hash = ? AND used_at IS NULL AND expires_at > ? LIMIT 1',
        )
        .get(hash, now)
      if (r === null) return undefined
      // single use: the first redeem wins
      const used = sqlite
        .query('UPDATE people_link_codes SET used_at = ? WHERE id = ? AND used_at IS NULL')
        .run(now, r.id)
      return used.changes === 1 ? r.person_id : undefined
    },
  }
  return store
}

/**
 * The sync SQLite store as the library's async `PersonStore` (`eharness/identity`): the gateway
 * keeps reading the directory synchronously, everything else (and the conformance suite) can use
 * this view. Roles outside the team's ladder are stored as given and read back as `null`.
 */
export function asPersonStore(sync: PersonStore): LibPersonStore {
  return {
    get: async (id) => sync.get(id),
    list: async (query) => sync.list(query),
    create: async (input, actor, now) =>
      sync.create({ ...input, role: input.role as Role | null | undefined }, actor, now),
    update: async (id, patch, actor, now) =>
      sync.update(id, { ...patch, role: patch.role as Role | null | undefined }, actor, now),
    delete: async (id, actor, now) => sync.delete(id, actor, now),
    byAccount: async (platform, nativeId) => sync.byAccount(platform, nativeId),
    accounts: async (personId, includeRevoked) => sync.accounts(personId, includeRevoked),
    link: async (personId, account, via, actor, now) =>
      sync.link(personId, account, via as 'owner' | 'pairing' | 'migration', actor, now),
    unlink: async (accountId, actor, now) => sync.unlink(accountId, actor, now),
    setLabel: async (accountId, label, actor, now) => sync.setLabel(accountId, label, actor, now),
    events: async (personId, limit) => sync.events(personId, limit),
    issueCode: (personId, now, ttlMs) => sync.issueCode(personId, now, ttlMs),
    redeemCode: (code, now) => sync.redeemCode(code, now),
  }
}
