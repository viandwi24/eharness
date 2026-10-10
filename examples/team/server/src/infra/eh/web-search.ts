/**
 * The provider's web search behind the `web_search` tool (as examples/coder): one `generateText`
 * call with a small fast model and the provider's own search, so no extra key or dependency is
 * needed. OpenRouter uses its `web` plugin; the AI Gateway uses the Perplexity search tool.
 * Scripted or keyless setups have no search: the factory then does not offer the tool at all.
 */
import { gateway, generateText, type LanguageModel, stepCountIs } from 'ai'
import type { WebSearchOptions } from 'eharness/web'

export type SearchFn = WebSearchOptions['search']

/** Default model of the search call per provider (override with `TEAM_SEARCH_MODEL`). */
export const SEARCH_MODEL = {
  openrouter: 'google/gemini-2.5-flash',
  gateway: 'anthropic/claude-haiku-4.5',
} as const

const PROMPT = (query: string): string =>
  `Search the web for: ${query}\n\nAnswer with the facts the search found, concisely, and name the sources you used. Do not invent anything that the results do not say.`

/** What one search call runs on: the provider kind (its search mechanism) and the model. */
export interface SearchTarget {
  provider: 'openrouter' | 'gateway'
  model: LanguageModel
}

export interface CreateSearchOptions {
  /**
   * The target of each call (read per call, so a profile edited in Settings applies at once).
   * Throws a readable error when the workspace has no provider that can search.
   */
  target: () => SearchTarget
}

export function createSearchFn(opts: CreateSearchOptions): SearchFn {
  return async (query, { allowedDomains, blockedDomains, signal } = {}) => {
    const { provider, model } = opts.target()
    const common = { model, prompt: PROMPT(query), ...(signal ? { abortSignal: signal } : {}) }
    const result =
      provider === 'openrouter'
        ? await generateText({
            ...common,
            providerOptions: {
              openrouter: {
                plugins: [
                  {
                    id: 'web',
                    max_results: 5,
                    ...(allowedDomains?.length ? { include_domains: allowedDomains } : {}),
                    ...(blockedDomains?.length ? { exclude_domains: blockedDomains } : {}),
                  },
                ],
              },
            },
          } as never)
        : await generateText({
            ...common,
            tools: {
              web_search: gateway.tools.perplexitySearch({
                maxResults: 5,
                ...(allowedDomains?.length
                  ? { search_domain_filter: allowedDomains }
                  : blockedDomains?.length
                    ? { search_domain_filter: blockedDomains.map((d) => `-${d}`) }
                    : {}),
              } as never),
            },
            stopWhen: stepCountIs(4),
          } as never)
    const sources = new Map<string, { url: string; title?: string }>()
    for (const s of result.sources ?? []) {
      const src = s as { sourceType?: string; url?: string; title?: string }
      if (
        (src.sourceType === undefined || src.sourceType === 'url') &&
        typeof src.url === 'string'
      ) {
        sources.set(src.url, { url: src.url, ...(src.title ? { title: src.title } : {}) })
      }
    }
    for (const step of result.steps ?? []) {
      for (const r of step.toolResults ?? []) {
        const results = (r.output as { results?: unknown } | null)?.results
        if (!Array.isArray(results)) continue
        for (const item of results as Array<{ url?: unknown; title?: unknown }>) {
          if (typeof item?.url === 'string' && !sources.has(item.url)) {
            sources.set(item.url, {
              url: item.url,
              ...(typeof item.title === 'string' ? { title: item.title } : {}),
            })
          }
        }
      }
    }
    return { text: result.text, sources: [...sources.values()], usage: result.usage, model }
  }
}
