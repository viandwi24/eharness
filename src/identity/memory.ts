/**
 * In-memory {@link PersonStore}: for tests, prototypes and single-process apps. Every read and
 * write copies.
 *
 * @see docs/specs/30-identity.md#3-personstore
 */
import { uuidv7 } from '../index.ts'
import {
  DEFAULT_CODE_TTL_MS,
  generatePairingCode,
  hashPairingCode,
  MAX_PENDING_CODES,
} from './pairing.ts'
import {
  IdentityError,
  type Person,
  type PersonAccount,
  type PersonEvent,
  type PersonStore,
} from './types.ts'

export interface MemoryPersonStoreOptions {
  /** Id source. Default UUIDv7. */
  ids?: { next(): string }
}

interface CodeRow {
  id: string
  personId: string
  hash: string
  expiresAt: number
  used: boolean
}

const clone = <T>(v: T): T => structuredClone(v)
const clamp = (n: number, lo: number, hi: number): number => Math.min(Math.max(n, lo), hi)

export function memoryPersonStore(options: MemoryPersonStoreOptions = {}): PersonStore {
  const ids = options.ids ?? { next: uuidv7 }
  const people = new Map<string, Person>()
  const accounts = new Map<string, PersonAccount>()
  const codes: CodeRow[] = []
  const events: PersonEvent[] = []

  const event = (
    personId: string,
    kind: string,
    actor: string | null,
    detail: Record<string, unknown>,
    at: number,
  ): void => {
    events.push({ id: ids.next(), personId, kind, actor, detail: clone(detail), at })
  }
  const linkedOf = (platform: string, nativeId: string): PersonAccount | undefined => {
    for (const a of accounts.values())
      if (a.status === 'linked' && a.platform === platform && a.nativeId === nativeId) return a
    return undefined
  }
  const need = (id: string): Person => {
    const p = people.get(id)
    if (p === undefined) throw new IdentityError('No such person.', 'PERSON_NOT_FOUND')
    return p
  }

  const store: PersonStore = {
    async get(id) {
      const p = people.get(id)
      return p === undefined ? undefined : clone(p)
    },
    async list(query = {}) {
      const limit = clamp(query.limit ?? 50, 1, 500)
      const offset = Math.max(query.offset ?? 0, 0)
      const q = query.q?.trim().toLowerCase() ?? ''
      let all = [...people.values()]
      if (q !== '') {
        all = all.filter(
          (p) =>
            p.displayName.toLowerCase().includes(q) ||
            (p.nickname ?? '').toLowerCase().includes(q) ||
            Object.values(p.fields).some((v) => v.toLowerCase().includes(q)) ||
            [...accounts.values()].some(
              (a) =>
                a.personId === p.id &&
                a.status === 'linked' &&
                a.nativeId.toLowerCase().includes(q),
            ),
        )
      }
      all.sort((a, b) => b.updatedAt - a.updatedAt)
      return { items: all.slice(offset, offset + limit).map(clone), total: all.length }
    },
    async create(input, actor, now) {
      const name = input.displayName.trim()
      if (name === '') throw new IdentityError('A person needs a name.', 'INVALID_PERSON')
      const p: Person = {
        id: ids.next(),
        displayName: name.slice(0, 120),
        nickname: input.nickname?.trim().slice(0, 60) || null,
        status: 'active',
        role: input.role ?? null,
        divisions: [...new Set(input.divisions ?? [])],
        fields: { ...(input.fields ?? {}) },
        notes: (input.notes ?? '').slice(0, 4000),
        memberId: input.memberId ?? null,
        createdBy: actor,
        createdAt: now,
        updatedAt: now,
      }
      people.set(p.id, p)
      event(
        p.id,
        'create',
        actor,
        { displayName: name, ...(p.role === null ? {} : { role: p.role }) },
        now,
      )
      return clone(p)
    },
    async update(id, patch, actor, now) {
      const p = need(id)
      const next: Person = clone(p)
      const changed: Record<string, unknown> = {}
      const name = patch.displayName?.trim()
      if (name !== undefined && name !== '' && name !== p.displayName) {
        next.displayName = name.slice(0, 120)
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
        changed.fields = clone(patch.fields)
      }
      if (patch.notes !== undefined && patch.notes !== p.notes) {
        next.notes = patch.notes.slice(0, 4000)
        changed.notes = true
      }
      if (patch.memberId !== undefined && patch.memberId !== p.memberId) {
        next.memberId = patch.memberId
        changed.memberId = patch.memberId
      }
      if (Object.keys(changed).length === 0) return clone(p)
      next.updatedAt = now
      people.set(id, next)
      event(
        id,
        'role' in changed ? 'role' : 'status' in changed ? 'status' : 'update',
        actor,
        changed,
        now,
      )
      return clone(next)
    },
    async delete(id, actor, now) {
      const p = people.get(id)
      if (p === undefined) return false
      const own = [...accounts.values()].filter((a) => a.personId === id)
      for (const a of own) accounts.delete(a.id)
      for (let i = codes.length - 1; i >= 0; i--) if (codes[i]?.personId === id) codes.splice(i, 1)
      people.delete(id)
      event(
        id,
        'delete',
        actor,
        {
          displayName: p.displayName,
          accounts: own
            .filter((a) => a.status === 'linked')
            .map((a) => ({ platform: a.platform, nativeId: a.nativeId })),
        },
        now,
      )
      return true
    },
    async byAccount(platform, nativeId) {
      const a = linkedOf(platform, nativeId)
      const p = a === undefined ? undefined : people.get(a.personId)
      return a === undefined || p === undefined
        ? undefined
        : { person: clone(p), account: clone(a) }
    },
    async accounts(personId, includeRevoked = false) {
      return [...accounts.values()]
        .filter((a) => a.personId === personId && (includeRevoked || a.status === 'linked'))
        .sort((a, b) => a.linkedAt - b.linkedAt)
        .map(clone)
    },
    async link(personId, account, via, actor, now) {
      const person = need(personId)
      const existing = linkedOf(account.platform, account.nativeId)
      if (existing !== undefined) {
        if (existing.personId !== personId) {
          const other = people.get(existing.personId)
          throw new IdentityError(
            `That ${account.platform} account already belongs to ${other?.displayName ?? 'another person'}. Unlink it there first.`,
            'ACCOUNT_LINKED_ELSEWHERE',
          )
        }
        if (account.label !== undefined && account.label !== existing.label) {
          return (await store.setLabel(existing.id, account.label, actor, now)) ?? clone(existing)
        }
        return clone(existing)
      }
      const a: PersonAccount = {
        id: ids.next(),
        personId,
        platform: account.platform,
        nativeId: account.nativeId,
        label: account.label?.trim().slice(0, 120) || null,
        status: 'linked',
        linkedVia: via,
        linkedBy: actor,
        linkedAt: now,
        revokedAt: null,
      }
      accounts.set(a.id, a)
      person.updatedAt = now
      event(personId, 'link', actor, { platform: a.platform, nativeId: a.nativeId, via }, now)
      return clone(a)
    },
    async unlink(accountId, actor, now) {
      const a = accounts.get(accountId)
      if (a === undefined || a.status === 'revoked') return undefined
      a.status = 'revoked'
      a.revokedAt = now
      const p = people.get(a.personId)
      if (p !== undefined) p.updatedAt = now
      event(a.personId, 'unlink', actor, { platform: a.platform, nativeId: a.nativeId }, now)
      return clone(a)
    },
    async setLabel(accountId, label, actor, now) {
      const a = accounts.get(accountId)
      if (a === undefined) return undefined
      a.label = label?.trim().slice(0, 120) || null
      event(a.personId, 'update', actor, { account: accountId, label: a.label }, now)
      return clone(a)
    },
    async events(personId, limit = 50) {
      return events
        .filter((e) => e.personId === personId)
        .map((e, i) => ({ e, i }))
        .sort((x, y) => y.e.at - x.e.at || y.i - x.i)
        .slice(0, clamp(limit, 1, 500))
        .map((x) => clone(x.e))
    },
    async issueCode(personId, now, ttlMs = DEFAULT_CODE_TTL_MS) {
      if (!people.has(personId)) return { error: 'No such person.' }
      const pending = codes.filter(
        (c) => c.personId === personId && !c.used && c.expiresAt > now,
      ).length
      if (pending >= MAX_PENDING_CODES) {
        return {
          error: `There are already ${MAX_PENDING_CODES} unused codes for this person; use one or wait until they expire.`,
        }
      }
      const code = generatePairingCode()
      const expiresAt = now + ttlMs
      codes.push({
        id: ids.next(),
        personId,
        hash: await hashPairingCode(code),
        expiresAt,
        used: false,
      })
      event(personId, 'pair', null, { issued: true, expiresAt }, now)
      return { code, expiresAt }
    },
    async redeemCode(code, now) {
      const hash = await hashPairingCode(code)
      const row = codes.find((c) => c.hash === hash && !c.used && c.expiresAt > now)
      if (row === undefined) return undefined
      // single threaded: check and flip in one synchronous step
      row.used = true
      return row.personId
    },
  }
  return store
}
