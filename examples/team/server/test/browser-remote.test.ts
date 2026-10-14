/**
 * A managed Chrome profile on the Remote sandbox (plan P48 phase F): the team connects a real
 * sandbox server (with a fake browser runtime, nothing is downloaded) through the Remote sandbox
 * connector, creates `runtime: "remote"` profiles and drives the runtime cards through the routes.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserRuntime, RuntimeStatus } from 'eharness/browser'
import { scriptedModel } from 'eharness/testing'
import { type RunningServer, startServer } from '../../../sandbox-server/src/server.ts'
import { scriptedModelConfig } from '../src/infra/eh/provider.ts'
import { compose, type Server } from '../src/main.ts'

// biome-ignore lint/suspicious/noExplicitAny: loosely typed JSON of the API under test
type Json = Record<string, any>
const TOKEN = 'remote-browser-token-1'
const key = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64')
const dirs: string[] = []
const servers: Server[] = []
const calls: string[] = []
let sandbox: RunningServer
let state: RuntimeStatus['state'] = 'missing'

const fake: BrowserRuntime = {
  status: async () => ({ state, ...(state === 'ready' ? { version: '9.9.9' } : {}) }),
  install: async () => {
    calls.push('install')
    state = 'ready'
  },
  start: async (p) => {
    calls.push(`start:${p.id}`)
    return { cdpUrl: 'ws://127.0.0.1:9/devtools/browser/x' }
  },
  stop: async (id) => {
    calls.push(`stop:${id}`)
  },
  removeProfileData: async (id) => {
    calls.push(`remove:${id}`)
  },
}

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'team-remote-browser-'))
  dirs.push(dir)
  sandbox = await startServer({
    token: TOKEN,
    dataDir: join(dir, 's'),
    osSandbox: false,
    log: () => {},
    browser: fake,
  })
})
afterAll(async () => {
  for (const s of servers.splice(0)) await s.close()
  await sandbox.stop()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function boot(): Server {
  const root = mkdtempSync(join(tmpdir(), 'team-browser-'))
  dirs.push(root)
  const server = compose({
    dbFile: ':memory:',
    models: scriptedModelConfig(scriptedModel([]) as never),
    env: {
      TEAM_SECRET_KEY: key,
      TEAM_BROWSER_ROOT: join(root, 'browser'),
      TEAM_BROWSER_DRIVER: 'local',
    },
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

const call = async (server: Server, method: string, path: string, body?: unknown) => {
  const res = await server.app.request(path, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await res.text()
  return { status: res.status, json: (text === '' ? undefined : JSON.parse(text)) as Json }
}

async function connectRemote(server: Server): Promise<void> {
  const started = await call(server, 'POST', '/connections/flows', {
    definitionId: 'remote-sandbox',
    label: 'Remote sandbox',
  })
  const done = await call(server, 'POST', `/connections/flows/${started.json.flow.id}/act`, {
    viewId: started.json.flow.view.viewId,
    action: 'submit',
    data: { url: sandbox.url, token: TOKEN },
  })
  expect(done.status).toBe(200)
}

describe('managed Chrome on the Remote sandbox', () => {
  test('without a connection the remote choice is refused and nothing is offered', async () => {
    const server = boot()
    await server.connectorsReady
    const a = (await call(server, 'GET', '/browser/adapters')).json
    expect(a.adapters.find((x: Json) => x.id === 'chrome').remote).toBeNull()
    const refused = await call(server, 'POST', '/browser/profiles', {
      name: 'R',
      adapter: 'chrome',
      mode: 'managed',
      runtime: 'remote',
    })
    expect(refused.status).toBe(400)
    expect(refused.json.error.code).toBe('REMOTE_UNAVAILABLE')
    expect((await call(server, 'POST', '/browser/runtimes/chrome@remote/install')).status).toBe(400)
  })

  test('connected: a remote runtime card, a remote profile, install, start, stop, delete', async () => {
    const server = boot()
    await server.connectorsReady
    await connectRemote(server)

    const a = (await call(server, 'GET', '/browser/adapters')).json
    const chrome = a.adapters.find((x: Json) => x.id === 'chrome')
    expect(chrome.remote.adapter).toBe('chrome@remote')
    expect(chrome.remote.where).toBe('remote')
    expect(chrome.remote.host).toBe(new URL(sandbox.url).host)
    expect(chrome.remote.state).toBe('missing')
    expect(JSON.stringify(a)).not.toContain(TOKEN)

    const created = await call(server, 'POST', '/browser/profiles', {
      name: 'Far away',
      adapter: 'chrome',
      mode: 'managed',
      runtime: 'remote',
    })
    expect(created.status).toBe(201)
    expect(created.json.runsOn).toBe('remote')
    expect(created.json.runtime.host).toBe(new URL(sandbox.url).host)
    expect(created.json.state).toBe('missing')
    const id = created.json.id as string
    // a local profile next to it is unchanged
    const near = await call(server, 'POST', '/browser/profiles', {
      name: 'Near',
      adapter: 'chrome',
      mode: 'managed',
    })
    expect(near.json.runsOn).toBe('local')
    expect(near.json.runtime.host).toBeUndefined()

    // install on the remote engine (polled through the route)
    const installing = await call(server, 'POST', '/browser/runtimes/chrome@remote/install')
    expect(installing.status).toBe(202)
    for (let i = 0; i < 50 && !calls.includes('install'); i++) await Bun.sleep(20)
    const ready = await call(server, 'GET', '/browser/runtimes/chrome@remote')
    expect(ready.json.state).toBe('ready')
    expect(ready.json.version).toBe('9.9.9')
    expect((await call(server, 'GET', `/browser/profiles/${id}`)).json.state).toBe('ready')

    // start goes to the sandbox server's runtime, not to a local engine (the fake CDP url is dead:
    // the attach may fail, the call must still have reached the remote)
    await call(server, 'POST', `/browser/profiles/${id}/start`)
    expect(calls).toContain(`start:${id}`)
    await call(server, 'POST', `/browser/profiles/${id}/stop`)
    expect(calls).toContain(`stop:${id}`)

    expect((await call(server, 'DELETE', `/browser/profiles/${id}`)).status).toBe(204)
    expect(calls).toContain(`remove:${id}`)
  })
})
