import { describe, expect, test } from 'bun:test'
import { uuidv7 } from 'eharness'
import { PersonError, sqlitePersonStore } from '../src/infra/channels/persons.ts'
import { openDatabase } from '../src/infra/db/client.ts'

const store = () => sqlitePersonStore(openDatabase(':memory:').sqlite, { next: uuidv7 })

describe('people directory (P43)', () => {
  test('one person, many accounts; an account belongs to one person only', () => {
    const s = store()
    const adi = s.create({ displayName: 'Adi Hidayat', nickname: 'Adi', role: 'member' }, 'web', 1)
    const tito = s.create({ displayName: 'Tito', role: 'owner' }, 'web', 1)
    s.link(adi.id, { platform: 'telegram', nativeId: '111', label: 'personal' }, 'owner', 'web', 2)
    s.link(
      adi.id,
      { platform: 'telegram', nativeId: '222', label: 'admin account' },
      'owner',
      'web',
      2,
    )
    s.link(adi.id, { platform: 'whatsapp', nativeId: '6281@s.whatsapp.net' }, 'owner', 'web', 2)
    expect(s.accounts(adi.id)).toHaveLength(3)
    expect(s.byAccount('telegram', '222')?.person.nickname).toBe('Adi')
    // moving an account needs an unlink first
    expect(() =>
      s.link(tito.id, { platform: 'telegram', nativeId: '111' }, 'owner', 'web', 3),
    ).toThrow(PersonError)
    const acc = s.byAccount('telegram', '111')?.account
    s.unlink(acc?.id as string, 'web', 4)
    expect(s.byAccount('telegram', '111')).toBeUndefined()
    s.link(tito.id, { platform: 'telegram', nativeId: '111' }, 'owner', 'web', 5)
    expect(s.byAccount('telegram', '111')?.person.id).toBe(tito.id)
  })

  test('search by name, nickname, field and account id; every change is an event', () => {
    const s = store()
    const adi = s.create({ displayName: 'Adi Hidayat', nickname: 'Adi' }, 'web', 1)
    s.update(adi.id, { fields: { jabatan: 'Clipper' }, role: 'member' }, 'web', 2)
    s.link(adi.id, { platform: 'telegram', nativeId: '999' }, 'owner', 'web', 3)
    expect(s.list({ q: 'hidayat' }).total).toBe(1)
    expect(s.list({ q: 'clipper' }).total).toBe(1)
    expect(s.list({ q: '999' }).total).toBe(1)
    expect(s.list({ q: 'nobody' }).total).toBe(0)
    expect(s.events(adi.id).map((e) => e.kind)).toEqual(['link', 'role', 'create'])
    // a null field value removes the key
    expect(s.update(adi.id, { fields: { jabatan: null } }, 'web', 4).fields).toEqual({})
  })

  test('pairing codes: hashed, single use, expire, at most three pending', async () => {
    const s = store()
    const adi = s.create({ displayName: 'Adi' }, 'web', 1)
    const issued = await s.issueCode(adi.id, 1000)
    if ('error' in issued) throw new Error(issued.error)
    expect(issued.code).toMatch(/^[A-HJ-NP-Z2-9]{8}$/)
    expect(await s.redeemCode('WRONGCOD', 1001)).toBeUndefined()
    expect(await s.redeemCode(issued.code.toLowerCase(), 1001)).toBe(adi.id)
    expect(await s.redeemCode(issued.code, 1002)).toBeUndefined()
    const late = await s.issueCode(adi.id, 2000, 10)
    if ('error' in late) throw new Error(late.error)
    expect(await s.redeemCode(late.code, 2011)).toBeUndefined()
    await s.issueCode(adi.id, 3000)
    await s.issueCode(adi.id, 3000)
    await s.issueCode(adi.id, 3000)
    expect('error' in (await s.issueCode(adi.id, 3000))).toBe(true)
  })
})
