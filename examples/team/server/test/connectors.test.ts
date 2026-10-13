/**
 * Connectors: the migration of the tool checklist and MCP servers, connect flows over HTTP (form,
 * OAuth with a fake fetch, stale views), enablement (inheritance, overrides, pinned asks in Bypass),
 * secrets at rest and two instances sharing a database.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scriptedModel } from 'eharness/testing'
import { scriptedModelConfig } from '../src/infra/eh/provider.ts'
import { compose, type Server, type ServerConfig } from '../src/main.ts'

// biome-ignore lint/suspicious/noExplicitAny: loosely typed JSON of the API under test
type Json = Record<string, any>
const dirs: string[] = []
const servers: Server[] = []
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const tmpDb = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'team-connectors-'))
  dirs.push(d)
  return join(d, 'team.db')
}

interface Boot {
  dbFile?: string
  model?: unknown
  env?: Record<string, string>
  fetch?: typeof fetch
  pollMs?: number
  seed?: boolean
  mcpListTools?: ServerConfig['mcpListTools']
}
const key = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64')
async function boot(o: Boot = {}): Promise<Server> {
  const server = compose({
    dbFile: o.dbFile ?? ':memory:',
    models: scriptedModelConfig((o.model ?? scriptedModel([])) as never),
    env: { TEAM_SECRET_KEY: key, ...(o.env ?? {}) },
    ...(o.fetch === undefined ? {} : { fetch: o.fetch }),
    changePollMs: o.pollMs ?? 0,
    seed: o.seed ?? true,
    publicUrl: 'http://api.test',
    webUrl: 'http://web.test',
    ...(o.mcpListTools === undefined ? {} : { mcpListTools: o.mcpListTools }),
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
  return { status: res.status, text, json: (text ? JSON.parse(text) : undefined) as Json, res }
}

/** A minimal MCP server: initialize, tools/list, tools/call; records auth headers and calls. */
function fakeMcp(extraTools = 0) {
  const seen = { auth: [] as string[], calls: [] as string[] }
  const srv = Bun.serve({
    port: 0,
    async fetch(req) {
      if (req.method !== 'POST') return new Response(null, { status: 405 })
      seen.auth.push(req.headers.get('authorization') ?? '')
      const msg = (await req.json()) as { id?: number; method: string; params: Json }
      if (msg.id === undefined) return new Response(null, { status: 202 })
      const result = (() => {
        switch (msg.method) {
          case 'initialize':
            return {
              protocolVersion: msg.params.protocolVersion,
              capabilities: { tools: {} },
              serverInfo: { name: 'fake', version: '1' },
            }
          case 'tools/list':
            return {
              tools: [
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
                ...Array.from({ length: extraTools }, (_, i) => ({
                  name: `extra_${i}`,
                  description: `Extra tool ${i}.`,
                  inputSchema: { type: 'object', properties: {} },
                  annotations: { readOnlyHint: true },
                })),
              ],
            }
          case 'tools/call':
            seen.calls.push(msg.params.name)
            return { content: [{ type: 'text', text: `found ${msg.params.arguments?.q}` }] }
          default:
            return {}
        }
      })()
      return Response.json({ jsonrpc: '2.0', id: msg.id, result })
    },
  })
  return { srv, seen, url: `http://localhost:${srv.port}/mcp` }
}
const mcps: Array<ReturnType<typeof Bun.serve>> = []
afterEach(() => {
  for (const m of mcps.splice(0)) m.stop(true)
})
const startMcp = (extraTools = 0) => {
  const m = fakeMcp(extraTools)
  mcps.push(m.srv)
  return m
}

/** Run the connect flow of the custom connector to the end through the routes. */
async function connectCustom(
  server: Server,
  url: string,
  extra: Json = {},
  settings: Json = {},
  scope: Json = {},
): Promise<Json> {
  const started = await call(server, 'POST', '/connections/flows', {
    definitionId: 'mcp-remote',
    label: 'docs',
    ...scope,
  })
  expect(started.status).toBe(201)
  const view = started.json.flow.view
  expect(view.type).toBe('form')
  const done = await call(server, 'POST', `/connections/flows/${started.json.flow.id}/act`, {
    viewId: view.viewId,
    action: 'submit',
    data: { url, authMode: 'none', ...settings },
    ...extra,
  })
  expect(done.status).toBe(200)
  return done.json
}

// --- the legacy tool checklist -----------------------------------------------------------------

interface Legacy {
  slug: string
  role: string
  tools: string[]
  mcp?: unknown[]
  rules?: { allow: string[]; ask: string[]; deny: string[] }
}

function insertLegacy(server: Server, rows: Legacy[]): void {
  for (const r of rows) {
    server.conn.sqlite
      .query(
        `INSERT INTO agents (id, workspace_id, slug, name, role, color, instructions, tools, skills, mcp, mcp_servers, permission_mode, rules, version, created_at, updated_at, connectors_migrated)
         VALUES (?, 'default', ?, ?, ?, '#000', 'x', ?, '[]', '[]', ?, 'default', ?, 1, 1, 1, 0)`,
      )
      .run(
        `id-${r.slug}`,
        r.slug,
        r.slug,
        r.role,
        JSON.stringify(r.tools),
        JSON.stringify(r.mcp ?? []),
        JSON.stringify(r.rules ?? { allow: [], ask: [], deny: [] }),
      )
  }
}

const READ = ['list_files', 'read_file', 'grep', 'glob']
const WRITE = ['write_file', 'edit_file', 'delete_file']
const MEMORY = [
  'memory_view',
  'memory_create',
  'memory_str_replace',
  'memory_insert',
  'memory_delete',
  'memory_rename',
]

/** The tools the model is offered in the first request of a turn. */
async function offeredTools(
  server: Server,
  slug: string,
  model: { calls: Array<{ tools?: Array<{ name: string }> }> },
): Promise<string[]> {
  const def = server.deps.agents.getBySlug(slug)
  if (def === undefined) throw new Error(`no agent ${slug}`)
  await server.factory.prepare(def)
  const session = server.factory.openSession(def, `dm:${def.id}`)
  await session.send('hi').result
  return (model.calls[0]?.tools ?? []).map((t: { name: string }) => t.name).sort()
}

describe('migration of the tool checklist and MCP servers', () => {
  test('every legacy agent exposes the same tools and keeps its rules', async () => {
    const dbFile = tmpDb()
    const first = await boot({ dbFile, seed: false })
    insertLegacy(first, [
      { slug: 'reader', role: 'role', tools: ['library_read', 'memory', 'todos'] },
      {
        slug: 'writer',
        role: 'role',
        tools: ['library_read', 'library_write', 'memory', 'todos', 'web_fetch', 'ask_user'],
        rules: { allow: ['read_file'], ask: ['delete_file'], deny: ['grep'] },
      },
      { slug: 'bare', role: 'custom', tools: [] },
      {
        slug: 'boss',
        role: 'lead',
        tools: ['library_read', 'memory', 'todos', 'ask_user', 'delegate', 'send_message'],
      },
    ])
    await first.close()
    servers.pop()

    const model = scriptedModel([{ text: 'ok' }])
    const server = await boot({ dbFile, model, seed: false })
    expect(server.deps.agents.getBySlug('reader')?.connectors).toBeDefined()
    // idempotent: a second boot changes nothing
    const before = JSON.stringify(
      server.conn.sqlite
        .query('SELECT * FROM agent_connectors ORDER BY agent_id, connection_id')
        .all(),
    )
    expect(before).not.toBe('[]')

    // reader: read files, memory, todos; as a role agent it also has the child side `send_message`,
    // and in a chat `propose_plan` (the Decision Center), `persona` and `reminder` (not connectors, always there)
    const reader = await offeredTools(server, 'reader', model)
    expect(reader).toEqual(
      [
        ...READ,
        ...MEMORY,
        'todo_write',
        'send_message',
        'propose_plan',
        'program_note',
        'person_note',
        'persona',
        'reminder',
        // the clock and the agent's own background worker (always there)
        'datetime',
        'agent',
        'agent_output',
        'agent_stop',
      ].sort(),
    )
    const readerOut = server.connectors.activated('id-reader')
    // the library is read only: edit tools are off
    expect(readerOut?.rules.deny).toEqual(expect.arrayContaining(WRITE))
    // memory writes are allowed without asking (the agent owns its memory)
    expect(readerOut?.rules.allow).toEqual(
      expect.arrayContaining(MEMORY.filter((m) => m !== 'memory_view')),
    )
    // a role agent may not write the shared workspace memory: its root is read only
    expect(
      server.connectors.activated('id-reader')?.connections.map((c) => c.connectionId),
    ).toEqual(expect.arrayContaining(['builtin:memory', 'builtin:memory:agent:id-reader']))

    const writerModel = scriptedModel([{ text: 'ok' }])
    const writerServer = server
    void writerModel
    const writerOut = writerServer.connectors.activated('id-writer')
    const rules = writerOut?.rules
    // write_file / edit_file allowed (library_write), delete asks (def rule), grep denied (def rule)
    expect(rules?.allow).toEqual(expect.arrayContaining(['write_file', 'edit_file', 'read_file']))
    expect(rules?.allow).not.toContain('delete_file')
    expect(rules?.ask).toContain('delete_file')
    expect(rules?.deny).toContain('grep')
    expect(rules?.deny).not.toContain('write_file')

    // bare: nothing is on
    expect(
      Object.keys(server.connectors.activated('id-bare')?.toolNameMap ?? {}).filter(
        (n) => !(server.connectors.activated('id-bare')?.rules.deny ?? []).includes(n),
      ),
    ).toEqual([])

    // lead: delegation exists, the library stays read only
    const bossOut = server.connectors.activated('id-boss')
    const bossOn = Object.keys(bossOut?.toolNameMap ?? {}).filter(
      (n) => !bossOut?.rules.deny.includes(n),
    )
    expect(bossOn).toEqual(
      expect.arrayContaining([
        'agent',
        'agent_output',
        'agent_stop',
        'send_message',
        'ask_user_question',
      ]),
    )
    expect(bossOut?.rules.deny).toEqual(expect.arrayContaining(['write_file', 'edit_file']))
    void WRITE
  })

  test('mcpServers become agent-scoped custom connections: headers sealed, tools prefixed as before', async () => {
    const { seen, url } = startMcp()
    const dbFile = tmpDb()
    const first = await boot({ dbFile, seed: false })
    insertLegacy(first, [
      {
        slug: 'ops',
        role: 'custom',
        tools: ['mcp'],
        mcp: [
          {
            name: 'docs',
            transport: { type: 'http', url, headers: { Authorization: 'Bearer HEADERSECRET1' } },
          },
          {
            name: 'legacy-sse',
            transport: { type: 'sse', url: 'http://127.0.0.1:9/sse', headers: {} },
            deny: ['danger'],
          },
        ],
      },
      {
        slug: 'nomcp',
        role: 'custom',
        tools: ['library_read'],
        mcp: [{ name: 'docs', transport: { type: 'http', url, headers: {} } }],
      },
    ])
    await first.close()
    servers.pop()

    const model = scriptedModel([
      { toolCalls: [{ toolName: 'tool_search', input: { query: 'lookup' } }] },
      { toolCalls: [{ toolName: 'docs_lookup', input: { q: 'eharness' } }] },
      { text: 'done' },
    ])
    const server = await boot({ dbFile, model, seed: false })
    await call(server, 'PATCH', '/settings', { toolAccess: 'on-demand' })
    const ops = server.deps.agents.getBySlug('ops')
    if (ops === undefined) throw new Error('ops')
    await server.factory.prepare(ops)
    const conns = await server.deps.connectors.connections({ scope: 'agent', scopeId: ops.id })
    expect(
      conns
        .map((c) => c.id)
        .filter((id) => id.startsWith('mcp:'))
        .sort(),
    ).toEqual([`mcp:${ops.id}:docs`, `mcp:${ops.id}:legacy-sse`])
    // the secret is a `{ set, hint }` in every view
    expect(JSON.stringify(conns)).not.toContain('HEADERSECRET1')
    expect((conns[0] as Json).settings.headers).toBeDefined()

    // the agent without the `mcp` tool keeps its server, switched off
    const nomcp = server.deps.agents.getBySlug('nomcp')
    if (nomcp === undefined) throw new Error('nomcp')
    const view = await call(server, 'GET', `/agents/${nomcp.id}/connectors`)
    const docs = view.json.connectors.find((c: Json) => c.connectionId === `mcp:${nomcp.id}:docs`)
    expect(docs.enabled).toBe(false)
    expect(docs.ownership).toBe('agent')

    // bypass mode, deferred tool, header reaches the server, result is framed as untrusted
    server.conn.sqlite.run(
      "UPDATE agents SET permission_mode = 'bypassPermissions' WHERE slug = 'ops'",
    )
    const def = server.deps.agents.getBySlug('ops') as NonNullable<typeof ops>
    const session = server.factory.openSession(def, `dm:${def.id}`)
    const result = await session.send('look it up').result
    expect(result.stop).toBe('complete')
    const first1 = (model.calls[0]?.tools ?? []).map((t: { name: string }) => t.name)
    expect(first1).toContain('tool_search')
    expect(first1).not.toContain('docs_lookup')
    expect(seen.calls).toEqual(['lookup'])
    expect(seen.auth.every((a) => a === 'Bearer HEADERSECRET1')).toBe(true)
    expect(JSON.stringify(model.prompts.at(-1))).toContain('<untrusted-content')
  })
})

// --- the connect flows over HTTP ---------------------------------------------------------------

describe('connect flows', () => {
  test('catalog: built-ins are included, GitHub and the custom connector can be connected', async () => {
    const server = await boot()
    const { json } = await call(server, 'GET', '/connectors')
    const byId = Object.fromEntries(json.connectors.map((c: Json) => [c.id, c]))
    expect(Object.keys(byId)).toEqual(
      expect.arrayContaining([
        'files',
        'memory',
        'planning',
        'web',
        'ask',
        'team',
        'github',
        'mcp-remote',
      ]),
    )
    expect(byId.files.builtin).toBe(true)
    expect(byId.files.capabilities.map((c: Json) => c.title)).toEqual([
      'Read files',
      'Edit files',
      'Delete files',
    ])
    expect(byId.github.oauthClient).toMatchObject({ required: true, configured: false })
    expect(byId.github.oauthClient.redirectUri).toBe('http://api.test/oauth/callback')
    // a built-in has nothing to connect
    const started = await call(server, 'POST', '/connections/flows', { definitionId: 'files' })
    expect(started.status).toBe(409)
  })

  test('form -> test -> status; the connection is saved, secrets sealed and never returned', async () => {
    const { url } = startMcp()
    const dbFile = tmpDb()
    const server = await boot({ dbFile })
    const started = await call(server, 'POST', '/connections/flows', {
      definitionId: 'mcp-remote',
      label: 'docs',
      defaultEnabled: true,
    })
    const flow = started.json.flow
    expect(flow.view.type).toBe('form')
    // a stale view id is a 409 that carries the current flow
    const stale = await call(server, 'POST', `/connections/flows/${flow.id}/act`, {
      viewId: 'not-current',
      action: 'submit',
      data: {},
    })
    expect(stale.status).toBe(409)
    expect(stale.json.error.code).toBe('STALE_VIEW')
    expect(stale.json.flow.view.viewId).toBe(flow.view.viewId)
    // a validation problem is a new form with errors, not an error status
    const invalid = await call(server, 'POST', `/connections/flows/${flow.id}/act`, {
      viewId: flow.view.viewId,
      action: 'submit',
      data: {
        url: 'not a url',
        authMode: 'headers',
        headers: { Authorization: 'Bearer HEADERSECRET2' },
      },
    })
    expect(invalid.status).toBe(200)
    expect(invalid.json.flow.view.errors.url).toBeDefined()
    expect(invalid.text).not.toContain('HEADERSECRET2')
    expect(invalid.json.flow.view.values.headers).toBeDefined()

    const done = await call(server, 'POST', `/connections/flows/${flow.id}/act`, {
      viewId: invalid.json.flow.view.viewId,
      action: 'submit',
      data: { url, authMode: 'headers', headers: { Authorization: { keep: true } } },
    })
    // the kept secret was the one typed before
    expect(done.json.flow.status).toBe('done')
    expect(done.json.flow.view).toMatchObject({ type: 'status', state: 'success' })
    const connection = done.json.connection
    expect(connection).toMatchObject({
      definitionId: 'mcp-remote',
      label: 'docs',
      scope: 'workspace',
      defaultEnabled: true,
      status: 'connected',
    })
    // tools found at connect time are grouped into capabilities by their annotations; reads default
    // to Allowed (asking for every lookup is noise, P40 value pass), writes ask first
    expect(connection.capabilities.map((c: Json) => [c.id, c.defaultMode])).toEqual([
      ['read', 'allow'],
      ['write', 'ask'],
    ])
    expect(done.text).not.toContain('HEADERSECRET2')
    expect(JSON.stringify((await call(server, 'GET', '/connections')).json)).not.toContain(
      'HEADERSECRET2',
    )

    // GET of a finished flow still answers (a polling tab learns the outcome)
    const again = await call(server, 'GET', `/connections/flows/${flow.id}`)
    expect(again.json.connection.id).toBe(connection.id)

    // the database never holds the secret: not in the rows, not in the file
    server.conn.sqlite.run('PRAGMA wal_checkpoint(TRUNCATE)')
    const rows = server.conn.sqlite
      .query<{ settings: string; kind: string }, []>('SELECT settings, kind FROM config_profiles')
      .all()
    const row = rows.find((r) => r.kind === 'connection' && r.settings.includes('~sealed'))
    expect(row).toBeDefined()
    expect(rows.every((r) => !r.settings.includes('HEADERSECRET'))).toBe(true)
    const flows = server.conn.sqlite
      .query<{ data: string }, []>('SELECT data FROM connector_flows')
      .all()
    expect(flows.every((f) => !f.data.includes('HEADERSECRET'))).toBe(true)
    const raw = readFileSync(dbFile)
    expect(raw.includes(Buffer.from('HEADERSECRET2'))).toBe(false)

    // editing: a secret left out keeps the stored value; the label changes
    const patched = await call(server, 'PATCH', `/connections/${connection.id}`, {
      label: 'docs-2',
      settings: { headers: { Authorization: { keep: true } } },
    })
    expect(patched.status).toBe(200)
    expect(patched.json.label).toBe('docs-2')

    // test records the status; delete removes the connection and every agent's choice
    const tested = await call(server, 'POST', `/connections/${connection.id}/test`)
    expect(tested.json).toMatchObject({ ok: true, tools: 2 })
    const lead = server.deps.agents.getBySlug('lead')
    if (lead === undefined) throw new Error('lead')
    await call(server, 'PUT', `/agents/${lead.id}/connectors`, {
      connections: { [connection.id]: { enabled: 'on' } },
    })
    expect((await call(server, 'DELETE', `/connections/${connection.id}`)).status).toBe(204)
    expect((await call(server, 'DELETE', `/connections/${connection.id}`)).status).toBe(404)
    const left = server.conn.sqlite
      .query('SELECT count(*) AS n FROM agent_connectors WHERE connection_id = ?')
      .get(connection.id) as { n: number }
    expect(left.n).toBe(0)
    // built-ins can not be removed
    expect((await call(server, 'DELETE', '/connections/builtin:files')).status).toBe(409)
  })

  test('OAuth: authorize URL, callback redirect, token stored sealed, tokens never in a view', async () => {
    const calls: string[] = []
    const fetchFake = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      calls.push(`${init?.method ?? 'GET'} ${url}`)
      if (url === 'https://github.com/login/oauth/access_token') {
        return Response.json({
          access_token: 'gho_ACCESSTOKEN123',
          token_type: 'bearer',
          scope: 'repo',
          refresh_token: 'ghr_REFRESHTOKEN456',
          expires_in: 3600,
        })
      }
      if (url === 'https://api.github.com/user') return Response.json({ login: 'octocat' })
      return new Response('not found', { status: 404 })
    }) as unknown as typeof fetch
    const listTools = async () => [
      { name: 'get_me', annotations: { readOnlyHint: true } },
      { name: 'create_issue' },
      { name: 'delete_repo', annotations: { destructiveHint: true } },
    ]
    const dbFile = tmpDb()
    const server = await boot({
      dbFile,
      fetch: fetchFake,
      env: { TEAM_GITHUB_CLIENT_ID: 'client-123', TEAM_GITHUB_CLIENT_SECRET: 'CLIENTSECRET789' },
      mcpListTools: listTools as never,
    })
    const catalog = (await call(server, 'GET', '/connectors')).json.connectors.find(
      (c: Json) => c.id === 'github',
    )
    expect(catalog.oauthClient).toMatchObject({ configured: true, source: 'env' })

    const started = await call(server, 'POST', '/connections/flows', {
      definitionId: 'github',
      defaultEnabled: true,
    })
    let flow = started.json.flow
    expect(flow.view.type).toBe('form')
    const toOauth = await call(server, 'POST', `/connections/flows/${flow.id}/act`, {
      viewId: flow.view.viewId,
      action: 'submit',
      data: { authMode: 'oauth' },
    })
    flow = toOauth.json.flow
    expect(flow.view.type).toBe('oauth')
    const authorize = new URL(flow.view.authorizeUrl)
    expect(authorize.origin + authorize.pathname).toBe('https://github.com/login/oauth/authorize')
    expect(authorize.searchParams.get('client_id')).toBe('client-123')
    expect(authorize.searchParams.get('redirect_uri')).toBe('http://api.test/oauth/callback')
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256')
    expect(authorize.searchParams.get('client_secret')).toBeNull()
    // polling before the callback changes nothing
    const poll = await call(server, 'POST', `/connections/flows/${flow.id}/act`, {
      viewId: flow.view.viewId,
      action: 'poll',
    })
    expect(poll.json.flow.view.type).toBe('oauth')

    // the callback needs no bearer token and redirects to the web app
    const state = authorize.searchParams.get('state') as string
    const cb = await server.app.request(`/oauth/callback?state=${state}&code=thecode`, {
      redirect: 'manual',
    })
    expect(cb.status).toBe(302)
    expect(cb.headers.get('location')).toBe(`http://web.test/connectors?flow=${flow.id}`)
    // the state is single use
    const replay = await server.app.request(`/oauth/callback?state=${state}&code=thecode`, {
      redirect: 'manual',
    })
    expect(replay.headers.get('location')).toContain('/connectors?oauth_error=')

    const done = await call(server, 'GET', `/connections/flows/${flow.id}`)
    expect(done.json.flow.status).toBe('done')
    expect(done.json.connection).toMatchObject({
      definitionId: 'github',
      status: 'connected',
      accountLabel: 'octocat',
      authorized: true,
    })
    expect(done.json.connection.capabilities.map((c: Json) => c.id)).toEqual([
      'read',
      'write',
      'destructive',
    ])
    for (const secret of ['ACCESSTOKEN123', 'REFRESHTOKEN456', 'CLIENTSECRET789']) {
      expect(done.text).not.toContain(secret)
    }
    // tokens are sealed in the credentials row
    server.conn.sqlite.run('PRAGMA wal_checkpoint(TRUNCATE)')
    const creds = server.conn.sqlite
      .query<{ settings: string }, []>(
        "SELECT settings FROM config_profiles WHERE kind = 'connection-credentials'",
      )
      .all()
    expect(creds).toHaveLength(1)
    expect(creds[0]?.settings).toContain('~sealed')
    const raw = readFileSync(dbFile)
    for (const secret of ['ACCESSTOKEN123', 'REFRESHTOKEN456', 'CLIENTSECRET789']) {
      expect(raw.includes(Buffer.from(secret))).toBe(false)
    }
    // the token reaches the server side only
    const id = done.json.connection.id as string
    expect(await server.connectors.accessTokenFor(id)).toBe('gho_ACCESSTOKEN123')
  })

  test('a connector that needs an OAuth app: saved from the web, sealed, never returned', async () => {
    const dbFile = tmpDb()
    const server = await boot({ dbFile })
    const put = await call(server, 'PUT', '/connectors/github/oauth-client', {
      clientId: 'cid-1',
      clientSecret: 'OAUTHAPPSECRET',
    })
    expect(put.status).toBe(204)
    const catalog = (await call(server, 'GET', '/connectors')).json.connectors.find(
      (c: Json) => c.id === 'github',
    )
    expect(catalog.oauthClient).toMatchObject({ configured: true, source: 'stored' })
    expect(JSON.stringify(catalog)).not.toContain('OAUTHAPPSECRET')
    server.conn.sqlite.run('PRAGMA wal_checkpoint(TRUNCATE)')
    expect(readFileSync(dbFile).includes(Buffer.from('OAUTHAPPSECRET'))).toBe(false)
    expect((await call(server, 'DELETE', '/connectors/github/oauth-client')).status).toBe(204)
    expect(
      (await call(server, 'PUT', '/connectors/files/oauth-client', { clientId: 'x' })).status,
    ).toBe(400)
  })
})

// --- enablement --------------------------------------------------------------------------------

describe('enablement', () => {
  test('workspace connections are inherited, an agent may override; agent connections stay with their agent', async () => {
    const { url } = startMcp()
    const server = await boot()
    const done = await connectCustom(server, url, {}, {}, { defaultEnabled: true })
    const shared = done.connection.id as string
    const writer = server.deps.agents.getBySlug('writer')
    const analyst = server.deps.agents.getBySlug('analyst')
    if (writer === undefined || analyst === undefined) throw new Error('seed')

    const view = async (id: string) =>
      (
        (await call(server as Server, 'GET', `/agents/${id}/connectors`)).json.connectors as Json[]
      ).find((c) => c.connectionId === shared)
    expect(await view(writer.id)).toMatchObject({
      enabled: true,
      state: 'inherit',
      ownership: 'workspace',
    })
    expect(await view(analyst.id)).toMatchObject({ enabled: true, state: 'inherit' })

    // the writer opts out; the analyst keeps it
    const put = await call(server, 'PUT', `/agents/${writer.id}/connectors`, {
      connections: { [shared]: { enabled: 'off' } },
    })
    expect(put.status).toBe(200)
    expect(await view(writer.id)).toMatchObject({ enabled: false, state: 'off' })
    expect(await view(analyst.id)).toMatchObject({ enabled: true })
    // and null goes back to inherit
    await call(server, 'PUT', `/agents/${writer.id}/connectors`, {
      connections: { [shared]: null },
    })
    expect(await view(writer.id)).toMatchObject({ enabled: true, state: 'inherit' })

    // not available to all agents: only agents that switch it on have it
    await call(server, 'PATCH', `/connections/${shared}`, { defaultEnabled: false })
    expect(await view(writer.id)).toMatchObject({ enabled: false })
    await call(server, 'PUT', `/agents/${writer.id}/connectors`, {
      connections: { [shared]: { enabled: 'on' } },
    })
    expect(await view(writer.id)).toMatchObject({ enabled: true, state: 'on' })

    // an agent-scoped connection belongs to that agent alone
    const own = await connectCustom(
      server,
      url,
      {},
      {},
      { scope: 'agent', scopeId: analyst.id, label: 'mine' },
    )
    const ownId = own.connection.id as string
    const ofAnalyst = (await call(server, 'GET', `/agents/${analyst.id}/connectors`)).json
      .connectors as Json[]
    expect(ofAnalyst.find((c) => c.connectionId === ownId)).toMatchObject({
      ownership: 'agent',
      scope: 'agent',
      enabled: true,
    })
    const ofWriter = (await call(server, 'GET', `/agents/${writer.id}/connectors`)).json
      .connectors as Json[]
    expect(ofWriter.find((c) => c.connectionId === ownId)).toBeUndefined()
    // unknown connections are refused
    const bad = await call(server, 'PUT', `/agents/${writer.id}/connectors`, {
      connections: { [ownId]: { enabled: 'on' } },
    })
    expect(bad.status).toBe(404)
    // the Team connector is the lead's
    const team = (await call(server, 'GET', `/agents/${writer.id}/connectors`)).json
      .connectors as Json[]
    expect(team.find((c) => c.connectorId === 'team')).toBeUndefined()
    const lead = server.deps.agents.getBySlug('lead')
    const ofLead = (await call(server, 'GET', `/agents/${lead?.id}/connectors`)).json
      .connectors as Json[]
    expect(ofLead.find((c) => c.connectorId === 'team')).toMatchObject({ enabled: true })
  })

  test('capability modes: most restrictive wins, writes of external connectors are pinned, even in Bypass', async () => {
    const { url, seen } = startMcp()
    const model = scriptedModel([
      { toolCalls: [{ toolName: 'tool_search', input: { query: 'create_note' } }] },
      { toolCalls: [{ toolName: 'docs_create_note', input: { q: 'x' } }] },
      { text: 'done' },
    ])
    const server = await boot({ model })
    await call(server, 'PATCH', '/settings', { toolAccess: 'on-demand' })
    const done = await connectCustom(server, url, {}, {}, { defaultEnabled: true })
    const id = done.connection.id as string
    const writer = server.deps.agents.getBySlug('writer')
    if (writer === undefined) throw new Error('seed')
    server.conn.sqlite.run(
      "UPDATE agents SET permission_mode = 'bypassPermissions' WHERE slug = 'writer'",
    )

    const caps = async () =>
      (
        (await call(server, 'GET', `/agents/${writer.id}/connectors`)).json.connectors as Json[]
      ).find((c) => c.connectionId === id)?.capabilities as Json[]
    // reads of a custom server are allowed by default (P40 value pass), writes ask first and are
    // pinned (they ask in Bypass too)
    expect(await caps()).toEqual([
      expect.objectContaining({ id: 'read', mode: 'allow', pinned: false }),
      expect.objectContaining({ id: 'write', mode: 'ask', pinned: true, inherited: 'ask' }),
    ])
    // the agent may open one up to Allowed (reads here); a pinned write still asks (the rule
    // compiler pins `ask` only, so Allowed is the person's explicit choice for that agent)
    await call(server, 'PUT', `/agents/${writer.id}/connectors`, {
      connections: { [id]: { capabilities: { read: 'allow', write: 'ask' } } },
    })
    await server.factory.prepare(writer)
    const out = server.connectors.activated(writer.id)
    expect(out?.rules.pinnedAsk).toContain('docs_create_note')
    expect(out?.rules.toolKinds.docs_create_note).toEqual({ kind: 'other', alwaysAsk: true })
    expect(out?.rules.allow).toContain('docs_lookup')
    expect(out?.rules.ask).toContain('docs_create_note')

    // Bypass mode does not skip the pinned ask: the call waits for a person, nothing ran
    const def = server.deps.agents.getBySlug('writer') as NonNullable<typeof writer>
    const session = server.factory.openSession(def, `dm:${def.id}`)
    const result = await session.send('make a note').result
    expect(result.stop).not.toBe('complete')
    expect(seen.calls).toEqual([])
    const pending = await server.factory.peek(`dm:${def.id}`).pending()
    expect(JSON.stringify(pending)).toContain('docs_create_note')

    // Off removes the tool: the most restrictive of the agent's rule and the connector wins
    await call(server, 'PUT', `/agents/${writer.id}/connectors`, {
      connections: { [id]: { capabilities: { write: 'off' } } },
    })
    await server.factory.prepare(writer)
    expect(server.connectors.activated(writer.id)?.rules.deny).toContain('docs_create_note')
    // the agent's own rule (deny) beats a connector Allowed
    await call(server, 'PUT', `/agents/${writer.id}/connectors`, {
      connections: { [id]: { capabilities: { read: 'allow' } } },
    })
    server.conn.sqlite.run(
      `UPDATE agents SET rules = '{"allow":[],"ask":[],"deny":["docs_lookup"]}', version = version + 1 WHERE slug = 'writer'`,
    )
    const edited = server.deps.agents.getBySlug('writer') as NonNullable<typeof writer>
    await server.factory.prepare(edited)
    const merged = server.connectors.activated(writer.id)?.rules
    expect(merged?.deny).toContain('docs_lookup')
    expect(merged?.allow).not.toContain('docs_lookup')
  })
})

// --- several instances -------------------------------------------------------------------------

describe('two instances', () => {
  test('a connection made on one is seen by the other through the feed; tokens refresh under a shared lock', async () => {
    const { url } = startMcp()
    const dbFile = tmpDb()
    const a = await boot({ dbFile, pollMs: 20 })
    const b = await boot({ dbFile, pollMs: 20 })
    const before = b.connectors.rev()
    const writer = b.deps.agents.getBySlug('writer')
    if (writer === undefined) throw new Error('seed')
    await b.factory.prepare(writer)
    const agentBefore = b.factory.agentFor(writer)

    const done = await connectCustom(a, url, {}, {}, { defaultEnabled: true })
    const id = done.connection.id as string
    for (let i = 0; i < 100 && b.connectors.rev() === before; i++) await Bun.sleep(20)
    expect(b.connectors.rev()).toBeGreaterThan(before)
    await b.factory.prepare(writer)
    expect(b.connectors.activated(writer.id)?.connections.map((c) => c.connectionId)).toContain(id)
    // the other instance rebuilds the agent from the new revision
    expect(b.factory.agentFor(writer)).not.toBe(agentBefore)

    // an enablement change travels too
    const rev = b.connectors.rev()
    await call(a, 'PUT', `/agents/${writer.id}/connectors`, {
      connections: { [id]: { enabled: 'off' } },
    })
    for (let i = 0; i < 100 && b.connectors.rev() === rev; i++) await Bun.sleep(20)
    await b.factory.prepare(writer)
    expect(b.connectors.activated(writer.id)?.connections.map((c) => c.connectionId)).not.toContain(
      id,
    )

    // deleting it removes it on both
    await call(a, 'DELETE', `/connections/${id}`)
    const list = (await call(b, 'GET', '/connections')).json.connections as Json[]
    expect(list.some((c) => c.id === id)).toBe(false)
  })
})

// --- tool access (Auto / On demand) --------------------------------------------------------------

describe('tool access', () => {
  /** The tool names of the first model call of a fresh turn of `slug`, in the order offered. */
  async function offered(server: Server, model: ReturnType<typeof scriptedModel>, slug: string) {
    const def = server.deps.agents.getBySlug(slug)
    if (def === undefined) throw new Error(`no agent ${slug}`)
    await server.factory.prepare(def)
    const before = model.calls.length
    await server.factory.openSession(def, `dm:${def.id}:${before}`).send('hi').result
    return (model.calls[before]?.tools ?? []).map((t: { name: string }) => t.name)
  }
  const script = () => scriptedModel(Array.from({ length: 12 }, () => ({ text: 'ok' })))
  const patchAgent = (server: Server, slug: string, body: Json) => {
    const id = server.deps.agents.getBySlug(slug)?.id
    return call(server, 'PATCH', `/agents/${id}`, body)
  }

  test('Auto loads connector tools up front, On demand finds them with tool_search; built-ins never defer', async () => {
    const { url } = startMcp()
    const model = script()
    const server = await boot({ model })
    await connectCustom(server, url, {}, {}, { defaultEnabled: true })

    const auto = await offered(server, model, 'writer')
    expect(auto).toEqual(expect.arrayContaining(['docs_lookup', 'docs_create_note']))
    expect(auto).not.toContain('tool_search')
    expect((await call(server, 'GET', '/settings')).json.toolAccess).toBe('auto')

    expect((await patchAgent(server, 'writer', { toolAccess: 'on-demand' })).status).toBe(200)
    const onDemand = await offered(server, model, 'writer')
    expect(onDemand).toContain('tool_search')
    expect(onDemand).not.toContain('docs_lookup')
    // the built-in tools (files, memory, ...) stay up front, in the same order as in Auto
    const builtins = (names: string[]) =>
      names.filter((n) => n !== 'tool_search' && !n.startsWith('docs_'))
    expect(builtins(onDemand)).toEqual(builtins(auto))
    expect(builtins(onDemand)).toContain('read_file')
  })

  test('the workspace default applies to agents without a setting; an agent setting wins', async () => {
    const { url } = startMcp()
    const model = script()
    const server = await boot({ model })
    await connectCustom(server, url, {}, {}, { defaultEnabled: true })

    expect(
      (await call(server, 'PATCH', '/settings', { toolAccess: 'on-demand' })).json.toolAccess,
    ).toBe('on-demand')
    expect(await offered(server, model, 'writer')).not.toContain('docs_lookup')
    expect(await offered(server, model, 'researcher')).not.toContain('docs_lookup')
    // one agent opts out of the default
    await patchAgent(server, 'writer', { toolAccess: 'auto' })
    expect(await offered(server, model, 'writer')).toContain('docs_lookup')
    expect(await offered(server, model, 'researcher')).not.toContain('docs_lookup')
    // back to the workspace default
    expect((await patchAgent(server, 'writer', { toolAccess: null })).json.toolAccess).toBeNull()
    expect(await offered(server, model, 'writer')).not.toContain('docs_lookup')
    // invalid values are refused
    expect((await call(server, 'PATCH', '/settings', { toolAccess: 'sometimes' })).status).toBe(400)
    expect((await patchAgent(server, 'writer', { toolAccess: 'sometimes' })).status).toBe(400)
  })

  test('Auto switches to tool_search once an agent has 20 or more third-party tools', async () => {
    const { url } = startMcp(30) // 32 tools
    const model = script()
    const server = await boot({ model })
    await connectCustom(server, url, {}, {}, { defaultEnabled: true })
    const names = await offered(server, model, 'writer')
    expect(names).toContain('tool_search')
    expect(names).not.toContain('docs_lookup')
    // On demand stays on demand
    await patchAgent(server, 'writer', { toolAccess: 'on-demand' })
    expect(await offered(server, model, 'writer')).toContain('tool_search')
  })
})
