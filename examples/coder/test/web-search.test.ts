import { describe, expect, test } from 'bun:test'
import { scriptedModel } from 'eharness/testing'
import { createSearchFn, type GenerateFn, SEARCH_MODEL } from '../src/app/web-search.ts'
import { makeController } from './helpers.ts'

const usage = {
  inputTokens: 10,
  outputTokens: 5,
  totalTokens: 15,
  inputTokenDetails: {
    noCacheTokens: undefined,
    cacheReadTokens: undefined,
    cacheWriteTokens: undefined,
  },
  outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined },
}

describe('web_search wiring', () => {
  test('a scripted controller has no search: the tool answers ERROR', async () => {
    const model = scriptedModel([
      { toolCalls: [{ toolName: 'web_search', input: { query: 'anything' } }] },
      { text: 'ok' },
    ])
    const { controller } = await makeController({
      model,
      flags: { permissionMode: 'bypassPermissions' },
    })
    await controller.run('search', { onRun: (run) => void run.stream.cancel().catch(() => {}) })
    expect(JSON.stringify(model.prompts.at(-1))).toContain(
      'ERROR: web search failed: web search is not available',
    )
  })

  test('an injected search works through the whole agent', async () => {
    const model = scriptedModel([
      { toolCalls: [{ toolName: 'web_search', input: { query: 'ai sdk 7' } }] },
      { text: 'ok' },
    ])
    const { controller } = await makeController({
      model,
      flags: { permissionMode: 'bypassPermissions' },
      search: async () => ({
        text: 'found it',
        sources: [{ url: 'https://ai-sdk.dev' }],
        model: 'm',
      }),
    })
    await controller.run('search', { onRun: (run) => void run.stream.cancel().catch(() => {}) })
    expect(JSON.stringify(model.prompts.at(-1))).toContain('Sources:\\n- https://ai-sdk.dev')
  })
})

describe('createSearchFn', () => {
  const fakeGenerate = (calls: unknown[]): GenerateFn =>
    (async (options: unknown) => {
      calls.push(options)
      return {
        text: 'answer',
        usage,
        sources: [
          { sourceType: 'url', url: 'https://a.com', title: 'A' },
          { sourceType: 'document', url: undefined },
        ],
        steps: [
          {
            toolResults: [
              {
                output: {
                  results: [{ url: 'https://b.com', title: 'B' }, { url: 'https://a.com' }],
                },
              },
            ],
          },
        ],
      }
    }) as GenerateFn

  test('OpenRouter: the web plugin with 5 results and the domain filters; sources deduplicated', async () => {
    const calls: Array<Record<string, unknown>> = []
    const resolved: string[] = []
    const search = createSearchFn({
      provider: 'openrouter',
      resolveModel: (id) => {
        resolved.push(id)
        return id
      },
      generate: fakeGenerate(calls),
    })
    const out = await search('q', { allowedDomains: ['a.com'], blockedDomains: ['z.com'] })
    expect(resolved).toEqual([SEARCH_MODEL.openrouter])
    expect(calls[0]?.providerOptions).toEqual({
      openrouter: {
        plugins: [
          { id: 'web', max_results: 5, include_domains: ['a.com'], exclude_domains: ['z.com'] },
        ],
      },
    })
    expect(calls[0]?.tools).toBeUndefined()
    expect(out.sources).toEqual([
      { url: 'https://a.com', title: 'A' },
      { url: 'https://b.com', title: 'B' },
    ])
    expect(out.text).toBe('answer')
    expect(out.usage).toBe(usage)
    expect(out.model).toBe(SEARCH_MODEL.openrouter)
  })

  test('Gateway: the perplexity search tool with a domain filter', async () => {
    const calls: Array<Record<string, unknown>> = []
    const search = createSearchFn({
      provider: 'gateway',
      resolveModel: (id) => id,
      generate: fakeGenerate(calls),
      model: 'custom/model',
    })
    const out = await search('q', { blockedDomains: ['z.com'] })
    const tools = calls[0]?.tools as Record<string, { type?: string; id?: string; args?: unknown }>
    expect(Object.keys(tools)).toEqual(['web_search'])
    expect(tools.web_search?.id).toContain('perplexity_search')
    expect(tools.web_search?.args).toMatchObject({
      maxResults: 5,
      search_domain_filter: ['-z.com'],
    })
    expect(calls[0]?.model).toBe('custom/model')
    expect(calls[0]?.stopWhen).toBeDefined()
    expect(out.sources.map((s) => s.url)).toEqual(['https://a.com', 'https://b.com'])
  })
})
