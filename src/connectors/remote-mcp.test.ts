import { describe, expect, test } from 'bun:test'
import { capabilitiesFromTools, remoteMcpConnector } from './remote-mcp.ts'

describe('capabilitiesFromTools', () => {
  test('every group defaults to ask: readOnlyHint is the server own claim', () => {
    const caps = capabilitiesFromTools([
      { name: 'search', annotations: { readOnlyHint: true } },
      { name: 'create' },
      { name: 'wipe', annotations: { destructiveHint: true } },
    ])
    expect(caps.map((c) => [c.id, c.defaultMode])).toEqual([
      ['read', 'ask'],
      ['write', 'ask'],
      ['destructive', 'ask'],
    ])
  })
})

describe('reviewToolChanges', () => {
  const activateWith = (settings: Record<string, unknown>) => {
    const def = remoteMcpConnector({ listTools: async () => [] })
    const parsed = (def.settings as unknown as { parse(v: unknown): unknown }).parse({
      url: 'https://mcp.example.com/mcp',
      ...settings,
    })
    return (def.activate as (ctx: never) => { pinDefinitions?: boolean })({
      settings: parsed,
      slug: 'phone',
      connection: { getAccessToken: async () => 'x' },
    } as never)
  }

  test('off by default: a server update is used at once (no pinning)', () => {
    expect(activateWith({}).pinDefinitions).toBe(false)
  })

  test('on: the tools a chat first saw are pinned until accepted', () => {
    expect(activateWith({ reviewToolChanges: true }).pinDefinitions).toBe(true)
  })
})
