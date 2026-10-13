/** Password login (`BASIC_AUTH_PASSWORD`): session cookie, throttle, protected routes (no network). */
import { afterEach, describe, expect, test } from 'bun:test'
import { listenConfig } from '../src/app/auth.ts'
import {
  BASE_LOCKOUT_MS,
  createLoginAuth,
  createLoginThrottle,
  MAX_FAILURES,
  SESSION_MS,
} from '../src/app/login.ts'
import { scriptedModelConfig } from '../src/infra/eh/provider.ts'
import { compose, type Server } from '../src/main.ts'

describe('session token', () => {
  test('verifies, expires after 30 days and rejects tampering', async () => {
    let t = 1_000_000
    const auth = createLoginAuth({ password: 'pw-long-enough', secret: 's', now: () => t })
    const { token, expiresAt } = await auth.issue()
    expect(expiresAt).toBe(t + SESSION_MS)
    expect(await auth.verify(token)).toBe(true)
    expect(await auth.verify(undefined)).toBe(false)
    expect(await auth.verify('garbage')).toBe(false)
    const [payload, sig] = token.split('.') as [string, string]
    const forged = btoa(JSON.stringify({ iat: t, exp: t + 10 * SESSION_MS }))
      .replace(/=+$/, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
    expect(await auth.verify(`${forged}.${sig}`)).toBe(false)
    expect(await auth.verify(`${payload}.${sig.slice(0, -2)}AA`)).toBe(false)
    t += SESSION_MS - 1
    expect(await auth.verify(token)).toBe(true)
    t += 2
    expect(await auth.verify(token)).toBe(false)
  })

  test('a changed password or secret invalidates sessions', async () => {
    const a = createLoginAuth({ password: 'one-long-password', secret: 's' })
    const { token } = await a.issue()
    expect(
      await createLoginAuth({ password: 'two-long-password', secret: 's' }).verify(token),
    ).toBe(false)
    expect(
      await createLoginAuth({ password: 'one-long-password', secret: 'x' }).verify(token),
    ).toBe(false)
    expect(await a.checkPassword('one-long-password')).toBe(true)
    expect(await a.checkPassword('one-long-passwor')).toBe(false)
  })
})

describe('throttle', () => {
  test('locks out after 5 failures with a growing delay, success resets', () => {
    let t = 0
    const th = createLoginThrottle(() => t)
    for (let i = 0; i < MAX_FAILURES - 1; i++) {
      th.failure('a')
      expect(th.retryAfter('a')).toBe(0)
    }
    th.failure('a')
    expect(th.retryAfter('a')).toBe(BASE_LOCKOUT_MS / 1000)
    expect(th.retryAfter('b')).toBe(0)
    t += BASE_LOCKOUT_MS
    expect(th.retryAfter('a')).toBe(0)
    th.failure('a')
    expect(th.retryAfter('a')).toBe((BASE_LOCKOUT_MS * 2) / 1000)
    th.success('a')
    expect(th.retryAfter('a')).toBe(0)
  })
})

describe('listenConfig with a login password', () => {
  test('the password can guard a non-loopback bind when long enough', () => {
    const bind = { TEAM_HOST: '0.0.0.0' }
    expect(() => listenConfig({ ...bind, BASIC_AUTH_PASSWORD: 'short' })).toThrow(/at least 12/)
    expect(listenConfig({ ...bind, BASIC_AUTH_PASSWORD: 'a-long-password-1' }).hostname).toBe(
      '0.0.0.0',
    )
    expect(() => listenConfig(bind)).toThrow(/BASIC_AUTH_PASSWORD/)
  })
})

let server: Server | undefined
afterEach(async () => {
  await server?.close()
  server = undefined
})

const PASSWORD = 'correct horse battery'

function boot(opts: { token?: string; password?: string } = {}): Server {
  server = compose({
    dbFile: ':memory:',
    ...(opts.token === undefined ? {} : { token: opts.token }),
    loginPassword: opts.password,
    models: scriptedModelConfig('x' as never),
  })
  return server
}

const post = (body: unknown, headers: Record<string, string> = {}): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body),
})

async function signIn(app: Server['app']): Promise<string> {
  const res = await app.request('/auth/login', post({ password: PASSWORD }))
  expect(res.status).toBe(200)
  const cookie = res.headers.get('set-cookie') ?? ''
  expect(cookie).toContain('team_session=')
  expect(cookie).toMatch(/HttpOnly/i)
  expect(cookie).toMatch(/SameSite=Lax/i)
  expect(cookie).toMatch(/Path=\//)
  return cookie.split(';')[0] as string
}

describe('login routes', () => {
  test('without a password nothing changes and the session probe says so', async () => {
    const { app } = boot()
    expect((await app.request('/agents')).status).toBe(200)
    expect(await (await app.request('/auth/session')).json()).toEqual({
      required: false,
      authenticated: true,
    })
    expect((await app.request('/auth/login', post({ password: 'x' }))).status).toBe(404)
    expect((await app.request('/docs')).status).toBe(200)
  })

  test('every route needs a session; exempt routes stay open; docs and openapi are protected', async () => {
    const { app } = boot({ password: PASSWORD })
    for (const path of [
      '/agents',
      '/docs',
      '/openapi.json',
      '/oauth/callback',
      '/activity/stream',
    ]) {
      const res = await app.request(path)
      expect(res.status).toBe(401)
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('AUTH_REQUIRED')
    }
    expect((await app.request('/health')).status).toBe(200)
    expect(await (await app.request('/auth/session')).json()).toEqual({
      required: true,
      authenticated: false,
    })
  })

  test('a wrong password is 401 INVALID_PASSWORD; the right one opens routes, docs and SSE', async () => {
    const { app } = boot({ password: PASSWORD })
    const bad = await app.request('/auth/login', post({ password: 'nope' }))
    expect(bad.status).toBe(401)
    expect(((await bad.json()) as { error: { code: string } }).error.code).toBe('INVALID_PASSWORD')
    expect((await app.request('/auth/login', post({}))).status).toBe(400)

    const cookie = await signIn(app)
    const headers = { cookie }
    expect((await app.request('/agents', { headers })).status).toBe(200)
    expect((await app.request('/docs', { headers })).status).toBe(200)
    expect((await app.request('/openapi.json', { headers })).status).toBe(200)
    const stream = await app.request('/activity/stream', { headers })
    expect(stream.status).toBe(200)
    await stream.body?.cancel()
    expect(await (await app.request('/auth/session', { headers })).json()).toEqual({
      required: true,
      authenticated: true,
    })
  })

  test('the bearer token keeps working beside the login; a wrong one does not', async () => {
    const { app } = boot({ password: PASSWORD, token: 'k3J9x2Qw8LmN4pRt7VzA' })
    expect(
      (await app.request('/agents', { headers: { authorization: 'Bearer k3J9x2Qw8LmN4pRt7VzA' } }))
        .status,
    ).toBe(200)
    expect(
      (await app.request('/agents', { headers: { authorization: 'Bearer nope' } })).status,
    ).toBe(401)
  })

  test('without TEAM_TOKEN a bearer header grants nothing when login is on', async () => {
    const { app } = boot({ password: PASSWORD })
    expect((await app.request('/agents', { headers: { authorization: 'Bearer x' } })).status).toBe(
      401,
    )
  })

  test('a cookie from another password is refused; logout clears the cookie', async () => {
    const { app } = boot({ password: PASSWORD })
    const other = createLoginAuth({ password: 'another password!', secret: 'x' })
    const { token } = await other.issue()
    expect(
      (await app.request('/agents', { headers: { cookie: `team_session=${token}` } })).status,
    ).toBe(401)
    const out = await app.request('/auth/logout', { method: 'POST' })
    expect(out.status).toBe(200)
    expect(out.headers.get('set-cookie')).toMatch(/team_session=;/)
  })

  test('state-changing requests with a cookie still pass the Origin check', async () => {
    const { app } = boot({ password: PASSWORD })
    const cookie = await signIn(app)
    const res = await app.request(
      '/agents',
      post({ name: 'X', instructions: 'y' }, { cookie, origin: 'https://evil.example' }),
    )
    expect(res.status).toBe(403)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('FORBIDDEN_ORIGIN')
  })

  test('five wrong passwords lock the client out, even for the right one', async () => {
    const { app } = boot({ password: PASSWORD })
    for (let i = 0; i < MAX_FAILURES; i++) {
      expect((await app.request('/auth/login', post({ password: `bad${i}` }))).status).toBe(401)
    }
    const locked = await app.request('/auth/login', post({ password: PASSWORD }))
    expect(locked.status).toBe(429)
    expect(locked.headers.get('retry-after')).toBeTruthy()
    expect(((await locked.json()) as { error: { code: string } }).error.code).toBe('LOGIN_LOCKED')
  })
})
