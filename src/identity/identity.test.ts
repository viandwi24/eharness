import { describe, expect, test } from 'bun:test'
import { personStoreConformance } from '../testing/identity.conformance.ts'
import { memoryPersonStore } from './memory.ts'
import {
  generatePairingCode,
  hashPairingCode,
  normalizePairingCode,
  PAIRING_ALPHABET,
  pairingGuard,
} from './pairing.ts'
import { decideByRisk, resolveRole } from './roles.ts'
import { isIdentityError } from './types.ts'

describe('memoryPersonStore conformance', () => {
  for (const c of personStoreConformance(() => memoryPersonStore())) test(c.name, c.run)
})

describe('pairing', () => {
  test('codes use the unambiguous alphabet', () => {
    for (let i = 0; i < 50; i++) {
      const code = generatePairingCode()
      expect(code).toHaveLength(8)
      expect([...code].every((ch) => PAIRING_ALPHABET.includes(ch))).toBe(true)
    }
  })
  test('normalize and hash are stable', async () => {
    expect(normalizePairingCode(' ab-cd ef ')).toBe('ABCDEF')
    expect(await hashPairingCode('abcd efgh')).toBe(await hashPairingCode('ABCDEFGH'))
    expect(await hashPairingCode('ABCDEFGH')).toMatch(/^[0-9a-f]{64}$/)
  })
  test('guard locks out after maxFailures and recovers after the window', () => {
    const g = pairingGuard({ maxFailures: 2, windowMs: 1000 })
    expect(g.allowed('tg:1', 0)).toBe(true)
    g.failure('tg:1', 0)
    g.failure('tg:1', 10)
    expect(g.allowed('tg:1', 20)).toBe(false)
    expect(g.allowed('tg:2', 20)).toBe(true)
    expect(g.allowed('tg:1', 2000)).toBe(true)
    g.failure('tg:1', 2000)
    g.failure('tg:1', 2001)
    g.success('tg:1')
    expect(g.allowed('tg:1', 2002)).toBe(true)
  })
  test('link error is typed', async () => {
    const s = memoryPersonStore()
    const a = await s.create({ displayName: 'A' }, null, 1)
    const b = await s.create({ displayName: 'B' }, null, 1)
    await s.link(a.id, { platform: 'x', nativeId: '1' }, 'owner', null, 1)
    const err = await s
      .link(b.id, { platform: 'x', nativeId: '1' }, 'owner', null, 1)
      .catch((e) => e)
    expect(isIdentityError(err, 'ACCOUNT_LINKED_ELSEWHERE')).toBe(true)
  })
})

describe('resolveRole', () => {
  const person = (status: 'active' | 'suspended' | 'left', role: string | null) => ({
    status,
    role,
  })
  test('cases', () => {
    expect(resolveRole({ person: person('active', 'admin'), defaultRole: 'guest' })).toBe('admin')
    expect(resolveRole({ person: person('active', null), defaultRole: 'member' })).toBe('member')
    expect(resolveRole({ person: person('suspended', 'owner'), defaultRole: 'member' })).toBe(
      'guest',
    )
    expect(
      resolveRole({ person: person('left', 'admin'), legacyRole: 'owner', defaultRole: 'member' }),
    ).toBe('guest')
    expect(resolveRole({ person: undefined, legacyRole: 'admin', defaultRole: 'guest' })).toBe(
      'admin',
    )
    expect(resolveRole({ person: undefined, defaultRole: 'guest' })).toBe('guest')
  })
})

describe('decideByRisk', () => {
  const table: Array<[string, string | undefined, boolean]> = [
    ['owner', 'destructive', true],
    ['admin', 'external', true],
    ['member', 'read', true],
    ['member', 'write', false],
    ['member', undefined, false],
    ['guest', 'read', false],
    ['custom', 'read', false],
  ]
  for (const [role, risk, allowed] of table)
    test(`${role} ${risk ?? 'unknown'} -> ${allowed}`, () => {
      const d = decideByRisk(role, risk)
      expect(d.allowed).toBe(allowed)
      expect(d.reason === undefined).toBe(allowed)
    })
  test('policy overrides: allow by name, deny wins, custom role', () => {
    const policy = {
      member: { allow: ['reminder'], deny: ['x'] },
      guest: { risks: ['read'] as const },
      ops: { risks: ['write'] as const },
    }
    expect(decideByRisk('member', 'write', policy, 'reminder').allowed).toBe(true)
    expect(decideByRisk('member', 'read', policy, 'x').allowed).toBe(false)
    expect(decideByRisk('guest', 'read', policy).allowed).toBe(true)
    expect(decideByRisk('ops', 'write', policy).allowed).toBe(true)
  })
})
