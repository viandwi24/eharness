---
"eharness": minor
---

New subpath `eharness/web`: `webFetch()` and `webSearch()`.

- `webFetch(options?)` fetches one URL as Markdown: allow and deny lists, a refusal of private and local addresses (an injectable `resolveHost` extends it to DNS names), redirects reported as `REDIRECT:`, byte and character caps, an injectable `toMarkdown` and `fetch`. Page content is framed as `<untrusted-content source="web_fetch" url="…">` (`wrapUntrusted: false` opts out).
- `webSearch({ search })` is provider-agnostic: you supply the search function; findings and sources are framed as untrusted content and its usage is charged to the turn.
- Both tools are `metadata.risk: 'external'` and return `ERROR:` strings for failures. Default tool names are exported as `WEB_FETCH_TOOL` and `WEB_SEARCH_TOOL`; helpers `htmlToText`, `isPrivateHost`, `matchHost`.

Known gap: without `resolveHost`, DNS names that resolve to private addresses are not refused. See spec 22 and the web guide.
