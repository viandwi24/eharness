/** MCP per agent: validation, secret redaction over HTTP, and the factory wiring against a real
 * (local, in-process) streamable-HTTP MCP server. */
import { afterEach, describe, expect, test } from 'bun:test'
import { scriptedModel } from 'eharness/testing'
import { createAgent } from '../src/app/agents.ts'
import { scriptedModelConfig } from '../src/infra/eh/provider.ts'
import { compose, type Server } from '../src/main.ts'

let server: Server | undefined
let mcp: ReturnType<typeof Bun.serve> | undefined
afterEach(async () => {
  await server?.close()
  mcp?.stop(true)
  server = undefined
  mcp = undefined
})

const post = (path: string, method: string, body: unknown): [string, RequestInit] => [
  path,
  { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
]

/** A minimal MCP server: initialize, tools/list, tools/call; records auth headers and calls. */
function fakeMcp() {
  const seen = { auth: [] as string[], calls: [] as string[] }
  const srv = Bun.serve({
    port: 0,
    async fetch(req) {
      if (req.method !== 'POST') return new Response(null, { status: 405 })
      seen.auth.push(req.headers.get('authorization') ?? '')
      const msg = (await req.json()) as { id?: number; method: string; params?: any }
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
                },
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
  return { srv, seen }
}

describe('MCP servers of an agent', () => {
  test('headers are stored but never returned; an edit without headers keeps them', async () => {
    server = compose({ dbFile: ':memory:', models: scriptedModelConfig('x' as never) })
    const { app, deps } = server
    const created = await app.request(
      ...post('/agents', 'POST', {
        name: 'Github helper',
        instructions: 'Use GitHub.',
        tools: ['mcp'],
        mcpServers: [
          {
            name: 'github',
            transport: {
              type: 'http',
              url: 'https://mcp.example.com/mcp',
              headers: { Authorization: 'Bearer s3cret' },
            },
          },
        ],
      }),
    )
    expect(created.status).toBe(201)
    const body = await created.text()
    expect(body).not.toContain('s3cret')
    const agent = JSON.parse(body) as { id: string; mcpServers: unknown[] }
    expect(agent.mcpServers).toEqual([
      {
        name: 'github',
        transport: {
          type: 'http',
          url: 'https://mcp.example.com/mcp',
          headerNames: ['Authorization'],
        },
      },
    ])
    expect(deps.agents.get(agent.id)?.mcpServers[0]?.transport.headers).toEqual({
      Authorization: 'Bearer s3cret',
    })

    // list, get and patch redact too; a patch without `headers` keeps the stored ones
    expect(await (await app.request('/agents')).text()).not.toContain('s3cret')
    const patched = await app.request(
      ...post(`/agents/${agent.id}`, 'PATCH', {
        mcpServers: [
          { name: 'github', transport: { type: 'sse', url: 'https://mcp.example.com/sse' } },
        ],
      }),
    )
    expect(patched.status).toBe(200)
    expect(await patched.text()).not.toContain('s3cret')
    const stored = deps.agents.get(agent.id)?.mcpServers[0]
    expect(stored?.transport).toMatchObject({
      type: 'sse',
      headers: { Authorization: 'Bearer s3cret' },
    })
  })

  test('rejects stdio, bad names, bad urls and duplicates', async () => {
    server = compose({ dbFile: ':memory:', models: scriptedModelConfig('x' as never) })
    const { app } = server
    const attempt = async (mcpServers: unknown) =>
      (await app.request(...post('/agents', 'POST', { name: 'X', instructions: 'x', mcpServers })))
        .status
    const http = { type: 'http', url: 'https://a.example/mcp' }
    expect(await attempt([{ name: 'a', transport: { type: 'stdio', command: 'ls' } }])).toBe(400)
    expect(await attempt([{ name: 'Bad Name', transport: http }])).toBe(400)
    expect(
      await attempt([{ name: 'a', transport: { type: 'http', url: 'file:///etc/passwd' } }]),
    ).toBe(400)
    expect(
      await attempt([
        { name: 'a', transport: http },
        { name: 'a', transport: http },
      ]),
    ).toBe(400)
    expect(await attempt([{ name: 'a', transport: http }])).toBe(201)
  })

  test('the factory wires mcpServer(): deferred tools, auth header, framed result', async () => {
    const { srv, seen } = fakeMcp()
    mcp = srv
    const model = scriptedModel([
      { toolCalls: [{ toolName: 'tool_search', input: { query: 'lookup' } }] },
      { toolCalls: [{ toolName: 'docs_lookup', input: { q: 'eharness' } }] },
      { text: 'done' },
    ])
    server = compose({ dbFile: ':memory:', models: scriptedModelConfig(model as never) })
    const def = createAgent(server.deps, {
      name: 'Docs helper',
      instructions: 'Use the docs server.',
      tools: ['mcp'],
      permissionMode: 'bypassPermissions',
      mcpServers: [
        {
          name: 'docs',
          transport: {
            type: 'http',
            url: `http://localhost:${srv.port}/mcp`,
            headers: { Authorization: 'Bearer abc' },
          },
        },
      ],
    })
    const session = server.factory.openSession(def, `dm:${def.id}`)
    const result = await session.send('look it up').result
    expect(result.stop).toBe('complete')

    // deferred: `tool_search` is offered, the MCP tool only after it is used
    const first = (model.calls[0]?.tools ?? []).map((t) => t.name)
    expect(first).toContain('tool_search')
    expect(first).not.toContain('docs_lookup')
    expect(seen.calls).toEqual(['lookup'])
    expect(seen.auth.every((a) => a === 'Bearer abc')).toBe(true)
    // untrusted framing reached the model
    expect(JSON.stringify(model.prompts.at(-1))).toContain('<untrusted-content')
  })
})
