/**
 * `eharness/web`: the `webFetch()` and `webSearch()` plugins — one URL to Markdown with SSRF
 * guards, and a provider-agnostic web search tool.
 *
 * @see docs/specs/22-web-plugin.md
 */
export {
  htmlToText,
  isPrivateHost,
  matchHost,
  type WebFetchOptions,
  webFetch,
} from './fetch.ts'
export {
  type SearchOptions,
  type SearchResult,
  type WebSearchOptions,
  webSearch,
} from './search.ts'
