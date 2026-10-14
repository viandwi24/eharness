/**
 * The browser of the team app (plan P48): the routes (auth, profiles, redaction, usage), the live
 * WebSocket against a fake CDP server, the Browser connector with a fake manager and the takeover
 * decision. Nothing is downloaded and no engine is started.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserManager } from 'eharness/browser'
import { scriptedModel } from 'eharness/testing'
import { websocket } from 'hono/bun'
import { trustNewConnection } from '../src/app/browser.ts'
import { createEscalation } from '../src/app/decisions.ts'
import { packFrame } from '../src/http/routes/browser.ts'
import { browserConnector } from '../src/infra/browser/connector.ts'
import { createBrowserHook } from '../src/infra/browser/hook.ts'
import { takeoverOutput } from '../src/infra/eh/decision-service.ts'
import { scriptedModelConfig } from '../src/infra/eh/provider.ts'
import { upgradeEnv } from '../src/infra/web-static.ts'
import { compose, type Server } from '../src/main.ts'

// biome-ignore lint/suspicious/noExplicitAny: loosely typed JSON of the API under test
type Json = Record<string, any>
const dirs: string[] = []
const servers: Server[] = []
const stops: Array<() => void> = []
afterEach(async () => {
  for (const stop of stops.splice(0)) stop()
  for (const s of servers.splice(0)) await s.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const key = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64')

function boot(o: { env?: Record<string, string>; token?: string; dbFile?: string } = {}): Server {
  const root = mkdtempSync(join(tmpdir(), 'team-browser-'))
  dirs.push(root)
  const server = compose({
    dbFile: o.dbFile ?? ':memory:',
    models: scriptedModelConfig(scriptedModel([]) as never),
    env: { TEAM_SECRET_KEY: key, TEAM_BROWSER_ROOT: join(root, 'browser'), ...(o.env ?? {}) },
    ...(o.token === undefined ? {} : { token: o.token }),
    changePollMs: 0,
    seed: false,
    publicUrl: 'http://api.test',
    webUrl: 'http://web.test',
    reconcile: { onBoot: false, everyMs: 0 },
    routines: { tickMs: 0 },
  })
  servers.push(server)
  return server
}

const call = async (
  server: Server,
  method: string,
  path: string,
  body?: unknown,
  token?: string,
) => {
  const res = await server.app.request(path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await res.text()
  return { status: res.status, json: (text === '' ? undefined : JSON.parse(text)) as Json }
}

const SECRET_URL = 'ws://127.0.0.1:9/devtools/browser/very-secret-id'

describe('browser routes', () => {
  test('every route needs the token when one is set', async () => {
    const server = boot({ token: 'tok-123' })
    expect((await call(server, 'GET', '/browser/adapters')).status).toBe(401)
    expect((await call(server, 'GET', '/browser/profiles')).status).toBe(401)
    expect((await call(server, 'GET', '/browser/usage')).status).toBe(401)
    expect((await call(server, 'GET', '/browser/adapters', undefined, 'tok-123')).status).toBe(200)
  })

  test('adapters: modes, forms and the managed runtime follow the driver', async () => {
    const local = boot({ env: { TEAM_BROWSER_DRIVER: 'local' } })
    const a = (await call(local, 'GET', '/browser/adapters')).json
    expect(a.driver).toBe('local')
    expect(a.max).toBe(4)
    const chrome = a.adapters.find((x: Json) => x.id === 'chrome')
    expect(chrome.modes).toEqual(['manual', 'managed'])
    expect(chrome.forms.manual.fields.some((f: Json) => f.path === 'cdpUrl' && f.secret)).toBe(true)
    expect(chrome.capabilities.manual.takeover).toBe(true)
    expect(['missing', 'ready', 'error']).toContain(chrome.runtime.state)
    const lp = a.adapters.find((x: Json) => x.id === 'lightpanda')
    expect(lp.capabilities.manual.liveView).toBe('poll')

    const off = boot({ env: { TEAM_BROWSER_DRIVER: 'off', TEAM_BROWSER_MAX: '2' } })
    const b = (await call(off, 'GET', '/browser/adapters')).json
    expect(b.driver).toBe('off')
    expect(b.max).toBe(2)
    const offChrome = b.adapters.find((x: Json) => x.id === 'chrome')
    expect(offChrome.modes).toEqual(['manual'])
    expect(offChrome.runtime).toBeNull()
    expect(offChrome.unavailable.managed).toContain('off on this server')
    // installing or creating a managed profile is refused with the reason
    expect((await call(off, 'POST', '/browser/runtimes/chrome/install')).status).toBe(400)
    const managed = await call(off, 'POST', '/browser/profiles', {
      name: 'M',
      adapter: 'chrome',
      mode: 'managed',
    })
    expect(managed.status).toBe(400)
    expect(managed.json.error.code).toBe('MODE_UNAVAILABLE')
  })

  test('a Chrome with a window is refused on a server without a display', async () => {
    const make = (server: Server) =>
      call(server, 'POST', '/browser/profiles', {
        name: 'Headed',
        adapter: 'chrome',
        mode: 'managed',
        settings: { headless: false },
      })
    const screen = process.platform !== 'linux' || Boolean(process.env.DISPLAY)
    const plain = await make(boot())
    if (screen) expect(plain.status).toBe(201)
    else {
      expect(plain.status).toBe(400)
      expect(plain.json.error.code).toBe('NO_DISPLAY')
      expect(plain.json.error.message).toContain('Turn Headless on')
    }
    // Xvfb gives it a window anywhere
    expect((await make(boot({ env: { TEAM_BROWSER_XVFB: '1' } }))).status).toBe(201)
  })

  test('profiles: create, redact, edit, trust, delete', async () => {
    const server = boot()
    const created = await call(server, 'POST', '/browser/profiles', {
      name: 'Work',
      adapter: 'chrome',
      mode: 'manual',
      settings: { cdpUrl: SECRET_URL, headers: { Authorization: 'Bearer abc-secret' } },
      allowDomains: [' Example.com ', 'example.com'],
    })
    expect(created.status).toBe(201)
    const id = created.json.id as string
    // the response holds no secret
    const text = JSON.stringify(created.json)
    expect(text).not.toContain('very-secret-id')
    expect(text).not.toContain('abc-secret')
    expect(created.json.settings.cdpUrl.set).toBe(true)
    expect(created.json.allowDomains).toEqual(['example.com'])
    expect(created.json.state).toBe('ready')
    expect(created.json.capabilities.snapshot).toBe(true)
    expect(created.json.trusted).toBeUndefined()
    // and neither does the table
    const row = server.conn.sqlite
      .query<{ settings_json: string }, [string]>(
        'SELECT settings_json FROM browser_profiles WHERE id = ?',
      )
      .get(id)
    expect(row?.settings_json).not.toContain('very-secret-id')
    expect(row?.settings_json).not.toContain('abc-secret')
    expect(row?.settings_json).toContain('~sealed')

    const listed = (await call(server, 'GET', '/browser/profiles')).json as Json[]
    expect(listed.map((p) => p.name)).toEqual(['Work'])
    expect(JSON.stringify(listed)).not.toContain('very-secret-id')

    // a second profile with the same name (any case) is refused
    const dup = await call(server, 'POST', '/browser/profiles', {
      name: 'work',
      adapter: 'chrome',
      mode: 'manual',
      settings: { cdpUrl: SECRET_URL },
    })
    expect(dup.status).toBe(400)
    // a manual profile needs its endpoint
    expect(
      (
        await call(server, 'POST', '/browser/profiles', {
          name: 'Bad',
          adapter: 'chrome',
          mode: 'manual',
        })
      ).status,
    ).toBe(400)
    expect(
      (
        await call(server, 'POST', '/browser/profiles', {
          name: 'Bad',
          adapter: 'nope',
          mode: 'manual',
        })
      ).json.error.code,
    ).toBe('UNKNOWN_ADAPTER')

    // an edit that omits the secret keeps it; trust and domains change
    const patched = await call(server, 'PATCH', `/browser/profiles/${id}`, {
      name: 'Work 2',
      settings: { liveUrl: 'https://live.test/view' },
      trusted: true,
      allowDomains: [],
    })
    expect(patched.status).toBe(200)
    expect(patched.json.name).toBe('Work 2')
    expect(patched.json.trusted).toBe(true)
    expect(patched.json.allowDomains).toBeUndefined()
    expect(patched.json.settings.cdpUrl.set).toBe(true)
    expect(patched.json.liveUrl).toBe('https://live.test/view')
    const stored = await server.deps.browser?.profiles.get(id)
    expect(stored?.settings.cdpUrl).toBe(SECRET_URL)

    expect((await call(server, 'GET', `/browser/profiles/${id}`)).json.name).toBe('Work 2')
    expect((await call(server, 'GET', '/browser/profiles/nope')).status).toBe(404)
    expect((await call(server, 'GET', `/browser/profiles/${id}/shots`)).json).toEqual([])

    expect((await call(server, 'DELETE', `/browser/profiles/${id}`)).status).toBe(204)
    expect((await call(server, 'GET', `/browser/profiles/${id}`)).status).toBe(404)
    expect((await call(server, 'DELETE', `/browser/profiles/${id}`)).status).toBe(404)
  })

  test('test connection answers ok:false for an unreachable browser, never an error status', async () => {
    const server = boot()
    const draft = await call(server, 'POST', '/browser/test', {
      adapter: 'chrome',
      mode: 'manual',
      settings: { cdpUrl: 'ws://127.0.0.1:9/devtools/browser/x' },
    })
    expect(draft.status).toBe(200)
    expect(draft.json.ok).toBe(false)
    expect(typeof draft.json.error).toBe('string')
    expect(draft.json.error).not.toContain('devtools/browser/x')
    const created = await call(server, 'POST', '/browser/profiles', {
      name: 'Dead',
      adapter: 'chrome',
      mode: 'manual',
      settings: { cdpUrl: 'ws://127.0.0.1:9/devtools/browser/x' },
    })
    const stored = await call(server, 'POST', `/browser/profiles/${created.json.id}/test`)
    expect(stored.status).toBe(200)
    expect(stored.json.ok).toBe(false)
    expect((await call(server, 'POST', '/browser/profiles/nope/test')).status).toBe(404)
  })

  test('usage and the Settings status have their shape (nothing running)', async () => {
    const server = boot({ env: { TEAM_BROWSER_DRIVER: 'local' } })
    const usage = (await call(server, 'GET', '/browser/usage')).json
    expect(usage.profiles).toEqual([])
    expect(usage.totals).toEqual({ rssBytes: 0, cpuPercent: 0 })
    expect(usage.system.totalBytes).toBeGreaterThan(0)
    expect(usage.system.freeBytes).toBeGreaterThan(0)
    const info = (await call(server, 'GET', '/settings/browser')).json
    expect(info.driver).toBe('local')
    expect(info.max).toBe(4)
    expect(info.running).toBe(0)
    expect(info.system.totalBytes).toBeGreaterThan(0)
    expect(info.runtimes.map((r: Json) => r.adapter).sort()).toEqual(['chrome', 'lightpanda'])
    expect(typeof info.label).toBe('string')
  })

  test('the live route is a WebSocket and checks the profile and the origin first', async () => {
    const server = boot()
    expect((await call(server, 'GET', '/browser/profiles/x/live')).status).toBe(426)
    const res = await server.app.request('/browser/profiles/nope/live', {
      headers: { upgrade: 'websocket', connection: 'upgrade' },
    })
    expect(res.status).toBe(404)
  })
})

// --- the live WebSocket against a fake CDP server ------------------------------------------------

/** A CDP endpoint that answers everything and sends one screencast frame. */
function fakeCdp(): { url: string; commands: string[] } {
  const commands: string[] = []
  const frame = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64')
  const s = Bun.serve({
    port: 0,
    fetch(req, srv) {
      return srv.upgrade(req) ? undefined : new Response('no', { status: 400 })
    },
    websocket: {
      message(ws, raw) {
        const msg = JSON.parse(String(raw)) as { id: number; method: string; sessionId?: string }
        commands.push(msg.method)
        const reply = (result: unknown): void => {
          ws.send(
            JSON.stringify({
              id: msg.id,
              result,
              ...(msg.sessionId ? { sessionId: msg.sessionId } : {}),
            }),
          )
        }
        switch (msg.method) {
          case 'Target.getTargets':
            return reply({
              targetInfos: [{ targetId: 'T1', type: 'page', url: 'about:blank', title: 'Fake' }],
            })
          case 'Target.attachToTarget':
            return reply({ sessionId: 'S1' })
          case 'Browser.getVersion':
            return reply({ product: 'Fake/1.0' })
          case 'Page.getLayoutMetrics':
            return reply({ cssVisualViewport: { clientWidth: 800, clientHeight: 600 } })
          case 'Page.startScreencast':
            reply({})
            ws.send(
              JSON.stringify({
                method: 'Page.screencastFrame',
                sessionId: 'S1',
                params: {
                  data: frame,
                  sessionId: 1,
                  metadata: { deviceWidth: 800, deviceHeight: 600 },
                },
              }),
            )
            return
          default:
            return reply({})
        }
      },
    },
  })
  stops.push(() => s.stop(true))
  return { url: `ws://127.0.0.1:${s.port}/devtools/browser/fake`, commands }
}

/** Messages of a client socket, in order, with a waiter. */
function client(url: string) {
  const ws = new WebSocket(url)
  ws.binaryType = 'arraybuffer'
  const got: Array<Json | ArrayBuffer> = []
  const waiting: Array<() => void> = []
  ws.onmessage = (e) => {
    got.push(typeof e.data === 'string' ? (JSON.parse(e.data) as Json) : (e.data as ArrayBuffer))
    for (const w of waiting.splice(0)) w()
  }
  const until = async (
    match: (m: Json | ArrayBuffer) => boolean,
    ms = 5000,
  ): Promise<Json | ArrayBuffer> => {
    const end = Date.now() + ms
    for (;;) {
      const hit = got.find(match)
      if (hit !== undefined) return hit
      if (Date.now() > end)
        throw new Error(
          `no matching message in ${ms} ms: ${JSON.stringify(got.map((m) => (m instanceof ArrayBuffer ? 'binary' : m)))}`,
        )
      await new Promise<void>((r) => {
        waiting.push(r)
        setTimeout(r, 50)
      })
    }
  }
  const opened = new Promise<void>((ok, fail) => {
    ws.onopen = () => ok()
    ws.onerror = () => fail(new Error('socket error'))
  })
  return { ws, got, until, opened }
}

const isJson =
  (type: string) =>
  (m: Json | ArrayBuffer): boolean =>
    !(m instanceof ArrayBuffer) && m.type === type

describe('live view over WebSocket', () => {
  test('hello, binary frames, take over, input, hand back and the hand-back event', async () => {
    const fake = fakeCdp()
    const server = boot()
    const events: string[] = []
    server.deps.browser?.onChange((e) => events.push(e.type))
    const created = await call(server, 'POST', '/browser/profiles', {
      name: 'Live',
      adapter: 'chrome',
      mode: 'manual',
      settings: { cdpUrl: fake.url },
    })
    const id = created.json.id as string
    // the app is served under `/api` like the web build does: the copied request must still upgrade
    const http = Bun.serve({
      port: 0,
      websocket,
      fetch: (request, srv) => {
        const url = new URL(request.url)
        if (!url.pathname.startsWith('/api')) return new Response('no', { status: 404 })
        url.pathname = url.pathname.slice(4)
        return server.app.fetch(new Request(url, request), upgradeEnv(request, srv))
      },
    })
    stops.push(() => http.stop(true))

    const c = client(`ws://127.0.0.1:${http.port}/api/browser/profiles/${id}/live`)
    await c.opened
    const hello = (await c.until(isJson('hello'))) as Json
    expect(hello.profileId).toBe(id)
    expect(hello.info.width).toBe(800)
    expect(hello.info.height).toBe(600)
    expect(hello.info.liveView).toBe('screencast')
    expect(hello.controller.by).toBe('agent')
    expect(hello.you.canTakeOver).toBe(true)
    expect(hello.you.id.startsWith('client:')).toBe(true)

    // a binary frame: 4-byte length, JSON header, image bytes
    const bin = (await c.until((m) => m instanceof ArrayBuffer)) as ArrayBuffer
    const view = new DataView(bin)
    const headerLength = view.getUint32(0)
    const header = JSON.parse(
      new TextDecoder().decode(new Uint8Array(bin, 4, headerLength)),
    ) as Json
    expect(header).toMatchObject({
      type: 'frame',
      seq: 1,
      width: 800,
      height: 600,
      mediaType: 'image/jpeg',
    })
    expect([...new Uint8Array(bin, 4 + headerLength)]).toEqual([0xff, 0xd8, 0xff, 0xd9])

    // input is refused until this viewer took over
    c.ws.send(JSON.stringify({ type: 'input', id: 'i1', event: { type: 'text', text: 'hi' } }))
    const refused = (await c.until(
      (m) => !(m instanceof ArrayBuffer) && m.type === 'error' && m.id === 'i1',
    )) as Json
    expect(refused.message).toContain('ERROR')

    c.ws.send(JSON.stringify({ type: 'takeOver', id: 't1' }))
    expect(
      await c.until((m) => !(m instanceof ArrayBuffer) && m.type === 'ack' && m.id === 't1'),
    ).toMatchObject({ ok: true })
    const human = (await c.until(
      (m) => !(m instanceof ArrayBuffer) && m.type === 'controller' && m.controller.by === 'human',
    )) as Json
    expect(human.controller.holder).toBe(hello.you.id)
    expect((await call(server, 'GET', `/browser/profiles/${id}`)).json.state).toBe('controlled')

    c.ws.send(
      JSON.stringify({
        type: 'input',
        id: 'i2',
        event: { type: 'mouse', event: 'down', x: 10, y: 20 },
      }),
    )
    await c.until((m) => !(m instanceof ArrayBuffer) && m.type === 'ack' && m.id === 'i2')
    expect(fake.commands).toContain('Input.dispatchMouseEvent')

    c.ws.send(JSON.stringify({ type: 'handBack', id: 'h1' }))
    await c.until((m) => !(m instanceof ArrayBuffer) && m.type === 'ack' && m.id === 'h1')
    await c.until(
      (m) =>
        !(m instanceof ArrayBuffer) &&
        m.type === 'controller' &&
        m.controller.by === 'agent' &&
        m !== human,
    )
    expect(events).toContain('takeover')
    expect(events).toContain('handback')

    c.ws.send(JSON.stringify({ type: 'ping' }))
    await c.until(isJson('pong'))
    c.ws.close()
  })

  test('a profile that cannot be opened answers a fatal error and closes', async () => {
    const server = boot()
    const created = await call(server, 'POST', '/browser/profiles', {
      name: 'Dead',
      adapter: 'chrome',
      mode: 'manual',
      settings: { cdpUrl: 'ws://127.0.0.1:9/devtools/browser/x' },
    })
    const http = Bun.serve({
      port: 0,
      websocket,
      fetch: (request, srv) => server.app.fetch(request, srv),
    })
    stops.push(() => http.stop(true))
    const c = client(`ws://127.0.0.1:${http.port}/browser/profiles/${created.json.id}/live`)
    await c.opened
    const err = (await c.until(isJson('error'), 15_000)) as Json
    expect(err.fatal).toBe(true)
    expect(err.message).toContain('ERROR')
    expect(err.message).not.toContain('devtools/browser/x')
  })

  test('packFrame lays out length, header and bytes', () => {
    const out = packFrame({
      seq: 3,
      data: new Uint8Array([1, 2, 3]),
      mediaType: 'image/png',
      width: 10,
      height: 5,
      at: 7,
    })
    const n = new DataView(out.buffer).getUint32(0)
    expect(JSON.parse(new TextDecoder().decode(out.slice(4, 4 + n)))).toEqual({
      type: 'frame',
      seq: 3,
      width: 10,
      height: 5,
      mediaType: 'image/png',
      at: 7,
    })
    expect([...out.slice(4 + n)]).toEqual([1, 2, 3])
  })
})

// --- the connector with a fake manager -----------------------------------------------------------

const EXTERNAL_TOOL = Symbol.for('eharness.externalTool')

function fakeManager(profile: { trusted?: boolean } = {}): BrowserManager {
  const stored = {
    id: 'p1',
    name: 'Shop',
    adapter: 'chrome',
    mode: 'manual',
    settings: {},
    createdAt: 1,
    updatedAt: 1,
    ...profile,
  }
  return {
    profile: async (id: string) => (id === 'p1' ? stored : null),
    capabilities: () => ({
      snapshot: true,
      screenshot: true,
      liveView: 'screencast',
      takeover: true,
      tabs: true,
      persistentProfile: false,
    }),
    rules: () => ({ allowDomains: [], denyDomains: [], allowPrivateHosts: false }),
    lease: async () => ({ touch() {}, requestHuman() {}, open: true }),
  } as unknown as BrowserManager
}

function hookWith(
  manager: BrowserManager,
  trusted: boolean,
  calls: { takeovers: unknown[]; settled: unknown[] },
  count = 1,
) {
  return createBrowserHook({
    service: {
      manager,
      profiles: {
        list: async () => ({
          items: [{ id: 'p1' }, { id: 'p2' }].slice(0, count),
        }),
        get: async (id: string) =>
          id === 'p1'
            ? ({
                id: 'p1',
                name: 'Shop',
                adapter: 'chrome',
                mode: 'manual',
                trusted,
                settings: {},
                createdAt: 1,
                updatedAt: 1,
              } as never)
            : null,
      } as never,
    },
    takeover: (r) => {
      calls.takeovers.push(r)
      return { id: 'decision-1' }
    },
    images: () => false,
    settle: (connectionId, t) => calls.settled.push([connectionId, t]),
  })
}

describe('Browser connector', () => {
  const definition = browserConnector(() => undefined)
  const activateCtx = () =>
    ({
      settings: {},
      agent: { id: 'agent-1' },
      connection: { id: 'conn-1' },
      modes: { browse: 'allow', act: 'ask' },
    }) as never

  test('a built-in for the whole workspace: browse is allowed, acting asks', () => {
    const caps = Object.fromEntries(definition.capabilities.map((c) => [c.id, c]))
    expect(caps.browse?.defaultMode).toBe('allow')
    expect(caps.browse?.tools).toContain('browser_request_human')
    expect(caps.browse?.tools).toContain('browser_profiles')
    expect(caps.act?.defaultMode).toBe('ask')
    expect(caps.act?.tools).toEqual(['browser_act'])
    expect(definition.source).toBe('builtin')
    expect(definition.scopes).toEqual(['workspace'])
    expect(definition.scopeDefaults?.workspace?.defaultEnabled).toBe(true)
  })

  test('activation adds the plugin once a profile exists; none, or no browser, adds nothing', async () => {
    const calls = { takeovers: [] as unknown[], settled: [] as unknown[] }
    const activateWith = (count: number) =>
      (
        browserConnector(() => hookWith(fakeManager(), false, calls, count)).activate as (
          ctx: never,
        ) => Promise<unknown>
      )(activateCtx())
    expect(((await activateWith(1)) as { name: string }).name).toBe('browser')
    expect(((await activateWith(2)) as { name: string }).name).toBe('browser')
    expect(await activateWith(0)).toEqual([])
    expect(await (definition.activate as (ctx: never) => Promise<unknown>)(activateCtx())).toEqual(
      [],
    )
  })

  test('the test names the only profile, or says the agent picks', async () => {
    const calls = { takeovers: [] as unknown[], settled: [] as unknown[] }
    const testWith = (count: number) =>
      (
        browserConnector(() => hookWith(fakeManager(), false, calls, count)).test as (
          ctx: never,
        ) => Promise<{ ok: boolean; message?: string; accountLabel?: string }>
      )({ settings: {} } as never)
    expect(await testWith(1)).toMatchObject({ ok: true, accountLabel: 'Shop' })
    expect(await testWith(2)).toMatchObject({ ok: true, accountLabel: 'Any profile' })
    expect((await testWith(0)).message).toContain('create one')
  })

  test('browser_request_human becomes a takeover decision with the wait id of the call', async () => {
    const calls = { takeovers: [] as Array<Record<string, unknown>>, settled: [] as unknown[] }
    const hook = hookWith(fakeManager(), false, calls)
    const plugin = hook.plugin({ agentId: 'agent-1', connectionId: 'conn-1', profileId: 'p1' })
    const ctx = {
      session: { id: 'chat:agent-1:t1' },
      log: { warn() {}, info() {} },
      services: {},
      agent: { id: 'lead' },
    }
    const session = (
      plugin['~def'] as unknown as {
        session: (c: unknown) => Promise<{
          tools: Record<
            string,
            Record<symbol, { start: (input: unknown, event: unknown) => unknown }>
          >
        }>
      }
    ).session
    const contribution = await session(ctx)
    const human = contribution.tools.browser_request_human
    expect(human).toBeDefined()
    const meta = human?.[EXTERNAL_TOOL]
    const wait = (await meta?.start(
      { reason: 'log in to the portal' },
      { waitId: 'w_call-9', toolCallId: 'call-9', ctx, abortSignal: new AbortController().signal },
    )) as Record<string, unknown>
    expect(calls.takeovers).toEqual([
      {
        agentId: 'agent-1',
        sessionId: 'chat:agent-1:t1',
        waitId: 'w_call-9',
        profileId: 'p1',
        profileName: 'Shop',
        reason: 'log in to the portal',
      },
    ])
    expect(wait.correlationId).toBe('decision-1')
    expect(wait.payload).toMatchObject({
      kind: 'browser-takeover',
      profileId: 'p1',
      decisionId: 'decision-1',
    })
  })
})

describe('trusted profile and a new connection', () => {
  const connection = (defaultModes?: Record<string, string>) =>
    ({
      id: 'conn-1',
      definitionId: 'browser',
      settings: { profileId: 'p1' },
      ...(defaultModes === undefined ? {} : { defaultModes }),
    }) as never
  const depsWith = (trusted: boolean, updates: unknown[]) =>
    ({
      browser: { profiles: { get: async () => ({ id: 'p1', trusted }) } },
      connectors: {
        updateConnection: async (id: string, patch: unknown) => {
          updates.push([id, patch])
          return { id, ...(patch as object) }
        },
      },
    }) as never

  test('a new connection to a trusted profile gets act: allow at once', async () => {
    const updates: unknown[] = []
    await trustNewConnection(depsWith(true, updates), connection())
    expect(updates).toEqual([['conn-1', { defaultModes: { act: 'allow' } }]])
  })

  test('untrusted profiles, other connectors and an existing choice are left alone', async () => {
    const updates: unknown[] = []
    await trustNewConnection(depsWith(false, updates), connection())
    await trustNewConnection(depsWith(true, updates), connection({ act: 'ask' }))
    await trustNewConnection(depsWith(true, updates), {
      ...(connection() as object),
      definitionId: 'web',
    } as never)
    expect(updates).toEqual([])
  })
})

describe('takeover answers', () => {
  const decision = (takeover: boolean) =>
    ({
      kind: 'escalation',
      payload: {
        question: 'q',
        options: [],
        source: 'agent',
        ...(takeover
          ? { takeover: { profileId: 'p1', link: { label: 'Open browser', path: '/browser/p1' } } }
          : {}),
      },
    }) as never
  test('the agent reads a string: hand-back line, the page text, or the refusal', () => {
    expect(takeoverOutput(decision(false), { decision: 'approved', note: '' })).toBeUndefined()
    expect(takeoverOutput(decision(true), { decision: 'approved', note: '' })).toContain(
      'The client handed the browser back',
    )
    expect(takeoverOutput(decision(true), { decision: 'approved', note: 'done' })).toContain(
      'Note: done',
    )
    const line =
      'The client handed the browser back · page "Home" https://x.test. Take a new snapshot before you continue.'
    expect(takeoverOutput(decision(true), { decision: 'approved', note: line })).toBe(line)
    expect(takeoverOutput(decision(true), { decision: 'rejected', note: 'no time' })).toContain(
      'declined to take over the browser: no time',
    )
  })
})

describe('takeover decision', () => {
  test('the card carries the profile and an Open browser link, one decision per wait', () => {
    const server = boot()
    const input = {
      agentId: 'agent-1',
      sessionId: 'chat:agent-1:t1',
      waitId: 'w_call-1',
      title: 'Lead needs you in the browser',
      question: 'Log in to the portal',
      takeover: { profileId: 'p1' },
    }
    const d = createEscalation(server.deps, input)
    expect(d.kind).toBe('escalation')
    if (d.kind !== 'escalation') return
    expect(d.payload.takeover).toEqual({
      profileId: 'p1',
      link: { label: 'Open browser', path: '/browser/p1' },
    })
    expect(d.payload.options).toEqual([])
    expect(d.waitId).toBe('w_call-1')
    // a retried start is the same decision
    expect(createEscalation(server.deps, input).id).toBe(d.id)
  })
})
