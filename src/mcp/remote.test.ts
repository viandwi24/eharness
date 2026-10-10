import { describe, expect, test } from 'bun:test'
import * as aiSdkMcp from '@ai-sdk/mcp'
import {
  bearerAuthProvider,
  createRemoteMcpSource,
  listRemoteMcpTools,
  remoteMcpSource,
  remoteMcpTransport,
} from './remote.ts'
import { fakeMcpServer } from './test-kit.ts'

describe('remote MCP helpers', () => {
  test('bearerAuthProvider asks for a fresh token on every call', async () => {
    let n = 0
    const provider = bearerAuthProvider(async () => `token-${++n}`)
    expect((await provider.tokens())?.access_token).toBe('token-1')
    expect((await provider.tokens())?.access_token).toBe('token-2')
    expect(() => provider.redirectToAuthorization(new URL('https://x.example.com'))).toThrow(
      'reconnect',
    )
  })

  test('transport config: url, headers copy, auth provider only with a token function', () => {
    const headers = { 'x-api-key': 'k' }
    const plain = remoteMcpTransport({ name: 'a', url: 'https://mcp.example.com/mcp', headers })
    expect(plain).toEqual({
      type: 'http',
      url: 'https://mcp.example.com/mcp',
      headers: { 'x-api-key': 'k' },
    })
    expect((plain as { headers: object }).headers).not.toBe(headers)
    const authed = remoteMcpTransport({
      name: 'a',
      url: 'https://mcp.example.com/mcp',
      getAccessToken: async () => 't',
    })
    expect((authed as { authProvider?: unknown }).authProvider).toBeDefined()
  })

  test('remoteMcpSource is a tool source named mcp:<name>', () => {
    const source = remoteMcpSource({
      kind: 'mcp',
      name: 'docs',
      url: 'https://mcp.example.com/mcp',
      prefix: '',
    })
    expect(source.id).toBe('mcp:docs')
  })

  test('the source lists tools through a transport built from the spec', async () => {
    const server = fakeMcpServer([{ name: 'search', description: 'Search.' }])
    const source = createRemoteMcpSource(
      { name: 'docs', url: 'https://mcp.example.com/mcp', prefix: 'docs_' },
      async () => ({
        createMCPClient: (config) =>
          aiSdkMcp.createMCPClient({ ...config, transport: server.transport() }),
      }),
    )
    const ctx = {
      signal: new AbortController().signal,
      log: { warn() {}, debug() {}, info() {}, error() {} },
      agent: { id: 'a' },
      session: { id: 's' },
      state: { get() {}, set() {} },
      warn() {},
    } as never
    await source.open?.(ctx)
    expect(Object.keys(await source.list(ctx))).toEqual(['docs_search'])
  })

  test('listRemoteMcpTools returns names, descriptions and annotations, and closes the client', async () => {
    const server = fakeMcpServer([
      { name: 'search', description: 'Search.', annotations: { readOnlyHint: true } },
      { name: 'drop', annotations: { destructiveHint: true } },
    ])
    const tools = await listRemoteMcpTools({ url: 'https://mcp.example.com/mcp' }, async () => ({
      createMCPClient: (config) =>
        aiSdkMcp.createMCPClient({ ...config, transport: server.transport() }),
    }))
    expect(tools.map((t) => t.name).sort()).toEqual(['drop', 'search'])
    expect(tools.find((t) => t.name === 'search')?.annotations?.readOnlyHint).toBe(true)
    expect(server.closed).toBe(1)
  })
})
