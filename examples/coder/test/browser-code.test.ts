/**
 * The opt-in browser tools (`eharness/browser`) and `run_python` (`eharness/code`) of the coder:
 * off by default, config, trust, permission kinds and a scripted turn through the real
 * controller. No real browser: a stub adapter stands in for Chrome. Python tests use the host's
 * `python3` and skip without it.
 */
import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  type BrowserAdapter,
  type BrowserConnection,
  defineBrowserAdapter,
  type PageInfo,
} from 'eharness/browser'
import { inMemoryFs } from 'eharness/filesystem/memory'
import { scratchSandbox } from 'eharness/shell'
import { z } from 'zod/v4'
import { browserToolKinds, createBrowserSupport } from '../src/app/browser.ts'
import { createCodeSupport } from '../src/app/code-sandbox.ts'
import { loadConfig } from '../src/app/config.ts'
import type { CoderConfig, CoderController, PermissionMode, RunHooks } from '../src/contracts.ts'
import { describeApproval } from '../src/permissions/describe.ts'
import { createPermissionEngine } from '../src/permissions/engine.ts'
import { makeController, onCleanup, routerModel, setup } from './helpers.ts'

const TINY_PNG = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  ),
  (c) => c.charCodeAt(0),
)

/** A stand-in for Chrome: records what the tools did and answers like a tiny app. */
function stubAdapter(): { adapter: BrowserAdapter; calls: string[] } {
  const calls: string[] = []
  let page: PageInfo = { url: 'about:blank', title: '' }
  let n = 0
  const connection: BrowserConnection = {
    async navigate(input) {
      calls.push(`navigate ${input.url ?? input.action}`)
      if (input.url !== undefined) page = { url: input.url, title: 'My App' }
      return page
    },
    async snapshot() {
      calls.push('snapshot')
      return {
        id: 's1',
        text: '- heading "Todo list" [e1]\n- button "Add item" [e2]',
        page,
        refCount: 2,
      }
    },
    async act(input) {
      calls.push(`act ${input.kind}${input.ref ? ` ${input.ref}` : ''}`)
      return {
        page,
        navigated: false,
        changed: input.kind !== 'scroll',
        summary: `Did ${input.kind}${input.ref ? ` ${input.ref}` : ''}`,
      }
    },
    async screenshot() {
      calls.push('screenshot')
      n++
      // a different hash each time so the library attaches every image
      return { bytes: TINY_PNG, mediaType: 'image/png', width: 1, height: 1, hash: `h${n}` }
    },
    async read() {
      calls.push('read')
      return { text: 'Todo list', page }
    },
    async page() {
      return page
    },
    async close() {
      calls.push('close')
    },
  }
  const adapter = defineBrowserAdapter({
    id: 'chrome',
    label: 'Stub Chrome',
    managed: {
      settings: z.object({ headless: z.boolean().optional() }),
      runtime: {
        status: async () => ({ state: 'ready', version: 'stub' }),
        install: async () => {},
        start: async () => ({ cdpUrl: 'ws://stub.test/devtools' }),
        stop: async () => {},
      },
    },
    capabilities: {
      snapshot: true,
      screenshot: true,
      liveView: 'poll',
      takeover: false,
      tabs: true,
      persistentProfile: false,
    },
    connect: async () => connection,
  })
  return { adapter, calls }
}

type Chunk = { type: string; [k: string]: unknown }

function hooks(): RunHooks & { chunks: Chunk[]; done: Promise<void>[] } {
  const chunks: Chunk[] = []
  const done: Promise<void>[] = []
  return {
    chunks,
    done,
    onRun(run) {
      done.push(
        (async () => {
          const reader = (run.stream as ReadableStream<Chunk>).getReader()
          for (;;) {
            const r = await reader.read()
            if (r.done) return
            chunks.push(r.value)
          }
        })(),
      )
    },
  }
}

async function turn(c: CoderController, text: string) {
  const h = hooks()
  const result = await c.run(text, h)
  await Promise.all(h.done)
  return result
}

/** Approve every approval the broker shows; returns what was asked. */
function approveAll(c: CoderController): Array<{ toolName: string; input: unknown }> {
  const asked: Array<{ toolName: string; input: unknown }> = []
  const answered = new Set<string>()
  const off = c.broker.subscribe((pending) => {
    for (const request of pending) {
      if (answered.has(request.id)) continue
      answered.add(request.id)
      asked.push({ toolName: request.toolName, input: request.input })
      queueMicrotask(() => c.broker.answer(request.id, { approved: true }))
    }
  })
  onCleanup(async () => off())
  return asked
}

const call = (toolName: string, input: unknown = {}) => ({ toolCalls: [{ toolName, input }] })

const BROWSER_ON = { browser: { enabled: true }, deferTools: false }

describe('off by default', () => {
  test('no browser or run_python tools and `/browser` says so', async () => {
    const model = routerModel(() => ({ text: 'done' }))
    const { controller } = await makeController({ model })
    await turn(controller, 'hi')
    const tools = model.routes[0]?.tools ?? []
    expect(tools.some((t) => t.startsWith('browser_'))).toBe(false)
    expect(tools).not.toContain('run_python')
    const info = await controller.browserStatus()
    expect(info.enabled).toBe(false)
    expect(info.lines.join('\n')).toContain('Browser tools are off')
    expect(info.lines.join('\n')).toContain('run_python is off')
  })

  test('createBrowserSupport and createCodeSupport return nothing for an absent or disabled setting', async () => {
    expect(await createBrowserSupport({ settings: undefined, userDir: '/x' })).toBeUndefined()
    expect(
      await createBrowserSupport({ settings: { enabled: false }, userDir: '/x' }),
    ).toBeUndefined()
    expect(createCodeSupport({ settings: undefined, osUsable: true })).toBeUndefined()
    expect(createCodeSupport({ settings: { enabled: false }, osUsable: true })).toBeUndefined()
  })
})

describe('browser setting', () => {
  test('the profile allows local dev servers only by default; allowDomains widen it', async () => {
    const a = await createBrowserSupport({
      settings: { enabled: true },
      userDir: '/tmp/none',
      adapters: [stubAdapter().adapter],
    })
    expect(a?.allowDomains).toEqual(['localhost', '127.0.0.1', '[::1]'])
    expect(a?.localOnly).toBe(true)
    const b = await createBrowserSupport({
      settings: { enabled: true, allowDomains: ['*.example.com'] },
      userDir: '/tmp/none',
      adapters: [stubAdapter().adapter],
    })
    expect(b?.allowDomains).toContain('*.example.com')
    expect(b?.localOnly).toBe(false)
  })

  test('a project file cannot turn the browser or code on or widen hosts without trust', async () => {
    const { config } = await setup({
      '.coder/settings.json': JSON.stringify({
        browser: { enabled: true, allowDomains: ['*'] },
        code: { enabled: true },
      }),
    })
    expect(config.untrusted).toEqual(expect.arrayContaining(['browser', 'code']))
    const untrusted = await loadConfig({ cwd: config.root })
    expect(untrusted.settings.browser).toBeUndefined()
    expect(untrusted.settings.code).toBeUndefined()
    const trusted = await loadConfig({ cwd: config.root, trustProject: true })
    expect(trusted.settings.browser).toEqual({ enabled: true, allowDomains: ['*'] })
    expect(trusted.settings.code).toEqual({ enabled: true })
  })

  test('a scripted turn: open localhost, snapshot, scroll, screenshot, click (asks), blocked host', async () => {
    const { adapter, calls } = stubAdapter()
    const model = routerModel((route) => {
      switch (route.toolResults) {
        case 0:
          return call('browser_open', { url: 'http://localhost:5173/' })
        case 1:
          return call('browser_snapshot')
        case 2:
          return call('browser_scroll', { direction: 'down', pages: 1 })
        case 3:
          return call('browser_screenshot')
        case 4:
          return call('browser_act', { kind: 'click', ref: 'e2' })
        case 5:
          return call('browser_open', { url: 'https://example.com/' })
        default:
          return { text: 'the app works' }
      }
    })
    const { controller } = await makeController({
      model,
      homeFiles: { 'settings.json': JSON.stringify(BROWSER_ON) },
      browserAdapters: [adapter],
    })
    const asked = approveAll(controller)
    const result = await turn(controller, 'check the app in the browser')
    expect(result.stop).toBe('complete')
    // only the click asks: opening localhost, reading and scrolling are safe
    expect(asked.map((a) => a.toolName)).toEqual(['browser_act'])
    expect(calls).toEqual(
      expect.arrayContaining([
        'navigate http://localhost:5173/',
        'snapshot',
        'act scroll',
        'screenshot',
        'act click e2',
      ]),
    )
    // another host is refused by the profile's list, before the browser is touched
    expect(calls.filter((c) => c.startsWith('navigate'))).toEqual([
      'navigate http://localhost:5173/',
    ])
    const last = JSON.stringify(model.prompts.at(-1))
    expect(last).toContain('Todo list')
    expect(last).toContain('BLOCKED')
    // the tools are on the main agent's list
    expect(model.routes[0]?.tools).toEqual(
      expect.arrayContaining([
        'browser_open',
        'browser_act',
        'browser_scroll',
        'browser_screenshot',
      ]),
    )
    const info = await controller.browserStatus()
    expect(info.enabled).toBe(true)
    expect(info.lines.join('\n')).toContain('localhost')
    expect(info.lines.join('\n')).toContain('My App')
  })

  test('browser_act is denied in plan mode and asks in the other modes; tool kinds follow the allowed hosts', async () => {
    const make = (mode: PermissionMode, localOnly = true) =>
      createPermissionEngine({
        config: {
          root: '/tmp/x',
          mode,
          rules: { allow: [], ask: [], deny: [] },
          settingsFiles: {},
        } as unknown as CoderConfig,
        mounts: () => [{ virtual: '/', real: '/tmp/x', readonly: false }],
        toolKinds: browserToolKinds(localOnly),
      })
    const act = { toolName: 'browser_act', input: { kind: 'click', ref: 'e1' } }
    expect(make('default').decide(act).status).toBe('user-approval')
    expect(make('acceptEdits').decide(act).status).toBe('user-approval')
    expect(make('plan').decide(act).status).toBe('denied')
    expect(make('bypassPermissions').decide(act).status).toBe('approved')
    expect(make('dontAsk').decide(act).status).toBe('denied')
    const open = { toolName: 'browser_open', input: { url: 'http://localhost:3000/' } }
    expect(make('default').decide(open).status).toBe('approved')
    // with wider hosts opening is a fetch: WebFetch rules decide
    expect(make('default', false).decide(open).status).toBe('user-approval')
    const allowed = createPermissionEngine({
      config: {
        root: '/tmp/x',
        mode: 'default',
        rules: { allow: ['WebFetch(domain:docs.example.com)'], ask: [], deny: [] },
        settingsFiles: {},
      } as unknown as CoderConfig,
      mounts: () => [{ virtual: '/', real: '/tmp/x', readonly: false }],
      toolKinds: browserToolKinds(false),
    })
    expect(
      allowed.decide({ toolName: 'browser_open', input: { url: 'https://docs.example.com/a' } })
        .status,
    ).toBe('approved')
    expect(
      allowed.decide({ toolName: 'browser_open', input: { url: 'https://evil.io/' } }).status,
    ).toBe('user-approval')
    expect(make('default').decide({ toolName: 'browser_snapshot', input: {} }).status).toBe(
      'approved',
    )
  })

  test('approval text of browser_act, browser_open and run_python', async () => {
    const engine = createPermissionEngine({
      config: {
        root: '/tmp/x',
        mode: 'default',
        rules: { allow: [], ask: [], deny: [] },
        settingsFiles: {},
      } as unknown as CoderConfig,
      mounts: () => [{ virtual: '/', real: '/tmp/x', readonly: false }],
    })
    const fs = inMemoryFs()
    const act = await describeApproval(
      { toolName: 'browser_act', input: { kind: 'fill', ref: 'e3', text: 'hello' } },
      fs,
      engine,
    )
    expect(act.title).toBe('Browser fill e3: hello')
    const open = await describeApproval(
      { toolName: 'browser_open', input: { url: 'http://localhost:3000/' } },
      fs,
      engine,
    )
    expect(open.title).toBe('Open http://localhost:3000/ in the browser')
    const py = await describeApproval(
      { toolName: 'run_python', input: { code: 'print(1)' } },
      fs,
      engine,
    )
    expect(py.title).toBe('Run Python code')
    expect(py.detail).toBe('print(1)')
    const file = await describeApproval(
      { toolName: 'run_python', input: { file: '/work/a.py' } },
      fs,
      engine,
    )
    expect(file.title).toBe('Run Python /work/a.py')
  })
})

const hasPython = Bun.spawnSync(['python3', '--version']).exitCode === 0

describe('run_python', () => {
  const CODE_ON = { code: { enabled: true, allowUnsandboxed: true }, deferTools: false }
  const sandbox = () => scratchSandbox({ os: { enabled: false, network: false, allowWrite: [] } })

  test('refuses to run without the OS sandbox unless allowUnsandboxed is set', async () => {
    const model = routerModel((route) =>
      route.toolResults === 0 ? call('run_python', { code: 'print(1)' }) : { text: 'done' },
    )
    const { controller } = await makeController({
      model,
      homeFiles: {
        'settings.json': JSON.stringify({ code: { enabled: true }, deferTools: false }),
      },
      codeSandbox: sandbox,
    })
    approveAll(controller)
    await turn(controller, 'run it')
    expect(JSON.stringify(model.prompts.at(-1))).toMatch(/isolat|sandbox/i)
    const info = await controller.browserStatus()
    expect(info.lines.join('\n')).toContain('run_python is on')
  })

  test.skipIf(!hasPython)(
    'runs a script over the work folder, asks first and writes the result back to the project',
    async () => {
      const model = routerModel((route) => {
        switch (route.toolResults) {
          case 0:
            return call('write_file', {
              path: '/work/sum.py',
              content:
                "rows = [int(x) for x in open('work/numbers.txt').read().split()]\nopen('work/total.txt', 'w').write(str(sum(rows)))\nprint('sum', sum(rows))\n",
            })
          case 1:
            return call('run_python', { file: '/work/sum.py' })
          default:
            return { text: 'total written' }
        }
      })
      const { controller, root } = await makeController({
        model,
        files: { 'work/numbers.txt': '1 2 3 4\n' },
        homeFiles: { 'settings.json': JSON.stringify(CODE_ON) },
        codeSandbox: sandbox,
      })
      const asked = approveAll(controller)
      const result = await turn(controller, 'sum the numbers with python')
      expect(result.stop).toBe('complete')
      expect(asked.map((a) => a.toolName)).toEqual(['write_file', 'run_python'])
      expect(existsSync(join(root, 'work', 'total.txt'))).toBe(true)
      expect(readFileSync(join(root, 'work', 'total.txt'), 'utf8')).toBe('10')
      expect(JSON.stringify(model.prompts.at(-1))).toContain('sum 10')
    },
  )

  test('run_python is not available in plan mode', async () => {
    const model = routerModel(() => ({ text: 'planning' }))
    const { controller } = await makeController({
      model,
      flags: { permissionMode: 'plan' },
      homeFiles: { 'settings.json': JSON.stringify(CODE_ON) },
      codeSandbox: sandbox,
    })
    await turn(controller, 'plan it')
    expect(model.routes[0]?.tools).not.toContain('run_python')
  })
})
