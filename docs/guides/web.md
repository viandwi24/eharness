# Web fetch and search (`eharness/web`)

Two plugins, both `risk: 'external'` (approval rules apply). Contract: [spec 22](../specs/22-web-plugin.md).

```ts
import { webFetch, webSearch } from 'eharness/web'

defineHarnessAgent({
  model,
  plugins: [
    webFetch({ deny: ['*.internal.example.com'] }),
    webSearch({ search }),
  ],
})
```

## `webFetch`

Fetches one http(s) URL and returns Markdown (`URL: … · 200 · N bytes`, then the content).
Safety, all `ERROR:` strings for the model:

- Private, loopback, link-local IP literals and local names are always refused, unless the host
  is trusted with `allow` (for a local docs server: `allow: ['localhost']`).
- The library has no DNS. To refuse names that resolve to private addresses, inject a resolver:
  `resolveHost: async (host) => (await dns.lookup(host, { all: true })).map((e) => e.address)`
  **Without `resolveHost`, a public hostname that resolves to a private address is not blocked**
  (DNS-based SSRF), so set it on any server that fetches for untrusted users. Node (and Bun):

  ```ts
  import { lookup } from 'node:dns/promises'

  webFetch({
    resolveHost: async (host) => (await lookup(host, { all: true })).map((e) => e.address),
  })
  ```
- `deny` always wins; `onlyAllowed: true` turns `allow` into a strict allow-list (the right setup
  for an autonomous server). `allow` can be a predicate wired to your own permission system.
- Cross-host redirects are returned as `REDIRECT: <url>` so the model's next call is checked again.
- Plain `http` is upgraded to `https` for untrusted hosts; ports other than 80/443 are refused.

HTML conversion: the built-in `htmlToText` is a small fallback. For better Markdown inject
`turndown`:

```ts
import TurndownService from 'turndown'
const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' })
turndown.remove(['script', 'style', 'nav', 'footer', 'noscript', 'iframe', 'template'])
webFetch({ toMarkdown: (html) => turndown.turndown(html) })
```

Prompt injection: the page content is wrapped in
`<untrusted-content source="web_fetch" url="…">…</untrusted-content>` (the `URL:` header and errors
are not). Tell the model what the frame means by adding `UNTRUSTED_CONTENT_INSTRUCTIONS` (exported
by `eharness`) to your instructions. Opt out with `wrapUntrusted: false`. Details:
[Permissions → Prompt injection](permissions.md#prompt-injection).

Profiles: autonomous server = allow-list policy and no approval; CLI / web = add `approval` by
risk (`external`) and answer through the pending state ([Approvals and interaction](approvals-and-interaction.md)).

## `webSearch`

The library has no search provider: you supply `search(query, { allowedDomains, blockedDomains, signal })`
returning `{ text, sources, usage?, model? }`. Usage is charged to the turn.

Findings and source titles are framed as `<untrusted-content source="web_search">` too
(`wrapUntrusted: false` to opt out).

OpenRouter (`web` plugin, with the AI SDK OpenRouter provider; citations are AI SDK `url` sources):

```ts
import { generateText } from 'ai'

const search: WebSearchOptions['search'] = async (query, { allowedDomains, blockedDomains, signal }) => {
  const model = openrouter('google/gemini-2.5-flash')
  const result = await generateText({
    model,
    prompt: `Search the web for: ${query}\n\nAnswer with the facts the search found, concisely, and name the sources you used. Do not invent anything that the results do not say.`,
    abortSignal: signal,
    providerOptions: {
      openrouter: {
        plugins: [{ id: 'web', max_results: 5,
          ...(allowedDomains?.length ? { include_domains: allowedDomains } : {}),
          ...(blockedDomains?.length ? { exclude_domains: blockedDomains } : {}) }],
      },
    },
  })
  return {
    text: result.text,
    sources: result.sources.flatMap((s) => (s.sourceType === 'url' ? [{ url: s.url, title: s.title }] : [])),
    usage: result.usage,
    model,
  }
}
```

AI Gateway (Perplexity search tool, provider-executed):

```ts
import { gateway, generateText, stepCountIs } from 'ai'

const search: WebSearchOptions['search'] = async (query, { allowedDomains, blockedDomains, signal }) => {
  const model = gateway('anthropic/claude-haiku-4.5')
  const filter = allowedDomains?.length ? allowedDomains : (blockedDomains ?? []).map((d) => `-${d}`)
  const result = await generateText({
    model,
    prompt: `Search the web for: ${query}`,
    abortSignal: signal,
    tools: { web_search: gateway.tools.perplexitySearch({ maxResults: 5, ...(filter.length ? { search_domain_filter: filter } : {}) }) },
    stopWhen: stepCountIs(4),
  })
  const sources = result.steps.flatMap((s) => s.toolResults.flatMap((r) => (r.output as { results?: { url: string; title?: string }[] })?.results ?? []))
  return { text: result.text, sources, usage: result.usage, model }
}
```

Check the provider package versions for the exact option names; these recipes mirror
`examples/coder/src/app/web-tools.ts`.

Refused private or local hosts tell the model how to allow them: `ERROR: <host> is a private or
local host and is not allowed. Add it to the web_fetch allow list (allow: ['<host>']) to fetch it.`
The text is neutral; wrap the tool (or map the host to `WebFetch(domain:<host>)`) if your app
manages that allow list through permission rules.
