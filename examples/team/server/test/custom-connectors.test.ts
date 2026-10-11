/**
 * Custom connectors ("Add custom connector", like Claude): probe a URL, add a named connector
 * (no sign in / sign in when needed / sign in now), several side by side with distinct tool
 * prefixes that survive a rename, secrets sealed, and the migration of older custom connections.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scriptedModel } from 'eharness/testing'
import { scriptedModelConfig } from '../src/infra/eh/provider.ts'
import { compose, type Server } from '../src/main.ts'
import { fakeMcp, fakeOAuthMcp } from './support/fake-mcp.ts'

// biome-ignore lint/suspicious/noExplicitAny: loosely typed JSON of the API under test
type Json = Record<string, any>
const dirs: string[] = []
const servers: Server[] = []
const stops: Array<() => void> = []
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close()
  for (const stop of stops.splice(0)) stop()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const tmpDb = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'team-custom-'))
  dirs.push(d)
  return join(d, 'team.db')
}
const key = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64')
async function boot(dbFile = ':memory:', seed = true): Promise<Server> {
  const server = compose({
    dbFile,
    models: scriptedModelConfig(scriptedModel([]) as never),
    env: { TEAM_SECRET_KEY: key, TEAM_ALLOW_PRIVATE_MCP: '1' },
    changePollMs: 0,
    seed,
    publicUrl: 'http://api.test',
    webUrl: 'http://web.test',
    reconcile: { onBoot: false, everyMs: 0 },
    routines: { tickMs: 0 },
  })
  servers.push(server)
  await server.connectorsReady
  return server
}
const call = async (server: Server, method: string, path: string, body?: unknown) => {
  const res = await server.app.request(path, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await res.text()
  return { status: res.status, text, json: (text ? JSON.parse(text) : undefined) as Json }
}
const plain = () => {
  const m = fakeMcp()
  stops.push(() => m.server.stop(true))
  return m
}
const oauth = () => {
  const m = fakeOAuthMcp()
  stops.push(() => m.server.stop(true))
  return m
}

/** Complete an OAuth flow view against the fake server: authorize, then the app's callback. */
async function signIn(server: Server, flow: Json): Promise<Json> {
  expect(flow.view.type).toBe('oauth')
  const authorize = await fetch(flow.view.authorizeUrl, { redirect: 'manual' })
  const back = new URL(authorize.headers.get('location') as string)
  const cb = await server.app.request(`/oauth/callback${back.search}`, { redirect: 'manual' })
  expect(cb.headers.get('location')).toBe(`http://web.test/connectors?flow=${flow.id}`)
  return (await call(server, 'GET', `/connections/flows/${flow.id}`)).json
}

describe('probe', () => {
  test('no sign in, OAuth (discovered, dynamic registration) and unreachable', async () => {
    const server = await boot()
    const open = plain()
    const none = await call(server, 'POST', '/connectors/custom/probe', { url: open.url })
    expect(none.json).toMatchObject({ detected: 'none', serverName: 'fake-mcp', tools: 2 })

    const secured = oauth()
    const need = await call(server, 'POST', '/connectors/custom/probe', { url: secured.url })
    expect(need.json).toMatchObject({
      detected: 'oauth',
      oauth: { discovered: true, issuer: secured.base, dynamicRegistration: true },
    })

    const dead = await call(server, 'POST', '/connectors/custom/probe', {
      url: 'http://localhost:1/mcp',
    })
    expect(dead.json.detected).toBe('unknown')
    // https only (localhost excepted)
    expect(
      (await call(server, 'POST', '/connectors/custom/probe', { url: 'http://example.com/mcp' }))
        .status,
    ).toBe(400)
  })
})

describe('add custom connector', () => {
  test('No sign in: connected at once, tools discovered, headers sealed and sent', async () => {
    const m = plain()
    const dbFile = tmpDb()
    const server = await boot(dbFile)
    const made = await call(server, 'POST', '/connectors/custom', {
      name: 'Company docs',
      url: m.url,
      signIn: 'none',
      headers: { 'X-Api-Key': 'HEADERSECRET9' },
      availableToAll: true,
    })
    expect(made.status).toBe(201)
    expect(made.json.flow).toBeUndefined()
    expect(made.json.connection).toMatchObject({
      definitionId: 'mcp-remote',
      label: 'Company docs',
      custom: true,
      scope: 'workspace',
      status: 'connected',
      defaultEnabled: true,
    })
    expect(made.json.connection.capabilities.map((c: Json) => c.id)).toEqual(['read', 'write'])
    expect(m.seen.headers.some((h) => h['x-api-key'] === 'HEADERSECRET9')).toBe(true)
    expect(made.text).not.toContain('HEADERSECRET9')
    server.conn.sqlite.run('PRAGMA wal_checkpoint(TRUNCATE)')
    expect(readFileSync(dbFile).includes(Buffer.from('HEADERSECRET9'))).toBe(false)

    // the agent sees it under its own name, with its tools
    const lead = server.deps.agents.getBySlug('lead')
    if (lead === undefined) throw new Error('lead')
    const view = await call(server, 'GET', `/agents/${lead.id}/connectors`)
    const mine = view.json.connectors.find((c: Json) => c.connectionId === made.json.connection.id)
    expect(mine).toMatchObject({ name: 'Company docs', source: 'custom', enabled: true })
    await server.factory.prepare(lead)
    const names = Object.keys(server.connectors.activated(lead.id)?.toolNameMap ?? {})
    expect(names).toContain('company-docs_lookup')

    // a server that can not be reached saves nothing
    const before = (await call(server, 'GET', '/connections')).json.connections.length
    const bad = await call(server, 'POST', '/connectors/custom', {
      name: 'Dead',
      url: 'http://localhost:1/mcp',
      signIn: 'none',
    })
    expect(bad.status).toBe(400)
    expect((await call(server, 'GET', '/connections')).json.connections.length).toBe(before)
  })

  test('Sign in when needed: needs-auth, no tools for agents until signed in; then it works', async () => {
    const m = oauth()
    const server = await boot()
    const made = await call(server, 'POST', '/connectors/custom', {
      name: 'Secure notes',
      url: m.url,
      signIn: 'later',
      availableToAll: true,
    })
    expect(made.status).toBe(201)
    const id = made.json.connection.id as string
    expect(made.json.connection).toMatchObject({
      status: 'needs-auth',
      authorized: false,
      settings: { authMode: 'oauth' },
    })
    const lead = server.deps.agents.getBySlug('lead')
    if (lead === undefined) throw new Error('lead')
    await server.factory.prepare(lead)
    const slug = (c: Json) => c.connectionId === id
    expect(
      (await call(server, 'GET', `/agents/${lead.id}/connectors`)).json.connectors.find(slug),
    ).toMatchObject({ status: 'needs-auth', name: 'Secure notes' })
    expect(Object.keys(server.connectors.activated(lead.id)?.toolNameMap ?? {})).not.toContain(
      'secure-notes_lookup',
    )

    // sign in (reconnect flow): authorize -> callback -> test -> connected
    const started = await call(server, 'POST', '/connections/flows', { connectionId: id })
    expect(started.json.flow.view.type).toBe('oauth')
    const done = await signIn(server, started.json.flow)
    expect(done.flow.status).toBe('done')
    expect(done.connection).toMatchObject({ status: 'connected', authorized: true })
    expect(done.connection.capabilities.map((c: Json) => c.id)).toEqual(['read', 'write'])
    // dynamic registration named the client; the token reached the server side only
    expect(m.seen.registrations).toHaveLength(1)
    expect(JSON.stringify(done)).not.toContain('fake-access-token')
    await server.factory.prepare(lead)
    expect(Object.keys(server.connectors.activated(lead.id)?.toolNameMap ?? {})).toContain(
      'secure-notes_lookup',
    )
  })

  test('Sign in now returns the OAuth flow; an own OAuth client is used instead of registering', async () => {
    const m = oauth()
    const server = await boot()
    const made = await call(server, 'POST', '/connectors/custom', {
      name: 'Own client',
      url: m.url,
      signIn: 'now',
      oauthClient: { clientId: 'my-client', clientSecret: 'CLIENTSECRET5' },
    })
    expect(made.json.connection.status).toBe('needs-auth')
    expect(made.json.flow.view.type).toBe('oauth')
    expect(new URL(made.json.flow.view.authorizeUrl).searchParams.get('client_id')).toBe(
      'my-client',
    )
    expect(m.seen.registrations).toHaveLength(0)
    expect(made.text).not.toContain('CLIENTSECRET5')
    const done = await signIn(server, made.json.flow)
    expect(done.connection.status).toBe('connected')
  })

  test('several custom connectors side by side: distinct prefixes, stable after rename', async () => {
    const a = plain()
    const b = plain()
    const server = await boot()
    const names = ['Docs', 'docs', 'Docs!']
    const ids: string[] = []
    for (const [i, name] of names.entries()) {
      const r = await call(server, 'POST', '/connectors/custom', {
        name,
        url: i === 1 ? b.url : a.url,
        signIn: 'none',
        availableToAll: true,
      })
      expect(r.status).toBe(201)
      ids.push(r.json.connection.id)
    }
    const lead = server.deps.agents.getBySlug('lead')
    if (lead === undefined) throw new Error('lead')
    const tools = async () => {
      await server.factory.prepare(lead)
      return Object.keys(server.connectors.activated(lead.id)?.toolNameMap ?? {})
        .filter((n) => n.endsWith('_lookup'))
        .sort()
    }
    expect(await tools()).toEqual(['docs-2_lookup', 'docs-3_lookup', 'docs_lookup'])

    // renaming changes the card, not the tools
    const renamed = await call(server, 'PATCH', `/connections/${ids[0]}`, { label: 'Handbook' })
    expect(renamed.json.label).toBe('Handbook')
    expect(await tools()).toEqual(['docs-2_lookup', 'docs-3_lookup', 'docs_lookup'])
    // a new connector never takes a prefix that is in use
    const again = await call(server, 'POST', '/connectors/custom', {
      name: 'docs',
      url: a.url,
      signIn: 'none',
      availableToAll: true,
    })
    expect(again.status).toBe(201)
    expect(await tools()).toContain('docs-4_lookup')
  })

  test('input is validated', async () => {
    const server = await boot()
    const bad = (body: Json) => call(server, 'POST', '/connectors/custom', body)
    expect((await bad({ name: '  ', url: 'https://x.test/mcp', signIn: 'later' })).status).toBe(400)
    expect((await bad({ name: 'x', url: 'ftp://x.test/mcp', signIn: 'later' })).status).toBe(400)
    expect(
      (
        await bad({
          name: 'x',
          url: 'https://x.test/mcp',
          signIn: 'later',
          headers: { 'bad name': 'v' },
        })
      ).status,
    ).toBe(400)
    expect(
      (
        await bad({
          name: 'x',
          url: 'https://x.test/mcp',
          signIn: 'later',
          scope: 'agent',
          scopeId: 'nope',
        })
      ).status,
    ).toBe(400)
  })
})

describe('migration of existing custom connections', () => {
  test('they keep their tool prefix, stored as a stable slug, and stay named by their label', async () => {
    const m = plain()
    const dbFile = tmpDb()
    const first = await boot(dbFile, false)
    first.conn.sqlite
      .query(
        `INSERT INTO agents (id, workspace_id, slug, name, role, color, instructions, tools, skills, mcp, mcp_servers, permission_mode, rules, version, created_at, updated_at, connectors_migrated)
         VALUES ('id-ops', 'default', 'ops', 'ops', 'custom', '#000', 'x', ?, '[]', '[]', ?, 'default', ?, 1, 1, 1, 0)`,
      )
      .run(
        JSON.stringify(['mcp']),
        JSON.stringify([{ name: 'My Docs', transport: { type: 'http', url: m.url, headers: {} } }]),
        JSON.stringify({ allow: [], ask: [], deny: [] }),
      )
    await first.close()
    servers.pop()

    const server = await boot(dbFile, false)
    const ops = server.deps.agents.getBySlug('ops')
    if (ops === undefined) throw new Error('ops')
    const conns = await server.deps.connectors.connections({ scope: 'agent', scopeId: ops.id })
    const legacy = conns.find((c) => c.id === `mcp:${ops.id}:My Docs`)
    expect(legacy).toMatchObject({ label: 'My Docs', custom: true })
    const record = await server.connectors.stores.connections.get(`mcp:${ops.id}:My Docs`)
    expect(record?.slug).toBe('my-docs')
    await server.factory.prepare(ops)
    const prefixOf = () =>
      server.connectors.activated(ops.id)?.connections.find((c) => c.connectionId === record?.id)
        ?.toolPrefix
    expect(prefixOf()).toBe('my-docs_')
    // a rename afterwards does not change the tool names
    await call(server, 'PATCH', `/connections/mcp:${ops.id}:My Docs`, { label: 'Handbook' })
    await server.factory.prepare(ops)
    expect(prefixOf()).toBe('my-docs_')
  })
})

describe('private endpoints (SSRF guard)', () => {
  test('refused unless TEAM_ALLOW_PRIVATE_MCP=1', async () => {
    const server = compose({
      dbFile: ':memory:',
      models: scriptedModelConfig(scriptedModel([]) as never),
      env: { TEAM_SECRET_KEY: key },
      changePollMs: 0,
      reconcile: { onBoot: false, everyMs: 0 },
      routines: { tickMs: 0 },
    })
    servers.push(server)
    await server.connectorsReady
    for (const url of [
      'http://localhost:1/mcp',
      'https://127.0.0.1/mcp',
      'https://169.254.169.254/mcp',
      'https://10.0.0.5/mcp',
      'https://intranet/mcp',
    ]) {
      const probe = await call(server, 'POST', '/connectors/custom/probe', { url })
      expect(probe.status).toBe(400)
      const made = await call(server, 'POST', '/connectors/custom', {
        name: 'X',
        url,
        signIn: 'none',
      })
      expect(made.status).toBe(400)
    }
  })
})
