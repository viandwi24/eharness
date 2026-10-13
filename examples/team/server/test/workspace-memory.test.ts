import { describe, expect, test } from 'bun:test'
import {
  agentMemoryConnection,
  BUILTIN_MEMORY_WORKSPACE,
  enablementFromTools,
} from '../src/domain/connectors.ts'

describe('workspace memory write', () => {
  test('legacy migration keeps the lead-only rule', () => {
    const role = enablementFromTools(['memory'], { id: 'a1', role: 'custom' })
    expect(role[BUILTIN_MEMORY_WORKSPACE]?.capabilities?.write).toBe('off')
    const lead = enablementFromTools(['memory'], { id: 'a2', role: 'lead' })
    expect(lead[BUILTIN_MEMORY_WORKSPACE]?.capabilities?.write).toBe('allow')
  })

  test('a new agent of any role may write the company memory', () => {
    const custom = enablementFromTools(
      ['memory'],
      { id: 'a3', role: 'custom' },
      { workspaceMemoryWrite: true },
    )
    expect(custom[BUILTIN_MEMORY_WORKSPACE]?.capabilities?.write).toBe('allow')
    expect(custom[agentMemoryConnection('a3')]?.capabilities?.write).toBe('allow')
  })
})
