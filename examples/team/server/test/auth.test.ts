import { describe, expect, test } from 'bun:test'
import { checkBearer, hostAllowed, listenConfig } from '../src/app/auth.ts'

describe('checkBearer', () => {
  test('open without a token, strict with one', () => {
    expect(checkBearer(undefined, undefined)).toBe(true)
    expect(checkBearer('secret', undefined)).toBe(false)
    expect(checkBearer('secret', 'Bearer secret')).toBe(true)
    expect(checkBearer('secret', 'Bearer secre')).toBe(false)
    expect(checkBearer('secret', 'Bearer secretXX')).toBe(false)
    expect(checkBearer('secret', 'Bearer ')).toBe(false)
  })
})

describe('listenConfig', () => {
  test('loopback by default, refuses a public bind without a token', () => {
    expect(listenConfig({}).hostname).toBe('127.0.0.1')
    expect(() => listenConfig({ TEAM_HOST: '0.0.0.0' })).toThrow(/TEAM_TOKEN/)
    expect(listenConfig({ TEAM_HOST: '0.0.0.0', TEAM_TOKEN: 't' }).hostname).toBe('0.0.0.0')
    expect(listenConfig({ TEAM_HOST: 'localhost' }).hostname).toBe('localhost')
  })
})

describe('hostAllowed', () => {
  const cfg = listenConfig({
    TEAM_TOKEN: 't',
    TEAM_PUBLIC_URL: 'https://team.example.com',
    TEAM_ALLOWED_HOSTS: 'a.test',
  })
  test('loopback and configured hosts only', () => {
    for (const h of [
      'localhost:4000',
      '127.0.0.1:4000',
      '[::1]:4000',
      'team.example.com',
      'a.test:1',
    ]) {
      expect(hostAllowed(h, cfg.allowedHosts)).toBe(true)
    }
    for (const h of ['attacker.com:4000', 'evil.localhost.attacker.com', '', undefined]) {
      expect(hostAllowed(h, cfg.allowedHosts)).toBe(false)
    }
  })
})
