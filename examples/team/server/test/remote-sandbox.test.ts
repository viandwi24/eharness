/**
 * The Remote sandbox connector (plan P44 D13): connect it with a URL and a token through the same
 * flow routes the web uses, enable it for an agent, and run_python executes on the sandbox server
 * (started in this process), not in the local scratch directory. With Files & Sandbox `run` on as
 * well the agent still has exactly one `run_python`. Real `python3` (skipped when missing).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ScriptedCallOptions, type ScriptedStepInput, scriptedModel } from 'eharness/testing'
import { type RunningServer, startServer } from '../../../sandbox-server/src/server.ts'
import { createAgent, updateAgent } from '../src/app/agents.ts'
import { builtinId } from '../src/domain/connectors.ts'
import { libraryFs } from '../src/infra/eh/library-fs.ts'
import type { ModelConfig } from '../src/infra/eh/provider.ts'
import { compose, type Server } from '../src/main.ts'
import { postAs, userMessage } from './support/http.ts'

// biome-ignore lint/suspicious/noExplicitAny: loosely typed JSON of the API under test
type Json = Record<string, any>
const hasPython = Bun.which('python3') !== null
const TOKEN = 'remote-sandbox-token-1'
let sandbox: RunningServer
const dirs: string[] = []
const servers: Server[] = []

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'team-remote-sbx-'))
  dirs.push(dir)
  if (hasPython) {
    sandbox = await startServer({
      token: TOKEN,
      dataDir: join(dir, 'sessions'),
      log: () => {},
      // `ulimit -u` counts every process of the user: on macOS the default is exceeded at once
      limits: { processes: 1_000_000 },
    })
  }
})
afterAll(async () => {
  for (const s of servers.splice(0)) await s.close()
  if (hasPython) await sandbox.stop()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const SCRIPT = `with open('library/work/remote.md', 'w') as f:
    f.write('ran remotely')
print('done')
`

describe.skipIf(!hasPython)('Remote sandbox connector', () => {
  test('connect, enable, run_python lands a file in the library; one run_python; local scratch unused', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'team-remote-'))
    dirs.push(dir)
    const toolCounts: number[] = []
    let n = 0
    const call = (toolName: string, input: unknown): ScriptedStepInput => ({
      toolCalls: [{ toolName, toolCallId: `c${++n}`, input }],
    })
    const counting =
      (step: ScriptedStepInput): ScriptedStepInput =>
      (c: ScriptedCallOptions) => {
        toolCounts.push(
          (c.tools ?? []).filter((t) => (t as { name: string }).name === 'run_python').length,
        )
        return typeof step === 'function' ? step(c) : step
      }
    let ranText = ''
    const model = scriptedModel([
      counting(call('write_file', { path: '/library/work/remote.py', content: SCRIPT })),
      call('run_python', { file: '/library/work/remote.py' }),
      (c: ScriptedCallOptions) => {
        const msgs = c.prompt as unknown as Array<{ role: string; content: Array<Json> }>
        const tool = [...msgs].reverse().find((m) => m.role === 'tool')
        const out = tool?.content.find((p) => p.type === 'tool-result')?.output as Json | undefined
        ranText = typeof out?.value === 'string' ? out.value : JSON.stringify(out?.value)
        return { text: 'done' }
      },
    ] as ScriptedStepInput[])
    const config: ModelConfig = {
      provider: 'scripted',
      defaultModel: 'none',
      resolve: () => model as never,
    }
    const server = compose({
      dbFile: join(dir, 'team.db'),
      models: config,
      tuning: { streams: { flushMs: 5, pollMs: 20 }, inbox: { pollMs: 30 }, abortPollMs: 40 },
      eventsPollMs: 30,
      reconcile: { onBoot: false, everyMs: 0 },
      routines: { tickMs: 0 },
      // the local sandbox is on too: Files & Sandbox `run` is allowed below
      code: { driver: 'local', install: 'off' },
    })
    servers.push(server)
    await server.connectorsReady
    const api = async (method: string, path: string, body?: unknown) => {
      const res = await server.app.request(path, {
        method,
        headers: { 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
      const text = await res.text()
      return { status: res.status, json: (text ? JSON.parse(text) : undefined) as Json }
    }

    // a wrong token is refused by the connection test
    const bad = await api('POST', '/connections/flows', { definitionId: 'remote-sandbox' })
    expect(bad.status).toBe(201)
    const refused = await api('POST', `/connections/flows/${bad.json.flow.id}/act`, {
      viewId: bad.json.flow.view.viewId,
      action: 'submit',
      data: { url: sandbox.url, token: 'wrong-token-123' },
    })
    expect(refused.json.flow.status).not.toBe('done')
    await api('POST', `/connections/flows/${bad.json.flow.id}/act`, {
      viewId: refused.json.flow.view.viewId,
      action: 'cancel',
    })

    const started = await api('POST', '/connections/flows', {
      definitionId: 'remote-sandbox',
      label: 'Remote sandbox',
    })
    const done = await api('POST', `/connections/flows/${started.json.flow.id}/act`, {
      viewId: started.json.flow.view.viewId,
      action: 'submit',
      data: { url: sandbox.url, token: TOKEN },
    })
    expect(done.status).toBe(200)
    const connectionId = done.json.connection.id as string
    expect(done.json.connection.definitionId).toBe('remote-sandbox')
    expect(JSON.stringify(done.json)).not.toContain(TOKEN)

    const def = createAgent(server.deps, {
      slug: 'analyst-r',
      name: 'Analyst R',
      role: 'custom',
      instructions: 'You analyse files.',
      model: 'm',
      connectors: {
        [builtinId('files')]: {
          enabled: 'on',
          capabilities: { read: 'allow', edit: 'allow', delete: 'allow', run: 'allow' },
        },
        [connectionId]: { enabled: 'on', capabilities: { run: 'allow' } },
      },
    })
    updateAgent(server.deps, def.id, { model: 'm' })
    expect((await api('PUT', '/agents/analyst-r/mode', { mode: 'bypass' })).status).toBe(200)

    const res = await server.app.request(
      '/sessions/dm:analyst-r/chat',
      postAs('dm:analyst-r', userMessage('run the script')),
    )
    expect(res.status).toBe(200)
    await res.text()

    expect(ranText).toContain('Exit code 0')
    const fs = libraryFs(server.conn.sqlite)
    expect((await fs.read('/library/work/remote.md'))?.content).toBe('ran remotely')
    // one run_python although both Files & Sandbox `run` and Remote sandbox `run` are on
    expect(toolCounts[0]).toBe(1)
    // it ran on the sandbox server: the local scratch directory was never created
    const scratch = join(dir, 'code-scratch')
    expect(!existsSync(scratch) || readdirSync(scratch).length === 0).toBe(true)

    // Settings shows the remote sandbox (no token)
    const status = await api('GET', '/settings/code')
    expect(status.json.remote).toMatchObject({ python: expect.any(String) })
    expect(JSON.stringify(status.json)).not.toContain(TOKEN)
  }, 60_000)
})
