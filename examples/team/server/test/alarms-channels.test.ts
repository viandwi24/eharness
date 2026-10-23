/**
 * Alarms through the channels gateway (docs/plans/P54-alarms.md): an owner is messaged in their
 * direct chat through the outbox, an approval that expires unanswered raises an alarm, and the
 * alarm layer's push falls back when no owner can be reached.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { webCryptoVault } from 'eharness/providers'
import { type ScriptedModel, type ScriptedStepInput, scriptedModel } from 'eharness/testing'
import { updateAgent } from '../src/app/agents.ts'
import { deliverAlarms, listAlarms, raiseSystemAlarm } from '../src/app/alarms.ts'
import { createMockAdapter, type MockAdapter } from '../src/infra/channels/index.ts'
import type { ModelConfig } from '../src/infra/eh/provider.ts'
import { compose, type Server } from '../src/main.ts'

const servers: Server[] = []
const dirs: string[] = []
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(what: string, condition: () => boolean | Promise<boolean>, ms = 6000) {
  const end = Date.now() + ms
  while (!(await condition())) {
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`)
    await sleep(15)
  }
}
const ceo = { id: '1001', name: 'Casey Owner', username: 'casey' }

async function setup(steps: ScriptedStepInput[]): Promise<{
  server: Server
  mock: MockAdapter
  model: ScriptedModel
}> {
  const dir = mkdtempSync(join(tmpdir(), 'team-alarms-ch-'))
  dirs.push(dir)
  const model = scriptedModel(steps)
  const config: ModelConfig = {
    provider: 'scripted',
    defaultModel: 'none',
    resolve: () => model,
  }
  const server = compose({
    dbFile: join(dir, 'team.db'),
    instanceId: 'alarms-ch',
    models: config,
    env: {},
    tuning: { streams: { flushMs: 5, pollMs: 20 }, inbox: { pollMs: 30 }, abortPollMs: 40 },
    eventsPollMs: 30,
    reconcile: { onBoot: false, everyMs: 0 },
    routines: { tickMs: 0 },
    channels: {
      vault: webCryptoVault(new Uint8Array(32).fill(9)),
      collect: { quietMs: 25, maxWaitMs: 300, maxItems: 20 },
      typingEveryMs: 20,
      purgeEveryMs: 0,
      maintenanceMs: 0,
      delivery: { retryBaseMs: 20, retryMaxMs: 80 },
    },
  })
  servers.push(server)
  const def = server.deps.agents.getBySlug('lead')
  if (def === undefined) throw new Error('seed missing')
  updateAgent(server.deps, def.id, { model: 'm-lead' })
  const gw = server.channels
  gw.configure({
    connectionId: 'c1',
    agentId: def.id,
    rate: { chatMinIntervalMs: 0 },
    people: { defaultRole: 'guest', policy: {} },
  })
  const room = gw.settings.ensureNode('c1', { nativeId: 'room', kind: 'room' })
  gw.settings.set(room.id, { enabled: true, label: 'Ops', ack: false } as never)
  const news = gw.settings.ensureNode('c1', { nativeId: 'news', kind: 'room' })
  gw.settings.set(news.id, { enabled: true, wake: 'never' } as never)
  const mock = createMockAdapter({ connectionId: 'c1', capabilities: { buttons: true } })
  await gw.register(mock)
  return { server, mock, model }
}

/** The owner wrote once (the platform shows who they are), then the directory gives them the role. */
async function knowAsOwner(server: Server, mock: MockAdapter): Promise<void> {
  await mock.say({ from: ceo, text: 'hello', id: 'd1', kind: 'dm', chat: 'dm1' })
  server.channels.people.setRole('c1', ceo.id, { role: 'owner' }, 'owner')
}

describe('owner delivery', () => {
  test('the owner is messaged in their direct chat; with no owner it is unavailable', async () => {
    const { server, mock } = await setup([{ text: 'unused' }])
    expect(await server.channels.notifyOwners('hello')).toBe('unavailable')
    await knowAsOwner(server, mock)
    expect(await server.channels.notifyOwners('Needs attention: something failed.')).toBe('sent')
    await until('the message went out', () =>
      mock.sent.some((s) => s.message.text.includes('something failed')),
    )
    const sent = mock.sent.find((s) => s.message.text.includes('something failed'))
    expect(sent?.conversationId).toBe('dm1')
  })

  test('an owner the account cannot message is skipped, and the note is raised once a day', async () => {
    const { server, mock } = await setup([{ text: 'unused' }])
    await knowAsOwner(server, mock)
    ;(mock as { canDirectMessage?: (id: string) => Promise<boolean> }).canDirectMessage =
      async () => false
    const before = mock.sent.length
    expect(await server.channels.notifyOwners('Needs attention: disk full')).toBe('unavailable')
    expect(await server.channels.notifyOwners('Needs attention: disk full again')).toBe(
      'unavailable',
    )
    await sleep(100)
    expect(mock.sent.length).toBe(before)
    const notes = server.deps.notifications
      .list({ open: true, limit: 20 })
      .filter((n) => n.title.includes('cannot reach'))
    expect(notes).toHaveLength(1)
    expect(notes[0]?.body).toContain('ask them to send one message to the account first')
    // once the account does have a conversation, the alarm goes out
    ;(mock as { canDirectMessage?: (id: string) => Promise<boolean> }).canDirectMessage =
      async () => true
    expect(await server.channels.notifyOwners('Needs attention: back')).toBe('sent')
  })

  test('an alarm raised after the owner is known reaches their chat, not the bell', async () => {
    const { server, mock } = await setup([{ text: 'unused' }])
    await knowAsOwner(server, mock)
    raiseSystemAlarm(server.deps, 'health-scan', new Error('disk full'))
    await deliverAlarms(server.deps)
    await until('pushed', () => mock.sent.some((s) => s.message.text.includes('disk full')))
    const alarm = listAlarms(server.deps).alarms.find((a) => a.kind === 'system')
    expect(alarm?.deliveredAt).not.toBeNull()
    expect(server.deps.notifications.byKey(`alarm:${alarm?.id}`)).toBeUndefined()
  })
})

describe('approval expiry', () => {
  test('an approval nobody answers raises one alarm when it expires', async () => {
    const { server, mock } = await setup([
      {
        toolCalls: [
          {
            toolName: 'channel_send',
            input: { action: 'send', conversation: 'news', text: 'Release notes are live.' },
            toolCallId: 'a1',
          },
        ],
      },
      { text: 'It was not approved.' },
    ])
    server.channels.people.setRole('c1', ceo.id, { role: 'admin' }, 'owner')
    await mock.say({ from: ceo, text: '@team_bot publish', id: 'w1', mentionSelf: true })
    await until('the request', () => mock.sent.some((s) => s.message.buttons !== undefined))
    expect(await server.channels.expireApprovals(Date.now() + 25 * 3_600_000)).toBe(1)
    const alarms = listAlarms(server.deps).alarms.filter((a) => a.kind === 'approval-expired')
    expect(alarms).toHaveLength(1)
    expect(alarms[0]?.text).toContain('channel_send')
    expect(alarms[0]?.text).toContain('nobody answered')
    // expiring again changes nothing: the approval is closed
    expect(await server.channels.expireApprovals(Date.now() + 26 * 3_600_000)).toBe(0)
    expect(
      listAlarms(server.deps).alarms.filter((a) => a.kind === 'approval-expired'),
    ).toHaveLength(1)
  })
})
