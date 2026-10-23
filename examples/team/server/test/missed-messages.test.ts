/**
 * Messages that arrived while nobody was listening are a choice of the owner:
 *  - after a restart, the start-up gap fill of a Telegram user account hands the messages it found
 *    to the gateway (`catchUp`), which answers the recent ones that addressed the account, once per
 *    chat, when the connection is set to (`replyMissed`, `missedWindowMinutes`);
 *  - Pause all with `answerHeldOnResume` answers the held ones at Resume (at most 12 hours old).
 * Component level: the real composed server, the mock adapter and a scripted model; the gap fill
 * runs against a fake Telegram client.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { webCryptoVault } from 'eharness/providers'
import { type ScriptedModel, type ScriptedStepInput, scriptedModel } from 'eharness/testing'
import { updateAgent } from '../src/app/agents.ts'
import { createMockAdapter, type MockAdapter } from '../src/infra/channels/index.ts'
import type { ModelConfig } from '../src/infra/eh/provider.ts'
import { createBackfill } from '../src/infra/telegram-user/backfill.ts'
import type { TgMessage, TgUserClient } from '../src/infra/telegram-user/client.ts'
import { normalizeMessage } from '../src/infra/telegram-user/normalize.ts'
import { nodeChatStore } from '../src/infra/telegram-user/store.ts'
import { compose, type Server } from '../src/main.ts'

const servers: Server[] = []
const dirs: string[] = []
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const TUNING = { streams: { flushMs: 5, pollMs: 20 }, inbox: { pollMs: 30 }, abortPollMs: 40 }
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(what: string, condition: () => boolean | Promise<boolean>, ms = 6000) {
  const end = Date.now() + ms
  while (!(await condition())) {
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`)
    await sleep(15)
  }
}

function instance(script: ScriptedStepInput[], dir = mkdtempSync(join(tmpdir(), 'team-missed-'))) {
  if (!dirs.includes(dir)) dirs.push(dir)
  const model: ScriptedModel = scriptedModel(script)
  const config: ModelConfig = {
    provider: 'scripted',
    defaultModel: 'none',
    resolve: () => model,
  }
  const server = compose({
    dbFile: join(dir, 'team.db'),
    instanceId: 'missed-test',
    models: config,
    env: {},
    tuning: TUNING,
    eventsPollMs: 30,
    reconcile: { onBoot: false, everyMs: 0 },
    routines: { tickMs: 0 },
    turnRetry: { tickMs: 0, retryUnknown: false },
    channels: {
      vault: webCryptoVault(new Uint8Array(32).fill(9)),
      collect: { quietMs: 120, maxWaitMs: 1000, maxItems: 20 },
      typingEveryMs: 20,
      purgeEveryMs: 0,
      maintenanceMs: 0,
      delivery: { retryBaseMs: 20, retryMaxMs: 80 },
    },
  })
  servers.push(server)
  const lead = server.deps.agents.getBySlug('lead')
  if (lead === undefined) throw new Error('seed missing')
  updateAgent(server.deps, lead.id, { model: 'm-lead' })
  return { server, model, dir, leadId: lead.id }
}
type Instance = ReturnType<typeof instance>

const CHAT = '-1001'
const person = { id: '1001', name: 'Vian Dwi', username: 'vian' }

async function connect(i: Instance, extra: Record<string, unknown> = {}): Promise<MockAdapter> {
  const gw = i.server.channels
  gw.configure({
    connectionId: 'c1',
    agentId: i.leadId,
    rate: { chatMinIntervalMs: 0 },
    people: { defaultRole: 'guest', policy: {} },
    ...extra,
  })
  const room = gw.settings.ensureNode('c1', { nativeId: CHAT, kind: 'room' })
  gw.settings.set(room.id, { enabled: true, label: 'Ops', ack: false } as never)
  const mock = createMockAdapter({ connectionId: 'c1' })
  await gw.register(mock)
  gw.people.setRole('c1', person.id, { role: 'owner' }, 'owner')
  return mock
}

const MIN = 60_000
function tg(
  id: number,
  text: string,
  o: { ageMin?: number; mention?: boolean; outgoing?: boolean } = {},
): TgMessage {
  return {
    chat: { id: CHAT, kind: 'group', title: 'Ops', forum: false },
    id,
    at: Date.now() - (o.ageMin ?? 5) * MIN,
    text,
    sender: { id: person.id, name: person.name, username: person.username, isBot: false },
    outgoing: o.outgoing ?? false,
    mention: o.mention ?? false,
    mentionsOthers: false,
    attachments: [],
    service: false,
  }
}
const noFetch = () => async () => {
  throw new Error('no files in history')
}
const asEvents = (list: TgMessage[]) =>
  list.map((m) => normalizeMessage(m, { selfId: 'c1-bot', fetch: noFetch }))

/** The start-up gap fill of the account against a fake client holding `history` (newest first on read). */
async function gapFill(
  i: Instance,
  history: TgMessage[],
  wake: 'mention' | 'never' = 'mention',
  seenUpTo = 100,
): Promise<void> {
  const chats = nodeChatStore({
    sqlite: i.server.conn.sqlite,
    nodes: i.server.channels.nodes,
    allowed: () => true,
  })
  chats.upsertDialog('c1', { id: CHAT, kind: 'group', title: 'Ops', forum: false, admin: false }, 1)
  chats.setSelected('c1', CHAT, true, 1)
  // choosing a chat makes it observe-only (wake never); the owner turns waking on per chat
  const room = i.server.channels.nodes.byNative('c1', CHAT)
  if (room !== undefined) {
    i.server.channels.settings.set(room.id, {
      enabled: true,
      label: 'Ops',
      ack: false,
      wake,
    } as never)
  }
  if (chats.get('c1', CHAT)?.highId === undefined) chats.noteMessage('c1', CHAT, seenUpTo, true)
  const client = {
    history: async (_chat: string, o: { limit: number; offsetId?: number }) =>
      [...history]
        .filter((m) => o.offsetId === undefined || m.id < o.offsetId)
        .sort((a, b) => b.id - a.id)
        .slice(0, o.limit),
  } as unknown as TgUserClient
  const gw = i.server.channels
  const backfill = createBackfill({
    connectionId: 'c1',
    client,
    chats,
    ingest: (m) => gw.ingest('c1', asEvents([m])[0] as never),
    ingestGap: async (_chat, messages) => {
      await gw.catchUp('c1', asEvents(messages))
    },
    allowed: () => true,
    hooks: { onFatal: () => undefined, onPark: () => undefined, onStorm: () => undefined },
    sleep: async () => undefined,
    pageDelayMs: { min: 0, max: 0 },
  })
  backfill.queueGapFill()
  await backfill.runUntilIdle()
  await backfill.stop()
}

const promptText = (model: ScriptedModel): string => JSON.stringify(model.prompts)
const replies = (mock: MockAdapter): number => mock.sent.length

describe('messages missed while the server was down', () => {
  test('an addressed message inside the window is answered, with a note that it was late', async () => {
    const i = instance([{ text: 'sorry for the wait' }])
    const mock = await connect(i)
    await gapFill(i, [tg(101, '@c1_bot status?', { mention: true, ageMin: 5 })])
    await until('answered', () => replies(mock) === 1)
    expect(mock.sent[0]?.message.text).toBe('sorry for the wait')
    expect(promptText(i.model)).toContain('while you were offline')
    expect(promptText(i.model)).toContain('status?')
    // the Activity page shows why the agent woke
    const rows = i.server.conn.sqlite
      .query<{ n: number }, []>(
        "SELECT COUNT(*) AS n FROM ch_events WHERE type = 'gateway.woke' AND payload LIKE '%woke after restart%'",
      )
      .get()
    expect(rows?.n).toBe(1)
  })

  test('a message older than the window is stored, not answered', async () => {
    const i = instance([{ text: 'should not happen' }])
    const mock = await connect(i, { missedWindowMinutes: 30 })
    await gapFill(i, [tg(101, '@c1_bot old one', { mention: true, ageMin: 90 })])
    await sleep(500)
    expect(replies(mock)).toBe(0)
    expect(i.model.prompts.length).toBe(0)
    const stored = i.server.conn.sqlite
      .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM ch_messages WHERE native_id = '101'")
      .get()
    expect(stored?.n).toBe(1)
  })

  test('a message that did not address the agent is not answered', async () => {
    const i = instance([{ text: 'should not happen' }])
    const mock = await connect(i)
    await gapFill(i, [tg(101, 'lunch anyone?', { ageMin: 2 })])
    await sleep(500)
    expect(replies(mock)).toBe(0)
    expect(i.model.prompts.length).toBe(0)
  })

  test('a chat that never wakes the agent stays silent', async () => {
    const i = instance([{ text: 'should not happen' }])
    const mock = await connect(i)
    await gapFill(i, [tg(101, '@c1_bot status?', { mention: true })], 'never')
    await sleep(500)
    expect(replies(mock)).toBe(0)
    expect(i.model.prompts.length).toBe(0)
  })

  test('a message sent by the account itself is never answered', async () => {
    const i = instance([{ text: 'should not happen' }])
    const mock = await connect(i)
    await gapFill(i, [tg(101, '@c1_bot hello', { mention: true, outgoing: true })])
    await sleep(400)
    expect(replies(mock)).toBe(0)
  })

  test('with the setting off the message is only stored', async () => {
    const i = instance([{ text: 'should not happen' }])
    const mock = await connect(i, { replyMissed: false })
    await gapFill(i, [tg(101, '@c1_bot status?', { mention: true })])
    await sleep(500)
    expect(replies(mock)).toBe(0)
    expect(i.model.prompts.length).toBe(0)
  })

  test('a second restart does not answer the same message again', async () => {
    const i = instance([{ text: 'first answer' }, { text: 'second answer' }])
    const mock = await connect(i)
    const history = [tg(101, '@c1_bot status?', { mention: true })]
    await gapFill(i, history)
    await until('answered', () => replies(mock) === 1)
    // the cursor already moved: a second start finds no gap
    await gapFill(i, history)
    // even a gap that is read again (a crash before the cursor moved) hits the log first
    await i.server.channels.catchUp('c1', asEvents(history))
    await sleep(600)
    expect(replies(mock)).toBe(1)
    expect(i.model.prompts.length).toBe(1)
  })

  test('several missed messages in one chat become one turn, oldest first', async () => {
    const i = instance([{ text: 'one answer for all' }, { text: 'a second turn must not happen' }])
    const mock = await connect(i)
    await gapFill(i, [
      tg(103, '@c1_bot third question', { mention: true, ageMin: 3 }),
      tg(101, '@c1_bot first question', { mention: true, ageMin: 9 }),
      tg(102, '@c1_bot second question', { mention: true, ageMin: 6 }),
    ])
    await until('answered', () => replies(mock) >= 1)
    await sleep(500)
    expect(replies(mock)).toBe(1)
    expect(i.model.prompts.length).toBe(1)
    const wire = promptText(i.model)
    expect(wire.indexOf('first question')).toBeLessThan(wire.indexOf('second question'))
    expect(wire.indexOf('second question')).toBeLessThan(wire.indexOf('third question'))
  })
})

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
})
const pause = async (i: Instance, body: Record<string, unknown>) => {
  const res = await i.server.app.request('/workspace/pause', json('POST', body))
  expect(res.status).toBe(200)
  return (await res.json()) as { answerHeldOnResume: boolean }
}
const resume = async (i: Instance) => {
  const res = await i.server.app.request('/workspace/resume', json('POST'))
  expect(res.status).toBe(200)
}

describe('messages held by Pause all', () => {
  test('answerHeldOnResume: one answer per conversation after Resume, folded, never twice', async () => {
    const i = instance([{ text: 'back, answering all' }, { text: 'must not happen' }])
    const mock = await connect(i)
    const view = await pause(i, { holdChannels: true, answerHeldOnResume: true })
    expect(view.answerHeldOnResume).toBe(true)
    await mock.say({
      chat: CHAT,
      from: person,
      text: '@c1_bot first held',
      id: 'h1',
      mentionSelf: true,
    })
    await mock.say({
      chat: CHAT,
      from: person,
      text: '@c1_bot second held',
      id: 'h2',
      mentionSelf: true,
    })
    await mock.say({ chat: CHAT, from: person, text: 'just chatting', id: 'h3' })
    await sleep(400)
    expect(replies(mock)).toBe(0)
    expect(i.model.prompts.length).toBe(0)

    await resume(i)
    await until('answered', () => replies(mock) >= 1)
    await sleep(500)
    expect(replies(mock)).toBe(1)
    expect(i.model.prompts.length).toBe(1)
    const wire = promptText(i.model)
    expect(wire).toContain('while the workspace was paused')
    expect(wire.indexOf('first held')).toBeLessThan(wire.indexOf('second held'))

    // a later pause and resume never brings them back
    await pause(i, { holdChannels: true, answerHeldOnResume: true })
    await resume(i)
    await sleep(500)
    expect(replies(mock)).toBe(1)
    expect(i.model.prompts.length).toBe(1)
  })

  test('without the choice the held messages are never answered', async () => {
    const i = instance([{ text: 'must not happen' }])
    const mock = await connect(i)
    await pause(i, { holdChannels: true })
    await mock.say({ chat: CHAT, from: person, text: '@c1_bot held', id: 'h1', mentionSelf: true })
    await resume(i)
    await sleep(600)
    expect(replies(mock)).toBe(0)
    // a later pause that asks for the answers does not resurrect the old ones
    await pause(i, { holdChannels: true, answerHeldOnResume: true })
    await resume(i)
    await sleep(500)
    expect(replies(mock)).toBe(0)
  })

  test('a message older than 12 hours is not answered', async () => {
    const i = instance([{ text: 'must not happen' }])
    const mock = await connect(i)
    await pause(i, { holdChannels: true, answerHeldOnResume: true })
    await mock.say({
      chat: CHAT,
      from: person,
      text: '@c1_bot ancient',
      id: 'h1',
      mentionSelf: true,
    })
    i.server.conn.sqlite
      .query('UPDATE ch_messages SET sent_at = ? WHERE native_id = ?')
      .run(Date.now() - 13 * 3_600_000, 'h1')
    await resume(i)
    await sleep(600)
    expect(replies(mock)).toBe(0)
  })

  test('a restart between pause and resume still answers at Resume', async () => {
    const a = instance([{ text: 'must not happen here' }])
    const mockA = await connect(a)
    await pause(a, { holdChannels: true, answerHeldOnResume: true })
    await mockA.say({
      chat: CHAT,
      from: person,
      text: '@c1_bot held across',
      id: 'h1',
      mentionSelf: true,
    })
    await sleep(300)
    await a.server.close()
    servers.splice(servers.indexOf(a.server), 1)

    const b = instance([{ text: 'answered after the restart' }], a.dir)
    const mockB = await connect(b)
    const state = (await (await b.server.app.request('/workspace/pause')).json()) as {
      paused: boolean
      answerHeldOnResume: boolean
    }
    expect(state).toMatchObject({ paused: true, answerHeldOnResume: true })
    await resume(b)
    await until('answered', () => replies(mockB) === 1)
    expect(mockB.sent[0]?.message.text).toBe('answered after the restart')
  })
})
