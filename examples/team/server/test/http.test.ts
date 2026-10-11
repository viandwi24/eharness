/** HTTP e2e of the M1 routes through `app.request()` (no network). */
import { afterEach, describe, expect, test } from 'bun:test'
import { scriptedModelConfig } from '../src/infra/eh/provider.ts'
import { compose, type Server } from '../src/main.ts'

let server: Server | undefined
afterEach(async () => {
  await server?.close()
  server = undefined
})

function boot(token?: string): Server {
  server = compose({
    dbFile: ':memory:',
    token,
    models: scriptedModelConfig('x' as never),
  })
  return server
}

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

describe('agents API', () => {
  test('seeds a lead and role agents with distinct connector choices', async () => {
    const res = await boot().app.request('/agents')
    expect(res.status).toBe(200)
    const { agents } = (await res.json()) as {
      agents: Array<{ slug: string; role: string; connectors: Record<string, unknown> }>
    }
    expect(agents.map((a) => a.slug)).toEqual(['lead', 'researcher', 'writer', 'analyst', 'ops'])
    expect(agents.filter((a) => a.role === 'lead')).toHaveLength(1)
    expect(new Set(agents.map((a) => JSON.stringify(a.connectors))).size).toBe(agents.length)
  })

  test('create, get by slug, patch bumps the version, archive hides it', async () => {
    const { app } = boot()
    const created = await app.request(
      '/agents',
      json({ name: 'Data Cleaner', instructions: 'Clean data.' }),
    )
    expect(created.status).toBe(201)
    const agent = (await created.json()) as {
      id: string
      slug: string
      version: number
      role: string
    }
    expect(agent.slug).toBe('data-cleaner')
    expect(agent.role).toBe('custom')

    const bySlug = await app.request(`/agents/${agent.slug}`)
    expect(bySlug.status).toBe(200)

    const patched = await app.request(`/agents/${agent.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ instructions: 'Clean data carefully.' }),
    })
    expect(((await patched.json()) as { version: number }).version).toBe(2)

    const del = await app.request(`/agents/${agent.id}`, { method: 'DELETE' })
    expect(del.status).toBe(200)
    const list = (await (await app.request('/agents')).json()) as { agents: Array<{ id: string }> }
    expect(list.agents.some((a) => a.id === agent.id)).toBe(false)
    const all = (await (await app.request('/agents?includeArchived=true')).json()) as {
      agents: Array<{ id: string }>
    }
    expect(all.agents.some((a) => a.id === agent.id)).toBe(true)
  })

  test('errors use one shape: validation 400, unknown mode 400, 404, slug conflict 409, lead protected', async () => {
    const { app } = boot()
    const bad = await app.request('/agents', json({ name: '', instructions: 'x' }))
    expect(bad.status).toBe(400)
    expect(((await bad.json()) as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR')

    const tool = await app.request(
      '/agents',
      json({
        name: 'X',
        instructions: 'x',
        connectors: { 'builtin:files': { capabilities: { read: 'rm_rf' } } },
      }),
    )
    expect(tool.status).toBe(400)

    const delegate = await app.request(
      '/agents',
      json({
        name: 'Y',
        instructions: 'x',
        connectors: { 'builtin:team': { enabled: 'on' } },
      }),
    )
    expect(delegate.status).toBe(400)
    expect(((await delegate.json()) as { error: { code: string } }).error.code).toBe('INVALID')

    const missing = await app.request('/agents/nope')
    expect(missing.status).toBe(404)
    expect(((await missing.json()) as { error: { code: string } }).error.code).toBe('NOT_FOUND')

    const dup = await app.request('/agents', json({ name: 'Z', slug: 'writer', instructions: 'x' }))
    expect(dup.status).toBe(409)

    const lead = await app.request('/agents/lead', { method: 'DELETE' })
    expect(lead.status).toBe(409)

    const route = await app.request('/nothing')
    expect(route.status).toBe(404)
  })
})

describe('system routes', () => {
  test('health, openapi 3.1 document and docs page', async () => {
    const { app } = boot()
    const health = await app.request('/health')
    expect(health.status).toBe(200)
    expect(typeof ((await health.json()) as { boot: string }).boot).toBe('string')
    const doc = (await (await app.request('/openapi.json')).json()) as {
      openapi: string
      paths: Record<string, unknown>
      components: { schemas: Record<string, unknown>; securitySchemes: Record<string, unknown> }
    }
    expect(doc.openapi).toBe('3.1.0')
    expect(Object.keys(doc.paths)).toEqual(
      expect.arrayContaining([
        '/health',
        '/agents',
        '/agents/{id}',
        '/connectors',
        '/agents/{id}/connectors',
      ]),
    )
    expect(Object.keys(doc.components.schemas)).toEqual(
      expect.arrayContaining(['Agent', 'AgentCreate', 'AgentPatch', 'Error']),
    )
    expect(doc.components.securitySchemes.Bearer).toBeDefined()
    const docs = await app.request('/docs')
    expect(docs.status).toBe(200)
    expect(await docs.text()).toContain('/openapi.json')
  })

  test('bearer token: required when TEAM_TOKEN is set, health and docs stay open', async () => {
    const { app } = boot('s3cret')
    expect((await app.request('/agents')).status).toBe(401)
    expect(
      (await app.request('/agents', { headers: { authorization: 'Bearer wrong' } })).status,
    ).toBe(401)
    expect(
      (await app.request('/agents', { headers: { authorization: 'Bearer s3cret' } })).status,
    ).toBe(200)
    expect((await app.request('/health')).status).toBe(200)
    expect((await app.request('/openapi.json')).status).toBe(200)
  })
})

describe('CSRF guard', () => {
  test('a state-changing request from a foreign Origin is refused, the web origin and no Origin pass', async () => {
    const { app } = boot()
    const post = (origin?: string): Promise<Response> =>
      Promise.resolve(
        app.request('/agents', {
          ...json({}),
          headers: {
            'content-type': 'application/json',
            ...(origin === undefined ? {} : { origin }),
          },
        }),
      )
    const evil = await post('https://evil.example')
    expect(evil.status).toBe(403)
    expect(((await evil.json()) as { error: { code: string } }).error.code).toBe('FORBIDDEN_ORIGIN')
    expect((await post('http://localhost:5173')).status).not.toBe(403)
    expect((await post()).status).not.toBe(403)
    const get = await app.request('/agents', { headers: { origin: 'https://evil.example' } })
    expect(get.status).toBe(200)
  })
})
