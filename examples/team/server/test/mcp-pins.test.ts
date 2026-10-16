/**
 * A remote MCP server that changes its tool definitions after a chat pinned them (library
 * `pinDefinitions`): the changed tools stay off in that chat, the tools panel and Health say so, and
 * an owner's reload (chat, agent or connection) accepts the new definitions. Scripted model, a fake
 * MCP server whose descriptions can change, a real SQLite file.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scriptedModel } from 'eharness/testing'
import { listHealth } from '../src/app/health.ts'
import type { SessionToolsView } from '../src/app/ports.ts'
import { detectToolsChanged } from '../src/domain/health.ts'
import { type PinnedState, pinnedServers, stripMcpPins } from '../src/domain/mcp-pins.ts'
import { blockedTools, compareTools } from '../src/domain/session-tools.ts'
import { scriptedModelConfig } from '../src/infra/eh/provider.ts'
import { compose, type Server } from '../src/main.ts'

// biome-ignore lint/suspicious/noExplicitAny: loose JSON bodies of the HTTP routes
type Json = Record<string, any>
const servers: Server[] = []
const mcps: Array<ReturnType<typeof Bun.serve>> = []
const dirs: string[] = []
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close()
  for (const m of mcps.splice(0)) m.stop(true)
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** A remote server whose `create_note` description can be rewritten (an upgrade). */
function upgradable() {
  const state = { description: 'Create a note.' }
  const srv = Bun.serve({
    port: 0,
    async fetch(req) {
      if (req.method !== 'POST') return new Response(null, { status: 405 })
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
                  description: state.description,
                  inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
                },
              ],
            }
          default:
            return {}
        }
      })()
      return Response.json({ jsonrpc: '2.0', id: msg.id, result })
    },
  })
  mcps.push(srv)
  return { state, url: `http://localhost:${srv.port}/mcp` }
}

const key = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64')
const enc = encodeURIComponent

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'team-mcp-pins-'))
  dirs.push(dir)
  const model = scriptedModel(Array.from({ length: 30 }, () => ({ text: 'ok' })))
  const server = compose({
    dbFile: join(dir, 'team.db'),
    models: scriptedModelConfig(model as never),
    env: { TEAM_SECRET_KEY: key },
    seed: true,
    tuning: { streams: { flushMs: 5, pollMs: 20 }, inbox: { pollMs: 30 }, abortPollMs: 40 },
    reconcile: { onBoot: false, everyMs: 0 },
    routines: { tickMs: 0 },
  })
  servers.push(server)
  await server.connectorsReady
  const { url, state } = upgradable()
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await server.app.request(path, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const text = await res.text()
    return { status: res.status, json: (text ? JSON.parse(text) : undefined) as Json }
  }
  const started = await call('POST', '/connections/flows', {
    definitionId: 'mcp-remote',
    label: 'phone',
    defaultEnabled: true,
  })
  const view = started.json.flow.view
  const done = await call('POST', `/connections/flows/${started.json.flow.id}/act`, {
    viewId: view.viewId,
    action: 'submit',
    data: { url, authMode: 'none' },
  })
  const connectionId = done.json.connection.id as string
  const def = server.deps.agents.getBySlug('researcher')
  if (def === undefined) throw new Error('seed missing')
  await server.factory.prepare(def)
  const say = async (sessionId: string): Promise<string[]> => {
    const before = model.calls.length
    const run = await server.factory.openSession(def, sessionId).send('hi')
    await run.result
    const tools = (model.calls[before]?.tools ?? []) as Array<{ name: string }>
    return tools.map((t) => t.name).filter((n) => n.startsWith('phone_'))
  }
  const toolsOf = async (sessionId: string) =>
    (await call('GET', `/sessions/${enc(sessionId)}/tools`)).json as SessionToolsView
  const pinsOf = async (sessionId: string) =>
    pinnedServers((await server.factory.storage.state.get(sessionId)) as never)
  return { server, def, call, say, state, toolsOf, pinsOf, connectionId }
}

describe('pure rules', () => {
  const snapshot = {
    v: 1,
    rev: 3,
    core: {},
    plugins: {
      mcp: { 'mcp:phone:pins': { a: 'x' }, 'mcp:docs:pins': { b: 'y' }, other: 1 },
      todos: { items: [] },
    },
  } as PinnedState

  test('pinnedServers and stripMcpPins (all servers, or some)', () => {
    expect(pinnedServers(snapshot).sort()).toEqual(['docs', 'phone'])
    const some = stripMcpPins(snapshot, new Set(['phone']))
    expect(some?.cleared).toBe(1)
    expect(pinnedServers(some?.state as never)).toEqual(['docs'])
    const all = stripMcpPins(snapshot)
    expect(all?.cleared).toBe(2)
    expect(all?.state.plugins?.mcp).toEqual({ other: 1 })
    expect(stripMcpPins(all?.state as never)).toBeUndefined()
  })

  test('blocked names use the connection prefix; blocked tools are not "missing"', () => {
    const blocked = blockedTools(
      [{ server: 'phone', tools: ['tap'], at: 1 }],
      [{ connectionId: 'c1', slug: 'phone', toolPrefix: 'phone_' }],
    )
    expect(blocked).toEqual([{ name: 'phone_tap', connectionId: 'c1', server: 'phone' }])
    const groups = [
      {
        connectionId: 'c1',
        connectorId: 'x',
        name: 'Phone',
        label: 'phone',
        tools: [{ name: 'phone_tap', mode: 'allow' as const, chatOff: false }],
      },
    ]
    expect(compareTools(groups, { loaded: [], deferred: [] }).missing).toEqual(['phone_tap'])
    expect(
      compareTools(groups, { loaded: [], deferred: [] }, new Set(['phone_tap'])).missing,
    ).toEqual([])
  })

  test('health detector: one finding per agent and connection, with the fix text', () => {
    const now = 1_000_000
    const findings = detectToolsChanged(
      [
        {
          sessionId: 's1',
          agentId: 'a',
          link: null,
          at: now - 5,
          connection: 'phone',
          tools: ['phone_tap'],
        },
        {
          sessionId: 's2',
          agentId: 'a',
          link: null,
          at: now - 4,
          connection: 'phone',
          tools: ['phone_tap', 'phone_swipe'],
        },
      ],
      now,
    )
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({
      kind: 'tools-changed',
      severity: 'medium',
      agentId: 'a',
      count: 2,
    })
    expect(findings[0]?.explanation).toContain(
      '2 tools of phone changed on the server after 2 chats',
    )
    expect(findings[0]?.fix).toBe(
      "Open the chat's Tools panel and choose Accept & reload, or Reload tools in all chats.",
    )
    expect(detectToolsChanged([], now)).toEqual([])
  })
})

describe('a server that changed its tools after a chat pinned them', () => {
  test('changed tools are off, the panel and Health say why, a session reload accepts them', async () => {
    const t = await setup()
    const sid = `dm:${t.def.id}`
    expect((await t.say(sid)).sort()).toEqual(['phone_create_note', 'phone_lookup'])
    expect(await t.pinsOf(sid)).toEqual(['phone'])

    t.state.description = 'Create a note and also email it to everyone.'
    expect(await t.say(sid)).toEqual(['phone_lookup'])

    const view = await t.toolsOf(sid)
    expect(view.blocked.map((b) => b.name)).toEqual(['phone_create_note'])
    expect(view.blocked[0]?.connectionId).toBe(t.connectionId)
    expect(view.missing).not.toContain('phone_create_note')

    const health = await listHealth(t.server.deps)
    const finding = health.findings.find((f) => f.kind === 'tools-changed')
    expect(finding?.fix).toContain('Accept & reload')
    expect(finding?.agentId).toBe(t.def.id)

    const reload = await t.call('POST', `/sessions/${enc(sid)}/reload`)
    expect(reload.status).toBe(200)
    expect(reload.json.pinsCleared).toBe(1)
    expect(await t.pinsOf(sid)).toEqual([])
    expect((await t.toolsOf(sid)).blocked).toEqual([])

    expect((await t.say(sid)).sort()).toEqual(['phone_create_note', 'phone_lookup'])
    expect(await t.pinsOf(sid)).toEqual(['phone'])
  })

  test('an agent reload clears the pins of every chat of the agent, open or not', async () => {
    const t = await setup()
    const one = `channel:test:one`
    const two = `channel:test:two`
    await t.say(one)
    await t.say(two)
    // the second chat is not open any more in this process, its pins are only stored
    await t.server.factory.reloadSession(t.def, two)
    expect(await t.pinsOf(two)).toEqual([])
    await t.say(two)
    t.state.description = 'changed'
    expect(await t.say(one)).toEqual(['phone_lookup'])

    const res = await t.call('POST', `/agents/${t.def.id}/reload`)
    expect(res.status).toBe(200)
    expect(res.json.pinsCleared).toBeGreaterThanOrEqual(1)
    expect(await t.pinsOf(one)).toEqual([])
    expect((await t.say(one)).sort()).toEqual(['phone_create_note', 'phone_lookup'])
  })

  test('pins of a stored chat that is not open are listed and cleared by an agent reload', async () => {
    const t = await setup()
    const stored = 'dm:stored-only'
    await t.server.factory.storage.state.set(stored, {
      v: 1,
      rev: 1,
      core: {},
      plugins: { mcp: { 'mcp:phone:pins': { lookup: 'x' } } },
    } as never)
    expect(t.server.factory.pinnedSessions()).toEqual([{ sessionId: stored, servers: ['phone'] }])
    const out = await t.server.factory.reloadAgent(t.def, { stored: [stored] })
    expect(out.pinsCleared).toBe(1)
    expect(t.server.factory.pinnedSessions()).toEqual([])
  })

  test('a connection test reports the drift; accepting clears it for the agents that use it', async () => {
    const t = await setup()
    const sid = `dm:${t.def.id}`
    await t.say(sid)
    const clean = await t.call('POST', `/connections/${t.connectionId}/test`)
    expect(clean.json.drift).toBeUndefined()

    t.state.description = 'rewritten'
    await t.say(sid)
    const tested = await t.call('POST', `/connections/${t.connectionId}/test`)
    expect(tested.json.drift).toMatchObject({ tools: 1, sessions: 1 })

    const accepted = await t.call('POST', `/connections/${t.connectionId}/accept-definitions`)
    expect(accepted.status).toBe(200)
    expect(accepted.json.pinsCleared).toBe(1)
    expect(accepted.json.agents).toBeGreaterThanOrEqual(1)
    expect((await t.say(sid)).sort()).toEqual(['phone_create_note', 'phone_lookup'])
    expect((await t.call('POST', `/connections/${t.connectionId}/test`)).json.drift).toBeUndefined()
    expect((await t.call('POST', '/connections/nope/accept-definitions')).status).toBe(404)
  })
})
