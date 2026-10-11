import { describe, expect, test } from 'bun:test'
import { checkBearer, hostAllowed, listenConfig, originAllowed } from '../src/app/auth.ts'

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
    expect(
      listenConfig({ TEAM_HOST: '0.0.0.0', TEAM_TOKEN: 'k3J9x2Qw8LmN4pRt7VzA' }).hostname,
    ).toBe('0.0.0.0')
    expect(listenConfig({ TEAM_HOST: 'localhost' }).hostname).toBe('localhost')
  })
})

describe('listenConfig token strength', () => {
  test('a non-loopback bind needs a strong token', () => {
    const bind = { TEAM_HOST: '0.0.0.0' }
    expect(() => listenConfig({ ...bind, TEAM_TOKEN: 'short' })).toThrow(/at least 16/)
    expect(() => listenConfig({ ...bind, TEAM_TOKEN: 'dev-secret-secret-secret' })).toThrow(/dev-/)
    expect(listenConfig({ ...bind, TEAM_TOKEN: 'k3J9x2Qw8LmN4pRt7VzA' }).hostname).toBe('0.0.0.0')
    // loopback keeps working with a short or empty token
    expect(listenConfig({ TEAM_TOKEN: 'dev-secret' }).hostname).toBe('127.0.0.1')
  })
})

describe('originAllowed', () => {
  const allowed = ['http://localhost:5173']
  test('state-changing requests with a foreign Origin are refused', () => {
    expect(originAllowed('POST', 'https://evil.example', allowed)).toBe(false)
    expect(originAllowed('DELETE', 'null', allowed)).toBe(false)
    expect(originAllowed('POST', 'http://localhost:5173', allowed)).toBe(true)
    expect(originAllowed('POST', undefined, allowed)).toBe(true)
    expect(originAllowed('GET', 'https://evil.example', allowed)).toBe(true)
  })
})

describe('hostAllowed', () => {
  const cfg = listenConfig({
    TEAM_TOKEN: 't',
    TEAM_HOST: '127.0.0.1',
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
