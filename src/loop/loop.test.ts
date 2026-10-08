import { describe, expect, test } from 'bun:test'
import type { ModelMessage, Tool } from 'ai'
import { applyCache, deepMerge, isAnthropicModel, layoutMessages, systemBlocks } from './prompt.ts'
import { stepEndEvent, toolSearchNames } from './steps.ts'
import { decideStop, findPending, type StepFacts } from './stop.ts'

const facts = (patch: Partial<StepFacts>): StepFacts => ({
  finishReason: 'tool-calls',
  sawError: false,
  pending: undefined,
  hookStop: undefined,
  stepCount: 1,
  budget: 50,
  outputTokens: 0,
  maxOutputTokens: 100,
  ...patch,
})

describe('decideStop (spec 05 §3.1)', () => {
  test('rules in order', () => {
    expect(decideStop(facts({ sawError: true, finishReason: 'stop' }))).toBe('error')
    expect(decideStop(facts({ finishReason: undefined }))).toBe('error')
    expect(decideStop(facts({ finishReason: 'error' }))).toBe('error')
    expect(decideStop(facts({ finishReason: 'length' }))).toBe('length')
    expect(decideStop(facts({ finishReason: 'content-filter' }))).toBe('content-filter')
    expect(decideStop(facts({ finishReason: 'stop', stepCount: 50 }))).toBe('complete')
    expect(decideStop(facts({ finishReason: 'other' }))).toBe('complete')
    const pending = {
      messageId: 'm',
      approvals: [],
      clientTools: [{ toolCallId: 'c', toolName: 't' }],
    }
    expect(decideStop(facts({ pending, hookStop: 'plugin:a:b' }))).toBe('tool-pending')
    expect(decideStop(facts({ hookStop: 'plugin:a:b', stepCount: 50 }))).toBe('plugin:a:b')
    expect(decideStop(facts({ stepCount: 50, outputTokens: 1000 }))).toBe('max-steps')
    expect(decideStop(facts({ outputTokens: 101 }))).toBe('cost-cap')
    expect(decideStop(facts({}))).toBeUndefined()
  })
})

describe('findPending', () => {
  test('approval requests and client tools without results are pending', () => {
    const response: ModelMessage[] = [
      {
        role: 'assistant',
        content: [
          { type: 'tool-call', toolCallId: 'a', toolName: 'server', input: {} },
          { type: 'tool-call', toolCallId: 'b', toolName: 'server', input: {} },
          { type: 'tool-approval-request', approvalId: 'ap', toolCallId: 'b' },
          { type: 'tool-call', toolCallId: 'c', toolName: 'client', input: {} },
          { type: 'tool-call', toolCallId: 'd', toolName: 'server', input: {} },
          { type: 'tool-approval-request', approvalId: 'auto', toolCallId: 'd' },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'a',
            toolName: 'server',
            output: { type: 'text', value: 'x' },
          },
          {
            type: 'tool-result',
            toolCallId: 'd',
            toolName: 'server',
            output: { type: 'execution-denied' },
          },
        ],
      },
    ]
    expect(findPending('m', response, new Set(['client']))).toEqual({
      v: 2,
      messageId: 'm',
      approvals: [{ approvalId: 'ap', toolCallId: 'b', toolName: 'server', input: {} }],
      clientTools: [{ toolCallId: 'c', toolName: 'client', input: {} }],
    })
    expect(findPending('m', response.slice(1), new Set())).toBeUndefined()
  })
})

describe('prompt layout (spec 02 §5)', () => {
  const wire: ModelMessage[] = [
    { role: 'user', content: 'old' },
    { role: 'assistant', content: 'old answer' },
    { role: 'user', content: 'new' },
  ]
  test('turn reminder before the current turn, step reminder at the end', () => {
    const { messages, lastStable } = layoutMessages(wire, 2, 'turn', 'step')
    expect(messages.map((m) => (typeof m.content === 'string' ? m.content : m.content[0]))).toEqual(
      [
        'old',
        'old answer',
        { type: 'text', text: '<system-reminder>\nturn\n</system-reminder>' },
        'new',
        { type: 'text', text: '<system-reminder>\nstep\n</system-reminder>' },
      ],
    )
    expect(lastStable).toBe(3)
    expect(layoutMessages(wire, 2, undefined, undefined).messages).toEqual(wire)
  })

  test('system blocks omit empty blocks', () => {
    expect(systemBlocks(undefined, undefined)).toEqual([])
    expect(systemBlocks('a', undefined)).toEqual([{ role: 'system', content: 'a' }])
  })

  test('deepMerge and isAnthropicModel', () => {
    expect(
      deepMerge<Record<string, unknown>>({ a: { x: 1, y: [1] } }, { a: { y: [2], z: 3 } }),
    ).toEqual({
      a: { x: 1, y: [2], z: 3 },
    })
    expect(isAnthropicModel('anthropic/claude-sonnet-4.6')).toBe(true)
    expect(isAnthropicModel('openai/gpt-5')).toBe(false)
    expect(isAnthropicModel({ provider: 'anthropic.messages', modelId: 'x' } as never)).toBe(true)
  })

  test('breakpoints: at most 4, one every 15 blocks back', () => {
    const long: ModelMessage[] = Array.from({ length: 40 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `m${i}`,
    }))
    const result = applyCache({
      config: { mode: 'breakpoints' },
      model: 'anthropic/claude',
      prompt: {
        system: [{ role: 'system', content: 's' }],
        messages: long,
        tools: { t: {} as Tool },
        providerOptions: undefined,
      },
      lastStable: 39,
      lastStaticTool: 't',
    })
    const marked = result.messages.flatMap((m, i) => (m.providerOptions === undefined ? [] : [i]))
    expect(marked).toEqual([24, 39])
    expect(result.system[0]?.providerOptions).toBeDefined()
    expect((result.tools.t as Tool).providerOptions).toBeDefined()
  })
})

describe('toolSearchNames', () => {
  test('reads tool names from tool_search outputs', () => {
    expect(
      toolSearchNames({ type: 'json', value: { tools: [{ name: 'a' }, { name: 'b' }] } }),
    ).toEqual(['a', 'b'])
    expect(toolSearchNames({ tools: [{ name: 'c' }, {}] })).toEqual(['c'])
    expect(toolSearchNames('nope')).toEqual([])
  })
})

describe('stepEndEvent without a StepResult', () => {
  test('falls back to the wire: tool calls, results (call order) and no `step`', () => {
    const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 } as never
    const response: ModelMessage[] = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Checking.' },
          { type: 'tool-call', toolCallId: 'a', toolName: 'read', input: { p: 1 } },
          { type: 'tool-call', toolCallId: 'b', toolName: 'pay', input: {} },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'a',
            toolName: 'read',
            output: { type: 'text', value: 'x' },
          },
          {
            type: 'tool-result',
            toolCallId: 'b',
            toolName: 'pay',
            output: { type: 'execution-denied', reason: 'no' },
          },
        ],
      },
    ]
    const event = stepEndEvent(0, 'tool-calls', usage, usage, response, undefined)
    expect(event.step).toBeUndefined()
    expect('step' in event).toBe(false)
    expect(event.toolCalls).toEqual([
      { toolName: 'read', toolCallId: 'a', input: { p: 1 } },
      { toolName: 'pay', toolCallId: 'b', input: {} },
    ])
    expect(event.toolResults).toEqual([
      { toolName: 'read', toolCallId: 'a', status: 'output' },
      { toolName: 'pay', toolCallId: 'b', status: 'denied' },
    ])
    expect(event.responseMessages).toEqual(response)
  })
})
