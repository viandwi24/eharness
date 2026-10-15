/**
 * "Run Python: Allowed" means no approval card. The Files & Sandbox `run` capability is a `write`
 * capability of a built-in connector: the library adds no rule for an Allowed built-in, so in
 * Manual mode the engine's default mode asked for every run (the app lets Allowed built-in reads
 * through, `connectors.ts` `readAllowed`; `run_python` joins them). Checked in a web chat and in
 * a channel conversation of an owner, with the mode left at Manual.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { webCryptoVault } from 'eharness/providers'
import { type ScriptedCallOptions, type ScriptedStepInput, scriptedModel } from 'eharness/testing'
import { createAgent, updateAgent } from '../src/app/agents.ts'
import { builtinId } from '../src/domain/connectors.ts'
import { createMockAdapter } from '../src/infra/channels/index.ts'
import type { ModelConfig } from '../src/infra/eh/provider.ts'
import { compose, type Server } from '../src/main.ts'
import { postAs, userMessage } from './support/http.ts'

const servers: Server[] = []
const dirs: string[] = []
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const hasPython = Bun.which('python3') !== null

function lastToolText(call: ScriptedCallOptions): string {
  const msgs = call.prompt as unknown as Array<{
    role: string
    content: Array<Record<string, unknown>>
  }>
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]
    if (m?.role !== 'tool') continue
    const out = m.content.find((p) => p.type === 'tool-result')?.output as
      | { value: unknown }
      | undefined
    return typeof out?.value === 'string' ? out.value : JSON.stringify(out?.value)
  }
  return ''
}

function build(extra: Record<string, unknown> = {}): {
  server: Server
  results: string[]
  agentId: string
} {
  const dir = mkdtempSync(join(tmpdir(), 'team-run-allowed-'))
  dirs.push(dir)
  const results: string[] = []
  const model = scriptedModel([
    { toolCalls: [{ toolName: 'run_python', toolCallId: 'r1', input: { code: 'print(6 * 7)' } }] },
    ((call: ScriptedCallOptions) => {
      results.push(lastToolText(call))
      return { text: 'done' }
    }) as ScriptedStepInput,
  ])
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
    code: { driver: 'local', install: 'off' },
    ...extra,
  })
  servers.push(server)
  const def = createAgent(server.deps, {
    slug: 'analyst-y',
    name: 'Analyst Y',
    role: 'custom',
    instructions: 'You analyse files.',
    model: 'm',
    connectors: {
      [builtinId('files')]: {
        enabled: 'on',
        capabilities: { read: 'allow', edit: 'allow', delete: 'allow', run: 'allow' },
      },
    },
  })
  updateAgent(server.deps, def.id, { model: 'm' })
  return { server, results, agentId: def.id }
}

describe.skipIf(!hasPython)('run_python set to Allowed never asks in Manual mode', () => {
  test('web chat', async () => {
    const { server, results } = build()
    const res = await server.app.request(
      '/sessions/dm:analyst-y/chat',
      postAs('dm:analyst-y', userMessage('compute')),
    )
    expect(res.status).toBe(200)
    const body = await res.text()
    // an automatic approval chunk (`isAutomatic`) is the engine letting it through; a person's card is not
    expect(body).not.toMatch(/"type":"tool-approval-request"(?:(?!"isAutomatic":true)[^}])*\}/)
    expect(results[0]).toContain('Exit code 0')
  }, 60_000)

  test('channel conversation of an owner', async () => {
    const { server, results, agentId } = build({
      channels: {
        vault: webCryptoVault(new Uint8Array(32).fill(7)),
        collect: { quietMs: 25, maxWaitMs: 300, maxItems: 20 },
        typingEveryMs: 20,
        purgeEveryMs: 0,
        delivery: { retryBaseMs: 20, retryMaxMs: 80 },
      },
    })
    const gw = server.channels
    gw.configure({
      connectionId: 'c1',
      agentId,
      people: { defaultRole: 'owner', policy: {} },
      rate: { chatMinIntervalMs: 0 },
    } as never)
    const room = gw.settings.ensureNode('c1', { nativeId: 'room', kind: 'room' })
    gw.settings.set(room.id, { enabled: true, label: 'Ops', ack: false } as never)
    const mock = createMockAdapter({ connectionId: 'c1', capabilities: { buttons: true } })
    await gw.register(mock)
    await mock.say({
      from: { id: 'u-owen', name: 'Owen', username: 'owen' },
      text: '@team_bot compute it',
      id: 'w1',
      mentionSelf: true,
    })
    const end = Date.now() + 20_000
    while (!mock.sent.some((s) => s.message.text === 'done') && Date.now() < end) await sleep(20)
    expect(mock.sent.some((s) => s.message.text === 'done')).toBe(true)
    expect(mock.sent.some((s) => s.message.buttons !== undefined)).toBe(false)
    expect(results[0]).toContain('Exit code 0')
  }, 60_000)
})
