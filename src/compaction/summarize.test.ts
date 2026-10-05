import { describe, expect, test } from 'bun:test'
import { MockLanguageModelV4 } from 'ai/test'
import { summarize } from './summarize.ts'
import { defaultCountTokens } from './tokens.ts'

function model(finishReason: 'stop' | 'length', text = 'SUMMARY') {
  return new MockLanguageModelV4({
    provider: 'mock',
    modelId: 'summarizer',
    doGenerate: async () => ({
      content: [{ type: 'text', text }],
      finishReason: { unified: finishReason, raw: finishReason },
      usage: {
        inputTokens: { total: 100, noCache: 100, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 20, text: 20, reasoning: undefined },
      },
      warnings: [],
    }),
  })
}

const input = {
  prompt: 'Summarize.',
  entries: ['USER: hello', 'ASSISTANT: hi'],
  context: [],
  maxSummaryTokens: 100,
  window: 100_000,
  count: defaultCountTokens,
}

describe('summarize', () => {
  test('a summary cut by the output limit (finishReason length) is a failure', async () => {
    let error: unknown
    try {
      await summarize({ ...input, model: model('length') })
    } catch (e) {
      error = e
    }
    expect(error).toBeInstanceOf(Error)
    expect((error as { reason?: string }).reason).toBe('length')
  })

  test('returns the summary and the usage of every call', async () => {
    const out = await summarize({ ...input, model: model('stop') })
    expect(out.summary).toBe('SUMMARY')
    expect(out.usage.map((u) => [u.inputTokens, u.outputTokens])).toEqual([[100, 20]])
  })
})
