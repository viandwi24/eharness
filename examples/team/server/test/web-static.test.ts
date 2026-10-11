import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { webStatic } from '../src/infra/web-static.ts'

// the build folder sits inside a temp folder that also holds a file it must never serve
const base = mkdtempSync(join(tmpdir(), 'team-web-'))
const dir = join(base, 'build')
mkdirSync(join(dir, '_app/immutable'), { recursive: true })
writeFileSync(join(dir, 'index.html'), '<!doctype html>index')
writeFileSync(join(dir, '_app/immutable/a.js'), 'asset')
writeFileSync(join(base, 'secret.txt'), 'secret')
afterAll(() => {
  rmSync(base, { recursive: true, force: true })
})

describe('web static (single-port deployment)', () => {
  const web = webStatic(dir)

  test('/api requests are routed to the API with the prefix stripped', () => {
    expect(
      new URL(web.apiRequest(new Request('http://x/api/agents?a=1'))?.url ?? '').pathname,
    ).toBe('/agents')
    expect(new URL(web.apiRequest(new Request('http://x/api'))?.url ?? '').pathname).toBe('/')
    expect(web.apiRequest(new Request('http://x/apix'))).toBeUndefined()
    expect(web.apiRequest(new Request('http://x/tasks'))).toBeUndefined()
  })

  test('files are served, hashed assets cached, client routes fall back to index.html', async () => {
    const asset = await web.serve(new Request('http://x/_app/immutable/a.js'))
    expect(await asset.text()).toBe('asset')
    expect(asset.headers.get('cache-control')).toContain('immutable')
    expect(await (await web.serve(new Request('http://x/tasks/123'))).text()).toContain('index')
    expect(await (await web.serve(new Request('http://x/'))).text()).toContain('index')
  })

  test('paths never leave the build folder', async () => {
    for (const path of ['/../secret.txt', '/..%2fsecret.txt', '/%2e%2e/secret.txt']) {
      expect(await (await web.serve(new Request(`http://x${path}`))).text()).not.toContain('secret')
    }
  })

  test('only GET and HEAD reach the web files', async () => {
    expect((await web.serve(new Request('http://x/tasks', { method: 'POST' }))).status).toBe(404)
  })
})
