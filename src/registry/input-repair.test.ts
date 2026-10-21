import { describe, expect, test } from 'bun:test'
import { tool } from 'ai'
import { z } from 'zod'
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

  test('JSON Schema tools: numbers become strings, clean number strings become numbers, per item', async () => {
    const seen: Array<Record<string, unknown>> = []
    const server = fakeMcpServer([
      {
        name: 'typed',
        inputSchema: {
          type: 'object',
          properties: {
            ids: { type: 'array', items: { type: 'string' } },
            count: { type: 'integer' },
            ratio: { type: 'number' },
            either: { type: ['string', 'number'] },
            short: { type: 'string', maxLength: 2 },
          },
        },
        call: (a) => {
          seen.push(a)
          return 'ok'
        },
      },
    ])
    const agent = defineHarnessAgent({
      model: scriptedModel([
        {
          toolCalls: [
            {
              toolName: 'api_typed',
              input: { ids: [1, 'b', true], count: '3', ratio: '1.5', either: 7, short: 12345 },
            },
            { toolName: 'api_typed', input: { count: '3.5', ratio: ' 2', either: '7' } },
          ],
        },
        { text: 'done' },
      ]),
      contextWindow: 100_000,
      storage: { messages: inMemoryMessages(), state: inMemoryState() },
      logger: silent,
      mcp: [mcpServerSource({ name: 'api', transport: () => server.transport() })],
    })
    await agent.session('s1').send('go').result
    await agent.close()
    expect(seen[0]).toEqual({
      ids: ['1', 'b', 'true'],
      count: 3,
      ratio: 1.5,
      either: 7,
      short: 12345,
    })
    expect(seen[1]).toEqual({ count: '3.5', ratio: ' 2', either: '7' })
  })
})

describe('tool call repair of zod tools (spec 09 §4.2)', () => {
  async function runZod(inputs: unknown[]) {
    const executed: unknown[] = []
    const warnings: HarnessWarning[] = []
    const note = tool({
      description: 'note',
      inputSchema: z.object({
        messageIds: z.array(z.string()),
        noticed: z.string().max(5),
        limit: z.number().optional(),
      }),
      execute: (input) => {
        executed.push(input)
        return 'noted'
      },
    })
    const model = scriptedModel([
      ...inputs.map((input) => ({ toolCalls: [{ toolName: 'note', input }] })),
      { text: 'done' },
    ])
    const agent = defineHarnessAgent({
      model,
      contextWindow: 100_000,
      storage: { messages: inMemoryMessages(), state: inMemoryState() },
      logger: silent,
      onWarning: (w) => warnings.push(w),
      tools: { note },
    })
    const run = agent.session('s1').send('go')
    await run.result
    const messages = await agent.session('s1').messages()
    await agent.close()
    return { executed, warnings, text: JSON.stringify(messages) }
  }

  test('numeric ids for declared strings are repaired and executed once', async () => {
    const { executed, warnings } = await runZod([{ messageIds: [23026, 23027], noticed: 'ok' }])
    expect(executed).toEqual([{ messageIds: ['23026', '23027'], noticed: 'ok' }])
    expect(
      warnings.filter((w) => w.code === 'W_TOOL_INPUT_REPAIRED').map((w) => w.details?.property),
    ).toEqual(['messageIds'])
  })

  test('a number string for a declared number is repaired', async () => {
    const { executed } = await runZod([{ messageIds: ['a'], noticed: 'ok', limit: '5' }])
    expect(executed).toEqual([{ messageIds: ['a'], noticed: 'ok', limit: 5 }])
  })

  test('valid input is untouched', async () => {
    const input = { messageIds: ['1'], noticed: 'ok', limit: 2 }
    const { executed, warnings } = await runZod([input])
    expect(executed).toEqual([input])
    expect(warnings.filter((w) => w.code === 'W_TOOL_INPUT_REPAIRED')).toHaveLength(0)
  })

  test('unrepairable and too-long input still reaches the model as a tool error', async () => {
    const { executed, text } = await runZod([
      { messageIds: 'nope', noticed: 'ok' },
      { messageIds: ['1'], noticed: 123456789 },
    ])
    expect(executed).toHaveLength(0)
    expect(text).toContain('Invalid input')
  })
})
