import { describe, expect, test } from 'bun:test'
import type { LanguageModelV4StreamPart } from '@ai-sdk/provider'
import {
  isStepCount,
  type ModelMessage,
  readUIMessageStream,
  streamText,
  type ToolSet,
  tool,
  toUIMessageStream,
  type UIMessage,
  type UIMessageChunk,
} from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import { z } from 'zod/v4'
import { HarnessToolError } from '../errors.ts'
import { project } from './project.ts'
import { createCoreMessageRegistry } from './registry.ts'
import type { HarnessUIMessage } from './types.ts'

type StreamPart = LanguageModelV4StreamPart
function streamPart(part: StreamPart): StreamPart {
  return part
}

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
}

function modelStream(parts: StreamPart[]) {
  return {
    stream: new ReadableStream<StreamPart>({
      start(controller) {
        for (const part of parts) controller.enqueue(part)
        controller.close()
      },
    }),
  }
}

const finish = (unified: 'stop' | 'tool-calls') =>
  streamPart({ type: 'finish', finishReason: { unified, raw: unified }, usage })

/** Drop `undefined`-valued keys (the round-trip rule compares JSON). */
const json = (value: unknown): unknown => JSON.parse(JSON.stringify(value))

/**
 * Run the steps like the core loop does (one streamText per step, wire += responseMessages) and
 * accumulate the assistant UI message from the same chunks.
 */
async function runSteps(
  model: MockLanguageModelV4,
  tools: ToolSet,
  wire: ModelMessage[],
  steps: number,
  inputs: Record<number, string> = {},
): Promise<UIMessage> {
  const chunks: UIMessageChunk[] = [{ type: 'start', messageId: 'a1' }]
  for (let step = 0; step < steps; step++) {
    const input = inputs[step]
    if (input !== undefined) {
      // delivered at the step boundary as data-eh.input (ADR-0011)
      chunks.push({ type: 'data-eh.input', data: { source: 'user', text: input } })
      wire.push({ role: 'user', content: [{ type: 'text', text: input }] })
    }
    const result = streamText({ model, tools, messages: wire, stopWhen: isStepCount(1) })
    const ui = toUIMessageStream({
      stream: result.stream,
      tools,
      sendStart: false,
      sendFinish: false,
      onError: (e) => (e instanceof HarnessToolError ? String(e) : String(e)),
    })
    for await (const chunk of ui) chunks.push(chunk as UIMessageChunk)
    wire.push(...(await result.responseMessages))
  }
  chunks.push({ type: 'finish' })
  let last: UIMessage | undefined
  const stream = new ReadableStream<UIMessageChunk>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    },
  })
  for await (const message of readUIMessageStream({ stream })) last = message
  if (last === undefined) throw new Error('no message')
  return last
}

describe('projection round-trip (spec 03 §6)', () => {
  test('tool call step + answer step project to exactly the wire the loop sent', async () => {
    const model = new MockLanguageModelV4({
      provider: 'mock',
      modelId: 'm',
      doStream: [
        modelStream([
          streamPart({ type: 'stream-start', warnings: [] }),
          streamPart({
            type: 'reasoning-start',
            id: 'r1',
            providerMetadata: { mock: { sig: 'abc' } },
          }),
          streamPart({ type: 'reasoning-delta', id: 'r1', delta: 'Need weather.' }),
          streamPart({
            type: 'reasoning-end',
            id: 'r1',
            providerMetadata: { mock: { sig: 'abc' } },
          }),
          streamPart({ type: 'text-start', id: 't1' }),
          streamPart({ type: 'text-delta', id: 't1', delta: 'Checking.' }),
          streamPart({ type: 'text-end', id: 't1' }),
          streamPart({
            type: 'tool-call',
            toolCallId: 'call-1',
            toolName: 'weather',
            input: '{"city":"Oslo"}',
          }),
          streamPart({
            type: 'tool-call',
            toolCallId: 'call-2',
            toolName: 'fails',
            input: '{}',
          }),
          finish('tool-calls'),
        ]),
        modelStream([
          streamPart({ type: 'text-start', id: 't2' }),
          streamPart({ type: 'text-delta', id: 't2', delta: 'It is 20 degrees.' }),
          streamPart({ type: 'text-end', id: 't2' }),
          finish('stop'),
        ]),
      ],
    })
    const tools = {
      weather: tool({
        inputSchema: z.object({ city: z.string() }),
        execute: async ({ city }) => ({ city, temp: 20 }),
      }),
      fails: tool({
        inputSchema: z.object({}),
        execute: async (): Promise<string> => {
          throw new HarnessToolError(new TypeError('no network'), {
            toolName: 'fails',
            toolCallId: 'call-2',
          })
        },
      }),
    }
    const user: HarnessUIMessage = {
      id: 'u1',
      role: 'user',
      parts: [{ type: 'text', text: 'Weather in Oslo?' }],
    }
    const wire: ModelMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'Weather in Oslo?' }] },
    ]
    const assistant = await runSteps(model, tools, wire, 2)

    const projected = await project([user, assistant as HarnessUIMessage], {
      registry: createCoreMessageRegistry(),
      sessionId: 's1',
      tools,
      model,
    })
    expect(json(projected)).toEqual(json(wire))
    // the tool error text the model saw is String(error) of the original
    expect(JSON.stringify(projected)).toContain('TypeError: no network')
  })

  test('a steer delivered between steps projects at the same position', async () => {
    const model = new MockLanguageModelV4({
      provider: 'mock',
      modelId: 'm',
      doStream: [
        modelStream([
          streamPart({
            type: 'tool-call',
            toolCallId: 'c1',
            toolName: 'weather',
            input: '{"city":"A"}',
          }),
          finish('tool-calls'),
        ]),
        modelStream([
          streamPart({
            type: 'tool-call',
            toolCallId: 'c2',
            toolName: 'weather',
            input: '{"city":"B"}',
          }),
          finish('tool-calls'),
        ]),
        modelStream([
          streamPart({ type: 'text-start', id: 't' }),
          streamPart({ type: 'text-delta', id: 't', delta: 'B is warm.' }),
          streamPart({ type: 'text-end', id: 't' }),
          finish('stop'),
        ]),
      ],
    })
    const tools = {
      weather: tool({
        inputSchema: z.object({ city: z.string() }),
        execute: async ({ city }) => ({ city, temp: 20 }),
      }),
    }
    const user: HarnessUIMessage = { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'A?' }] }
    const wire: ModelMessage[] = [{ role: 'user', content: [{ type: 'text', text: 'A?' }] }]
    const assistant = await runSteps(model, tools, wire, 3, { 1: 'Actually, B.' })
    expect(assistant.parts.some((p) => p.type === 'data-eh.input')).toBe(true)

    const projected = await project([user, assistant as HarnessUIMessage], {
      registry: createCoreMessageRegistry(),
      sessionId: 's1',
      tools,
    })
    expect(json(projected)).toEqual(json(wire))
    expect(projected.map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'user',
      'assistant',
      'tool',
      'assistant',
    ])
  })
})
