/** MCP servers and project skills as wired by `createAgents` (agent.ts): tools, approvals, trust, failures. */
import { afterEach, describe, expect, test } from 'bun:test'
import type { HarnessSession } from 'eharness'
import { scriptedModel } from 'eharness/testing'
import { driveTurn } from '../src/agents/index.ts'
import type { CoderMessage } from '../src/contracts.ts'
import { makeAgentsEnv, nextPending } from './helpers.ts'

// ─── a minimal MCP server over HTTP (JSON responses), in this process ───

interface FakeMcp {
  url: string
  calls: Array<{ tool: string; args: unknown }>
  stop(): void
}

function startMcp(tools: Array<{ name: string; description: string }>): FakeMcp {
  const calls: FakeMcp['calls'] = []
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      if (req.method !== 'POST') return new Response('', { status: 405 })
      const body = (await req.json()) as {
        id?: number
        method: string
        params?: { name?: string; arguments?: unknown; protocolVersion?: string }
      }
      if (body.id === undefined) return new Response(null, { status: 202 })
      const reply = (result: unknown): Response =>
        Response.json({ jsonrpc: '2.0', id: body.id, result })
      switch (body.method) {
        case 'initialize':
          return reply({
            protocolVersion: body.params?.protocolVersion ?? '2025-03-26',
            capabilities: { tools: {} },
            serverInfo: { name: 'fake', version: '1.0.0' },
          })
        case 'tools/list':
          return reply({
            tools: tools.map((t) => ({
              ...t,
              inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
            })),
          })
        case 'tools/call':
          calls.push({ tool: body.params?.name ?? '', args: body.params?.arguments })
          return reply({
            content: [
              {
                type: 'text',
                text: `echo: ${(body.params?.arguments as { text?: string })?.text ?? ''}`,
              },
            ],
          })
        default:
          return Response.json({
            jsonrpc: '2.0',
            id: body.id,
            error: { code: -32601, message: 'no such method' },
          })
      }
    },
  })
  return { url: `http://127.0.0.1:${server.port}/mcp`, calls, stop: () => void server.stop(true) }
}

let servers: FakeMcp[] = []
afterEach(() => {
  for (const s of servers) s.stop()
  servers = []
})

const names = (model: { calls: Array<{ tools?: unknown }> }, i = 0): string[] =>
  ((model.calls[i]?.tools ?? []) as Array<{ name: string }>).map((t) => t.name)

async function runTurn(
  env: Awaited<ReturnType<typeof makeAgentsEnv>>,
  text: string,
  approve?: boolean,
) {
  const session = env.agents.main.session('s1') as never as HarnessSession<CoderMessage>
  const turn = driveTurn(session.send(text), {
    session,
    broker: env.broker,
    permissions: env.permissions,
    describe: env.describe,
    stopOnBareDeny: true,
  })
  if (approve !== undefined) {
    const request = await nextPending(env.broker)
    env.broker.answer(request.id, { approved: approve })
    return { result: await turn, request }
  }
  return { result: await turn, request: undefined }
}

describe('MCP servers (config.mcpServers)', () => {
  test('server tools are prefixed, listed after the built-ins and ask before they run', async () => {
    const mcp = startMcp([{ name: 'echo', description: 'Echo the text' }])
    servers.push(mcp)
    const model = scriptedModel([
      { toolCalls: [{ toolName: 'docs_echo', input: { text: 'hi' } }] },
      { text: 'done' },
    ])
    const env = await makeAgentsEnv({
      model,
      mcpServers: { docs: { type: 'http', url: mcp.url, defer: false } },
    })
    const { result, request } = await runTurn(env, 'use docs', true)
    expect(result.stop).toBe('complete')
    expect(request?.toolName).toBe('docs_echo')
    expect(mcp.calls).toEqual([{ tool: 'echo', args: { text: 'hi' } }])
    const tools = names(model)
    expect(tools).toContain('docs_echo')
    // static tools first, MCP tools after them (prompt-cache prefix)
    expect(tools.indexOf('bash')).toBeLessThan(tools.indexOf('docs_echo'))
    // the result reaches the model, framed as untrusted content
    const last = JSON.stringify(model.prompts.at(-1))
    expect(last).toContain('echo: hi')
    expect(last).toContain('untrusted-content')
  })

  test('a denied MCP call never reaches the server', async () => {
    const mcp = startMcp([{ name: 'echo', description: 'Echo the text' }])
    servers.push(mcp)
    const model = scriptedModel([
      { toolCalls: [{ toolName: 'docs_echo', input: { text: 'hi' } }] },
      { text: 'ok' },
    ])
    const env = await makeAgentsEnv({
      model,
      mcpServers: { docs: { type: 'http', url: mcp.url, defer: false } },
    })
    await runTurn(env, 'use docs', false)
    expect(mcp.calls).toEqual([])
  })

  test('deferTools: the tool is hidden until tool_search finds it (server default)', async () => {
    const mcp = startMcp([{ name: 'echo', description: 'Echo the text' }])
    servers.push(mcp)
    const model = scriptedModel([{ text: 'nothing needed' }])
    const env = await makeAgentsEnv({
      model,
      mcpServers: { docs: { type: 'http', url: mcp.url } },
    })
    await runTurn(env, 'hello')
    expect(names(model)).not.toContain('docs_echo')
    expect(names(model)).toContain('tool_search')
  })

  test('an invalid server entry is skipped with a warning; the others still work', async () => {
    const mcp = startMcp([{ name: 'echo', description: 'Echo the text' }])
    servers.push(mcp)
    const model = scriptedModel([{ text: 'hi' }])
    const env = await makeAgentsEnv({
      model,
      mcpServers: {
        bad: { type: 'telepathy' },
        docs: { type: 'http', url: mcp.url, defer: false },
      },
    })
    const { result } = await runTurn(env, 'hello')
    expect(result.stop).toBe('complete')
    expect(names(model)).toContain('docs_echo')
    const text = JSON.stringify(env.warnings)
    expect(text).toContain('bad')
  })

  test('an unreachable server is a warning, not a crash: the turn still completes', async () => {
    const model = scriptedModel([{ text: 'fine without it' }])
    const env = await makeAgentsEnv({
      model,
      mcpServers: { gone: { type: 'http', url: 'http://127.0.0.1:1/mcp', defer: false } },
    })
    const { result } = await runTurn(env, 'hello')
    expect(result.stop).toBe('complete')
    expect(names(model)).not.toContain('gone_echo')
    expect(JSON.stringify(env.warnings)).toContain('gone')
  })
})

describe('project skills (.coder/skills)', () => {
  const skill = {
    '.coder/skills/pdf/SKILL.md':
      '---\nname: pdf\ndescription: Work with PDF files\n---\n# PDF\nUse pdftotext for extraction.\n',
    '.coder/skills/pdf/notes.md': 'Extra notes for the pdf skill.',
  }

  test('a trusted project: the model sees the skill tools and loads a skill', async () => {
    const model = scriptedModel([
      { toolCalls: [{ toolName: 'load_skill', input: { name: 'pdf' } }] },
      { text: 'loaded' },
    ])
    const env = await makeAgentsEnv({ model, files: skill, flags: { trustProject: true } })
    const { result } = await runTurn(env, 'extract the text')
    expect(result.stop).toBe('complete')
    expect(names(model)).toContain('load_skill')
    expect(JSON.stringify(model.prompts[0])).toContain('Work with PDF files')
    expect(JSON.stringify(model.prompts.at(-1))).toContain('pdftotext')
  })

  test('an untrusted project: skills are not loaded at all', async () => {
    const model = scriptedModel([{ text: 'no skills here' }])
    const env = await makeAgentsEnv({ model, files: skill })
    expect(env.config.trusted).toBe(false)
    await runTurn(env, 'hello')
    expect(names(model)).not.toContain('load_skill')
    expect(JSON.stringify(model.prompts[0])).not.toContain('Work with PDF files')
  })

  test('a project without a skills directory has no skill tools', async () => {
    const model = scriptedModel([{ text: 'plain' }])
    const env = await makeAgentsEnv({
      model,
      files: { 'a.txt': 'a' },
      flags: { trustProject: true },
    })
    await runTurn(env, 'hello')
    expect(names(model)).not.toContain('load_skill')
  })
})
