import { describe, expect, test } from 'bun:test'
import { isHarnessError } from '../index.ts'
import {
  assertSecureUrl,
  buildAuthorizationUrl,
  discoverAuthorizationServer,
  discoverMcpAuthorization,
  discoverProtectedResource,
  exchangeCode,
  generatePkce,
  generateState,
  pkceChallenge,
  pollDeviceToken,
  refreshTokens,
  registerClient,
  requestDeviceCode,
} from './oauth.ts'
import { asFetch, fakeAuthServer } from './test-kit.ts'

describe('PKCE and the authorization URL', () => {
  test('the S256 challenge matches the RFC 7636 example', async () => {
    expect(await pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    )
  })

  test('generatePkce makes a 43-character verifier and its challenge', async () => {
    const a = await generatePkce()
    const b = await generatePkce()
    expect(a.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(a.challenge).toBe(await pkceChallenge(a.verifier))
    expect(a.method).toBe('S256')
    expect(a.verifier).not.toBe(b.verifier)
    expect(generateState()).not.toBe(generateState())
  })

  test('buildAuthorizationUrl sets the code flow parameters, the resource and ignores reserved extras', () => {
    const url = new URL(
      buildAuthorizationUrl({
        authorizationUrl: 'https://auth.example.com/authorize?x=1',
        clientId: 'cid',
        redirectUri: 'https://app.example.com/cb',
        scopes: ['a', 'b'],
        state: 'st',
        codeChallenge: 'ch',
        resource: 'https://mcp.example.com/mcp',
        extra: { prompt: 'consent', state: 'evil', client_id: 'evil' },
      }),
    )
    expect(url.searchParams.get('x')).toBe('1')
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('client_id')).toBe('cid')
    expect(url.searchParams.get('redirect_uri')).toBe('https://app.example.com/cb')
    expect(url.searchParams.get('scope')).toBe('a b')
    expect(url.searchParams.get('state')).toBe('st')
    expect(url.searchParams.get('code_challenge')).toBe('ch')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('resource')).toBe('https://mcp.example.com/mcp')
    expect(url.searchParams.get('prompt')).toBe('consent')
  })

  test('assertSecureUrl accepts https and localhost http only', () => {
    expect(() => assertSecureUrl('https://a.example.com', 'x')).not.toThrow()
    expect(() => assertSecureUrl('http://localhost:3000/cb', 'x')).not.toThrow()
    expect(() => assertSecureUrl('http://a.example.com', 'x')).toThrow()
    expect(() => assertSecureUrl('nonsense', 'x')).toThrow()
    expect(() => assertSecureUrl('http://10.0.0.1', 'x', { allowInsecure: true })).not.toThrow()
  })
})

describe('discovery', () => {
  test('protected resource metadata through the 401 challenge, then the authorization server', async () => {
    const server = fakeAuthServer()
    const found = await discoverMcpAuthorization('https://mcp.example.com/mcp', {
      fetch: server.fetch,
    })
    expect(found.resource).toBe('https://mcp.example.com/mcp')
    expect(found.server.token_endpoint).toBe('https://auth.example.com/token')
    expect(found.server.registration_endpoint).toBe('https://auth.example.com/register')
    expect(found.scopes).toEqual(['mcp.read'])
    expect(server.requests[0]).toBe('GET https://mcp.example.com/mcp')
    expect(server.requests).toContain(
      'GET https://mcp.example.com/.well-known/oauth-protected-resource/mcp',
    )
  })

  test('a server without resource metadata is its own authorization server (legacy)', async () => {
    const server = fakeAuthServer()
    server.noResourceMetadata = true
    expect(
      await discoverProtectedResource('https://mcp.example.com/mcp', { fetch: server.fetch }),
    ).toBeUndefined()
  })

  test('resource metadata naming another origin is rejected', async () => {
    const fetchFn = asFetch(async (input) => {
      const url = String(input)
      if (url.includes('oauth-protected-resource')) {
        return new Response(JSON.stringify({ resource: 'https://evil.example.com/mcp' }), {
          status: 200,
        })
      }
      return new Response('', { status: 404 })
    })
    await expect(
      discoverProtectedResource('https://mcp.example.com/mcp', { fetch: fetchFn }),
    ).rejects.toMatchObject({
      details: { reason: 'oauth-resource-mismatch' },
    })
  })

  test('authorization server metadata with a different issuer or without S256 is rejected', async () => {
    const make = (body: Record<string, unknown>): typeof fetch =>
      asFetch(async (input) =>
        String(input).includes('oauth-authorization-server')
          ? new Response(JSON.stringify(body), { status: 200 })
          : new Response('', { status: 404 }),
      )
    const base = {
      authorization_endpoint: 'https://auth.example.com/authorize',
      token_endpoint: 'https://auth.example.com/token',
    }
    await expect(
      discoverAuthorizationServer('https://auth.example.com', {
        fetch: make({ ...base, issuer: 'https://other.example.com' }),
      }),
    ).rejects.toMatchObject({ details: { reason: 'oauth-issuer-mismatch' } })
    await expect(
      discoverAuthorizationServer('https://auth.example.com', {
        fetch: make({
          ...base,
          issuer: 'https://auth.example.com',
          code_challenge_methods_supported: ['plain'],
        }),
      }),
    ).rejects.toMatchObject({ details: { reason: 'oauth-no-pkce' } })
    await expect(
      discoverAuthorizationServer('https://nothing.example.com', { fetch: make({}) }),
    ).rejects.toMatchObject({ details: { reason: 'oauth-discovery-failed' } })
  })

  test('insecure discovery URLs are refused', async () => {
    const error = await discoverAuthorizationServer('http://auth.example.com', {
      fetch: fakeAuthServer().fetch,
    }).catch((e) => e)
    expect(isHarnessError(error, 'EH_CONFIG_INVALID')).toBe(true)
  })
})

describe('registration, code exchange and refresh', () => {
  test('registerClient registers a public client with the redirect URI', async () => {
    const server = fakeAuthServer()
    const client = await registerClient({
      registrationEndpoint: 'https://auth.example.com/register',
      clientName: 'My app',
      redirectUris: ['https://app.example.com/cb'],
      scopes: ['a'],
      fetch: server.fetch,
    })
    expect(client).toEqual({ clientId: 'dcr-client', dynamic: true })
    expect(server.registrations[0]).toMatchObject({
      client_name: 'My app',
      redirect_uris: ['https://app.example.com/cb'],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
    })
  })

  test('exchangeCode sends the verifier and the resource and returns tokens with an expiry', async () => {
    const server = fakeAuthServer()
    const tokens = await exchangeCode({
      tokenUrl: 'https://auth.example.com/token',
      clientId: 'cid',
      code: 'good-code',
      redirectUri: 'https://app.example.com/cb',
      codeVerifier: 'verifier-123',
      resource: 'https://mcp.example.com/mcp',
      fetch: server.fetch,
      now: () => 1_000_000,
    })
    expect(tokens).toEqual({
      accessToken: 'access-1',
      tokenType: 'Bearer',
      refreshToken: 'refresh-1',
      expiresAt: 1_000_000 + 3_600_000,
    })
    const body = server.tokenRequests[0] as URLSearchParams
    expect(body.get('grant_type')).toBe('authorization_code')
    expect(body.get('code_verifier')).toBe('verifier-123')
    expect(body.get('resource')).toBe('https://mcp.example.com/mcp')
    expect(body.get('client_id')).toBe('cid')
    expect(body.get('client_secret')).toBeNull()
  })

  test('exchangeCode with a secret uses the post or basic method and never echoes secrets in errors', async () => {
    const server = fakeAuthServer()
    const error = await exchangeCode({
      tokenUrl: 'https://auth.example.com/token',
      clientId: 'cid',
      clientSecret: 'topsecret',
      code: 'bad-code',
      redirectUri: 'https://app.example.com/cb',
      codeVerifier: 'v',
      fetch: server.fetch,
    }).catch((e) => e)
    const text = JSON.stringify({ message: error.message, details: error.details })
    expect(text).not.toContain('topsecret')
    expect(text).not.toContain('bad-code')
    expect(text).toContain('invalid_grant')
    expect((server.tokenRequests[0] as URLSearchParams).get('client_secret')).toBe('topsecret')

    const seen: Array<Record<string, string>> = []
    const basic = asFetch(async (_input, init) => {
      seen.push(init?.headers as Record<string, string>)
      return new Response(JSON.stringify({ access_token: 'a', token_type: 'bearer' }), {
        status: 200,
      })
    })
    await exchangeCode({
      tokenUrl: 'https://auth.example.com/token',
      clientId: 'cid',
      clientSecret: 's',
      method: 'basic',
      code: 'c',
      redirectUri: 'https://app.example.com/cb',
      codeVerifier: 'v',
      fetch: basic,
    })
    expect(seen[0]?.authorization).toBe(`Basic ${btoa('cid:s')}`)
  })

  test('refreshTokens keeps the old refresh token when none is returned and reports invalid_grant', async () => {
    const calls: URLSearchParams[] = []
    const noRotate = asFetch(async (_input, init) => {
      calls.push(new URLSearchParams(String(init?.body)))
      return new Response(
        JSON.stringify({ access_token: 'new', token_type: 'Bearer', expires_in: 60 }),
        { status: 200 },
      )
    })
    const tokens = await refreshTokens({
      tokenUrl: 'https://auth.example.com/token',
      clientId: 'cid',
      refreshToken: 'old-refresh',
      resource: 'https://mcp.example.com/mcp',
      fetch: noRotate,
      now: () => 0,
    })
    expect(tokens).toEqual({
      accessToken: 'new',
      tokenType: 'Bearer',
      refreshToken: 'old-refresh',
      expiresAt: 60_000,
    })
    expect(calls[0]?.get('resource')).toBe('https://mcp.example.com/mcp')

    const server = fakeAuthServer()
    server.rejectRefresh = true
    await expect(
      refreshTokens({
        tokenUrl: 'https://auth.example.com/token',
        clientId: 'cid',
        refreshToken: 'r',
        fetch: server.fetch,
      }),
    ).rejects.toMatchObject({ details: { oauthError: 'invalid_grant' } })
  })
})

describe('device authorization grant', () => {
  test('requestDeviceCode returns the codes and the polling interval', async () => {
    const server = fakeAuthServer()
    const started = await requestDeviceCode({
      deviceAuthorizationUrl: 'https://auth.example.com/device',
      clientId: 'cid',
      scopes: ['read'],
      fetch: server.fetch,
      now: () => 10_000,
    })
    expect(started).toEqual({
      deviceCode: 'dev-code',
      userCode: 'ABCD-EFGH',
      verificationUrl: 'https://auth.example.com/activate',
      verificationUrlComplete: 'https://auth.example.com/activate?user_code=ABCD-EFGH',
      expiresAt: 10_000 + 600_000,
      intervalMs: 5000,
    })
    expect(server.deviceRequests[0]?.get('scope')).toBe('read')
  })

  test('pollDeviceToken maps pending, slow_down, denied, expired and authorized', async () => {
    const server = fakeAuthServer()
    server.devicePolls = ['authorization_pending', 'slow_down', 'access_denied', 'expired_token']
    const poll = (intervalMs: number) =>
      pollDeviceToken({
        tokenUrl: 'https://auth.example.com/token',
        clientId: 'cid',
        deviceCode: 'dev-code',
        intervalMs,
        fetch: server.fetch,
      })
    expect(await poll(5000)).toEqual({ status: 'pending', intervalMs: 5000 })
    expect(await poll(5000)).toEqual({ status: 'pending', intervalMs: 10_000 })
    expect(await poll(5000)).toEqual({ status: 'denied' })
    expect(await poll(5000)).toEqual({ status: 'expired' })
    const ok = await poll(5000)
    expect(ok.status).toBe('authorized')
    expect((server.tokenRequests[0] as URLSearchParams).get('grant_type')).toBe(
      'urn:ietf:params:oauth:grant-type:device_code',
    )
  })
})
