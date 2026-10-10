/**
 * A fake OAuth / MCP discovery server behind an injectable `fetch`, for the `eharness/connectors`
 * tests only (no network). Not an entry point, not bundled.
 */

/** The fake server's knobs and records. */
export interface FakeAuthServer {
  fetch: typeof fetch
  /** Every request as `METHOD url`. */
  readonly requests: string[]
  /** Parsed bodies of the token endpoint requests. */
  readonly tokenRequests: URLSearchParams[]
  /** Parsed JSON bodies of registration requests. */
  readonly registrations: Array<Record<string, unknown>>
  /** Parsed bodies of device authorization requests. */
  readonly deviceRequests: URLSearchParams[]
  /** Make refreshes fail with `invalid_grant`. */
  rejectRefresh: boolean
  /** Device token polls answer these in order (then `authorized`). */
  devicePolls: string[]
  /** Seconds until access tokens expire. Default 3600. */
  expiresIn: number
  /** Omit the protected resource metadata (legacy MCP server). */
  noResourceMetadata: boolean
  /** Add a delay-free counter of issued tokens. */
  issued: number
}

/** A function as `typeof fetch` (Bun's type has `preconnect`). */
export function asFetch(
  fn: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
): typeof fetch {
  return Object.assign(fn, { preconnect: () => undefined }) as unknown as typeof fetch
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })

/** Create the fake server: MCP at `https://mcp.example.com/mcp`, AS at `https://auth.example.com`. */
export function fakeAuthServer(): FakeAuthServer {
  const server: FakeAuthServer = {
    requests: [],
    tokenRequests: [],
    registrations: [],
    deviceRequests: [],
    rejectRefresh: false,
    devicePolls: [],
    expiresIn: 3600,
    noResourceMetadata: false,
    issued: 0,
    fetch: asFetch(async (input, init) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      const method = init?.method ?? 'GET'
      server.requests.push(`${method} ${url}`)
      const bodyText = init?.body === undefined ? '' : String(init.body)
      if (url === 'https://mcp.example.com/mcp' && method === 'GET') {
        return new Response('unauthorized', {
          status: 401,
          headers: server.noResourceMetadata
            ? { 'www-authenticate': 'Bearer' }
            : {
                'www-authenticate':
                  'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/mcp"',
              },
        })
      }
      if (
        url === 'https://mcp.example.com/.well-known/oauth-protected-resource/mcp' &&
        !server.noResourceMetadata
      ) {
        return json({
          resource: 'https://mcp.example.com/mcp',
          authorization_servers: ['https://auth.example.com'],
          scopes_supported: ['mcp.read'],
        })
      }
      if (url === 'https://auth.example.com/.well-known/oauth-authorization-server') {
        return json({
          issuer: 'https://auth.example.com',
          authorization_endpoint: 'https://auth.example.com/authorize',
          token_endpoint: 'https://auth.example.com/token',
          registration_endpoint: 'https://auth.example.com/register',
          code_challenge_methods_supported: ['S256'],
        })
      }
      if (url === 'https://auth.example.com/register' && method === 'POST') {
        server.registrations.push(JSON.parse(bodyText) as Record<string, unknown>)
        return json({ client_id: 'dcr-client' }, 201)
      }
      if (url === 'https://auth.example.com/token' && method === 'POST') {
        const params = new URLSearchParams(bodyText)
        server.tokenRequests.push(params)
        const grant = params.get('grant_type')
        if (grant === 'authorization_code') {
          if (params.get('code') !== 'good-code') return json({ error: 'invalid_grant' }, 400)
          server.issued++
          return json({
            access_token: `access-${server.issued}`,
            token_type: 'Bearer',
            refresh_token: `refresh-${server.issued}`,
            expires_in: server.expiresIn,
          })
        }
        if (grant === 'refresh_token') {
          if (server.rejectRefresh) {
            return json({ error: 'invalid_grant', error_description: 'refresh token revoked' }, 400)
          }
          server.issued++
          return json({
            access_token: `access-${server.issued}`,
            token_type: 'Bearer',
            refresh_token: `refresh-${server.issued}`,
            expires_in: server.expiresIn,
          })
        }
        if (grant === 'urn:ietf:params:oauth:grant-type:device_code') {
          const next = server.devicePolls.shift() ?? 'authorized'
          if (next === 'authorized') {
            server.issued++
            return json({
              access_token: `device-access-${server.issued}`,
              token_type: 'Bearer',
              expires_in: 3600,
            })
          }
          return json({ error: next }, 400)
        }
        return json({ error: 'unsupported_grant_type' }, 400)
      }
      if (url === 'https://auth.example.com/device' && method === 'POST') {
        server.deviceRequests.push(new URLSearchParams(bodyText))
        return json({
          device_code: 'dev-code',
          user_code: 'ABCD-EFGH',
          verification_uri: 'https://auth.example.com/activate',
          verification_uri_complete: 'https://auth.example.com/activate?user_code=ABCD-EFGH',
          expires_in: 600,
          interval: 5,
        })
      }
      return new Response('not found', { status: 404 })
    }),
  }
  return server
}
