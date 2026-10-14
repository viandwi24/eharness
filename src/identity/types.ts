/**
 * Types and the storage port of `eharness/identity`: one person, many platform accounts.
 *
 * @see docs/specs/30-identity.md
 */

export type PersonStatus = 'active' | 'suspended' | 'left'
export const PERSON_STATUSES: readonly PersonStatus[] = ['active', 'suspended', 'left']

/** The default role ladder. Apps may use any role names; this is a type helper only. */
export const DEFAULT_ROLES = ['owner', 'admin', 'member', 'guest'] as const
export type DefaultRole = (typeof DEFAULT_ROLES)[number]

/** A human. Role, divisions and status belong to the person, so every account has the same rights. */
export interface Person {
  id: string
  displayName: string
  nickname: string | null
  status: PersonStatus
  /** App-defined role name; `null` = the app's default role. */
  role: string | null
  divisions: string[]
  fields: Record<string, string>
  notes: string
  /** Optional link to an app-side member record. */
  memberId: string | null
  createdBy: string | null
  createdAt: number
  updatedAt: number
}

/** How an account was linked; `string` leaves room for app-specific values. */
export type LinkedVia = 'owner' | 'pairing' | 'migration' | (string & {})

/** One platform account of a person, keyed by the platform's stable user id. */
export interface PersonAccount {
  id: string
  personId: string
  /** The platform family, e.g. `telegram`. */
  platform: string
  /** The platform's stable user id. Never a username or display name. */
  nativeId: string
  label: string | null
  status: 'linked' | 'revoked'
  linkedVia: LinkedVia
  linkedBy: string | null
  linkedAt: number
  revokedAt: number | null
}

/** One audit record of a person (create, update, role, status, link, unlink, pair, delete). */
export interface PersonEvent {
  id: string
  personId: string
  kind: string
  actor: string | null
  detail: Record<string, unknown>
  at: number
}

export interface PersonInput {
  displayName: string
  nickname?: string | null
  role?: string | null
  divisions?: string[]
  fields?: Record<string, string>
  notes?: string
  memberId?: string | null
}

export interface PersonPatch {
  displayName?: string | undefined
  nickname?: string | null | undefined
  status?: PersonStatus | undefined
  role?: string | null | undefined
  divisions?: string[] | undefined
  /** Merged into the fields; a `null` value removes the key. */
  fields?: Record<string, string | null> | undefined
  notes?: string | undefined
  memberId?: string | null | undefined
}

export interface PersonListQuery {
  /** Matches name, nickname, field values and linked native ids (case-insensitive substring). */
  q?: string
  limit?: number
  offset?: number
}

export type IdentityErrorCode = 'ACCOUNT_LINKED_ELSEWHERE' | 'PERSON_NOT_FOUND' | 'INVALID_PERSON'

/** Rejected for a refused directory change; the message is a sentence for people and models. */
export class IdentityError extends Error {
  readonly code: IdentityErrorCode
  constructor(message: string, code: IdentityErrorCode) {
    super(message)
    this.name = 'IdentityError'
    this.code = code
  }
}

/** Type guard for {@link IdentityError}, optionally narrowed to one code. */
export function isIdentityError(error: unknown, code?: IdentityErrorCode): error is IdentityError {
  return error instanceof IdentityError && (code === undefined || error.code === code)
}

/**
 * The people directory port. Every method is async so adapters may sit on a database.
 * Timestamps are epoch ms supplied by the caller.
 */
export interface PersonStore {
  get(id: string): Promise<Person | undefined>
  /** Newest-updated first. */
  list(query?: PersonListQuery): Promise<{ items: Person[]; total: number }>
  create(input: PersonInput, actor: string | null, now: number): Promise<Person>
  /** Rejects `PERSON_NOT_FOUND` for an unknown id. */
  update(id: string, patch: PersonPatch, actor: string | null, now: number): Promise<Person>
  /** Accounts and pending codes go; events stay plus a final `delete` event. False when unknown. */
  delete(id: string, actor: string | null, now: number): Promise<boolean>
  /** The linked (not revoked) account of a platform user id, with its person. */
  byAccount(
    platform: string,
    nativeId: string,
  ): Promise<{ person: Person; account: PersonAccount } | undefined>
  accounts(personId: string, includeRevoked?: boolean): Promise<PersonAccount[]>
  /**
   * Link an account. Rejects `ACCOUNT_LINKED_ELSEWHERE` when linked to another person; linking it
   * again to the same person only updates the label.
   */
  link(
    personId: string,
    account: { platform: string; nativeId: string; label?: string | null },
    via: LinkedVia,
    actor: string | null,
    now: number,
  ): Promise<PersonAccount>
  unlink(accountId: string, actor: string | null, now: number): Promise<PersonAccount | undefined>
  setLabel(
    accountId: string,
    label: string | null,
    actor: string | null,
    now: number,
  ): Promise<PersonAccount | undefined>
  /** Newest first. */
  events(personId: string, limit?: number): Promise<PersonEvent[]>
  /** A pairing code (stored hashed); the plain code is returned once. Max 3 pending per person. */
  issueCode(
    personId: string,
    now: number,
    ttlMs?: number,
  ): Promise<{ code: string; expiresAt: number } | { error: string }>
  /** The person a valid unused code belongs to; the code is consumed (compare-and-set). */
  redeemCode(code: string, now: number): Promise<string | undefined>
}
