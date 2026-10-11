import { describe, expect, test } from 'bun:test'
import { webCryptoVault } from '../providers/index.ts'
import { advanceFlow, completeOAuth, startFlow } from './flow.ts'
import { discoverMcpAuthorization, exchangeCode, registerClient } from './oauth.ts'
import { remoteMcpConnector } from './remote-mcp.ts'
import { createConnectorService } from './service.ts'
import {
  inMemoryConnectionStore,
  inMemoryCredentialStore,
  inMemoryEnablementStore,
  inMemoryFlowStore,
} from './store.ts'
import { asFetch, fakeAuthServer } from './test-kit.ts'
import type { ConnectionRecord, FlowDeps, FlowView } from './types.ts'

const vault = webCryptoVault(new Uint8Array(32).fill(5))
const reason = (error: unknown): unknown =>
  (error as { details?: { reason?: unknown } }).details?.reason

describe('OAuth requests: redirects and private networks', () => {
  test('a redirect to another origin is refused and never followed', async () => {
    const seen: string[] = []
    const fetchFn = asFetch(async (input, init) => {
      const url = String(input)
      seen.push(`${init?.redirect} ${url}`)
      return new Response(null, {
        status: 302,
        headers: { location: 'http://169.254.169.254/latest/meta-data' },
      })
    })
    const error = await exchangeCode({
      tokenUrl: 'https://auth.example.com/token',
      clientId: 'c',
      code: 'x',
      redirectUri: 'https://app.example.com/cb',
      codeVerifier: 'v',
      fetch: fetchFn,
    }).catch((e: unknown) => e)
    expect(reason(error)).toBe('oauth-redirect-refused')
    expect(seen).toEqual(['manual https://auth.example.com/token'])
  })

  test('a same-origin redirect is followed a few times, not forever', async () => {
    let hops = 0
    const fetchFn = asFetch(async (_input, init) => {
      hops++
      expect(init?.redirect).toBe('manual')
      return new Response(null, { status: 307, headers: { location: '/again' } })
    })
    const error = await registerClient({
      registrationEndpoint: 'https://auth.example.com/register',
      clientName: 'x',
      redirectUris: ['https://app.example.com/cb'],
      fetch: fetchFn,
    }).catch((e: unknown) => e)
    expect(reason(error)).toBe('oauth-redirect-refused')
    expect(hops).toBe(4)

    const ok = asFetch(async (input) =>
      String(input).endsWith('/token')
        ? new Response(null, { status: 307, headers: { location: '/token2' } })
        : Response.json({ access_token: 'a' }),
    )
    const tokens = await exchangeCode({
      tokenUrl: 'https://auth.example.com/token',
      clientId: 'c',
      code: 'x',
      redirectUri: 'https://app.example.com/cb',
      codeVerifier: 'v',
      fetch: ok,
    })
    expect(tokens.accessToken).toBe('a')
  })

  test('a same-origin redirect to a downgraded or private target is re-validated', async () => {
    const fetchFn = asFetch(
      async () =>
        new Response(null, { status: 307, headers: { location: 'http://auth.example.com/t' } }),
    )
    const error = await exchangeCode({
      tokenUrl: 'https://auth.example.com/token',
      clientId: 'c',
      code: 'x',
      redirectUri: 'https://app.example.com/cb',
      codeVerifier: 'v',
      fetch: fetchFn,
    }).catch((e: unknown) => e)
    expect(reason(error)).toBe('oauth-redirect-refused')
  })

  test('discovered endpoints on private ranges are refused unless the app opts in', async () => {
    const make = (tokenEndpoint: string): typeof fetch =>
      asFetch(async (input) => {
        const url = String(input)
        if (url.includes('oauth-authorization-server')) {
          return Response.json({
            issuer: 'https://auth.example.com',
            authorization_endpoint: 'https://auth.example.com/authorize',
            token_endpoint: tokenEndpoint,
          })
        }
        if (url.includes('oauth-protected-resource')) {
          return Response.json({
            resource: 'https://mcp.example.com/mcp',
            authorization_servers: ['https://auth.example.com'],
          })
        }
        return new Response('', { status: 401 })
      })
    const error = await discoverMcpAuthorization('https://mcp.example.com/mcp', {
      fetch: make('https://169.254.169.254/token'),
    }).catch((e: unknown) => e)
    expect(reason(error)).toBe('oauth-url-private')
    const allowed = await discoverMcpAuthorization('https://mcp.example.com/mcp', {
      fetch: make('https://169.254.169.254/token'),
      allowPrivateNetwork: true,
    })
    expect(allowed.server.token_endpoint).toBe('https://169.254.169.254/token')
    // a custom check replaces the default one
    const custom = await discoverMcpAuthorization('https://mcp.example.com/mcp', {
      fetch: make('https://10.1.2.3/token'),
      isAllowedUrl: (url) => url.hostname !== 'blocked.example.com',
    })
    expect(custom.server.token_endpoint).toBe('https://10.1.2.3/token')
    // a private issuer is refused before any request
    await expect(
      discoverMcpAuthorization('https://192.168.1.5/mcp', {
        fetch: make('https://a.example.com/t'),
      }),
    ).rejects.toMatchObject({ details: { reason: 'oauth-url-private' } })
  })

  test('a response above maxResponseBytes is refused', async () => {
    const big = asFetch(async () => new Response(JSON.stringify({ pad: 'x'.repeat(5000) })))
    const error = await exchangeCode({
      tokenUrl: 'https://auth.example.com/token',
      clientId: 'c',
      code: 'x',
      redirectUri: 'https://app.example.com/cb',
      codeVerifier: 'v',
      fetch: big,
      maxResponseBytes: 1000,
    }).catch((e: unknown) => e)
    expect(reason(error)).toBe('oauth-response-too-large')
  })
})

describe('OAuth state bound to a principal', () => {
  const definition = remoteMcpConnector({ listTools: async () => [] })
  function setup() {
    const server = fakeAuthServer()
    const store = inMemoryFlowStore()
    const d: FlowDeps = {
      definitions: [definition],
      vault,
      fetch: server.fetch,
      redirectUri: 'https://app.example.com/oauth/callback',
    }
    return { server, store, d }
  }
  async function toAuthorize(principal: string | undefined) {
    const { store, d } = setup()
    const s0 = await startFlow(
      { definition, scope: 'workspace', ...(principal === undefined ? {} : { principal }) },
      d,
    )
    const r = await advanceFlow(
      s0,
      {
        viewId: s0.view.viewId,
        action: 'submit',
        data: { url: 'https://mcp.example.com/mcp', authMode: 'oauth' },
        ...(principal === undefined ? {} : { principal }),
      },
      d,
    )
    if (!r.ok) throw new Error('flow did not start')
    await store.put(r.state)
    const state = new URL(
      (r.state.view as Extract<FlowView, { type: 'oauth' }>).authorizeUrl,
    ).searchParams.get('state') as string
    return { store, d, state, flow: r.state }
  }

  test('only the starting principal can complete the callback', async () => {
    const { store, d, state, flow } = await toAuthorize('user-1')
    expect(flow.principalHash).toBeDefined()
    expect(JSON.stringify(flow)).not.toContain('user-1')
    for (const principal of [undefined, 'user-2']) {
      expect(
        await completeOAuth(
          { state, code: 'good-code', ...(principal ? { principal } : {}) },
          store,
          d,
        ),
      ).toMatchObject({ ok: false, error: 'principal-mismatch' })
    }
    // the refused attempts did not consume the state
    const done = await completeOAuth({ state, code: 'good-code', principal: 'user-1' }, store, d)
    expect(done.ok && done.state.status).toBe('done')
  })

  test('advanceFlow refuses another principal, and flows without a principal are unchanged', async () => {
    const { d, flow } = await toAuthorize('user-1')
    expect(
      await advanceFlow(flow, { viewId: flow.view.viewId, action: 'poll', principal: 'user-2' }, d),
    ).toMatchObject({ ok: false, error: 'principal-mismatch' })
    expect(
      await advanceFlow(flow, { viewId: flow.view.viewId, action: 'poll', principal: 'user-1' }, d),
    ).toMatchObject({ ok: true })
    const plain = await toAuthorize(undefined)
    expect(plain.flow.principalHash).toBeUndefined()
    const done = await completeOAuth(
      { state: plain.state, code: 'good-code', principal: 'anyone' },
      plain.store,
      plain.d,
    )
    expect(done.ok).toBe(true)
  })
})

describe('service.test error classes', () => {
  function build(credentialsGet: 'missing' | 'outage') {
    const credentials = inMemoryCredentialStore({ vault })
    const connections = inMemoryConnectionStore()
    const base = credentials.get.bind(credentials)
    const t = 1_000
    const record = {
      id: 'conn_1',
      kind: 'connection',
      definitionId: 'mcp-remote',
      label: 'Docs',
      settings: { url: 'https://mcp.example.com/mcp', authMode: 'oauth' },
      enabled: true,
      scope: 'workspace',
      status: 'connected',
      defaultEnabled: false,
      choices: {},
      createdAt: t,
      updatedAt: t,
    } as unknown as ConnectionRecord
    const warnings: unknown[] = []
    const service = createConnectorService({
      definitions: [remoteMcpConnector({ listTools: async () => [] })],
      connections,
      credentials: Object.assign(credentials, {
        get: async (id: string) => {
          if (credentialsGet === 'outage') throw new Error('database is down')
          return base(id)
        },
      }),
      enablement: inMemoryEnablementStore(),
      flows: inMemoryFlowStore(),
      vault,
      fetch: fakeAuthServer().fetch,
      onError: (e) => warnings.push(e),
    })
    return { service, connections, record, warnings }
  }

  test('no credentials: Reconnect required', async () => {
    const { service, connections, record } = build('missing')
    await connections.put(record)
    expect(await service.test('conn_1')).toEqual({ ok: false, message: 'Reconnect required.' })
  })

  test('a store outage is not a reconnect: temporarily unavailable, logged, status untouched', async () => {
    const { service, connections, record, warnings } = build('outage')
    await connections.put(record)
    const result = await service.test('conn_1')
    expect(result.ok).toBe(false)
    expect(result.message).toContain('Temporarily unavailable')
    expect(result.message).not.toContain('Reconnect')
    expect(warnings.length).toBe(1)
    expect((await connections.get('conn_1'))?.status).toBe('connected')
  })
})
