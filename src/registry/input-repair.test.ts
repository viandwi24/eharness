import { describe, expect, test } from 'bun:test'
import { defineHarnessAgent } from '../agent/define-agent.ts'
import type { HarnessWarning } from '../errors.ts'
import { mcpServerSource } from '../mcp/index.ts'
import { type FakeMcpTool, fakeMcpServer } from '../mcp/test-kit.ts'
import { inMemoryMessages, inMemoryState } from '../storage/memory.ts'
import { scriptedModel } from '../testing/index.ts'

const silent = { debug() {}, info() {}, warn() {}, error() {} }

const schema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    body: { type: 'object' },
    tags: { type: 'array', items: { type: 'string' } },
    free: {},
    either: { anyOf: [{ type: 'string' }, { type: 'object' }] },
    maybe: { type: ['object', 'null'] },
    nested: {
      type: 'object',
      properties: { inner: { type: 'object' }, text: { type: 'string' } },
    },
  },
}

async function run(args: Record<string, unknown>, calls = [args]) {
  const seen: Array<Record<string, unknown>> = []
  const tool: FakeMcpTool = {
    name: 'call_api',
    inputSchema: schema,
    call: (a) => {
      seen.push(a)
      return 'ok'
    },
  }
  const server = fakeMcpServer([tool])
  const warnings: HarnessWarning[] = []
  const agent = defineHarnessAgent({
    model: scriptedModel([
      ...calls.map((input) => ({ toolCalls: [{ toolName: 'api_call_api', input }] })),
      { text: 'done' },
    ]),
    contextWindow: 100_000,
    storage: { messages: inMemoryMessages(), state: inMemoryState() },
    logger: silent,
    onWarning: (w) => warnings.push(w),
    mcp: [mcpServerSource({ name: 'api', transport: () => server.transport() })],
  })
  await agent.session('s1').send('go').result
  await agent.close()
  return { seen, warnings }
}

describe('tool input repair (spec 09 §4.2)', () => {
  test('object and array given as JSON strings are parsed, with one warning each', async () => {
    const { seen, warnings } = await run({ id: 'a', body: '{"title":"x"}', tags: '["a","b"]' })
    expect(seen[0]).toEqual({ id: 'a', body: { title: 'x' }, tags: ['a', 'b'] })
    const repaired = warnings.filter((w) => w.code === 'W_TOOL_INPUT_REPAIRED')
    expect(repaired.map((w) => w.details)).toEqual([
      { tool: 'api_call_api', property: 'body' },
      { tool: 'api_call_api', property: 'tags' },
    ])
  })

  test('the warning is raised once per tool and property', async () => {
    const call = { id: 'a', body: '{"n":1}' }
    const { seen, warnings } = await run(call, [call, call])
    expect(seen).toHaveLength(2)
    expect(warnings.filter((w) => w.code === 'W_TOOL_INPUT_REPAIRED')).toHaveLength(1)
  })

  test('strings, untyped properties, anyOf with string and wrong shapes stay as sent', async () => {
    const input = {
      id: '{"a":1}',
      free: '{"a":1}',
      either: '{"a":1}',
      body: '["not","an","object"]',
      tags: '{"not":"array"}',
    }
    const { seen, warnings } = await run(input)
    expect(seen[0]).toEqual(input)
    expect(warnings.filter((w) => w.code === 'W_TOOL_INPUT_REPAIRED')).toHaveLength(0)
  })

  test('invalid JSON stays untouched', async () => {
    const input = { id: 'a', body: '{"title": ' }
    const { seen } = await run(input)
    expect(seen[0]).toEqual(input)
  })

  test('type: [object, null] and nested object properties are repaired', async () => {
    const { seen, warnings } = await run({
      maybe: '{"k":1}',
      nested: { inner: '{"deep":true}', text: '{"keep":"string"}' },
    })
    expect(seen[0]).toEqual({
      maybe: { k: 1 },
      nested: { inner: { deep: true }, text: '{"keep":"string"}' },
    })
    expect(
      warnings.filter((w) => w.code === 'W_TOOL_INPUT_REPAIRED').map((w) => w.details?.property),
    ).toEqual(['maybe', 'nested.inner'])
  })
})
