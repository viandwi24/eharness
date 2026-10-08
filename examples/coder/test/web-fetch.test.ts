import { afterAll, describe, expect, test } from 'bun:test'
import { createWebFetchTool, htmlToMarkdown, isPrivateHost } from '../src/app/web-tools.ts'

const HTML = `<!doctype html><html><head><title>T</title><style>.x{}</style><script>evil()</script></head>
<body><nav><a href="/">Home</a></nav><main><h1>Title</h1><p>Hello <b>world</b> <a href="https://e.com/a">link</a></p>
<ul><li>one</li><li>two</li></ul><pre><code>const a = 1</code></pre></main><footer>copyright</footer></body></html>`

const big = 'x'.repeat(6 * 1024 * 1024)

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
        return new Response(big, { headers: { 'content-type': 'text/plain' } })
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

type Exec = (input: unknown, opts: unknown) => Promise<string>
const run = async (
  deps: Parameters<typeof createWebFetchTool>[0],
  input: { url: string; prompt?: string },
  signal?: AbortSignal,
): Promise<string> => {
  const t = createWebFetchTool(deps) as unknown as { execute: Exec }
  return t.execute(input, { toolCallId: 'c', messages: [], abortSignal: signal })
}
const local = { isHostAllowed: (h: string) => h === '127.0.0.1' }

describe('web_fetch', () => {
  test('HTML becomes Markdown without scripts, styles, nav and footer; header line first', async () => {
    const out = await run(local, { url: `${base}/html` })
    const [header, , ...rest] = out.split('\n')
    expect(header).toMatch(new RegExp(`^URL: ${base}/html · 200 · \\d+ bytes$`))
    const body = rest.join('\n')
    expect(body).toContain('# Title')
    expect(body).toContain('Hello **world** [link](https://e.com/a)')
    expect(body).toContain('-   one')
    expect(body).toContain('const a = 1')
    for (const gone of ['evil()', 'Home', 'copyright', '.x{}']) expect(body).not.toContain(gone)
  })

  test('prompt is repeated as a Focus line', async () => {
    const out = await run(local, { url: `${base}/text`, prompt: 'the price' })
    expect(out).toBe(`URL: ${base}/text · 200 · 10 bytes\n(Focus: the price)\n\nplain text`)
  })

  test('JSON and plain text pass through', async () => {
    expect(await run(local, { url: `${base}/json` })).toEndWith('\n\n{"a":1}')
  })

  test('the result is capped at 30 000 characters with a note', async () => {
    const out = await run(local, { url: `${base}/long` })
    expect(out).toContain('… [truncated: 20000 more characters]')
    expect(out.length).toBeLessThan(30_200)
  })

  test('the body is capped at 5 MB', async () => {
    const out = await run(local, { url: `${base}/huge` })
    expect(out.split('\n')[0]).toContain(`${5 * 1024 * 1024} bytes`)
    expect(out).toContain('truncated')
  })

  test('a same-host redirect is followed, a cross-host one is returned', async () => {
    expect(await run(local, { url: `${base}/same` })).toContain('plain text')
    const other = await run(local, { url: `${base}/other` })
    expect(other).toBe(
      'REDIRECT: http://localhost:1/elsewhere — call web_fetch again with this URL',
    )
    expect(await run(local, { url: `${base}/loop` })).toContain('too many redirects')
  })

  test('errors are ERROR strings: 404, binary, bad URL, protocol, credentials, timeout', async () => {
    expect(await run(local, { url: `${base}/missing` })).toBe(
      `ERROR: ${base}/missing returned HTTP 404 Not Found`,
    )
    expect(await run(local, { url: `${base}/img` })).toContain(
      'ERROR: unsupported content type image/png',
    )
    expect(await run(local, { url: 'not a url' })).toStartWith('ERROR: invalid URL')
    expect(await run(local, { url: 'file:///etc/passwd' })).toContain('only http and https')
    expect(await run(local, { url: 'https://user:pw@example.com/' })).toContain('credentials')
    expect(await run({ ...local, timeoutMs: 100 }, { url: `${base}/slow` })).toContain('timed out')
    const controller = new AbortController()
    const pending = run(local, { url: `${base}/slow` }, controller.signal)
    controller.abort()
    expect(await pending).toBe('ERROR: the fetch was aborted')
  })

  test('private hosts and unusual ports are refused without an allow rule', async () => {
    const strict = { isHostAllowed: () => false }
    expect(await run(strict, { url: `${base}/text` })).toContain('private or local host')
    expect(await run(strict, { url: 'http://localhost/x' })).toContain('WebFetch(domain:localhost)')
    expect(await run(strict, { url: 'https://169.254.169.254/latest' })).toContain('private')
    expect(await run(strict, { url: 'https://[::1]/' })).toContain('private')
    const publicResolve = { ...strict, resolve: async () => ['93.184.216.34'] }
    expect(await run(publicResolve, { url: 'https://example.com:8443/x' })).toContain(
      'port 8443 is not allowed',
    )
    const rebinding = { ...strict, resolve: async () => ['10.0.0.5'] }
    expect(await run(rebinding, { url: 'https://example.com/x' })).toContain(
      'resolves to a private address',
    )
  })

  test('http is upgraded to https for public hosts; allowed local hosts keep http', async () => {
    const seen: string[] = []
    const fake = (async (url: string) => {
      seen.push(url)
      return new Response('ok', { headers: { 'content-type': 'text/plain' } })
    }) as unknown as typeof fetch
    const deps = { isHostAllowed: () => false, fetch: fake, resolve: async () => ['93.184.216.34'] }
    await run(deps, { url: 'http://example.com/a?b=1' })
    await run(deps, { url: 'http://example.com:80/c' })
    expect(seen).toEqual(['https://example.com/a?b=1', 'https://example.com/c'])
  })

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
      'intranet',
      'x.internal',
    ]) {
      expect(isPrivateHost(h)).toBe(true)
    }
    for (const h of ['example.com', '93.184.216.34', '172.32.0.1', '2606:4700::1111']) {
      expect(isPrivateHost(h)).toBe(false)
    }
  })

  test('htmlToMarkdown', () => {
    expect(htmlToMarkdown('<h2>A</h2><script>x</script><p>b</p>')).toBe('## A\n\nb')
  })
})
