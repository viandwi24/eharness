import { describe, expect, test } from 'bun:test'
import { capabilitiesFromTools } from './remote-mcp.ts'

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
