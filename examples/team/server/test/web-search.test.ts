/**
 * The search call caps its output: without a cap OpenRouter reserves the model maximum and refuses
 * the call when the credit left cannot cover it.
 */
import { describe, expect, test } from 'bun:test'
import { scriptedModel } from 'eharness/testing'
import { createSearchFn, SEARCH_MAX_OUTPUT_TOKENS } from '../src/infra/eh/web-search.ts'

describe('web search', () => {
  for (const provider of ['openrouter', 'gateway'] as const) {
    test(`a ${provider} search call sets maxOutputTokens`, async () => {
      const model = scriptedModel([{ text: 'found it' }])
      const search = createSearchFn({ target: () => ({ provider, model }) })
      const out = await search('gold price', {})
      expect(out.text).toBe('found it')
      expect(model.calls[0]?.maxOutputTokens).toBe(SEARCH_MAX_OUTPUT_TOKENS)
    })
  }
})
