# Spec 22 — Web plugins (`eharness/web`)

Status: **Draft (0.7)**. Module: `src/web/*`. Built only with the public core API (ADR-0008) and
Web APIs (`fetch`, `URL`, `TextDecoder`); no `node:` imports, so the library cannot resolve DNS —
the resolver is injectable. Design principle: ADR-0034.

Both tools carry `metadata.risk: 'external'` (spec 11 §3: approval policy and risk rules apply).
Failures are returned as `ERROR:` strings (hard rule 6). The default tool names are exported as the
constants `WEB_FETCH_TOOL` (`'web_fetch'`) and `WEB_SEARCH_TOOL` (`'web_search'`), like `BASH_TOOL` in
`eharness/shell`.

## 1. Profiles

| Profile | `webFetch` | `webSearch` |
|---|---|---|
| (a) autonomous server | governed by `allow` / `deny` / `onlyAllowed` and `resolveHost`; no approval | the `search` function is the policy (domain filters per call) |
| (b) CLI | same, plus approval by risk or policy (`approval.risk`) | same |
| (c) web/server | same; approvals go through the pending state (spec 11) | same |

## 2. `webFetch(options)` → `HarnessPlugin<'web-fetch'>`

```ts
webFetch({
  allow?: string[] | ((host: string) => boolean)   // trusted hosts
  deny?: string[]                                   // never fetched; wins over allow
  onlyAllowed?: boolean                             // strict allow-list (default false)
  maxBytes?: number         // 5 MiB
  maxChars?: number         // 30 000
  timeoutMs?: number        // 15 000
  maxRedirects?: number     // 5
  toMarkdown?: (html: string, url: string) => string   // default htmlToText
  resolveHost?: (host: string) => Promise<string[]>
  fetch?: typeof fetch
  wrapUntrusted?: boolean   // true: frame the page content (spec 03 §10)
  toolName?: string         // WEB_FETCH_TOOL = 'web_fetch'
  userAgent?: string
})
```

Host patterns (`matchHost`): `example.com` (exact), `*.example.com` (subdomains, not the apex),
`*`, optionally `:port`; case-insensitive.

Tool input `{ url, prompt? }`. Rules, in order:

1. Only `http`/`https`; URLs with credentials are refused.
2. `deny` match → `ERROR: <host> is not allowed`.
3. A host not trusted by `allow` (or any host when `onlyAllowed` and not in `allow`: `ERROR: <host> is not in the allow list`):
   - IP literals and local names (`localhost`, `*.localhost`, `*.local`, `*.internal`, `*.lan`,
     single-label names) in private, loopback, link-local, CGNAT, unspecified or multicast ranges
     (IPv4, IPv6, IPv4-mapped) → `ERROR: <host> is a private or local host and is not allowed. Add it to the <toolName> allow list (allow: ['<host>']) to fetch it.` (`<toolName>` is the configured `toolName`, default `web_fetch`). **Always** applied to untrusted hosts, with or without
     `resolveHost`.
   - ports other than 80/443 → refused.
   - with `resolveHost`: any resolved address in a private range → refused. A resolver error is
     ignored (the fetch reports it). **Without `resolveHost` a public hostname that resolves to a
     private address is NOT blocked** (DNS-based SSRF; the library has no DNS, it is runtime-neutral):
     servers fetching on behalf of untrusted users must pass `resolveHost` (guide: `docs/guides/web.md`).
   - `http` is upgraded to `https`.
   Trusted hosts skip all of rule 3 (their private addresses, odd ports and `http` are fetched).
4. Redirects are handled manually: a same-host redirect is followed (re-checked, never downgraded
   from https), another host returns `REDIRECT: <url> — call <toolName> again with this URL` (so the
   model's next call is checked again), more than `maxRedirects` hops → `ERROR: too many redirects`.
5. Non-2xx → `ERROR: <url> returned HTTP <status> <text>`. Content types: `text/*`, `*json*`,
   `*xml*`, `application/javascript` and none; others → `ERROR: unsupported content type <type> …`.
6. The body is read up to `maxBytes`; `text/html` and `application/xhtml+xml` go through
   `toMarkdown`; the result is capped at `maxChars` with `… [truncated: N more characters]` (or a
   `… [truncated: the page is larger than N MB]` note when only the byte cap hit).
7. Timeout → `ERROR: timed out after Ns`; abort → `ERROR: the fetch was aborted`.

Output: `URL: <final url> · <status> · <bytes> bytes`, an optional `(Focus: <prompt>)` line, a blank
line, the content. Unless `wrapUntrusted: false`, the content (including a truncation note) is
framed with `untrustedContent(content, { source: <toolName>, url: <final url> })` (spec 03 §10);
the header line and every `ERROR:` / `REDIRECT:` string stay unwrapped (they are ours).

The DNS check has a time-of-check gap (rebinding); resolve in the injected function and pin
addresses in a custom `fetch` for strict environments. Document-level threats: page text is data,
never instructions (the description says so).

`htmlToText(html)` is the dependency-free fallback converter: drops `script`, `style`, `nav`,
`footer`, `head`, `svg`, `iframe`, `noscript`, `template`; keeps headings, links, lists, emphasis,
`pre`/`code`; decodes entities. It is not a full HTML parser: plug `turndown` (or similar) into
`toMarkdown` for fidelity.

## 3. `webSearch(options)` → `HarnessPlugin<'web-search'>`

```ts
webSearch({
  search: (query: string, o: { allowedDomains?: string[]; blockedDomains?: string[]; signal?: AbortSignal })
    => Promise<{ text: string; sources: { title?: string; url: string }[]; usage?: AddUsageInput; model?: LanguageModel }>
  wrapUntrusted?: boolean    // true: frame the findings and sources (spec 03 §10)
  toolName?: string          // WEB_SEARCH_TOOL = 'web_search'
})
```

Tool input `{ query (≥ 2 chars), allowed_domains?, blocked_domains? }`. Output: the answer text, a
blank line, `Sources:` and one `- <title> — <url>` (or `- <url>`) line per source; `No results
found.` for empty text and no sources; a thrown error → `ERROR: web search failed: <message>`;
abort → `ERROR: the search was aborted`. Unless `wrapUntrusted: false`, the answer text and the
`Sources:` lines are framed together as one `untrustedContent(…, { source: <toolName> })` block;
`No results found.` and `ERROR:` strings stay unwrapped. `usage` (with `model` or `costUsd`) is charged to the
turn through `ctx.turn.addUsage(…, { source: 'web_search' })`. The library has no provider code;
recipes are in the guide.
