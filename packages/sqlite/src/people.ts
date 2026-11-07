/**
 * `PersonStore` (spec 30 §3) on `<prefix>people`, `<prefix>person_accounts`, `<prefix>person_codes`
 * and `<prefix>person_events`. Person events live in a table of their own with no link to the
 * person row, so they outlive `delete`. A linked account of one platform user id is unique (a
 * partial unique index), pairing codes are stored hashed and redeemed with one conditional
 * update, and every multi-statement change runs in one write transaction.
 */
import { uuidv7 } from 'eharness'
import {
  DEFAULT_CODE_TTL_MS,
  generatePairingCode,
  hashPairingCode,
  IdentityError,
  MAX_PENDING_CODES,
  type Person,
  type PersonAccount,
  type PersonEvent,
  type PersonStore,
} from 'eharness/identity'
import type { SqlDriver, SqlParam } from './driver.ts'
import { type AdapterOptions, one, tables } from './util.ts'

/** Options of {@link sqlitePersonStore}. */
export interface SqlitePersonStoreOptions extends AdapterOptions {
  /** Id source for people and accounts. Default UUIDv7. */
  ids?: { next(): string }
}

interface PersonRow {
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

interface AccountRow {
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

const toPerson = (r: PersonRow): Person => ({
  id: r.id,
  displayName: r.display_name,
  nickname: r.nickname,
  status: r.status as Person['status'],
  role: r.role,
  divisions: JSON.parse(r.divisions) as string[],
  fields: JSON.parse(r.fields) as Record<string, string>,
  notes: r.notes,
  memberId: r.member_id,
  createdBy: r.created_by,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

const toAccount = (r: AccountRow): PersonAccount => ({
  id: r.id,
  personId: r.person_id,
  platform: r.platform,
  nativeId: r.native_id,
  label: r.label,
  status: r.status as PersonAccount['status'],
  linkedVia: r.linked_via,
  linkedBy: r.linked_by,
  linkedAt: r.linked_at,
  revokedAt: r.revoked_at,
})

const clamp = (n: number, lo: number, hi: number): number => Math.min(Math.max(n, lo), hi)

export function sqlitePersonStore(
  driver: SqlDriver,
  options: SqlitePersonStoreOptions = {},
): PersonStore {
  const names = tables(options.prefix)
  const ids = options.ids ?? { next: uuidv7 }

  const person = (id: string): PersonRow | undefined =>
    one<PersonRow>(driver, `SELECT * FROM ${names.people} WHERE id = ?`, [id])
  const account = (id: string): AccountRow | undefined =>
    one<AccountRow>(driver, `SELECT * FROM ${names.personAccounts} WHERE id = ?`, [id])
  const linkedOf = (platform: string, nativeId: string): AccountRow | undefined =>
    one<AccountRow>(
      driver,
      `SELECT * FROM ${names.personAccounts}
       WHERE platform = ? AND native_id = ? AND status = 'linked'`,
      [platform, nativeId],
    )
  const need = (id: string): PersonRow => {
    const row = person(id)
    if (row === undefined) throw new IdentityError('No such person.', 'PERSON_NOT_FOUND')
    return row
  }
  const event = (
    personId: string,
    kind: string,
    actor: string | null,
    detail: Record<string, unknown>,
    at: number,
  ): void => {
    driver.run(
      `INSERT INTO ${names.personEvents} (person_id, kind, actor, detail, at) VALUES (?, ?, ?, ?, ?)`,
      [personId, kind, actor, JSON.stringify(detail), at],
    )
  }
  const touch = (id: string, at: number): void => {
    driver.run(`UPDATE ${names.people} SET updated_at = ? WHERE id = ?`, [at, id])
  }

  const store: PersonStore = {
    async get(id) {
      const row = person(id)
      return row === undefined ? undefined : toPerson(row)
    },

    async list(query = {}) {
      const limit = clamp(query.limit ?? 50, 1, 500)
      const offset = Math.max(query.offset ?? 0, 0)
      const q = query.q?.trim().toLowerCase() ?? ''
      let all = driver
        .query<PersonRow>(
          `SELECT * FROM ${names.people} ORDER BY updated_at DESC, created_at DESC, id`,
        )
        .map(toPerson)
      if (q !== '') {
        const native = new Map<string, string[]>()
        for (const a of driver.query<{ person_id: string; native_id: string }>(
          `SELECT person_id, native_id FROM ${names.personAccounts} WHERE status = 'linked'`,
        )) {
          native.set(a.person_id, [...(native.get(a.person_id) ?? []), a.native_id])
        }
        all = all.filter((p) =>
          [
            p.displayName,
            p.nickname ?? '',
            ...Object.values(p.fields),
            ...(native.get(p.id) ?? []),
          ].some((text) => text.toLowerCase().includes(q)),
        )
      }
      return { items: all.slice(offset, offset + limit), total: all.length }
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
      driver.transaction(() => {
        driver.run(
          `INSERT INTO ${names.people} (id, display_name, nickname, status, role, divisions, fields,
             notes, member_id, created_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            p.id,
            p.displayName,
            p.nickname,
            p.status,
            p.role,
            JSON.stringify(p.divisions),
            JSON.stringify(p.fields),
            p.notes,
            p.memberId,
            p.createdBy,
            p.createdAt,
            p.updatedAt,
          ],
        )
        event(
          p.id,
          'create',
          actor,
          { displayName: name, ...(p.role === null ? {} : { role: p.role }) },
          now,
        )
      })
      return p
    },

    async update(id, patch, actor, now) {
      return driver.transaction(() => {
        const p = toPerson(need(id))
        const next: Person = structuredClone(p)
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
          changed.fields = structuredClone(patch.fields)
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
        next.updatedAt = now
        driver.run(
          `UPDATE ${names.people} SET display_name = ?, nickname = ?, status = ?, role = ?,
             divisions = ?, fields = ?, notes = ?, member_id = ?, updated_at = ? WHERE id = ?`,
          [
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
          ],
        )
        event(
          id,
          'role' in changed ? 'role' : 'status' in changed ? 'status' : 'update',
          actor,
          changed,
          now,
        )
        return next
      })
    },

    async delete(id, actor, now) {
      return driver.transaction(() => {
        const row = person(id)
        if (row === undefined) return false
        const own = driver.query<AccountRow>(
          `SELECT * FROM ${names.personAccounts} WHERE person_id = ?`,
          [id],
        )
        driver.run(`DELETE FROM ${names.personAccounts} WHERE person_id = ?`, [id])
        driver.run(`DELETE FROM ${names.personCodes} WHERE person_id = ?`, [id])
        driver.run(`DELETE FROM ${names.people} WHERE id = ?`, [id])
        event(
          id,
          'delete',
          actor,
          {
            displayName: row.display_name,
            accounts: own
              .filter((a) => a.status === 'linked')
              .map((a) => ({ platform: a.platform, nativeId: a.native_id })),
          },
          now,
        )
        return true
      })
    },

    async byAccount(platform, nativeId) {
      const a = linkedOf(platform, nativeId)
      const p = a === undefined ? undefined : person(a.person_id)
      return a === undefined || p === undefined
        ? undefined
        : { person: toPerson(p), account: toAccount(a) }
    },

    async accounts(personId, includeRevoked = false) {
      return driver
        .query<AccountRow>(
          `SELECT * FROM ${names.personAccounts}
           WHERE person_id = ? ${includeRevoked ? '' : "AND status = 'linked'"}
           ORDER BY linked_at, rowid`,
          [personId],
        )
        .map(toAccount)
    },

    async link(personId, input, via, actor, now) {
      return driver.transaction(() => {
        need(personId)
        const existing = linkedOf(input.platform, input.nativeId)
        if (existing !== undefined) {
          if (existing.person_id !== personId) {
            const other = person(existing.person_id)
            throw new IdentityError(
              `That ${input.platform} account already belongs to ${other?.display_name ?? 'another person'}. Unlink it there first.`,
              'ACCOUNT_LINKED_ELSEWHERE',
            )
          }
          if (input.label !== undefined && input.label !== existing.label) {
            const label = input.label?.trim().slice(0, 120) || null
            driver.run(`UPDATE ${names.personAccounts} SET label = ? WHERE id = ?`, [
              label,
              existing.id,
            ])
            event(existing.person_id, 'update', actor, { account: existing.id, label }, now)
            return toAccount(account(existing.id) as AccountRow)
          }
          return toAccount(existing)
        }
        const id = ids.next()
        driver.run(
          `INSERT INTO ${names.personAccounts} (id, person_id, platform, native_id, label, status,
             linked_via, linked_by, linked_at) VALUES (?, ?, ?, ?, ?, 'linked', ?, ?, ?)`,
          [
            id,
            personId,
            input.platform,
            input.nativeId,
            input.label?.trim().slice(0, 120) || null,
            via,
            actor,
            now,
          ],
        )
        touch(personId, now)
        event(
          personId,
          'link',
          actor,
          { platform: input.platform, nativeId: input.nativeId, via },
          now,
        )
        return toAccount(account(id) as AccountRow)
      })
    },

    async unlink(accountId, actor, now) {
      return driver.transaction(() => {
        const a = account(accountId)
        if (a === undefined || a.status === 'revoked') return undefined
        driver.run(
          `UPDATE ${names.personAccounts} SET status = 'revoked', revoked_at = ? WHERE id = ?`,
          [now, accountId],
        )
        touch(a.person_id, now)
        event(a.person_id, 'unlink', actor, { platform: a.platform, nativeId: a.native_id }, now)
        return toAccount(account(accountId) as AccountRow)
      })
    },

    async setLabel(accountId, label, actor, now) {
      return driver.transaction(() => {
        const a = account(accountId)
        if (a === undefined) return undefined
        const next = label?.trim().slice(0, 120) || null
        driver.run(`UPDATE ${names.personAccounts} SET label = ? WHERE id = ?`, [next, accountId])
        event(a.person_id, 'update', actor, { account: accountId, label: next }, now)
        return toAccount(account(accountId) as AccountRow)
      })
    },

    async events(personId, limit = 50) {
      return driver
        .query<{
          seq: number
          kind: string
          actor: string | null
          detail: string
          at: number
        }>(
          `SELECT seq, kind, actor, detail, at FROM ${names.personEvents}
           WHERE person_id = ? ORDER BY at DESC, seq DESC LIMIT ?`,
          [personId, clamp(limit, 1, 500)],
        )
        .map(
          (r): PersonEvent => ({
            id: String(r.seq),
            personId,
            kind: r.kind,
            actor: r.actor,
            detail: JSON.parse(r.detail) as Record<string, unknown>,
            at: r.at,
          }),
        )
    },

    async issueCode(personId, now, ttlMs = DEFAULT_CODE_TTL_MS) {
      // hashing is async, the transaction is not: draw and hash the code first
      const code = generatePairingCode()
      const hash = await hashPairingCode(code)
      return driver.transaction(() => {
        if (person(personId) === undefined) return { error: 'No such person.' }
        const pending = Number(
          one<{ n: number }>(
            driver,
            `SELECT count(*) AS n FROM ${names.personCodes}
             WHERE person_id = ? AND used_at IS NULL AND expires_at > ?`,
            [personId, now],
          )?.n ?? 0,
        )
        if (pending >= MAX_PENDING_CODES) {
          return {
            error: `There are already ${MAX_PENDING_CODES} unused codes for this person; use one or wait until they expire.`,
          }
        }
        const expiresAt = now + ttlMs
        driver.run(
          `INSERT INTO ${names.personCodes} (hash, person_id, expires_at, created_at) VALUES (?, ?, ?, ?)`,
          [hash, personId, expiresAt, now],
        )
        event(personId, 'pair', null, { issued: true, expiresAt }, now)
        return { code, expiresAt }
      })
    },

    async redeemCode(code, now) {
      const hash = await hashPairingCode(code)
      const params: SqlParam[] = [now, hash, now]
      const claimed = driver.query<{ person_id: string }>(
        `UPDATE ${names.personCodes} SET used_at = ?
         WHERE hash = ? AND used_at IS NULL AND expires_at > ? RETURNING person_id`,
        params,
      )[0]
      return claimed?.person_id
    },
  }
  return store
}
