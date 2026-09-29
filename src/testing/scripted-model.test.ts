import { describe, expect, test } from 'bun:test'
import { generateText, isStepCount, streamText, tool } from 'ai'
import { z } from 'zod/v4'
import { scriptedModel } from './scripted-model.ts'

const tools = {
  echo: tool({ inputSchema: z.object({ text: z.string() }), execute: async ({ text }) => text }),
}

describe('scriptedModel', () => {
  test('plays steps in order and records prompts', async () => {
    const model = scriptedModel([
      { toolCalls: [{ toolName: 'echo', input: { text: 'hi' } }] },
      { text: 'Done.', usage: { inputTokens: 20, outputTokens: 3 } },
    ])
    const first = streamText({ model, tools, prompt: 'go', stopWhen: isStepCount(1) })
    expect(await first.finishReason).toBe('tool-calls')
    const response = await first.responseMessages
    const second = streamText({
      model,
      tools,
      messages: [{ role: 'user', content: 'go' }, ...response],
      stopWhen: isStepCount(1),
    })
    expect(await second.text).toBe('Done.')
    expect((await second.usage).outputTokens).toBe(3)
    expect(model.prompts).toHaveLength(2)
    expect(model.prompts[1]?.map((m) => m.role)).toEqual(['user', 'assistant', 'tool'])
    expect(model.calls[0]?.tools?.map((t) => t.name)).toEqual(['echo'])
  })

  test('throws before streaming and rejects calls beyond the script', async () => {
    const model = scriptedModel([{ throws: new Error('boom') }])
    const failed = streamText({ model, prompt: 'x', maxRetries: 0 })
    await expect(failed.responseMessages).rejects.toBeDefined()
    const beyond = streamText({ model, prompt: 'x', maxRetries: 0 })
    await expect(beyond.responseMessages).rejects.toBeDefined()
    expect(model.calls).toHaveLength(2)
  })

  test('delayed streams honour the abort signal', async () => {
    const model = scriptedModel([{ text: 'slow', delayMs: 1000 }])
    const controller = new AbortController()
    const result = streamText({ model, prompt: 'x', abortSignal: controller.signal })
    setTimeout(() => controller.abort('stop'), 10)
    const started = Date.now()
    await expect(result.responseMessages).rejects.toBeDefined()
    expect(Date.now() - started).toBeLessThan(500)
  })
})

describe('scriptedModel with generateText', () => {
  test('doGenerate plays the same script as doStream and records the call', async () => {
    const model = scriptedModel([
      { text: 'streamed' },
      { reasoning: 'hmm', text: 'Summary.', usage: { inputTokens: 7, outputTokens: 2 } },
      { toolCalls: [{ toolName: 'echo', input: { text: 'x' }, toolCallId: 'c1' }] },
    ])
    expect(await streamText({ model, prompt: 'a' }).text).toBe('streamed')
    const summary = await generateText({ model, prompt: 'summarize' })
    expect(summary.text).toBe('Summary.')
    expect(summary.reasoningText).toBe('hmm')
    expect(summary.usage.outputTokens).toBe(2)
    const calls = await generateText({ model, tools, prompt: 'call', stopWhen: isStepCount(1) })
    expect(calls.toolCalls.map((c) => [c.toolCallId, c.toolName, c.input])).toEqual([
      ['c1', 'echo', { text: 'x' }],
    ])
    expect(model.calls).toHaveLength(3)
    expect(model.prompts[1]?.at(-1)?.role).toBe('user')
  })

  test('doGenerate throws scripted errors', async () => {
    const model = scriptedModel([{ throws: new Error('boom') }, { streamError: new Error('late') }])
    await expect(generateText({ model, prompt: 'x', maxRetries: 0 })).rejects.toThrow('boom')
    await expect(generateText({ model, prompt: 'x', maxRetries: 0 })).rejects.toThrow('late')
    await expect(generateText({ model, prompt: 'x', maxRetries: 0 })).rejects.toThrow(
      'no scripted step',
    )
  })
})
