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
  WEB_FETCH_TOOL,
  type WebFetchOptions,
  webFetch,
} from './fetch.ts'
export {
  type SearchOptions,
  type SearchResult,
  WEB_SEARCH_TOOL,
  type WebSearchOptions,
  webSearch,
} from './search.ts'
