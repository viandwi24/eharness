/**
 * Warm tools: a deferred tool the agent called in the last N days loads up front (no `tool_search`
 * round, no prompt-cache reset); the warm set of a chat is fixed when it starts listing its tools.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { tool } from 'ai'
import { defineToolSource, type HarnessContext } from 'eharness'
import { scriptedModel } from 'eharness/testing'
import { z } from 'zod'
import { scriptedModelConfig } from '../src/infra/eh/provider.ts'
import { type ToolUsageStore, warmTools } from '../src/infra/eh/tool-usage.ts'
import { compose, type Server } from '../src/main.ts'

// biome-ignore lint/suspicious/noExplicitAny: loosely typed JSON of the API under test
type Json = Record<string, any>
const DAY = 86_400_000
const dirs: string[] = []
const servers: Server[] = []
const mcps: Array<ReturnType<typeof Bun.serve>> = []
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close()
  for (const m of mcps.splice(0)) m.stop(true)
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const key = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64')

function startMcp(): string {
  const srv = Bun.serve({
    port: 0,
    async fetch(req) {
      if (req.method !== 'POST') return new Response(null, { status: 405 })
      const msg = (await req.json()) as { id?: number; method: string; params: Json }
      if (msg.id === undefined) return new Response(null, { status: 202 })
      const result =
        msg.method === 'initialize'
          ? {
              protocolVersion: msg.params.protocolVersion,
              capabilities: { tools: {} },
              serverInfo: { name: 'fake', version: '1' },
            }
          : msg.method === 'tools/list'
            ? {
                tools: ['lookup', 'create_note'].map((name) => ({
                  name,
                  description: `Tool ${name}.`,
                  ...(name === 'lookup' ? { annotations: { readOnlyHint: true } } : {}),
                  inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
                })),
              }
            : { content: [{ type: 'text', text: 'ok' }] }
      return Response.json({ jsonrpc: '2.0', id: msg.id, result })
    },
  })
  mcps.push(srv)
  return `http://localhost:${srv.port}/mcp`
}

async function boot(model: ReturnType<typeof scriptedModel>): Promise<Server> {
  const d = mkdtempSync(join(tmpdir(), 'team-warm-'))
  dirs.push(d)
  const server = compose({
    dbFile: join(d, 'team.db'),
    models: scriptedModelConfig(model as never),
    env: { TEAM_SECRET_KEY: key },
    changePollMs: 0,
    seed: true,
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
  return { status: res.status, json: (text ? JSON.parse(text) : undefined) as Json }
}

async function connect(server: Server, url: string): Promise<string> {
  const started = await call(server, 'POST', '/connections/flows', {
    definitionId: 'mcp-remote',
    label: 'docs',
    defaultEnabled: true,
  })
  const done = await call(server, 'POST', `/connections/flows/${started.json.flow.id}/act`, {
    viewId: started.json.flow.view.viewId,
    action: 'submit',
    data: { url, authMode: 'none' },
  })
  expect(done.status).toBe(200)
  return done.json.connection.id as string
}

/** Tool names the first model call of a new chat with the `writer` agent sees. */
async function firstTools(
  server: Server,
  model: ReturnType<typeof scriptedModel>,
): Promise<string[]> {
  const writer = server.deps.agents.getBySlug('writer')
  if (writer === undefined) throw new Error('seed')
  await server.factory.prepare(writer)
  const session = server.factory.openSession(writer, `dm:${writer.id}:${crypto.randomUUID()}`)
  await session.send('hi').result
  return (model.calls[0]?.tools ?? []).map((t: { name: string }) => t.name)
}

const use = (server: Server, tool: string, at: number): void => {
  const writer = server.deps.agents.getBySlug('writer')
  server.conn.sqlite.run(
    'INSERT INTO tool_usage (agent_id, tool, last_used_at, calls) VALUES (?, ?, ?, 1)',
    [writer?.id ?? '', tool, at],
  )
}

describe('warm tools (server)', () => {
  test('a tool used yesterday is not deferred in a new chat; an unused or stale one stays deferred', async () => {
    const model = scriptedModel([{ text: 'hi' }])
    const server = await boot(model)
    await call(server, 'PATCH', '/settings', { toolAccess: 'on-demand' })
    await connect(server, startMcp())
    use(server, 'docs_lookup', Date.now() - DAY)
    use(server, 'docs_create_note', Date.now() - 30 * DAY)
    const names = await firstTools(server, model)
    expect(names).toContain('tool_search')
    expect(names).toContain('docs_lookup')
    expect(names).not.toContain('docs_create_note')
  })

  test('0 turns it off: everything stays deferred', async () => {
    const model = scriptedModel([{ text: 'hi' }])
    const server = await boot(model)
    await call(server, 'PATCH', '/settings', { toolAccess: 'on-demand', toolWarmDays: 0 })
    await connect(server, startMcp())
    use(server, 'docs_lookup', Date.now() - DAY)
    const names = await firstTools(server, model)
    expect(names).toContain('tool_search')
    expect(names).not.toContain('docs_lookup')
  })

  test('a finished tool call is recorded for the agent', async () => {
    const model = scriptedModel([
      { toolCalls: [{ toolName: 'tool_search', input: { query: 'lookup' } }] },
      { toolCalls: [{ toolName: 'docs_lookup', input: { q: 'x' } }] },
      { text: 'done' },
    ])
    const server = await boot(model)
    await call(server, 'PATCH', '/settings', { toolAccess: 'on-demand' })
    const id = await connect(server, startMcp())
    const writer = server.deps.agents.getBySlug('writer')
    if (writer === undefined) throw new Error('seed')
    await call(server, 'PUT', `/agents/${writer.id}/connectors`, {
      connections: { [id]: { capabilities: { read: 'allow' } } },
    })
    await server.factory.prepare(writer)
    server.conn.sqlite.run(
      "UPDATE agents SET permission_mode = 'bypassPermissions' WHERE slug = 'writer'",
    )
    const def = server.deps.agents.getBySlug('writer') ?? writer
    const r = await server.factory.openSession(def, `dm:${def.id}`).send('look').result
    expect(r.stop).toBe('complete')
    const rows = server.conn.sqlite
      .query<{ tool: string }, [string]>('SELECT tool FROM tool_usage WHERE agent_id = ?')
      .all(def.id)
    expect(rows.map((r) => r.tool)).toContain('docs_lookup')
  })

  test('the setting round-trips over HTTP with a default of 7 days', async () => {
    const server = await boot(scriptedModel([]))
    expect((await call(server, 'GET', '/settings')).json.toolWarmDays).toBe(7)
    expect((await call(server, 'PATCH', '/settings', { toolWarmDays: 3 })).json.toolWarmDays).toBe(
      3,
    )
    expect((await call(server, 'GET', '/settings')).json.toolWarmDays).toBe(3)
    expect((await call(server, 'PATCH', '/settings', { toolWarmDays: -1 })).status).toBe(400)
    expect((await call(server, 'PATCH', '/settings', { toolWarmDays: 1.5 })).status).toBe(400)
  })
})

describe('warmTools', () => {
  const memory = (): ToolUsageStore & { rows: Map<string, number> } => {
    const rows = new Map<string, number>()
    return {
      rows,
      record: (a, t, at) => void rows.set(`${a}|${t}`, at),
      usedSince: (a, since) =>
        [...rows]
          .filter(([k, at]) => k.startsWith(`${a}|`) && at >= since)
          .map(([k]) => k.slice(a.length + 1)),
    }
  }
  const noop = tool({ description: 'x', inputSchema: z.object({}), execute: () => 'ok' })
  const source = defineToolSource({
    id: 'mcp:docs',
    list: () => ({
      docs_lookup: { ...noop, deferLoading: true },
      docs_create_note: { ...noop, deferLoading: true },
    }),
  })
  const ctxOf = (id: string): HarnessContext => ({ session: { id } }) as unknown as HarnessContext
  const deferred = async (src: typeof source, id: string): Promise<string[]> =>
    Object.entries(await src.list(ctxOf(id)))
      .filter(([, t]) => (t as { deferLoading?: boolean }).deferLoading === true)
      .map(([n]) => n)

  test('the warm set of a chat does not change when a tool is used or found later', async () => {
    const store = memory()
    store.record('a1', 'docs_lookup', Date.now() - 1000)
    const warm = warmTools({ store, days: () => 7 })
    const src = warm.wrap('a1', source)
    expect(await deferred(src, 's1')).toEqual(['docs_create_note'])
    store.record('a1', 'docs_create_note', Date.now())
    expect(await deferred(src, 's1')).toEqual(['docs_create_note'])
    // the next chat starts with both loaded
    expect(await deferred(src, 's2')).toEqual([])
  })

  test('days 0 leaves the source as it is; a source marked defer is deferred except warm tools', async () => {
    const store = memory()
    store.record('a1', 'docs_lookup', Date.now())
    const off = warmTools({ store, days: () => 0 })
    expect(await deferred(off.wrap('a1', source), 's1')).toEqual([
      'docs_lookup',
      'docs_create_note',
    ])
    const whole = defineToolSource({
      id: 'mcp:all',
      defer: true,
      list: () => ({ docs_lookup: noop, docs_create_note: noop }),
    })
    const on = warmTools({ store, days: () => 7 })
    expect(await deferred(on.wrap('a1', whole), 's1')).toEqual(['docs_create_note'])
  })
})
