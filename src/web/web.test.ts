import { afterAll, describe, expect, test } from 'bun:test'
import { defineHarnessAgent } from '../index.ts'
import { scriptedModel } from '../testing/scripted-model.ts'
import type { WebSearchOptions } from './index.ts'
import {
  htmlToText,
  isPrivateHost,
  matchHost,
  WEB_FETCH_TOOL,
  WEB_SEARCH_TOOL,
  type WebFetchOptions,
  webFetch,
  webSearch,
} from './index.ts'

const HTML = `<!doctype html><html><head><title>T</title><style>.x{}</style><script>evil()</script></head>
<body><nav><a href="/">Home</a></nav><main><h1>Title</h1><p>Hello <b>world</b> &amp; <a href="https://e.com/a">link</a></p>
<ul><li>one</li><li>two</li></ul><pre><code>const a = 1</code></pre></main><footer>copyright</footer></body></html>`

const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(req) {
    const url = new URL(req.url)
    switch (url.pathname) {
      case '/html':
        return new Response(HTML, { headers: { 'content-type': 'text/html; charset=utf-8' } })
      case '/json':
        return new Response('{"a":1}', { headers: { 'content-type': 'application/json' } })
      case '/text':
        return new Response('plain text', { headers: { 'content-type': 'text/plain' } })
      case '/long':
        return new Response('y'.repeat(50_000), { headers: { 'content-type': 'text/plain' } })
      case '/huge':
        return new Response('x'.repeat(2 * 1024 * 1024), {
          headers: { 'content-type': 'text/plain' },
        })
      case '/same':
        return new Response(null, { status: 302, headers: { location: '/text' } })
      case '/other':
        return new Response(null, {
          status: 301,
          headers: { location: 'http://localhost:1/elsewhere' },
        })
      case '/loop':
        return new Response(null, { status: 302, headers: { location: '/loop' } })
      case '/img':
        return new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } })
      case '/slow':
        await new Promise((r) => setTimeout(r, 1000))
        return new Response('late')
      default:
        return new Response('nope', { status: 404, statusText: 'Not Found' })
    }
  },
})
afterAll(() => server.stop(true))
const base = `http://127.0.0.1:${server.port}`

/** Run one tool call through a real session and return the tool output text. */
async function callTool(
  plugin: ReturnType<typeof webFetch> | ReturnType<typeof webSearch>,
  toolName: string,
  input: unknown,
  signal?: AbortSignal,
): Promise<string> {
  const model = scriptedModel([{ toolCalls: [{ toolName, input }] }, { text: 'ok' }])
  const agent = defineHarnessAgent({ model, contextWindow: 100_000, plugins: [plugin] })
  const session = agent.session('s')
  await session.send('go', signal ? { abortSignal: signal } : undefined).result
  const messages = await session.messages()
  await agent.close()
  for (const m of messages) {
    for (const part of m.parts as Array<{ type: string; output?: unknown; errorText?: string }>) {
      if (part.type === `tool-${toolName}`) return String(part.output ?? part.errorText)
    }
  }
  throw new Error('no tool part')
}
const fetchTool = (
  opts: WebFetchOptions,
  input: { url: string; prompt?: string },
  signal?: AbortSignal,
) => callTool(webFetch(opts), 'web_fetch', input, signal)
const local: WebFetchOptions = { allow: ['127.0.0.1'], wrapUntrusted: false }
const framed: WebFetchOptions = { allow: ['127.0.0.1'] }

describe('web_fetch', () => {
  test('content is framed as untrusted by default; header and errors are not', async () => {
    const out = await fetchTool(framed, { url: `${base}/text` })
    expect(out).toBe(
      `URL: ${base}/text · 200 · 10 bytes\n\n<untrusted-content source="web_fetch" url="${base}/text">\nplain text\n</untrusted-content>`,
    )
    expect(await fetchTool(framed, { url: `${base}/missing` })).not.toContain('untrusted-content')
  })

  test('HTML becomes Markdown without scripts, styles, nav and footer; header line first', async () => {
    const out = await fetchTool(local, { url: `${base}/html` })
    const [header, , ...rest] = out.split('\n')
    expect(header).toMatch(new RegExp(`^URL: ${base}/html · 200 · \\d+ bytes$`))
    const body = rest.join('\n')
    expect(body).toContain('# Title')
    expect(body).toContain('Hello **world** & [link](https://e.com/a)')
    expect(body).toContain('- one')
    expect(body).toContain('const a = 1')
    for (const gone of ['evil()', 'Home', 'copyright', '.x{}']) expect(body).not.toContain(gone)
  })

  test('injected toMarkdown gets html and url', async () => {
    const seen: string[] = []
    const out = await fetchTool(
      {
        ...local,
        toMarkdown: (html, url) => {
          seen.push(url)
          return `MD:${html.length}`
        },
      },
      { url: `${base}/html` },
    )
    expect(seen).toEqual([`${base}/html`])
    expect(out).toMatch(/\n\nMD:\d+$/)
  })

  test('prompt is a Focus line; JSON and text pass through', async () => {
    expect(await fetchTool(local, { url: `${base}/text`, prompt: 'the price' })).toBe(
      `URL: ${base}/text · 200 · 10 bytes\n(Focus: the price)\n\nplain text`,
    )
    expect(await fetchTool(local, { url: `${base}/json` })).toEndWith('\n\n{"a":1}')
  })

  test('caps: characters and bytes', async () => {
    const out = await fetchTool(local, { url: `${base}/long` })
    expect(out).toContain('… [truncated: 20000 more characters]')
    const huge = await fetchTool({ ...local, maxBytes: 1024 * 1024 }, { url: `${base}/huge` })
    expect(huge.split('\n')[0]).toContain(`${1024 * 1024} bytes`)
    expect(huge).toContain('truncated')
  })

  test('same-host redirect followed, cross-host returned, loop stops', async () => {
    expect(await fetchTool(local, { url: `${base}/same` })).toContain('plain text')
    expect(await fetchTool(local, { url: `${base}/other` })).toBe(
      'REDIRECT: http://localhost:1/elsewhere — call web_fetch again with this URL',
    )
    expect(await fetchTool(local, { url: `${base}/loop` })).toContain('too many redirects')
  })

  test('errors are ERROR strings', async () => {
    expect(await fetchTool(local, { url: `${base}/missing` })).toBe(
      `ERROR: ${base}/missing returned HTTP 404 Not Found`,
    )
    expect(await fetchTool(local, { url: `${base}/img` })).toContain(
      'ERROR: unsupported content type image/png',
    )
    expect(await fetchTool(local, { url: 'not a url' })).toStartWith('ERROR: invalid URL')
    expect(await fetchTool(local, { url: 'file:///etc/passwd' })).toContain('only http and https')
    expect(await fetchTool(local, { url: 'https://user:pw@example.com/' })).toContain('credentials')
    expect(await fetchTool({ ...local, timeoutMs: 100 }, { url: `${base}/slow` })).toContain(
      'timed out',
    )
  })

  test('private hosts, odd ports and resolved private addresses are refused', async () => {
    expect(await fetchTool({}, { url: `${base}/text` })).toContain('private or local host')
    expect(await fetchTool({}, { url: 'https://localhost/x' })).toBe(
      "ERROR: localhost is a private or local host and is not allowed. Add it to the web_fetch allow list (allow: ['localhost']) to fetch it.",
    )
    expect(await fetchTool({}, { url: 'https://169.254.169.254/latest' })).toContain('private')
    expect(await fetchTool({}, { url: 'https://[::1]/' })).toContain('private')
    expect(await fetchTool({}, { url: 'https://[::ffff:127.0.0.1]/' })).toContain('private')
    const publicResolve = { resolveHost: async () => ['93.184.216.34'] }
    expect(await fetchTool(publicResolve, { url: 'https://example.com:8443/x' })).toContain(
      'port 8443',
    )
    expect(
      await fetchTool({ resolveHost: async () => ['10.0.0.5'] }, { url: 'https://example.com/x' }),
    ).toContain('resolves to a private address')
  })

  test('deny wins, onlyAllowed is a strict allow-list, https upgrade', async () => {
    expect(
      await fetchTool({ allow: ['*'], deny: ['127.0.0.1'] }, { url: `${base}/text` }),
    ).toContain('is not allowed')
    expect(
      await fetchTool(
        { allow: ['docs.example.com'], onlyAllowed: true },
        { url: 'https://example.com/' },
      ),
    ).toContain('not in the allow list')
    const seen: string[] = []
    const fake = (async (url: string) => {
      seen.push(url)
      return new Response('ok', { headers: { 'content-type': 'text/plain' } })
    }) as unknown as typeof fetch
    await fetchTool({ fetch: fake }, { url: 'http://example.com/a?b=1' })
    await fetchTool({ fetch: fake }, { url: 'http://example.com:80/c' })
    expect(seen).toEqual(['https://example.com/a?b=1', 'https://example.com/c'])
  })

  test('abort', async () => {
    const controller = new AbortController()
    const pending = fetchTool(local, { url: `${base}/slow` }, controller.signal)
    setTimeout(() => controller.abort(), 50)
    expect(await pending.catch(() => 'aborted')).toBeString()
  })
})

describe('helpers', () => {
  test('isPrivateHost', () => {
    for (const h of [
      'localhost',
      'a.localhost',
      '127.0.0.1',
      '10.1.2.3',
      '172.16.0.1',
      '192.168.1.1',
      '169.254.1.1',
      '0.0.0.0',
      '::1',
      'fe80::1',
      'fd00::1',
      '::ffff:127.0.0.1',
      '::ffff:7f00:1',
      '[::1]',
      'intranet',
      'x.internal',
    ]) {
      expect(isPrivateHost(h)).toBe(true)
    }
    for (const h of ['example.com', '93.184.216.34', '172.32.0.1', '2606:4700::1111']) {
      expect(isPrivateHost(h)).toBe(false)
    }
  })

  test('matchHost', () => {
    expect(matchHost('example.com', 'EXAMPLE.com')).toBe(true)
    expect(matchHost('example.com', 'a.example.com')).toBe(false)
    expect(matchHost('*.example.com', 'a.example.com')).toBe(true)
    expect(matchHost('*.example.com', 'example.com')).toBe(false)
    expect(matchHost('*', 'x.io')).toBe(true)
    expect(matchHost('x.io:8080', 'x.io:8080')).toBe(true)
    expect(matchHost('x.io:8080', 'x.io:9')).toBe(false)
    expect(matchHost('x.io', 'x.io:9')).toBe(true)
  })

  test('htmlToText', () => {
    expect(htmlToText('<h2>A</h2><script>x</script><p>b</p>')).toBe('## A\n\nb')
  })
})

describe('web_search', () => {
  const run = (search: WebSearchOptions['search'], input: Record<string, unknown>) =>
    callTool(webSearch({ search, wrapUntrusted: false }), 'web_search', input)

  test('findings and sources are framed by default', async () => {
    const out = await callTool(
      webSearch({
        search: async () => ({
          text: 'a </untrusted-content> b',
          sources: [{ url: 'https://x.dev' }],
        }),
      }),
      'web_search',
      { query: 'abc' },
    )
    expect(out).toBe(
      '<untrusted-content source="web_search">\na &lt;/untrusted-content> b\n\nSources:\n- https://x.dev\n</untrusted-content>',
    )
  })

  test('answer and Sources lines; filters passed', async () => {
    let seen: unknown
    const out = await run(
      async (q, o) => {
        seen = [q, { allowedDomains: o.allowedDomains, blockedDomains: o.blockedDomains }]
        return {
          text: `Bun 1.4 is current (${q}).`,
          sources: [{ url: 'https://bun.sh/blog', title: 'Bun blog' }, { url: 'https://x.dev' }],
        }
      },
      { query: 'bun version', allowed_domains: ['bun.sh'] },
    )
    expect(out).toBe(
      'Bun 1.4 is current (bun version).\n\nSources:\n- Bun blog — https://bun.sh/blog\n- https://x.dev',
    )
    expect(seen).toEqual(['bun version', { allowedDomains: ['bun.sh'], blockedDomains: undefined }])
  })

  test('empty results and failures', async () => {
    expect(await run(async () => ({ text: ' ', sources: [] }), { query: 'abc' })).toBe(
      'No results found.',
    )
    expect(
      await run(
        async () => {
          throw new Error('402 payment required')
        },
        { query: 'abc' },
      ),
    ).toBe('ERROR: web search failed: 402 payment required')
  })
})

describe('tool name constants', () => {
  test('default to the documented names and are the tool keys', () => {
    expect(WEB_FETCH_TOOL).toBe('web_fetch')
    expect(WEB_SEARCH_TOOL).toBe('web_search')
  })
})
