/**
 * Connection access: register accounts first, then route them to agents (All agents / Selected
 * agents), move them, convert agent-scoped connections, and exclusions in All mode.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { scriptedModel } from 'eharness/testing'
import { scriptedModelConfig } from '../src/infra/eh/provider.ts'
import { compose, type Server } from '../src/main.ts'
import { fakeMcp } from './support/fake-mcp.ts'

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

const mkAgent = async (server: Server, name: string): Promise<string> =>
  (await call(server, 'POST', '/agents', { name, instructions: 'x' })).json.id as string
const addDocs = async (server: Server, name: string, extra: Json = {}): Promise<string> => {
  const made = await call(server, 'POST', '/connectors/custom', {
    name,
    url: plain().url,
    signIn: 'none',
    ...extra,
  })
  expect(made.status).toBe(201)
  return made.json.connection.id as string
}
const accessOf = async (server: Server, id: string): Promise<Json> =>
  (await call(server, 'GET', '/connections')).json.connections.find((c: Json) => c.id === id).access
const toolsOf = async (server: Server, agentId: string): Promise<string[]> => {
  const agent = server.deps.agents.get(agentId)
  if (agent === undefined) throw new Error('agent')
  await server.factory.prepare(agent)
  return Object.keys(server.connectors.activated(agentId)?.toolNameMap ?? {})
    .filter((n) => n.includes('docs'))
    .sort()
}
const put = (server: Server, id: string, body: Json) =>
  call(server, 'PUT', `/connections/${id}/access`, body)

describe('connection access', () => {
  test('register first (no agent), route C to A and D to B, then move C to B', async () => {
    const server = await boot()
    const a = await mkAgent(server, 'Agent A')
    const b = await mkAgent(server, 'Agent B')
    const c = await addDocs(server, 'Docs C')
    const d = await addDocs(server, 'Docs D')
    // registered but used by nobody
    expect(await accessOf(server, c)).toEqual({
      mode: 'selected',
      agentIds: [],
      excludedAgentIds: [],
    })
    expect(await toolsOf(server, a)).toEqual([])

    expect(
      (await put(server, c, { mode: 'selected', agentIds: [a] })).json.access.agentIds,
    ).toEqual([a])
    await put(server, d, { mode: 'selected', agentIds: [b] })
    expect(await toolsOf(server, a)).toEqual(['docs-c_create_note', 'docs-c_lookup'])
    expect(await toolsOf(server, b)).toEqual(['docs-d_create_note', 'docs-d_lookup'])

    // the agent's own tab sees the same
    const viewA = (await call(server, 'GET', `/agents/${a}/connectors`)).json.connectors
    expect(viewA.find((v: Json) => v.connectionId === c).enabled).toBe(true)
    expect(viewA.find((v: Json) => v.connectionId === d).enabled).toBe(false)

    // move C from A to B: just change the list
    await put(server, c, { mode: 'selected', agentIds: [b] })
    expect(await toolsOf(server, a)).toEqual([])
    const onB = await toolsOf(server, b)
    expect(onB.some((n) => n.startsWith('docs-c_'))).toBe(true)
    expect(onB.some((n) => n.startsWith('docs-d_'))).toBe(true)
    expect(await accessOf(server, c)).toMatchObject({ mode: 'selected', agentIds: [b] })

    // unknown agents are refused
    expect((await put(server, c, { mode: 'selected', agentIds: ['nope'] })).status).toBe(400)
    // built-ins have no access control
    const builtin = (await call(server, 'GET', '/connections')).json.connections.find(
      (x: Json) => x.builtin,
    )
    expect(builtin.access).toBeUndefined()
    expect((await put(server, builtin.id, { mode: 'all' })).status).toBe(409)
  })

  test('All mode lists the agents that turned it off; going back to Selected forgets them', async () => {
    const server = await boot()
    const a = await mkAgent(server, 'Agent A')
    const b = await mkAgent(server, 'Agent B')
    const c = await addDocs(server, 'Docs C', { availableToAll: true })
    const lead = server.deps.agents.getBySlug('lead')?.id as string
    expect((await accessOf(server, c)).mode).toBe('all')
    const everyone = (await accessOf(server, c)).agentIds
    expect(everyone).toEqual(expect.arrayContaining([a, b, lead]))

    // agent B opts out in its own tab
    await call(server, 'PUT', `/agents/${b}/connectors`, {
      connections: { [c]: { enabled: 'off' } },
    })
    expect(await accessOf(server, c)).toMatchObject({ mode: 'all', excludedAgentIds: [b] })
    expect((await toolsOf(server, b)).length).toBe(0)
    expect((await toolsOf(server, a)).length).toBe(2)
    // Selected [A] then back to All: B is no longer excluded
    await put(server, c, { mode: 'selected', agentIds: [a] })
    expect(await accessOf(server, c)).toMatchObject({ mode: 'selected', agentIds: [a] })
    await put(server, c, { mode: 'all' })
    expect((await accessOf(server, c)).excludedAgentIds).toEqual([])
    // excluded list can be set directly
    await put(server, c, { mode: 'all', excludedAgentIds: [a] })
    expect((await accessOf(server, c)).excludedAgentIds).toEqual([a])
  })

  test('an agent-scoped connection is Selected = [agent]; adding agents converts it keeping id, slug, tool names and modes', async () => {
    const server = await boot()
    const a = await mkAgent(server, 'Agent A')
    const b = await mkAgent(server, 'Agent B')
    const c = await addDocs(server, 'Docs C', { scope: 'agent', scopeId: a })
    expect(await accessOf(server, c)).toEqual({
      mode: 'selected',
      agentIds: [a],
      excludedAgentIds: [],
    })
    // agent A restricts writes
    await call(server, 'PUT', `/agents/${a}/connectors`, {
      connections: { [c]: { capabilities: { write: 'off' } } },
    })
    const before = await toolsOf(server, a)
    expect(before).toEqual(['docs-c_create_note', 'docs-c_lookup'])
    const slug = (await server.connectors.stores.connections.get(c))?.slug

    const res = await put(server, c, { mode: 'selected', agentIds: [a, b] })
    expect(res.json).toMatchObject({ id: c, scope: 'workspace', defaultEnabled: false })
    expect(res.json.scopeId).toBeUndefined()
    expect(res.json.access.agentIds.sort()).toEqual([a, b].sort())
    expect((await server.connectors.stores.connections.get(c))?.slug).toBe(slug)
    // A keeps its tool names and its own mode; B gets the connector defaults
    expect(await toolsOf(server, a)).toEqual(before)
    expect((await toolsOf(server, b)).length).toBe(2)
    const mode = async (agent: string): Promise<string> =>
      (await call(server, 'GET', `/agents/${agent}/connectors`)).json.connectors
        .find((v: Json) => v.connectionId === c)
        .capabilities.find((k: Json) => k.id === 'write').mode
    expect(await mode(a)).toBe('off')
    expect(await mode(b)).not.toBe('off')

    // the same for an agent-scoped connection moved to another agent only
    const d = await addDocs(server, 'Docs D', { scope: 'agent', scopeId: a })
    await put(server, d, { mode: 'selected', agentIds: [b] })
    expect(await toolsOf(server, a)).toEqual(before)
    expect(await accessOf(server, d)).toMatchObject({ agentIds: [b] })
  })

  test('initial access when registering, and the agent tab removes an agent without deleting the account', async () => {
    const server = await boot()
    const a = await mkAgent(server, 'Agent A')
    const c = await addDocs(server, 'Docs C', { agentIds: [a] })
    expect(await accessOf(server, c)).toMatchObject({ mode: 'selected', agentIds: [a] })
    await call(server, 'PUT', `/agents/${a}/connectors`, {
      connections: { [c]: { enabled: 'off' } },
    })
    expect(await accessOf(server, c)).toMatchObject({ mode: 'selected', agentIds: [] })
    expect(
      (await call(server, 'GET', '/connections')).json.connections.some((x: Json) => x.id === c),
    ).toBe(true)
  })
})
