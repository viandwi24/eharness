/**
 * Artifacts (docs/plans/P45-team-artifacts.md, phases 1-2 + the revision): kind registry and
 * validation, creation (content, `from`, `dir`), versions snapshotted at the end of a turn, signed
 * view URLs and their expiry, the CSP on the content routes, the share token lifecycle, and the
 * authority of `artifact_visibility`.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ScriptedCallOptions, type ScriptedStepInput, scriptedModel } from 'eharness/testing'
import {
  ARTIFACT_KIND_IDS,
  kindForFile,
  pickEntry,
  validateArtifact,
} from '../../shared/artifacts/kinds.ts'
import { createAgent, updateAgent } from '../src/app/agents.ts'
import { builtinId } from '../src/domain/connectors.ts'
import { type ArtifactDecisions, artifacts } from '../src/infra/artifacts/plugin.ts'
import { libraryFs } from '../src/infra/eh/library-fs.ts'
import type { ModelConfig } from '../src/infra/eh/provider.ts'
import { compose, type Server } from '../src/main.ts'
import { postAs, userMessage } from './support/http.ts'

const servers: Server[] = []
const dirs: string[] = []
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1,
  0, 0, 0, 1, 8, 6, 0, 0, 0, 0x1f, 0x15, 0xc4, 0x89, 0xff, 0xfe, 0xfd,
])

function boot(env: Record<string, string | undefined> = {}, token?: string): Server {
  const server = compose({
    dbFile: ':memory:',
    seed: false,
    env,
    ...(token === undefined ? {} : { token }),
    models: {
      provider: 'scripted',
      defaultModel: 'none',
      resolve: () => scriptedModel([]) as never,
    },
    tuning: { streams: { flushMs: 5, pollMs: 20 }, inbox: { pollMs: 30 }, abortPollMs: 40 },
    eventsPollMs: 30,
    reconcile: { onBoot: false, everyMs: 0 },
    routines: { tickMs: 0 },
    publicUrl: 'http://localhost:4000',
    webUrl: 'http://localhost:5173',
  })
  servers.push(server)
  return server
}

const create = (
  server: Server,
  input: Record<string, unknown>,
): Promise<{ id: string; version: number; dir: string; entry: string; files: unknown[] }> =>
  server.artifacts.create(input as never).then((a) => a as never)

describe('kind registry', () => {
  test('every kind is defined; entries and the file fallback', () => {
    expect(ARTIFACT_KIND_IDS).toEqual([
      'html',
      'document',
      'image',
      'mermaid',
      'code',
      'data',
      'file',
    ])
    expect(pickEntry('html', ['a.css', 'index.html'])).toBe('index.html')
    expect(pickEntry('document', ['notes/x.md', 'b.md'])).toBe('b.md')
    expect(pickEntry('image', ['chart.png'], 'chart.png')).toBe('chart.png')
    expect(pickEntry('image', ['chart.png'], 'nope.png')).toBeUndefined()
    expect(kindForFile('x.mmd')).toBe('mermaid')
    expect(kindForFile('x.csv')).toBe('data')
    expect(kindForFile('x.py')).toBe('code')
  })

  test('validate: html (missing asset, blocked host, fetch), mermaid, data, svg', () => {
    const f = (path: string, text: string) => ({
      path,
      size: text.length,
      mediaType: 'text/plain',
      text,
    })
    const html = validateArtifact(
      'html',
      [
        f(
          'index.html',
          '<html><head><script src="https://evil.example/x.js"></script><link href="style.css"></head><body><script>fetch("https://api.example/x")</script></body></html>',
        ),
      ],
      'index.html',
    )
    expect(html.join('\n')).toContain('style.css')
    expect(html.join('\n')).toContain('evil.example')
    expect(html.join('\n')).toContain('fetch()')
    expect(
      validateArtifact(
        'html',
        [
          f(
            'index.html',
            '<html><body><script src="https://cdn.jsdelivr.net/npm/chart.js"></script></body></html>',
          ),
        ],
        'index.html',
      ),
    ).toEqual([])
    expect(validateArtifact('mermaid', [f('d.mmd', 'hello world')], 'd.mmd')[0]).toContain(
      'diagram type',
    )
    expect(
      validateArtifact('mermaid', [f('d.mmd', '%% c\nflowchart TD\n A-->B')], 'd.mmd'),
    ).toEqual([])
    expect(validateArtifact('data', [f('d.json', '{oops')], 'd.json')[0]).toContain(
      'not valid JSON',
    )
    expect(validateArtifact('data', [f('d.csv', 'a,b\n1,2\n3')], 'd.csv')[0]).toContain('columns')
    expect(
      validateArtifact(
        'image',
        [{ path: 'a.svg', size: 9, mediaType: 'image/svg+xml', text: '<p>x</p>' }],
        'a.svg',
      )[0],
    ).toContain('not an SVG')
    expect(validateArtifact('document', [f('a.txt', 'x')], 'a.txt')[0]).toContain(
      'not a document file',
    )
  })
})

describe('creation and versions', () => {
  test('content, from and dir; entry pick; private by default; list and get', async () => {
    const server = boot()
    const fs = libraryFs(server.conn.sqlite)
    await fs.writeBytes?.('/library/work/chart.png', PNG)
    await fs.write('/library/work/report/index.html', '<html><body><h1>Hi</h1></body></html>')
    await fs.write('/library/work/report/app.js', 'console.log(1)')

    const page = await create(server, {
      kind: 'html',
      title: 'Landing page',
      files: [
        { path: 'index.html', content: '<!doctype html><html><body><h1>Hello</h1></body></html>' },
      ],
    })
    expect(page.version).toBe(1)
    expect(page.dir).toMatch(/^\/library\/artifacts\/landing-page-[a-z0-9]{6}$/)
    expect(page.entry).toBe('index.html')

    const img = await create(server, {
      kind: 'image',
      title: 'Sales chart',
      files: [{ from: '/library/work/chart.png' }],
    })
    expect(img.entry).toBe('chart.png')
    // the copy is a binary file in the artifact folder; the original stays where it was
    expect((await fs.readBytes?.(`${img.dir}/chart.png`))?.bytes.byteLength).toBe(PNG.byteLength)
    expect(await fs.stat?.('/library/work/chart.png')).not.toBeNull()

    const adopted = await create(server, {
      kind: 'html',
      title: 'Report',
      dir: '/library/work/report',
    })
    expect(adopted.dir).toBe('/library/work/report')
    expect(adopted.files).toHaveLength(2)
    // one folder, one artifact
    await expect(
      create(server, { kind: 'html', title: 'Again', dir: '/library/work/report' }),
    ).rejects.toThrow(/already the folder/)
    await expect(
      create(server, { kind: 'html', title: 'Broad', dir: '/library' }),
    ).rejects.toThrow()
    await expect(
      create(server, {
        kind: 'html',
        title: 'Escape',
        files: [{ path: '../x.html', content: 'x' }],
      }),
    ).rejects.toThrow(/invalid artifact file path/)

    const res = await server.app.request('/artifacts')
    const list = (await res.json()) as {
      items: Array<{ id: string; visibility: string; shareUrl: string | null }>
    }
    expect(list.items).toHaveLength(3)
    expect(list.items.every((i) => i.visibility === 'private' && i.shareUrl === null)).toBe(true)
    const one = (await (await server.app.request(`/artifacts/${page.id}`)).json()) as {
      files: Array<{ path: string; size: number; mediaType: string }>
    }
    expect(one.files).toEqual([
      { path: 'index.html', size: expect.any(Number), mediaType: 'text/html' },
    ])
    const filtered = (await (
      await server.app.request('/artifacts?kind=image&query=sales')
    ).json()) as {
      items: unknown[]
    }
    expect(filtered.items).toHaveLength(1)
  })

  test('a write to the folder makes version 2 at the end of the turn; old versions stay viewable', async () => {
    const server = boot()
    const page = await create(server, {
      kind: 'html',
      title: 'Hero',
      files: [{ path: 'index.html', content: '<html><body style="color:red">v1</body></html>' }],
    })
    const agentFs = libraryFs(server.conn.sqlite, {
      agentId: 'agent-x',
      onChange: (c) => server.artifacts.onLibraryChange(c),
    })
    await agentFs.write(`${page.dir}/index.html`, '<html><body style="color:blue">v2</body></html>')
    const done = await server.artifacts.snapshotDirty('agent-x')
    expect(done.map((d) => d.n)).toEqual([2])
    // nothing changed since: no third version
    expect(await server.artifacts.snapshotDirty('agent-x')).toEqual([])
    const versions = (await (
      await server.app.request(`/artifacts/${page.id}/versions`)
    ).json()) as Array<{
      n: number
      by: string
    }>
    expect(versions.map((v) => [v.n, v.by])).toEqual([
      [2, 'agent:agent-x'],
      [1, expect.stringContaining('')],
    ])
    expect(server.artifacts.contentOfVersion(page.id, 1, '')?.bytes).toBeDefined()
    expect(
      new TextDecoder().decode(server.artifacts.contentOfVersion(page.id, 1, '')?.bytes),
    ).toContain('red')
    expect(
      new TextDecoder().decode(server.artifacts.contentOfVersion(page.id, 2, '')?.bytes),
    ).toContain('blue')
  })

  test('editor save is compare-and-set and makes a version by the web; a stale save conflicts', async () => {
    const server = boot()
    const doc = await create(server, {
      kind: 'document',
      title: 'Proposal',
      files: [{ path: 'document.md', content: '# One\n' }],
    })
    const fs = libraryFs(server.conn.sqlite)
    const cur = (await fs.stat?.(`${doc.dir}/document.md`))?.version
    const ok = await server.app.request(`/artifacts/${doc.id}/entry`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: '# Two\n', ifVersion: cur }),
    })
    expect(ok.status).toBe(200)
    expect(((await ok.json()) as { version: number }).version).toBe(2)
    const stale = await server.app.request(`/artifacts/${doc.id}/entry`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: '# Three\n', ifVersion: cur }),
    })
    expect(stale.status).toBe(409)
    expect(((await stale.json()) as { error: { code: string } }).error.code).toBe(
      'VERSION_CONFLICT',
    )
    const versions = (await (
      await server.app.request(`/artifacts/${doc.id}/versions`)
    ).json()) as Array<{ by: string }>
    expect(versions[0]?.by).toBe('web')
  })

  test('exports: md, html of a document, csv of json, zip; client formats refuse', async () => {
    const server = boot()
    const doc = await create(server, {
      kind: 'document',
      title: 'Plan',
      files: [{ path: 'document.md', content: '# Title\n\n- a\n- b\n\n<script>x</script>' }],
    })
    const html = await server.app.request(`/artifacts/${doc.id}/export/html`)
    expect(html.status).toBe(200)
    const text = await html.text()
    expect(text).toContain('<h1>Title</h1>')
    expect(text).toContain('&lt;script&gt;')
    expect((await server.app.request(`/artifacts/${doc.id}/export/pdf`)).status).toBe(400)
    const zip = new Uint8Array(
      await (await server.app.request(`/artifacts/${doc.id}/export/zip`)).arrayBuffer(),
    )
    expect(String.fromCharCode(...zip.slice(0, 2))).toBe('PK')
    const data = await create(server, {
      kind: 'data',
      title: 'Rows',
      files: [{ path: 'data.json', content: '[{"a":1,"b":"x,y"},{"a":2,"b":"z"}]' }],
    })
    expect(await (await server.app.request(`/artifacts/${data.id}/export/csv`)).text()).toBe(
      'a,b\n1,"x,y"\n2,z\n',
    )
  })
})

describe('content routes', () => {
  test('signed view URL: CSP and hardening headers, the bridge, relative assets, expiry, tampering', async () => {
    let now = Date.now()
    const server = boot()
    const page = await create(server, {
      kind: 'html',
      title: 'Page',
      files: [
        {
          path: 'index.html',
          content:
            '<!doctype html><html><head><title>t</title></head><body><img src="a.png"></body></html>',
        },
        { path: 'a.txt', content: 'plain' },
      ],
    })
    const signed = (await (
      await server.app.request(`/artifacts/${page.id}/view-url`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      })
    ).json()) as { url: string; expiresAt: number }
    // no body at all is fine too
    const bare = await server.app.request(`/artifacts/${page.id}/view-url`, { method: 'POST' })
    expect(bare.status).toBe(200)
    expect(signed.url).toMatch(new RegExp(`^/art/v/${page.id}/1/~`))
    expect(signed.expiresAt - now).toBeLessThanOrEqual(10 * 60 * 1000 + 1000)

    const path = new URL(signed.url, 'http://x').pathname
    const res = await server.app.request(path)
    expect(res.status).toBe(200)
    const csp = res.headers.get('content-security-policy') ?? ''
    expect(csp).toContain('sandbox allow-scripts allow-popups allow-forms allow-modals')
    expect(csp).not.toContain('allow-same-origin')
    expect(csp).toContain("connect-src 'none'")
    expect(csp).toContain("default-src 'none'")
    expect(csp).toContain('cdn.jsdelivr.net')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('referrer-policy')).toBe('no-referrer')
    expect(res.headers.get('x-robots-tag')).toContain('noindex')
    expect(res.headers.get('cross-origin-resource-policy')).toBe('cross-origin')
    expect(res.headers.get('content-type')).toContain('text/html')
    const body = await res.text()
    expect(body).toContain("source:'eh-artifact'")
    expect(body.indexOf('eh-artifact')).toBeLessThan(body.indexOf('<title>'))

    // a relative asset next to the entry works with the same token (it is a path segment)
    const sibling = path.replace(/\/index\.html$/, '/a.txt')
    const asset = await server.app.request(sibling)
    expect(asset.status).toBe(200)
    expect(await asset.text()).toBe('plain')
    expect(asset.headers.get('content-security-policy')).toContain('sandbox')

    // tampered token, wrong version, missing token
    const segs = path.split('/')
    const ti = segs.findIndex((x) => x.startsWith('~'))
    segs[ti] = `${segs[ti]?.slice(0, -1)}${segs[ti]?.endsWith('A') ? 'B' : 'A'}`
    const tampered = segs.join('/')
    expect((await server.app.request(tampered)).status).toBe(403)
    expect((await server.app.request(path.replace('/1/', '/2/'))).status).toBe(403)
    expect((await server.app.request(`/art/v/${page.id}/1/index.html`)).status).toBe(403)
    // `?t=` also carries the token
    const token = /~([^/]+)/.exec(path)?.[1] ?? ''
    expect((await server.app.request(`/art/v/${page.id}/1/index.html?t=${token}`)).status).toBe(200)
    // path traversal
    expect((await server.app.request(path.replace('index.html', '..%2F..%2Fx'))).status).toBe(404)

    // expiry: a token minted in the past is refused
    void now
    now = Date.now()
    const expired = await server.artifacts.viewUrl(page.id, {})
    const exp = Number.parseInt(/~([0-9a-z]+)\./.exec(expired.url)?.[1] ?? '', 36)
    const older = expired.url.replace(exp.toString(36), (exp - 11 * 60 * 1000).toString(36))
    // changing exp invalidates the signature too (403 either way)
    expect((await server.app.request(new URL(older, 'http://x').pathname)).status).toBe(403)
  })

  test('a token past its expiry is refused (service clock)', async () => {
    const server = boot()
    const page = await create(server, {
      kind: 'code',
      title: 'Script',
      files: [{ path: 'main.py', content: 'print(1)\n' }],
    })
    const ok = await server.artifacts.viewUrl(page.id, {})
    const token = /~([^/]+)/.exec(ok.url)?.[1] ?? ''
    expect(await server.artifacts.verifyView(page.id, 1, token)).toBe(true)
    const realNow = Date.now
    Date.now = () => realNow() + 11 * 60 * 1000
    try {
      expect(await server.artifacts.verifyView(page.id, 1, token)).toBe(false)
      expect((await server.app.request(new URL(ok.url, 'http://x').pathname)).status).toBe(403)
    } finally {
      Date.now = realNow
    }
  })

  test('/api refuses Origin: null; content needs no login; library view URL for run_python outputs', async () => {
    const server = boot({}, 'secrettoken-0123456789')
    // no bearer: /api refuses, but the content routes and /share answer without it
    expect((await server.app.request('/artifacts')).status).toBe(401)
    expect((await server.app.request('/art/s/doesnotexist1234/index.html')).status).toBe(404)
    expect((await server.app.request('/share/doesnotexist1234')).status).toBe(404)
    const headers = { authorization: 'Bearer secrettoken-0123456789', origin: 'null' }
    const nullOrigin = await server.app.request('/artifacts', { headers })
    expect(nullOrigin.status).toBe(403)
    expect(((await nullOrigin.json()) as { error: { code: string } }).error.code).toBe(
      'FORBIDDEN_ORIGIN',
    )

    await libraryFs(server.conn.sqlite).writeBytes?.('/library/work/chart.png', PNG)
    const signed = await server.app.request('/library/view-url', {
      method: 'POST',
      headers: {
        authorization: 'Bearer secrettoken-0123456789',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ path: '/library/work/chart.png' }),
    })
    expect(signed.status).toBe(200)
    const { url } = (await signed.json()) as { url: string }
    expect(url).toContain('/art/l/')
    const raw = await server.app.request(new URL(url, 'http://x').pathname)
    expect(raw.status).toBe(200)
    expect(raw.headers.get('content-type')).toBe('image/png')
    expect(raw.headers.get('content-security-policy')).toContain('sandbox')
    expect(new Uint8Array(await raw.arrayBuffer())).toEqual(PNG)
    // another path with the same token is refused; memory paths are never signed
    expect(
      (
        await server.app.request(
          new URL(url, 'http://x').pathname.replace('chart.png', 'other.png'),
        )
      ).status,
    ).toBe(403)
    const mem = await server.app.request('/library/view-url', {
      method: 'POST',
      headers: {
        authorization: 'Bearer secrettoken-0123456789',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ path: '/memories/workspace/profile.md' }),
    })
    expect(mem.status).toBe(400)
  })
})

describe('sharing', () => {
  test('private -> public issues a token; back to private kills it; public again gives a NEW one; pin a version', async () => {
    const server = boot()
    const page = await create(server, {
      kind: 'html',
      title: 'Shared',
      files: [{ path: 'index.html', content: '<html><body>one</body></html>' }],
    })
    const patch = (body: unknown) =>
      server.app.request(`/artifacts/${page.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    const pub = (await (await patch({ visibility: 'public' })).json()) as {
      shareUrl: string
      visibility: string
    }
    expect(pub.visibility).toBe('public')
    const token1 = pub.shareUrl.split('/s/')[1] as string
    expect(pub.shareUrl).toBe(`http://localhost:5173/s/${token1}`)

    const meta = await server.app.request(`/share/${token1}`)
    expect(meta.status).toBe(200)
    const shared = (await meta.json()) as {
      artifact: { title: string; dir: string; agentId: unknown }
      entryUrl: string
      baseUrl: string
    }
    expect(shared.artifact.title).toBe('Shared')
    // no internals on the public page
    expect(shared.artifact.dir).toBe('')
    expect(shared.entryUrl).toBe(`/art/s/${token1}/index.html`)
    const content = await server.app.request(new URL(shared.entryUrl, 'http://x').pathname)
    expect(content.status).toBe(200)
    expect(content.headers.get('content-security-policy')).toContain('sandbox')
    expect(await content.text()).toContain('one')

    // a pinned version stays while the artifact moves on
    const fs = libraryFs(server.conn.sqlite, {
      agentId: 'a',
      onChange: (c) => server.artifacts.onLibraryChange(c),
    })
    await fs.write(`${page.dir}/index.html`, '<html><body>two</body></html>')
    await server.artifacts.snapshotDirty('a')
    expect(
      await (await server.app.request(new URL(shared.entryUrl, 'http://x').pathname)).text(),
    ).toContain('two')
    const pinned = (await (await patch({ shareVersion: 1 })).json()) as {
      shareVersion: number
      shareUrl: string
    }
    expect(pinned.shareVersion).toBe(1)
    // pinning keeps the link
    expect(pinned.shareUrl).toBe(pub.shareUrl)
    expect(
      await (await server.app.request(new URL(shared.entryUrl, 'http://x').pathname)).text(),
    ).toContain('one')

    // private again: the old link is dead
    const priv = (await (await patch({ visibility: 'private' })).json()) as {
      shareUrl: unknown
      shareVersion: unknown
    }
    expect(priv.shareUrl).toBeNull()
    expect(priv.shareVersion).toBeNull()
    expect((await server.app.request(`/share/${token1}`)).status).toBe(404)
    expect((await server.app.request(new URL(shared.entryUrl, 'http://x').pathname)).status).toBe(
      404,
    )

    // public again: a different token; the old one stays dead
    const again = (await (await patch({ visibility: 'public' })).json()) as { shareUrl: string }
    const token2 = again.shareUrl.split('/s/')[1] as string
    expect(token2).not.toBe(token1)
    expect((await server.app.request(`/share/${token1}`)).status).toBe(404)
    expect((await server.app.request(`/share/${token2}`)).status).toBe(200)

    // delete is soft and revokes the link
    expect((await server.app.request(`/artifacts/${page.id}`, { method: 'DELETE' })).status).toBe(
      200,
    )
    expect((await server.app.request(`/share/${token2}`)).status).toBe(404)
    expect((await server.app.request(`/artifacts/${page.id}`)).status).toBe(404)
  })
})

describe('agent tools', () => {
  type Tool = { execute: (input: unknown, options: unknown) => Promise<string> | string }
  function toolsOf(
    server: Server,
    opts: {
      sessionId: string
      gateway?: unknown
      decisions?: ArtifactDecisions
      tools?: string[]
    },
  ): { tools: Record<string, Tool>; data: Array<{ name: string; data: unknown; id?: string }> } {
    const data: Array<{ name: string; data: unknown; id?: string }> = []
    const plugin = artifacts({
      service: server.artifacts,
      agentOf: (slug) => ({ id: slug, name: slug }),
      channels: () => opts.gateway as never,
      access: () => undefined,
      decisions: () => opts.decisions,
      tools: opts.tools ?? ['artifact_create', 'artifact_list', 'artifact_visibility'],
    })
    const def = plugin['~def'] as unknown as {
      session: (ctx: unknown) => { tools: Record<string, Tool> }
    }
    const out = def.session({
      session: { id: opts.sessionId, parent: undefined },
      agent: { id: 'writer' },
      stream: {
        data: (name: string, d: unknown, o?: { id?: string }) =>
          data.push({ name, data: d, ...(o?.id ? { id: o.id } : {}) }),
      },
      log: { warn: () => undefined },
    })
    return { tools: out.tools, data }
  }
  const gateway = (role: string | undefined, conversation = true) => ({
    requesterOf: async () => (role === undefined ? undefined : { role, name: 'Rina' }),
    conversationOf: () => (conversation ? {} : undefined),
    unresolvedChatTurn: () => false,
  })
  const call = (t: Tool | undefined, input: unknown): Promise<string> =>
    Promise.resolve(t?.execute(input, { toolCallId: 'c', messages: [] }) ?? 'missing tool')

  test('artifact_create writes the data part and returns the id and the app link; problems come back', async () => {
    const server = boot()
    const { tools, data } = toolsOf(server, { sessionId: 'dm:writer' })
    const text = await call(tools.artifact_create, {
      kind: 'html',
      title: 'Broken page',
      files: [{ path: 'index.html', content: '<html><body><img src="missing.png"></body></html>' }],
    })
    expect(text).toMatch(/Created artifact [0-9a-f-]{36}/)
    expect(text).toContain('http://localhost:5173/artifacts/')
    expect(text).toContain('missing.png')
    expect(text).toContain('private')
    expect(data).toHaveLength(1)
    expect(data[0]).toMatchObject({
      name: 'artifact',
      data: { kind: 'html', title: 'Broken page', version: 1 },
    })
    expect(await call(tools.artifact_create, { kind: 'html', title: 'x', files: [] })).toMatch(
      /^ERROR: .*at least one file/,
    )
    expect(
      await call(tools.artifact_create, {
        kind: 'file',
        title: 'x',
        files: [{ path: 'a', content: 'x', from: '/library/a' }],
      }),
    ).toMatch(/^ERROR: .*exactly one/)
    expect(await call(tools.artifact_list, { query: 'broken' })).toContain('Broken page')
  })

  test('visibility authority: web owner and channel owner/admin may publish, member and guest may not', async () => {
    const server = boot()
    const page = await create(server, {
      kind: 'html',
      title: 'Offer',
      files: [{ path: 'index.html', content: '<html><body>offer</body></html>' }],
    })
    const web = toolsOf(server, { sessionId: 'dm:writer' })
    const member = toolsOf(server, { sessionId: 'chat:writer:x', gateway: gateway('member') })
    const guest = toolsOf(server, { sessionId: 'chat:writer:y', gateway: gateway('guest') })
    const admin = toolsOf(server, { sessionId: 'chat:writer:z', gateway: gateway('admin') })

    const refused = await call(member.tools.artifact_visibility, {
      id: page.id,
      visibility: 'public',
    })
    expect(refused).toContain('Not allowed')
    expect(
      await call(guest.tools.artifact_visibility, { id: page.id, visibility: 'public' }),
    ).toContain('Not allowed')
    expect(server.artifacts.get(page.id)?.visibility).toBe('private')

    const made = await call(admin.tools.artifact_visibility, { id: page.id, visibility: 'public' })
    expect(made).toContain('/s/')
    expect(server.artifacts.get(page.id)?.visibility).toBe('public')
    // a member may always make it private
    expect(
      await call(member.tools.artifact_visibility, { id: page.id, visibility: 'private' }),
    ).toContain('private again')
    expect(server.artifacts.get(page.id)?.shareUrl).toBeNull()
    // the web user (a web chat) may publish too
    expect(
      await call(web.tools.artifact_visibility, { id: page.id, visibility: 'public' }),
    ).toContain('now public')
    expect(await call(web.tools.artifact_visibility, { id: 'nope', visibility: 'public' })).toMatch(
      /^ERROR: no artifact/,
    )
    // audit
    const events = server.conn.sqlite
      .query<{ action: string }, [string]>(
        'SELECT action FROM artifact_events WHERE artifact_id = ? ORDER BY seq',
      )
      .all(page.id)
      .map((e) => e.action)
    expect(events).toEqual(['create', 'version', 'visibility', 'visibility', 'visibility'])
  })

  test('an autonomous run opens a decision instead of publishing; approved, it does', async () => {
    const server = boot()
    const page = await create(server, {
      kind: 'document',
      title: 'Weekly report',
      files: [{ path: 'document.md', content: '# Report\n' }],
    })
    const asked: string[] = []
    let approved = false
    const decisions: ArtifactDecisions = {
      request: (i) => {
        asked.push(i.artifactId)
        return { id: 'dec-1' }
      },
      approved: () => approved,
    }
    const run = toolsOf(server, {
      sessionId: 'program:p1:123',
      gateway: gateway(undefined, false),
      decisions,
    })
    const text = await call(run.tools.artifact_visibility, { id: page.id, visibility: 'public' })
    expect(text).toContain('Decision Center')
    expect(asked).toEqual([page.id])
    expect(server.artifacts.get(page.id)?.visibility).toBe('private')
    approved = true
    expect(
      await call(run.tools.artifact_visibility, { id: page.id, visibility: 'public' }),
    ).toContain('after the owner approved')
    expect(server.artifacts.get(page.id)?.visibility).toBe('public')
    // a rehearsal never creates
    const rehearsal = toolsOf(server, { sessionId: 'rehearsal:p1:1' })
    expect(
      await call(rehearsal.tools.artifact_create, {
        kind: 'file',
        title: 'x',
        files: [{ path: 'a.txt', content: 'x' }],
      }),
    ).toContain('rehearsal')
  })

  test('a program run is held to its path authority', async () => {
    const server = boot()
    const plugin = artifacts({
      service: server.artifacts,
      agentOf: (slug) => ({ id: slug, name: slug }),
      channels: () => undefined,
      access: () => ({
        canRead: () => false,
        canWrite: (p: string) => p.startsWith('/library/reports/'),
      }),
      decisions: () => undefined,
      tools: ['artifact_create'],
    })
    const def = plugin['~def'] as unknown as {
      session: (ctx: unknown) => { tools: Record<string, Tool> }
    }
    const { tools } = def.session({
      session: { id: 'program:p:1', parent: undefined },
      agent: { id: 'w' },
      stream: { data: () => undefined },
      log: { warn: () => undefined },
    })
    // the default artifact folder is /library/artifacts/**: not granted
    expect(
      await call(tools.artifact_create, {
        kind: 'file',
        title: 'x',
        files: [{ path: 'a.txt', content: 'x' }],
      }),
    ).toMatch(/^ERROR: .*not allowed to write/)
    await libraryFs(server.conn.sqlite).write('/library/reports/q1/a.md', '# q1')
    expect(
      await call(tools.artifact_create, {
        kind: 'document',
        title: 'q1',
        dir: '/library/reports/q1',
      }),
    ).toContain('Created artifact')
    // reading a source it may not read is refused
    expect(
      await call(tools.artifact_create, {
        kind: 'image',
        title: 'c',
        files: [{ from: '/library/work/c.png', path: '../x' }],
      }),
    ).toMatch(/^ERROR:/)
  })
})

describe('chat flow: create, edit with write_file, version at the end of the turn', () => {
  test('artifact_create from the model, a file edit, then version 2; adopting a run output by `from`', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'team-artifacts-'))
    dirs.push(dir)
    let n = 0
    const seen: string[] = []
    const call = (toolName: string, input: unknown): ScriptedStepInput => ({
      toolCalls: [{ toolName, toolCallId: `c${++n}`, input }],
    })
    const resultOf =
      (next: () => ScriptedStepInput) =>
      (c: ScriptedCallOptions): ScriptedStepInput => {
        const msgs = c.prompt as unknown as Array<{
          role: string
          content: Array<Record<string, unknown>>
        }>
        const last = [...msgs].reverse().find((m) => m.role === 'tool')
        const out = last?.content.find((p) => p.type === 'tool-result')?.output as
          | { value: unknown }
          | undefined
        seen.push(typeof out?.value === 'string' ? out.value : JSON.stringify(out?.value))
        return next()
      }
    let id = ''
    let folder = ''
    const model = scriptedModel([
      call('write_file', { path: '/library/work/chart.png', content: 'placeholder' }),
      call('artifact_create', {
        kind: 'html',
        title: 'Dashboard',
        files: [{ path: 'index.html', content: '<html><body><h1>v1</h1></body></html>' }],
      }),
      resultOf(() => {
        id = /artifact ([0-9a-f-]{36})/.exec(seen.at(-1) ?? '')?.[1] ?? ''
        folder = /in (\/library\/artifacts\/[^ ]+)\//.exec(seen.at(-1) ?? '')?.[1] ?? ''
        return call('read_file', { path: `${folder}/index.html` })
      }),
      resultOf(() => {
        return call('write_file', {
          path: `${folder}/index.html`,
          content: '<html><body><h1>v2</h1></body></html>',
        })
      }),
      resultOf(() => ({ text: 'done' })),
    ] as ScriptedStepInput[])
    const config: ModelConfig = {
      provider: 'scripted',
      defaultModel: 'none',
      resolve: () => model as never,
    }
    const server = compose({
      dbFile: join(dir, 'team.db'),
      models: config,
      env: {},
      tuning: { streams: { flushMs: 5, pollMs: 20 }, inbox: { pollMs: 30 }, abortPollMs: 40 },
      eventsPollMs: 30,
      reconcile: { onBoot: false, everyMs: 0 },
      routines: { tickMs: 0 },
      code: { driver: 'off' },
    })
    servers.push(server)
    const def = createAgent(server.deps, {
      slug: 'maker',
      name: 'Maker',
      role: 'custom',
      instructions: 'You make things.',
      model: 'm',
      connectors: {
        [builtinId('files')]: { enabled: 'on', capabilities: { read: 'allow', edit: 'allow' } },
        [builtinId('artifacts')]: {
          enabled: 'on',
          capabilities: { create: 'allow', read: 'allow', share: 'allow' },
        },
      },
    })
    updateAgent(server.deps, def.id, { model: 'm' })
    expect(
      (
        await server.app.request('/agents/maker/mode', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ mode: 'bypass' }),
        })
      ).status,
    ).toBe(200)
    const res = await server.app.request(
      '/sessions/dm:maker/chat',
      postAs('dm:maker', userMessage('make a dashboard')),
    )
    expect(res.status).toBe(200)
    const stream = await res.text()
    // the card part of the web: `data-artifacts.artifact`
    expect(stream).toContain('data-artifacts.artifact')
    expect(stream).toContain('"title":"Dashboard"')
    expect(id).toMatch(/^[0-9a-f-]{36}$/)

    const art = server.artifacts.get(id)
    expect(art?.version).toBe(2)
    expect(new TextDecoder().decode(server.artifacts.contentOfVersion(id, 1, '')?.bytes)).toContain(
      'v1',
    )
    expect(new TextDecoder().decode(server.artifacts.contentOfVersion(id, 2, '')?.bytes)).toContain(
      'v2',
    )
    const versions = server.artifacts.versions(id) ?? []
    expect(versions[0]?.by).toMatch(/^agent:/)
    expect(versions.map((v) => v.n)).toEqual([2, 1])
  }, 30_000)
})
