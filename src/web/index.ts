/**
 * `eharness/web`: the `webFetch()` and `webSearch()` plugins — one URL to Markdown with SSRF
 * guards, and a provider-agnostic web search tool.
 *
 * **Draft:** every symbol of this subpath is experimental and may change in a minor release
 * (docs/engineering/api-stability.md).
 *
 * @experimental
 * @see docs/specs/22-web-plugin.md
 */
export {
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
