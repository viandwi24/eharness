import { describe, expect, test } from 'bun:test'
import { MockLanguageModelV4 } from 'ai/test'
import { defaultCountTokens } from '../models/tokens.ts'
import { SUMMARY_REASONING_HEADROOM, summarize, summaryOutputCap } from './summarize.ts'

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

  test('the prompt states the length limit; the output cap is the budget plus headroom', async () => {
    const calls: Array<{ maxOutputTokens?: number; prompt: unknown }> = []
    const m = new MockLanguageModelV4({
      provider: 'mock',
      modelId: 'summarizer',
      doGenerate: async (options) => {
        calls.push({ maxOutputTokens: options.maxOutputTokens, prompt: options.prompt })
        return {
          content: [{ type: 'text', text: 'S' }],
          finishReason: { unified: 'stop', raw: 'stop' },
          usage: {
            inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 1, text: 1, reasoning: undefined },
          },
          warnings: [],
        }
      },
    })
    // the agent's 32k cap does not raise the summarizer cap
    await summarize({ ...input, model: m, maxSummaryTokens: 4_000, maxOutputTokens: 32_768 })
    expect(calls[0]?.maxOutputTokens).toBe(4_000 + SUMMARY_REASONING_HEADROOM)
    expect(JSON.stringify(calls[0]?.prompt)).toContain(
      'the brief must fit 4000 tokens (about 2800 words)',
    )
  })

  test('summaryOutputCap: a smaller agent cap lowers it, never below the summary budget', () => {
    expect(summaryOutputCap(4_000)).toBe(16_000)
    expect(summaryOutputCap(4_000, 32_768)).toBe(16_000)
    expect(summaryOutputCap(4_000, 8_000)).toBe(8_000)
    expect(summaryOutputCap(4_000, 1_000)).toBe(4_000)
  })
})
