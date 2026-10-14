import { assertJsonEqual, assertTrue } from './assert.ts'
import type { ConformanceCase } from './types.ts'

/** Structural shape of a person (`eharness/identity` `Person`). */
interface PersonLike {
  id: string
  displayName: string
  status: string
  role: string | null
  fields: Record<string, string>
  divisions: string[]
}
interface AccountLike {
  id: string
  personId: string
  platform: string
  nativeId: string
  label: string | null
  status: string
}

/** Structural shape of a `PersonStore` (`eharness/identity`). */
export interface PersonStoreUnderTest {
  get(id: string): Promise<PersonLike | undefined>
  list(query?: {
    q?: string
    limit?: number
    offset?: number
  }): Promise<{ items: PersonLike[]; total: number }>
  create(
    input: Record<string, unknown> & { displayName: string },
    actor: string | null,
    now: number,
  ): Promise<PersonLike>
  update(
    id: string,
    patch: Record<string, unknown>,
    actor: string | null,
    now: number,
  ): Promise<PersonLike>
  delete(id: string, actor: string | null, now: number): Promise<boolean>
  byAccount(
    platform: string,
    nativeId: string,
  ): Promise<{ person: PersonLike; account: AccountLike } | undefined>
  accounts(personId: string, includeRevoked?: boolean): Promise<AccountLike[]>
  link(
    personId: string,
    account: { platform: string; nativeId: string; label?: string | null },
    via: string,
    actor: string | null,
    now: number,
  ): Promise<AccountLike>
  unlink(accountId: string, actor: string | null, now: number): Promise<AccountLike | undefined>
  setLabel(
    accountId: string,
    label: string | null,
    actor: string | null,
    now: number,
  ): Promise<AccountLike | undefined>
  events(personId: string, limit?: number): Promise<Array<{ kind: string }>>
  issueCode(
    personId: string,
    now: number,
    ttlMs?: number,
  ): Promise<{ code: string; expiresAt: number } | { error: string }>
  redeemCode(code: string, now: number): Promise<string | undefined>
}

const T = 1_790_000_000_000

async function rejectsWith(p: Promise<unknown>, code: string): Promise<void> {
  try {
    await p
  } catch (e) {
    assertTrue(
      (e as { code?: string }).code === code,
      `expected code ${code}, got ${String((e as { code?: string }).code)}`,
    )
    return
  }
  throw new Error(`expected rejection with ${code}`)
}

/**
 * Conformance cases for a `PersonStore` (`eharness/identity`): create/update/fields merge, list
 * and search, account linking rules, unlink, delete with audit trail and pairing codes.
 *
 * @see docs/specs/30-identity.md#3-personstore
 */
export function personStoreConformance(
  factory: () => PersonStoreUnderTest | Promise<PersonStoreUnderTest>,
): ConformanceCase[] {
  const c = (title: string, run: (s: PersonStoreUnderTest) => Promise<void>): ConformanceCase => ({
    name: `PersonStore: ${title}`,
    run: async () => run(await factory()),
  })
  return [
    c('create then get; unknown id is undefined', async (s) => {
      const p = await s.create({ displayName: 'Ana', role: 'admin' }, 'owner', T)
      assertJsonEqual((await s.get(p.id))?.displayName, 'Ana', 'name')
      assertJsonEqual((await s.get(p.id))?.role, 'admin', 'role')
      assertTrue((await s.get('nope')) === undefined, 'unknown')
    }),
    c('update merges fields and null removes a key; unknown id rejects', async (s) => {
      const p = await s.create({ displayName: 'Ana', fields: { a: '1', b: '2' } }, null, T)
      const u = await s.update(
        p.id,
        { fields: { b: null, c: '3' }, status: 'suspended' },
        null,
        T + 1,
      )
      assertJsonEqual(u.fields, { a: '1', c: '3' }, 'fields')
      assertJsonEqual(u.status, 'suspended', 'status')
      await rejectsWith(s.update('nope', { notes: 'x' }, null, T), 'PERSON_NOT_FOUND')
    }),
    c('list filters by q, pages and reports total', async (s) => {
      await s.create({ displayName: 'Ana' }, null, T)
      await s.create({ displayName: 'Budi', fields: { team: 'ops' } }, null, T + 1)
      await s.create({ displayName: 'Cici' }, null, T + 2)
      const all = await s.list()
      assertJsonEqual(all.total, 3, 'total')
      assertJsonEqual(
        (await s.list({ q: 'ops' })).items.map((p) => p.displayName),
        ['Budi'],
        'q',
      )
      const page = await s.list({ limit: 1, offset: 1 })
      assertJsonEqual([page.items.length, page.total], [1, 3], 'page')
    }),
    c('link, byAccount and accounts', async (s) => {
      const p = await s.create({ displayName: 'Ana' }, null, T)
      const a = await s.link(
        p.id,
        { platform: 'telegram', nativeId: '42', label: '@ana' },
        'owner',
        'o',
        T,
      )
      assertJsonEqual(a.status, 'linked', 'status')
      assertJsonEqual((await s.byAccount('telegram', '42'))?.person.id, p.id, 'byAccount')
      assertTrue((await s.byAccount('slack', '42')) === undefined, 'platform scoped')
      assertJsonEqual((await s.accounts(p.id)).length, 1, 'accounts')
    }),
    c('linking an account owned by another person rejects ACCOUNT_LINKED_ELSEWHERE', async (s) => {
      const a = await s.create({ displayName: 'Ana' }, null, T)
      const b = await s.create({ displayName: 'Budi' }, null, T)
      await s.link(a.id, { platform: 'telegram', nativeId: '42' }, 'owner', null, T)
      await rejectsWith(
        s.link(b.id, { platform: 'telegram', nativeId: '42' }, 'owner', null, T),
        'ACCOUNT_LINKED_ELSEWHERE',
      )
      assertJsonEqual((await s.byAccount('telegram', '42'))?.person.id, a.id, 'unchanged')
    }),
    c('re-linking to the same person only updates the label', async (s) => {
      const p = await s.create({ displayName: 'Ana' }, null, T)
      const first = await s.link(
        p.id,
        { platform: 'telegram', nativeId: '42', label: 'a' },
        'owner',
        null,
        T,
      )
      const again = await s.link(
        p.id,
        { platform: 'telegram', nativeId: '42', label: 'b' },
        'pairing',
        null,
        T + 1,
      )
      assertJsonEqual(again.id, first.id, 'same account')
      assertJsonEqual(again.label, 'b', 'label')
      assertJsonEqual((await s.accounts(p.id)).length, 1, 'one account')
    }),
    c('unlink revokes, frees the account and keeps it in includeRevoked', async (s) => {
      const a = await s.create({ displayName: 'Ana' }, null, T)
      const b = await s.create({ displayName: 'Budi' }, null, T)
      const acc = await s.link(a.id, { platform: 'telegram', nativeId: '42' }, 'owner', null, T)
      assertJsonEqual((await s.unlink(acc.id, null, T + 1))?.status, 'revoked', 'revoked')
      assertTrue((await s.unlink(acc.id, null, T + 2)) === undefined, 'idempotent')
      assertTrue((await s.byAccount('telegram', '42')) === undefined, 'not resolvable')
      assertJsonEqual((await s.accounts(a.id)).length, 0, 'linked only')
      assertJsonEqual((await s.accounts(a.id, true)).length, 1, 'with revoked')
      await s.link(b.id, { platform: 'telegram', nativeId: '42' }, 'owner', null, T + 3)
      assertJsonEqual((await s.byAccount('telegram', '42'))?.person.id, b.id, 'relinked elsewhere')
    }),
    c('setLabel updates the label', async (s) => {
      const p = await s.create({ displayName: 'Ana' }, null, T)
      const acc = await s.link(p.id, { platform: 'telegram', nativeId: '42' }, 'owner', null, T)
      assertJsonEqual((await s.setLabel(acc.id, 'work', null, T + 1))?.label, 'work', 'label')
      assertTrue((await s.setLabel('nope', 'x', null, T)) === undefined, 'unknown')
    }),
    c('delete removes person and accounts but keeps events with a delete event', async (s) => {
      const p = await s.create({ displayName: 'Ana' }, null, T)
      await s.link(p.id, { platform: 'telegram', nativeId: '42' }, 'owner', null, T)
      assertTrue(await s.delete(p.id, 'o', T + 1), 'deleted')
      assertTrue(!(await s.delete(p.id, 'o', T + 2)), 'second delete is false')
      assertTrue((await s.get(p.id)) === undefined, 'gone')
      assertTrue((await s.byAccount('telegram', '42')) === undefined, 'account gone')
      const kinds = (await s.events(p.id)).map((e) => e.kind)
      assertTrue(
        kinds.includes('create') && kinds.includes('link') && kinds.includes('delete'),
        `events ${kinds.join(',')}`,
      )
    }),
    c('events record changes newest first', async (s) => {
      const p = await s.create({ displayName: 'Ana' }, null, T)
      await s.update(p.id, { role: 'admin' }, 'o', T + 1)
      assertJsonEqual((await s.events(p.id))[0]?.kind, 'role', 'newest')
    }),
    c('pairing code is 8 chars, single use, normalized', async (s) => {
      const p = await s.create({ displayName: 'Ana' }, null, T)
      const r = await s.issueCode(p.id, T)
      assertTrue('code' in r, 'issued')
      if (!('code' in r)) return
      assertJsonEqual(r.code.length, 8, 'length')
      const typed = `${r.code.slice(0, 4).toLowerCase()}-${r.code.slice(4)}`
      assertJsonEqual(await s.redeemCode(typed, T + 1), p.id, 'redeem')
      assertTrue((await s.redeemCode(r.code, T + 2)) === undefined, 'single use')
    }),
    c('pairing code expires and unknown codes fail', async (s) => {
      const p = await s.create({ displayName: 'Ana' }, null, T)
      const r = await s.issueCode(p.id, T, 1000)
      if (!('code' in r)) throw new Error('not issued')
      assertTrue((await s.redeemCode(r.code, T + 1000)) === undefined, 'expired')
      assertTrue((await s.redeemCode('ZZZZZZZZ', T)) === undefined, 'unknown')
      assertTrue('error' in (await s.issueCode('nope', T)), 'unknown person')
    }),
    c('at most 3 pending codes per person', async (s) => {
      const p = await s.create({ displayName: 'Ana' }, null, T)
      for (let i = 0; i < 3; i++) assertTrue('code' in (await s.issueCode(p.id, T)), `issue ${i}`)
      assertTrue('error' in (await s.issueCode(p.id, T)), 'fourth refused')
      assertTrue('code' in (await s.issueCode(p.id, T + 3_600_001)), 'after expiry')
    }),
    c('concurrent redeem of one code succeeds once', async (s) => {
      const p = await s.create({ displayName: 'Ana' }, null, T)
      const r = await s.issueCode(p.id, T)
      if (!('code' in r)) throw new Error('not issued')
      const results = await Promise.all([s.redeemCode(r.code, T + 1), s.redeemCode(r.code, T + 1)])
      assertJsonEqual(results.filter((x) => x !== undefined).length, 1, 'winners')
    }),
  ]
}
