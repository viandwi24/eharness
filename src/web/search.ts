/**
 * The `webSearch()` plugin (spec 22 §3): a provider-agnostic `web_search` tool.
 *
 * @see docs/specs/22-web-plugin.md
 */

import type { LanguageModel } from 'ai'
import { tool } from 'ai'
import { z } from 'zod/v4'
import { type AddUsageInput, definePlugin, type HarnessPlugin, untrustedContent } from '../index.ts'

/** Filters and abort signal passed to the app's `search` function. */
export interface SearchOptions {
  allowedDomains?: string[]
  blockedDomains?: string[]
  signal?: AbortSignal
}

/** What one search produced. */
export interface SearchResult {
  text: string
  sources: Array<{ title?: string; url: string }>
  /** Usage of the search call; charged to the turn (`ctx.turn.addUsage`). */
  usage?: AddUsageInput
  /** Model that did the work (priced from the agent's `models`). */
  model?: LanguageModel
}

/** Options of {@link webSearch}. */
export interface WebSearchOptions {
  /** Runs one search (the app supplies the provider). Throwing is reported as an `ERROR:` text. */
  search: (query: string, options: SearchOptions) => Promise<SearchResult>
  /**
   * Wrap the findings and source titles in an `<untrusted-content source="web_search">` frame
   * (`untrustedContent()`, spec 03 §10). Default `true`. Errors and `No results found.` stay unwrapped.
   */
  wrapUntrusted?: boolean
  /** Default `'web_search'`. */
  toolName?: string
}

const description = (
  fetchName: string,
): string => `Search the web and return an answer with its sources.

- Use it for current information (library versions, error messages, documentation, news) that the project files cannot tell you. Use ${fetchName} to read a specific page.
- \`allowed_domains\` limits the results to those domains; \`blocked_domains\` excludes some. Use one of them, not both.
- The result is the findings followed by \`Sources:\` lines. Cite the sources you rely on.`

/** The web search plugin. @see docs/specs/22-web-plugin.md */
export function webSearch(options: WebSearchOptions): HarnessPlugin<'web-search'> {
  const toolName = options.toolName ?? 'web_search'
  return definePlugin({
    name: 'web-search',
    session: (ctx) => ({
      tools: {
        [toolName]: tool({
          description: description('web_fetch'),
          inputSchema: z.object({
            query: z.string().min(2).describe('The search query'),
            allowed_domains: z.array(z.string()).optional().describe('Only these domains'),
            blocked_domains: z.array(z.string()).optional().describe('Never these domains'),
          }),
          metadata: { risk: 'external' },
          execute: async (
            { query, allowed_domains, blocked_domains },
            { abortSignal },
          ): Promise<string> => {
            try {
              const found = await options.search(query, {
                ...(allowed_domains?.length ? { allowedDomains: allowed_domains } : {}),
                ...(blocked_domains?.length ? { blockedDomains: blocked_domains } : {}),
                ...(abortSignal ? { signal: abortSignal } : {}),
              })
              if (found.usage !== undefined) {
                ctx.turn?.addUsage(found.usage, {
                  source: 'web_search',
                  ...(found.model !== undefined ? { model: found.model } : {}),
                })
              }
              const text = found.text.trim()
              if (text === '' && found.sources.length === 0) return 'No results found.'
              const sources = found.sources.map((s) =>
                s.title ? `- ${s.title} — ${s.url}` : `- ${s.url}`,
              )
              const body = sources.length > 0 ? `${text}\n\nSources:\n${sources.join('\n')}` : text
              return options.wrapUntrusted === false
                ? body
                : untrustedContent(body, { source: toolName })
            } catch (error) {
              if (abortSignal?.aborted) return 'ERROR: the search was aborted'
              return `ERROR: web search failed: ${error instanceof Error ? error.message : String(error)}`
            }
          },
        }),
      },
    }),
  })
}
