# Web fetch and search (`eharness/web`)

Two plugins, both `risk: 'external'` (approval rules apply). Contract: [spec 22](../specs/22-web-plugin.md).

```ts
import { defineHarnessAgent } from 'eharness'
import { webFetch, webSearch } from 'eharness/web'

// yours: model (LanguageModel) and search (see `webSearch` below)
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
- Local names and IP literals are normalised first: a trailing dot (`localhost.`,
  `metadata.google.internal.`) is ignored, and IPv4-mapped / compatible, NAT64 (`64:ff9b::/96`),
  6to4 (`2002::/16`, embedded IPv4 checked), site-local (`fec0::/10`), `100.64.0.0/10`,
  `198.18.0.0/15`, `0.0.0.0/8`, `192.0.0.0/24` and the documentation ranges are refused too.
- The library has no DNS (the core is runtime-neutral). To refuse names that resolve to private
  addresses, pass `resolveHost: (host) => Promise<string[]>`, which returns the addresses of a
  name. Node ships a ready one, `nodeResolveHost` in `eharness/web/node` (Node-only, ADR-0036;
  `dns.lookup` with all addresses, IP literals resolve to themselves, an unresolvable name is left
  to the fetch to report):

  ```ts
  import { webFetch } from 'eharness/web'
  import { nodeResolveHost } from 'eharness/web/node'

  webFetch({ resolveHost: nodeResolveHost })
  ```

  **Without `resolveHost`, a public hostname that resolves to a private address is not blocked**
  (DNS-based SSRF), so set it on any server that fetches for untrusted users. Creating `webFetch`
  without it (and without `onlyAllowed`) emits a `W_WEB_NO_RESOLVER` warning once per session
  (`onWarning`); with `onlyAllowed: true` no resolver is needed because only hosts you named are
  fetched. On other runtimes pass your own resolver (for example a DNS-over-HTTPS lookup).
- `isPrivateHost(host)` (exported from `eharness`, not `eharness/web`) is the check `webFetch` uses
  for IP literals and local names; call it yourself, for example in a pinned-IP `fetch` as below.
- **DNS rebinding is not prevented.** The resolver check and the connection are two lookups: a
  hostile DNS server can answer a public address first and `169.254.169.254` second. For a hard
  guarantee, pin the checked address in your `fetch`. Node recipe with `undici`
  (`bun add undici`; your app dependency, not the library's):

  ```ts
  import { lookup } from 'node:dns'
  import { Agent, fetch as undiciFetch } from 'undici'
  import { isPrivateHost } from 'eharness'
  import { webFetch } from 'eharness/web'

  // validates the address the socket really connects to, at connect time
  const dispatcher = new Agent({
    connect: {
      lookup: (host, opts, cb) =>
        lookup(host, opts, (err, address, family) => {
          const list = Array.isArray(address) ? address.map((a) => a.address) : [address]
          if (!err && list.some((a) => isPrivateHost(a))) return cb(new Error('private address'), '', 4)
          cb(err, address as never, family)
        }),
    },
  })
  webFetch({ fetch: ((url, init) => undiciFetch(url as string, { ...init, dispatcher })) as typeof fetch })
  ```

  Trusted hosts (`allow`) that are private will fail this dispatcher: use it only for deployments
  without an `allow` list of internal hosts, or branch on the host.
- `deny` always wins; `onlyAllowed: true` turns `allow` into a strict allow-list (the right setup
  for an autonomous server). `allow` can be a predicate wired to your own permission system.
- Cross-host redirects are returned as `REDIRECT: <url>` so the model's next call is checked again.
- Plain `http` is upgraded to `https` for untrusted hosts; ports other than 80/443 are refused.

HTML conversion: the built-in converter is a small fallback. For better Markdown inject
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
import type { WebSearchOptions } from 'eharness/web'

// yours: openrouter (the AI SDK OpenRouter provider instance)
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
import type { WebSearchOptions } from 'eharness/web'

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
