import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserRuntime, RuntimeStatus } from 'eharness/browser'
import { remoteBrowserRuntime } from '../src/client.ts'
import { type RunningServer, startServer } from '../src/server.ts'

const TOKEN = 'test-token-123456'
let dir: string
let server: RunningServer
let chrome: ReturnType<typeof Bun.serve>
let off: RunningServer
const calls: string[] = []
const running = new Set<string>()
let state: RuntimeStatus['state'] = 'missing'

function fake(): BrowserRuntime {
  return {
    status: async () => ({
      state: running.size > 0 ? 'running' : state,
      ...(running.size > 0 ? { running: [...running] } : {}),
    }),
    install: async () => {
      calls.push('install')
      state = 'installing'
      await new Promise((r) => setTimeout(r, 30))
      state = 'ready'
    },
    start: async (profile, settings) => {
      calls.push(`start:${profile.id}:${JSON.stringify(settings ?? null)}`)
      running.add(profile.id)
      // the "local Chrome": an echo socket on loopback
      return { cdpUrl: `ws://127.0.0.1:${chrome.port}/devtools/browser/x`, pid: 42 }
    },
    stop: async (id) => {
      calls.push(`stop:${id}`)
      running.delete(id)
    },
    removeProfileData: async (id) => {
      calls.push(`remove:${id}`)
    },
    uninstall: async () => {
      calls.push('uninstall')
      state = 'missing'
    },
    usage: async (id) => (running.has(id) ? { rssBytes: 1000, cpuPercent: 5 } : null),
  }
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'eh-sbx-browser-'))
  chrome = Bun.serve<undefined>({
    port: 0,
    hostname: '127.0.0.1',
    fetch: (req, srv) =>
      srv.upgrade(req, { data: undefined }) ? undefined : new Response('no', { status: 400 }),
    websocket: {
      message: (ws, m) => {
        ws.send(`echo:${String(m)}`)
      },
    },
  })
  server = await startServer({
    token: TOKEN,
    dataDir: dir,
    osSandbox: false,
    log: () => {},
    browser: fake(),
  })
  off = await startServer({
    token: TOKEN,
    dataDir: join(dir, 'off'),
    osSandbox: false,
    log: () => {},
  })
})
afterAll(async () => {
  await server.stop()
  await off.stop()
  await chrome.stop(true)
  await rm(dir, { recursive: true, force: true })
})

const runtime = (token = TOKEN): BrowserRuntime =>
  remoteBrowserRuntime({ baseUrl: server.url, token, pollMs: 10 })

const wsOpen = (url: string, init?: { headers: Record<string, string> }): Promise<WebSocket> =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(url, init as never)
    ws.onopen = () => resolve(ws)
    ws.onerror = () => reject(new Error('socket refused'))
  })

describe('/v1/browser', () => {
  test('needs the token and is off when no runtime is given', async () => {
    expect((await fetch(`${server.url}/v1/browser/status`)).status).toBe(401)
    await expect(runtime('wrong-token-xx').status()).rejects.toThrow(/401/)
    const res = await fetch(`${off.url}/v1/browser/status`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    })
    expect(res.status).toBe(404)
    const info = (await (
      await fetch(`${server.url}/v1/info`, { headers: { authorization: `Bearer ${TOKEN}` } })
    ).json()) as { browser: boolean }
    expect(info.browser).toBe(true)
  })

  test('install polls to ready, status, uninstall', async () => {
    const rt = runtime()
    expect((await rt.status()).state).toBe('missing')
    await rt.install()
    expect((await rt.status()).state).toBe('ready')
    expect(calls).toContain('install')
  })

  test('start returns a proxied, signed CDP url; frames round trip', async () => {
    const rt = runtime()
    const endpoint = await rt.start({ id: 'p1', name: 'One' }, { headless: true })
    expect(endpoint.cdpUrl.startsWith(`ws://127.0.0.1:${server.port}/v1/browser/cdp/p1?t=`)).toBe(
      true,
    )
    expect(endpoint.cdpUrl).not.toContain(String(chrome.port))
    expect(calls).toContain('start:p1:{"headless":true}')
    const ws = await wsOpen(endpoint.cdpUrl)
    const got = new Promise<string>((r) => {
      ws.onmessage = (e) => r(String(e.data))
    })
    ws.send('hello')
    expect(await got).toBe('echo:hello')
    ws.close()
    expect(await rt.usage?.('p1')).toEqual({ rssBytes: 1000, cpuPercent: 5 })
  })

  test('the socket needs a valid token for that profile; the bearer header also works', async () => {
    const rt = runtime()
    const { cdpUrl } = await rt.start({ id: 'p2' })
    const bare = cdpUrl.split('?')[0] as string
    await expect(wsOpen(bare)).rejects.toThrow()
    await expect(
      wsOpen(`${bare.replace('/p2', '/p1')}?t=${cdpUrl.split('t=')[1]}`),
    ).rejects.toThrow()
    await expect(wsOpen(`${bare}?t=1.deadbeef`)).rejects.toThrow()
    const ws = await wsOpen(bare, { headers: { authorization: `Bearer ${TOKEN}` } })
    ws.close()
  })

  test('stop closes proxied sockets and refuses new ones; removeProfileData', async () => {
    const rt = runtime()
    const { cdpUrl } = await rt.start({ id: 'p3' })
    const ws = await wsOpen(cdpUrl)
    const closed = new Promise<void>((r) => {
      ws.onclose = () => r()
    })
    await rt.stop('p3')
    await closed
    await expect(wsOpen(cdpUrl)).rejects.toThrow()
    await rt.removeProfileData?.('p3')
    expect(calls).toContain('remove:p3')
    expect(await rt.usage?.('p3')).toBeNull()
    await rt.uninstall?.()
    expect(calls).toContain('uninstall')
  })

  test('a start failure is a readable error', async () => {
    const res = await fetch(`${server.url}/v1/browser/start`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ profileId: '../x' }),
    })
    expect(res.status).toBe(400)
  })
})
