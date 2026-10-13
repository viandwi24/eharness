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
import { ROLES, type Role } from './roles.ts'

export type PersonStatus = 'active' | 'suspended' | 'left'
export const PERSON_STATUSES: readonly PersonStatus[] = ['active', 'suspended', 'left']

export interface Person {
  id: string
  displayName: string
  nickname: string | null
  status: PersonStatus
  /** null = the connection or chat default. */
  role: Role | null
  divisions: string[]
  fields: Record<string, string>
  notes: string
  memberId: string | null
  createdBy: string | null
  createdAt: number
  updatedAt: number
}

export interface PersonAccount {
  id: string
  personId: string
  platform: string
  nativeId: string
  label: string | null
  status: 'linked' | 'revoked'
  linkedVia: 'owner' | 'pairing' | 'migration'
  linkedBy: string | null
  linkedAt: number
  revokedAt: number | null
}

export interface PersonEvent {
  id: string
  personId: string
  kind: string
  actor: string | null
  detail: Record<string, unknown>
  at: number
}

export interface PersonPatch {
  displayName?: string | undefined
  nickname?: string | null | undefined
  status?: PersonStatus | undefined
  role?: Role | null | undefined
  divisions?: string[] | undefined
  /** Merged into the fields; a null value removes the key. */
  fields?: Record<string, string | null> | undefined
  notes?: string | undefined
  memberId?: string | null | undefined
}

export interface PersonStore {
  get(id: string): Person | undefined
  /** Newest first; `q` matches name, nickname, field values and account ids. */
  list(query?: { q?: string; limit?: number; offset?: number }): { items: Person[]; total: number }
  create(
    input: {
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
    via: PersonAccount['linkedVia'],
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
export class PersonError extends Error {
  readonly code: string
  constructor(message: string, code: string) {
    super(message)
    this.code = code
  }
}

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

/** Unambiguous code characters (no 0/O, 1/I/L). */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
const CODE_LENGTH = 8
const MAX_PENDING_CODES = 3

async function sha256(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** A code as people type it: upper case, no spaces or dashes. */
export const normalizeCode = (code: string): string => code.toUpperCase().replace(/[\s-]/g, '')

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
      if (name === '') throw new PersonError('A person needs a name.', 'INVALID_PERSON')
      const id = ids.next()
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
      if (p === undefined) throw new PersonError('No such person.', 'PERSON_NOT_FOUND')
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
      if (get(personId) === undefined) throw new PersonError('No such person.', 'PERSON_NOT_FOUND')
      const existing = store.byAccount(account.platform, account.nativeId)
      if (existing !== undefined) {
        if (existing.person.id !== personId) {
          throw new PersonError(
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
      const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH))
      const code = [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('')
      const expiresAt = now + ttlMs
      sqlite
        .query(
          'INSERT INTO people_link_codes (id, person_id, code_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)',
        )
        .run(ids.next(), personId, await sha256(code), expiresAt, now)
      event(personId, 'pair', null, { issued: true, expiresAt }, now)
      return { code, expiresAt }
    },
    async redeemCode(code, now) {
      const hash = await sha256(normalizeCode(code))
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
