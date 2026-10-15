/**
 * An approval of a chat turn reaches the owners outside the chat too (a Telegram user account
 * cannot show buttons, and nobody may read the request there): the chat says in plain words that
 * the agent waits for an owner or admin, and a bell notification links to the session.
 */
import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { webCryptoVault } from 'eharness/providers'
import { scriptedModel } from 'eharness/testing'
import { createAgent, updateAgent } from '../src/app/agents.ts'
import { builtinId } from '../src/domain/connectors.ts'
import { createMockAdapter } from '../src/infra/channels/index.ts'
import type { ModelConfig } from '../src/infra/eh/provider.ts'
import { compose, type Server } from '../src/main.ts'

const servers: Server[] = []
const dirs: string[] = []
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

test('no buttons: the chat says it waits for an owner, and the bell links to the session', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'team-approval-notify-'))
  dirs.push(dir)
  const model = scriptedModel([
    {
      toolCalls: [{ toolName: 'delete_file', toolCallId: 'd1', input: { path: '/library/x.md' } }],
    },
    { text: 'done' },
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
    channels: {
      vault: webCryptoVault(new Uint8Array(32).fill(7)),
      collect: { quietMs: 25, maxWaitMs: 300, maxItems: 20 },
      typingEveryMs: 20,
      purgeEveryMs: 0,
      delivery: { retryBaseMs: 20, retryMaxMs: 80 },
    },
  })
  servers.push(server)
  const def = createAgent(server.deps, {
    slug: 'ops-z',
    name: 'Ops Z',
    role: 'custom',
    instructions: 'You help.',
    model: 'm',
    connectors: {
      [builtinId('files')]: {
        enabled: 'on',
        capabilities: { read: 'allow', edit: 'allow', delete: 'allow' },
      },
    },
  })
  updateAgent(server.deps, def.id, { model: 'm' })
  const gw = server.channels
  gw.configure({
    connectionId: 'c1',
    agentId: def.id,
    people: { defaultRole: 'owner', policy: {} },
    rate: { chatMinIntervalMs: 0 },
  } as never)
  const room = gw.settings.ensureNode('c1', { nativeId: 'room', kind: 'room' })
  gw.settings.set(room.id, { enabled: true, label: 'Ops', ack: false } as never)
  const mock = createMockAdapter({ connectionId: 'c1', capabilities: { buttons: false } })
  await gw.register(mock)
  await mock.say({
    from: { id: 'u-owen', name: 'Owen', username: 'owen' },
    text: '@team_bot delete x.md',
    id: 'w1',
    mentionSelf: true,
  })
  const end = Date.now() + 15_000
  while (
    !mock.sent.some((s) => s.message.text.includes('waiting for an owner')) &&
    Date.now() < end
  )
    await sleep(20)
  const ask = mock.sent.find((s) => s.message.text.includes('waiting for an owner'))
  expect(ask?.message.buttons).toBeUndefined()
  expect(ask?.message.text).toContain('delete_file')
  const bell = server.deps.notifications
    .list({ open: true, limit: 20 })
    .find((n) => n.title.startsWith('Approval needed'))
  expect(bell?.title).toContain('delete_file')
  expect(bell?.body).toContain('owner or admin')
  expect(bell?.link).toMatch(/^\/a\/.+\?t=/)
}, 30_000)
