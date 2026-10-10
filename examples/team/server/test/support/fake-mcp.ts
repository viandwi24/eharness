/**
 * Tiny fake remote MCP servers for tests and manual checks (no network, no secrets).
 *
 * - `fakeMcp()`: streamable-HTTP MCP, no sign in; tools `lookup` (read-only) and `create_note`.
 * - `fakeOAuthMcp()`: the same behind OAuth 2.1: 401 + `WWW-Authenticate` with the RFC 9728
 *   metadata URL, RFC 8414 server metadata, RFC 7591 registration, `/authorize` (redirects back
 *   with a code at once), `/token`. Valid bearer token: `fake-access-token`.
 */
type Json = Record<string, unknown>

export const FAKE_TOKEN = 'fake-access-token'

function rpc(
  msg: { id?: number; method: string; params?: Json },
  tools: Json[],
  calls: string[],
): Response {
  if (msg.id === undefined) return new Response(null, { status: 202 })
  const result = ((): Json => {
    switch (msg.method) {
      case 'initialize':
        return {
          protocolVersion: msg.params?.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: 'fake-mcp', version: '1' },
        }
      case 'tools/list':
        return { tools }
      case 'tools/call': {
        calls.push(String(msg.params?.name))
        return { content: [{ type: 'text', text: 'ok' }] }
      }
      default:
        return {}
    }
  })()
  return Response.json({ jsonrpc: '2.0', id: msg.id, result })
}

const TOOLS: Json[] = [
  {
    name: 'lookup',
    description: 'Look something up.',
    inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'create_note',
    description: 'Create a note.',
    inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
  },
]

export function fakeMcp(port = 0): {
  server: ReturnType<typeof Bun.serve>
  url: string
  seen: { headers: Array<Record<string, string>>; calls: string[] }
} {
  const seen = { headers: [] as Array<Record<string, string>>, calls: [] as string[] }
  const server = Bun.serve({
    port,
    async fetch(req) {
      if (req.method !== 'POST') return new Response(null, { status: 405 })
      seen.headers.push(Object.fromEntries(req.headers))
      return rpc((await req.json()) as never, TOOLS, seen.calls)
    },
  })
  return { server, url: `http://localhost:${server.port}/mcp`, seen }
}

export function fakeOAuthMcp(port = 0): {
  server: ReturnType<typeof Bun.serve>
  url: string
  base: string
  seen: { registrations: Json[]; tokens: string[]; calls: string[] }
} {
  const seen = { registrations: [] as Json[], tokens: [] as string[], calls: [] as string[] }
  let base = ''
  const server = Bun.serve({
    port,
    async fetch(req) {
      const u = new URL(req.url)
      base = `http://localhost:${server.port}`
      const challenge = {
        'www-authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`,
      }
      if (u.pathname.startsWith('/.well-known/oauth-protected-resource')) {
        return Response.json({ resource: `${base}/mcp`, authorization_servers: [base] })
      }
      if (u.pathname.startsWith('/.well-known/oauth-authorization-server')) {
        return Response.json({
          issuer: base,
          authorization_endpoint: `${base}/authorize`,
          token_endpoint: `${base}/token`,
          registration_endpoint: `${base}/register`,
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
        })
      }
      if (u.pathname === '/register' && req.method === 'POST') {
        seen.registrations.push((await req.json()) as Json)
        return Response.json({ client_id: 'dyn-client' }, { status: 201 })
      }
      if (u.pathname === '/authorize') {
        const redirect = new URL(u.searchParams.get('redirect_uri') ?? base)
        redirect.searchParams.set('code', 'the-code')
        redirect.searchParams.set('state', u.searchParams.get('state') ?? '')
        return Response.redirect(redirect.toString(), 302)
      }
      if (u.pathname === '/token' && req.method === 'POST') {
        return Response.json({
          access_token: FAKE_TOKEN,
          token_type: 'Bearer',
          refresh_token: 'fake-refresh',
          expires_in: 3600,
        })
      }
      if (u.pathname === '/mcp') {
        const auth = req.headers.get('authorization') ?? ''
        if (auth !== `Bearer ${FAKE_TOKEN}`)
          return new Response('unauthorized', { status: 401, headers: challenge })
        seen.tokens.push(auth)
        if (req.method !== 'POST') return new Response(null, { status: 405 })
        return rpc((await req.json()) as never, TOOLS, seen.calls)
      }
      return new Response('not found', { status: 404 })
    },
  })
  base = `http://localhost:${server.port}`
  return { server, url: `${base}/mcp`, base, seen }
}
