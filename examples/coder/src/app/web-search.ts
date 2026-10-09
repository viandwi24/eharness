/**
 * The app's side of the network tools: `web_fetch` and `web_search` are the library's
 * (`eharness/web`); what stays here is policy and providers: the Markdown converter
 * (turndown), host resolution (Node DNS), and the provider-specific search (an OpenRouter web
 * plugin call or the AI Gateway's Perplexity search tool).
 */
import { lookup } from 'node:dns/promises'
import { gateway, generateText, type LanguageModel, type LanguageModelUsage, stepCountIs } from 'ai'
import type { WebSearchOptions } from 'eharness/web'
import TurndownService from 'turndown'
import type { ModelProvider } from '../contracts.ts'

/** Resolve a host name to its addresses (`webFetch({ resolveHost })`). */
export const resolveHost = async (host: string): Promise<string[]> =>
  (await lookup(host, { all: true })).map((entry) => entry.address)

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
})
turndown.remove(['script', 'style', 'nav', 'footer', 'noscript', 'iframe', 'template'])
turndown.addRule('svg', {
  filter: (node) => node.nodeName.toLowerCase() === 'svg',
  replacement: () => '',
})

/** HTML to Markdown (`webFetch({ toMarkdown })`), without scripts, styles, navigation and footers. */
export function htmlToMarkdown(html: string): string {
  return turndown
    .turndown(html)
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Default model of the search call per provider (override with `CODER_SEARCH_MODEL`). */
export const SEARCH_MODEL: Record<ModelProvider, string> = {
  openrouter: 'google/gemini-2.5-flash',
  gateway: 'anthropic/claude-haiku-4.5',
}

/** Runs one web search: the library's `webSearch({ search })` signature. */
export type SearchFn = WebSearchOptions['search']

/** The part of `generateText` the search needs (inject a fake in tests). */
export type GenerateFn = (options: Parameters<typeof generateText>[0]) => Promise<{
  text: string
  usage: LanguageModelUsage
  sources?: ReadonlyArray<{ sourceType?: string; url?: string; title?: string }>
  steps?: ReadonlyArray<{ toolResults?: ReadonlyArray<{ output?: unknown }> }>
}>

/** Options of {@link createSearchFn}. */
export interface CreateSearchOptions {
  provider: ModelProvider
  /** Model id → model, as the app resolves them. */
  resolveModel: (id: string) => LanguageModel
  /** Search model id; default `CODER_SEARCH_MODEL` or {@link SEARCH_MODEL}. */
  model?: string
  generate?: GenerateFn
}

const SEARCH_PROMPT = (query: string): string =>
  `Search the web for: ${query}\n\nAnswer with the facts the search found, concisely, and name the sources you used. Do not invent anything that the results do not say.`

function urlsOf(output: unknown): Array<{ url: string; title?: string }> {
  const results = (output as { results?: unknown } | null)?.results
  if (!Array.isArray(results)) return []
  return results.flatMap((r: { url?: unknown; title?: unknown }) =>
    typeof r?.url === 'string'
      ? [{ url: r.url, ...(typeof r.title === 'string' ? { title: r.title } : {}) }]
      : [],
  )
}

/**
 * The provider-specific search:
 *
 * - OpenRouter: one `generateText` with a small fast model and the `web` plugin
 *   (`providerOptions.openrouter.plugins`, 5 results, domain filters passed through); the
 *   citations come back as AI SDK `url` sources.
 * - AI Gateway: one `generateText` with `gateway.tools.perplexitySearch()` (provider-executed).
 */
export function createSearchFn(opts: CreateSearchOptions): SearchFn {
  const generate = (opts.generate ?? generateText) as GenerateFn
  const modelId = opts.model ?? process.env.CODER_SEARCH_MODEL ?? SEARCH_MODEL[opts.provider]
  return async (query, { allowedDomains, blockedDomains, signal } = {}) => {
    const model = opts.resolveModel(modelId)
    const common = {
      model,
      prompt: SEARCH_PROMPT(query),
      ...(signal ? { abortSignal: signal } : {}),
    }
    let result: Awaited<ReturnType<GenerateFn>>
    if (opts.provider === 'openrouter') {
      result = await generate({
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
      } as Parameters<GenerateFn>[0])
    } else {
      const filter = allowedDomains?.length
        ? allowedDomains
        : (blockedDomains ?? []).map((d) => `-${d}`)
      result = await generate({
        ...common,
        tools: {
          web_search: gateway.tools.perplexitySearch({
            maxResults: 5,
            ...(filter.length > 0 ? { search_domain_filter: filter } : {}),
          } as never),
        },
        stopWhen: stepCountIs(4),
      } as Parameters<GenerateFn>[0])
    }
    const sources = new Map<string, { url: string; title?: string }>()
    for (const s of result.sources ?? []) {
      if ((s.sourceType === undefined || s.sourceType === 'url') && typeof s.url === 'string') {
        sources.set(s.url, { url: s.url, ...(s.title ? { title: s.title } : {}) })
      }
    }
    for (const step of result.steps ?? []) {
      for (const r of step.toolResults ?? []) {
        for (const s of urlsOf(r.output)) if (!sources.has(s.url)) sources.set(s.url, s)
      }
    }
    return { text: result.text, sources: [...sources.values()], usage: result.usage, model }
  }
}
