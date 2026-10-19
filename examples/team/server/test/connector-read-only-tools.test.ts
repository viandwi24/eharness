import { describe, expect, test } from 'bun:test'
import { capabilitiesFromTools } from 'eharness/connectors'
import { withReadOnlyTools } from '../src/infra/eh/connector-catalog.ts'

const tools = [
  { name: 'snapshot' },
  { name: 'scroll' },
  { name: 'tap', annotations: { destructiveHint: true } },
  { name: 'lookup', annotations: { readOnlyHint: true } },
]

describe('read-only tools of a connection', () => {
  test('without a list every unannotated tool stays a write', () => {
    const caps = capabilitiesFromTools(withReadOnlyTools(tools, undefined))
    expect(caps.find((c) => c.id === 'read')?.tools).toEqual(['lookup'])
  })

  test('the listed tools become read, the rest keep their class', () => {
    const caps = capabilitiesFromTools(withReadOnlyTools(tools, 'snapshot\n scroll , tap'))
    expect(caps.find((c) => c.id === 'read')?.tools).toEqual([
      'snapshot',
      'scroll',
      'tap',
      'lookup',
    ])
    expect(caps.find((c) => c.id === 'write')).toBeUndefined()
  })

  test('names that the server does not have are ignored; nothing is guessed from names', () => {
    const caps = capabilitiesFromTools(withReadOnlyTools(tools, 'phone_snapshot'))
    expect(caps.find((c) => c.id === 'read')?.tools).toEqual(['lookup'])
    expect(caps.find((c) => c.id === 'write')?.tools).toEqual(['snapshot', 'scroll'])
  })
})
