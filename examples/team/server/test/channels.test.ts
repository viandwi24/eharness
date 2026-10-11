/**
 * Channels gateway (docs/plans/P41-team-channels.md, phase L1), on a mock adapter and scripted
 * models only: the pure policy, the encrypted log, pairing, and the use cases U1 (observe only),
 * U2 (a program posts through the outbound queue) and U3 (a group wakes the agent with context,
 * replies quoting the trigger in its topic, DMs need pairing, two agents never loop), plus
 * dedupe and restart.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { webCryptoVault } from 'eharness/providers'
import { type ScriptedModel, type ScriptedStepInput, scriptedModel } from 'eharness/testing'
import { z } from 'zod'
import { updateAgent } from '../src/app/agents.ts'
import { threadSessionOf } from '../src/app/threads.ts'
import {
  ChannelError,
  type ChannelGateway,
  createMockAdapter,
  type MockAdapter,
} from '../src/infra/channels/index.ts'
import {
  ConnectionConfigSchema,
  createLoopGuard,
  decideWake,
  matchesAlias,
  neutralize,
  resolveScope,
  splitText,
} from '../src/infra/channels/policy.ts'
import type { InboundEvent } from '../src/infra/channels/types.ts'
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

const KEY = new Uint8Array(32).fill(7)
const TUNING = { streams: { flushMs: 5, pollMs: 20 }, inbox: { pollMs: 30 }, abortPollMs: 40 }
const COLLECT = { quietMs: 25, maxWaitMs: 300, maxItems: 20 }

type Slug = 'lead' | 'researcher'
interface Instance {
  server: Server
  gw: ChannelGateway
  models: Record<string, ScriptedModel>
  leadId: string
  researcherId: string
}

function instance(
  script: Partial<Record<Slug, ScriptedStepInput[]>>,
  options: {
    dir?: string
    sleepless?: boolean
    delivery?: { retryBaseMs?: number; retryMaxMs?: number; maxAttempts?: number }
    /** Outbound queue sleeps at most a few ms (internal retries would take seconds otherwise). */
    fastSleep?: boolean
  } = {},
): Instance {
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), 'team-p41-'))
  if (options.dir === undefined) dirs.push(dir)
  const models: Record<string, ScriptedModel> = {}
  for (const [slug, steps] of Object.entries(script)) models[slug] = scriptedModel(steps)
  const config: ModelConfig = {
    provider: 'scripted',
    defaultModel: 'none',
    resolve: (id) => {
      const slug = (id ?? '').replace('m-', '')
      let model = models[slug]
      if (model === undefined) {
        model = scriptedModel([
          () => {
            throw new Error(`unexpected model call of ${slug}`)
          },
        ])
        models[slug] = model
      }
      return model
    },
  }
  const server = compose({
    dbFile: join(dir, 'team.db'),
    instanceId: 'channels-test',
    models: config,
    env: {},
    tuning: TUNING,
    eventsPollMs: 30,
    reconcile: { onBoot: false, everyMs: 0 },
    routines: { tickMs: 0 },
    channels: {
      vault: webCryptoVault(KEY),
      collect: COLLECT,
      typingEveryMs: 20,
      purgeEveryMs: 0,
      delivery: options.delivery ?? { retryBaseMs: 20, retryMaxMs: 80 },
      ...(options.fastSleep === true
        ? { outbound: { sleep: async (ms: number) => void (await sleep(Math.min(ms, 5))) } }
        : {}),
    },
  })
  servers.push(server)
  for (const slug of ['lead', 'researcher']) {
    const def = server.deps.agents.getBySlug(slug)
    if (def === undefined) throw new Error('seed missing')
    updateAgent(server.deps, def.id, { model: `m-${slug}` })
  }
  const id = (slug: string) => (server.deps.agents.getBySlug(slug) as { id: string }).id
  return {
    server,
    gw: server.channels,
    models,
    leadId: id('lead'),
    researcherId: id('researcher'),
  }
}

const ana = { id: 'u-ana', name: 'Ana Putri', username: 'ana' }
const budi = { id: 'u-budi', name: 'Budi', username: 'budi' }
const wire = (m: ScriptedModel): string => JSON.stringify(m.prompts)
const calls = (m: ScriptedModel | undefined): number => m?.prompts.length ?? 0

async function connect(
  i: Instance,
  options: {
    connectionId?: string
    agentId?: string
    groups?: Record<string, Record<string, unknown>>
    config?: Record<string, unknown>
    adapter?: Parameters<typeof createMockAdapter>[0]
  } = {},
): Promise<MockAdapter> {
  const connectionId = options.connectionId ?? 'c1'
  i.gw.configure({
    connectionId,
    agentId: options.agentId ?? i.leadId,
    groups: options.groups ?? { room: { label: 'Ops' } },
    ...options.config,
  })
  const mock = createMockAdapter({ connectionId, ...options.adapter })
  await i.gw.register(mock)
  return mock
}

const textStep = (text: string): ScriptedStepInput => ({ text })

describe('policy (pure)', () => {
  const cfg = ConnectionConfigSchema.parse({
    connectionId: 'c',
    agentId: 'lead',
    groups: {
      ops: {
        wake: 'mention',
        topics: { billing: { agentId: 'finance' }, quiet: { wake: 'never' } },
      },
      news: { wake: 'always' },
    },
  })
  const ref = (container: string, topic?: string) => ({
    id: topic === undefined ? container : `${container}/${topic}`,
    connectionId: 'c',
    container,
    ...(topic === undefined ? {} : { topic }),
    kind: 'group' as const,
  })
  const msg = (over: Partial<Extract<InboundEvent, { type: 'message' }>> = {}) =>
    ({
      type: 'message',
      conversation: ref('ops'),
      at: 1,
      messageId: '1',
      sender: ana,
      text: 'hello',
      attachments: [],
      signals: { mentionedSelf: false, replyToSelf: false },
      ...over,
    }) as Extract<InboundEvent, { type: 'message' }>
  const self = { id: 'bot', username: 'team_bot', isSelf: true }

  test('allowlist, topic overrides and defaults', () => {
    expect(resolveScope(cfg, ref('ops')).allowed).toBe(true)
    expect(resolveScope(cfg, ref('other')).allowed).toBe(false)
    const open = ConnectionConfigSchema.parse({
      connectionId: 'c',
      agentId: 'a',
      groupPolicy: 'open',
    })
    expect(resolveScope(open, ref('other')).allowed).toBe(true)
    const topic = resolveScope(cfg, ref('ops', 'billing'))
    expect(topic).toMatchObject({ agentId: 'finance', ownTopic: true, wake: 'mention' })
    expect(resolveScope(cfg, ref('ops', 'quiet')).wake).toBe('never')
    expect(resolveScope(cfg, ref('ops')).quote).toBe('first')
    expect(resolveScope(cfg, { ...ref('x'), kind: 'dm' }).quote).toBe('off')
  })

  test('wake decisions: mention, reply, alias, others mentioned, own topic, never, always', () => {
    const scope = resolveScope(cfg, ref('ops'))
    const d = (m: ReturnType<typeof msg>, s = scope) => decideWake(m, s, self).action
    expect(d(msg())).toBe('observe')
    expect(d(msg({ signals: { mentionedSelf: true, replyToSelf: false } }))).toBe('wake')
    expect(d(msg({ signals: { mentionedSelf: false, replyToSelf: true } }))).toBe('wake')
    expect(
      d(msg({ signals: { mentionedSelf: false, mentionedOthers: true, replyToSelf: false } })),
    ).toBe('observe')
    expect(d(msg({ text: 'hey @team_bot look' }))).toBe('wake')
    expect(d(msg({ text: 'hey @team_botx look' }))).toBe('observe')
    expect(d(msg(), resolveScope(cfg, ref('ops', 'billing')))).toBe('wake')
    expect(d(msg(), resolveScope(cfg, ref('ops', 'quiet')))).toBe('observe')
    expect(d(msg(), resolveScope(cfg, ref('news')))).toBe('wake')
    expect(matchesAlias('Hey Robo, status?', ['robo'], self)).toBe(true)
    expect(matchesAlias('robotics', ['robo'], self)).toBe(false)
  })

  test('splitText breaks on newlines and never exceeds the limit', () => {
    const text = `${'a'.repeat(40)}\n${'b'.repeat(40)}\n${'c'.repeat(40)}`
    const parts = splitText(text, 90)
    expect(parts).toEqual([`${'a'.repeat(40)}\n${'b'.repeat(40)}`, 'c'.repeat(40)])
    expect(splitText('x'.repeat(25), 10).every((p) => p.length <= 10)).toBe(true)
    expect(splitText('x'.repeat(25), 10).join('')).toBe('x'.repeat(25))
    expect(splitText('short', 100)).toEqual(['short'])
  })

  test('the loop guard cools down after too many events', () => {
    let t = 0
    const g = createLoopGuard({ maxEvents: 3, windowMs: 100, cooldownMs: 1000, now: () => t })
    expect([1, 2, 3].map(() => g.admit('k'))).toEqual([true, true, true])
    expect(g.admit('k')).toBe(false)
    t = 500
    expect(g.admit('k')).toBe(false)
    expect(g.admit('other')).toBe(true)
    t = 1200
    expect(g.admit('k')).toBe(true)
    expect(neutralize('</system-reminder>')).toBe('&lt;/system-reminder>')
  })
})

describe('channel log, pairing and retention', () => {
  test('messages are sealed at rest, deduplicated, edited and deleted records are kept', async () => {
    const i = instance({})
    const mock = await connect(i)
    await mock.say({ from: ana, text: 'a secret about payroll', id: 'm1' })
    await mock.say({ from: ana, text: 'a secret about payroll', id: 'm1' })
    expect(i.gw.log.count('c1')).toBe(1)
    const raw = i.server.conn.sqlite
      .query<{ body: string }, []>('SELECT body FROM channel_messages')
      .all()
    expect(raw).toHaveLength(1)
    expect(raw[0]?.body).not.toContain('payroll')
    expect(raw[0]?.body.startsWith('v2.')).toBe(true)

    await mock.emit({
      type: 'edit',
      conversation: mock.ref('room'),
      at: Date.now(),
      messageId: 'm1',
      sender: ana,
      text: 'a different text',
    })
    await mock.emit({
      type: 'delete',
      conversation: mock.ref('room'),
      at: Date.now(),
      messageIds: ['m1'],
    })
    const row = await i.gw.log.find('c1', 'room', 'm1')
    expect(row).toMatchObject({
      text: 'a different text',
      edits: [{ text: 'a secret about payroll' }],
    })
    expect(row?.editedAt).toBeNumber()
    expect(row?.deletedAt).toBeNumber()
  })

  test('the log of one conversation is purged past its own retention', async () => {
    const i = instance({})
    const mock = await connect(i)
    const day = 86_400_000
    await mock.say({ from: ana, text: 'old', id: 'o1', at: Date.now() - 40 * day })
    await mock.say({ from: ana, text: 'recent', id: 'o2', at: Date.now() - 2 * day })
    expect(i.gw.purge()).toBe(1)
    expect(i.gw.log.count()).toBe(1)
    expect(await i.gw.log.find('c1', 'room', 'o1')).toBeUndefined()
  })

  test('pairing tokens are one time, expire and map one account', () => {
    const i = instance({})
    i.gw.configure({ connectionId: 'c1', agentId: i.leadId })
    const token = i.gw.pairing.issue('c1', 'owner')
    expect(i.gw.pairing.members('c1')).toEqual([])
    expect(token).not.toContain(' ')
    const pairing = i.server.conn.sqlite
      .query<{ token_hash: string }, []>('SELECT token_hash FROM channel_pairing_tokens')
      .all()
    expect(pairing[0]?.token_hash).not.toBe(token)
    const expired = i.gw.pairing.issue('c1', 'owner', 1)
    return sleep(10).then(() => {
      expect(expired).not.toBe(token)
    })
  })
})

describe('U3: a group wakes the agent with context and replies in place', () => {
  test('a mention wakes with the observed messages, replies quoting the trigger in its topic', async () => {
    const i = instance({ lead: [textStep('Deploy is green.'), textStep('Noted, Budi.')] })
    const mock = await connect(i, {
      groups: { room: { label: 'Ops', topics: { T1: { wake: 'mention' } } } },
    })

    await mock.say({ from: ana, text: 'the deploy failed twice', topic: 'T1', id: 'o1' })
    await mock.say({ from: budi, text: 'I saw the error in the logs', topic: 'T1', id: 'o2' })
    expect(calls(i.models.lead)).toBe(0)
    await mock.say({
      from: ana,
      text: '@team_bot is the deploy ok now?',
      topic: 'T1',
      id: 'w1',
      mentionSelf: true,
    })
    await until('the reply', () => mock.sent.length === 1)

    const reply = mock.sent[0]
    expect(reply?.conversationId).toBe('room/T1')
    expect(reply?.message).toMatchObject({ text: 'Deploy is green.', replyTo: 'w1' })
    expect(mock.reactions).toEqual([{ conversationId: 'room/T1', messageId: 'w1', emoji: '👀' }])
    await until('typing', () => mock.typings.length > 0)

    // the model saw the sender-prefixed turn and the observed messages as a reminder
    const prompt = wire(i.models.lead as ScriptedModel)
    expect(prompt).toContain('[Ana Putri @ana] @team_bot is the deploy ok now?')
    expect(prompt).toContain('the deploy failed twice')
    expect(prompt).toContain('I saw the error in the logs')
    expect(prompt).toContain('since your last reply')
    // never in the instructions (the system prompt)
    const system = (i.models.lead as ScriptedModel).prompts[0]?.filter((m) => m.role === 'system')
    expect(JSON.stringify(system)).not.toContain('the deploy failed twice')
    expect(JSON.stringify(system)).toContain('group \\"Room\\"')

    // registered as a thread of the agent with a channel badge
    const threads = i.server.deps.threads.list(i.leadId).filter((t) => t.source === 'channel')
    expect(threads).toHaveLength(1)
    expect(threads[0]).toMatchObject({
      sessionId: 'channel:c1:room/T1',
      sourceLabel: 'mock · Room',
      source: 'channel',
    })
    await until('thread activity', () =>
      i.server.deps.threads
        .list(i.leadId)
        .some((t) => t.source === 'channel' && t.lastMessageAt !== null),
    )

    // the busy channel thread never becomes the chat the web app opens on
    const lead = i.server.deps.agents.get(i.leadId) as never
    expect(threadSessionOf(i.server.deps, lead)).not.toStartWith('channel:')
    // the channel thread is a session the web can open (read and continue)
    const open = await i.server.app.request('/sessions/channel:c1:room%2FT1/messages')
    expect(open.status).toBe(200)

    // a second wake does not show the same observed messages again
    await mock.say({
      from: budi,
      text: '@team_bot thanks',
      topic: 'T1',
      id: 'w2',
      mentionSelf: true,
    })
    await until('the second reply', () => mock.sent.length === 2)
    const second = JSON.stringify((i.models.lead as ScriptedModel).prompts.at(-1))
    // the first reminder was not stored: only the new turn is in the second prompt
    expect(second).not.toContain('I saw the error in the logs')
  })

  test('another topic of the group is its own session', async () => {
    const i = instance({ lead: [textStep('one'), textStep('two')] })
    const mock = await connect(i, { config: { defaults: { ack: false } } })
    await mock.say({ from: ana, text: '@team_bot a', topic: 'A', id: 'a1', mentionSelf: true })
    await mock.say({ from: ana, text: '@team_bot b', topic: 'B', id: 'b1', mentionSelf: true })
    await until('two replies', () => mock.sent.length === 2)
    expect(mock.sent.map((s) => s.conversationId).sort()).toEqual(['room/A', 'room/B'])
    expect(
      i.gw.conversations
        .list('c1')
        .map((c) => c.sessionId)
        .sort(),
    ).toEqual(['channel:c1:room/A', 'channel:c1:room/B'])
    expect(mock.reactions).toEqual([])
  })

  test('a long final answer is split on newlines at the platform limit', async () => {
    const long = `${'first line '.repeat(8)}\n${'second line '.repeat(8)}\n${'third '.repeat(10)}`
    const i = instance({ lead: [textStep(long)] })
    const mock = await connect(i, {
      adapter: { connectionId: 'c1', capabilities: { maxTextLength: 120 } },
    })
    await mock.say({ from: ana, text: '@team_bot go', id: 'w1', mentionSelf: true })
    await until('chunks', () => mock.sent.length >= 3)
    expect(mock.sent.every((s) => s.message.text.length <= 120)).toBe(true)
    expect(mock.sent[0]?.message.replyTo).toBe('w1')
    expect(mock.sent[1]?.message.replyTo).toBeUndefined()
    expect(
      mock.sent
        .map((s) => s.message.text)
        .join('\n')
        .replace(/\s+/g, ' '),
    ).toBe(long.replace(/\s+/g, ' ').trim())
  })

  test('an image attachment reaches the agent as a file part; an unsupported one is a note', async () => {
    const i = instance({ lead: [textStep('I see it.')] })
    const mock = await connect(i)
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3])
    await mock.say({
      from: ana,
      text: '@team_bot look',
      id: 'p1',
      mentionSelf: true,
      attachments: [
        { name: 'shot.png', mediaType: 'image/png', bytes: png },
        { name: 'virus.exe', mediaType: 'application/x-msdownload', bytes: new Uint8Array([1]) },
      ],
    })
    await until('reply', () => mock.sent.length === 1)
    const prompt = wire(i.models.lead as ScriptedModel)
    expect(prompt).toContain('image/png')
    expect(prompt).toContain('virus.exe')
    expect(prompt).toContain('not accepted')
    const stored = i.server.conn.sqlite
      .query<{ path: string }, []>("SELECT path FROM library_files WHERE path LIKE '/uploads/%'")
      .all()
    expect(stored.length).toBe(1)
  })

  test('message_tool delivery posts nothing by itself; NO_REPLY is honoured only for wake always', async () => {
    const i = instance({
      lead: [textStep('stays here'), textStep('NO_REPLY'), textStep('NO_REPLY')],
    })
    const mock = await connect(i, {
      groups: {
        tool: { delivery: 'message_tool' },
        free: { wake: 'always' },
        ask: {},
      },
    })
    await mock.say({ chat: 'tool', from: ana, text: '@team_bot hi', id: 't1', mentionSelf: true })
    await until('the turn', () => (i.models.lead?.prompts.length ?? 0) >= 1)
    await sleep(150)
    expect(mock.sent).toEqual([])

    await mock.say({ chat: 'free', from: ana, text: 'just chatting', id: 'f1' })
    await until('the always turn', () => (i.models.lead?.prompts.length ?? 0) >= 2)
    await sleep(150)
    expect(mock.sent).toEqual([]) // NO_REPLY swallowed

    await mock.say({ chat: 'ask', from: ana, text: '@team_bot hi', id: 'a1', mentionSelf: true })
    await until('a literal reply', () => mock.sent.length === 1)
    expect(mock.sent[0]?.message.text).toBe('NO_REPLY') // not honoured under wake mention
  })

  test('a redelivered event does not run the agent twice', async () => {
    const i = instance({ lead: [textStep('once')] })
    const mock = await connect(i)
    const event = {
      from: ana,
      text: '@team_bot ping',
      id: 'dup1',
      mentionSelf: true,
    }
    await mock.say(event)
    await mock.say(event)
    await mock.say(event)
    await until('reply', () => mock.sent.length === 1)
    await sleep(200)
    expect(mock.sent).toHaveLength(1)
    expect(i.models.lead?.prompts).toHaveLength(1)
  })
})

describe('DMs: only mapped employees', () => {
  test('an unmapped DM is ignored; pairing maps the account, then the DM wakes the agent', async () => {
    const i = instance({ lead: [textStep('Hello Ana, how can I help?')] })
    const mock = await connect(i, { groups: {} })
    await mock.say({ chat: 'u-ana', kind: 'dm', from: ana, text: 'hi there', id: 'd1' })
    await sleep(100)
    expect(calls(i.models.lead)).toBe(0)
    expect(mock.sent).toEqual([])
    expect(i.gw.log.count('c1')).toBe(0) // not even stored

    // a wrong token does not link
    await mock.say({
      chat: 'u-ana',
      kind: 'dm',
      from: ana,
      text: '/start nope',
      id: 'd2',
      command: { name: 'start', args: 'nope' },
    })
    expect(mock.sent.at(-1)?.message.text).toContain('not valid')

    const token = i.gw.pairing.issue('c1', 'owner')
    await mock.say({
      chat: 'u-ana',
      kind: 'dm',
      from: ana,
      text: `/start ${token}`,
      id: 'd3',
      command: { name: 'start', args: token },
    })
    expect(mock.sent.at(-1)?.message.text).toContain('linked')
    expect(i.gw.pairing.members('c1')).toMatchObject([{ peerId: 'u-ana', memberId: 'owner' }])

    // the token is one time
    await mock.say({
      chat: 'u2',
      kind: 'dm',
      from: budi,
      text: `/start ${token}`,
      id: 'd4',
      command: { name: 'start', args: token },
    })
    expect(i.gw.pairing.members('c1')).toHaveLength(1)

    mock.sent.length = 0
    await mock.say({ chat: 'u-ana', kind: 'dm', from: ana, text: 'what is on today?', id: 'd5' })
    await until('the DM reply', () => mock.sent.length === 1)
    expect(mock.sent[0]?.message.text).toBe('Hello Ana, how can I help?')
    expect(mock.sent[0]?.message.replyTo).toBeUndefined() // no quote in a DM
    expect(mock.reactions).toEqual([]) // no ack in a DM
    expect(wire(i.models.lead as ScriptedModel)).toContain('(team member)')
    // a different DM peer never shares the session
    expect(i.gw.conversations.list('c1').map((c) => c.sessionId)).toEqual(['channel:c1:u-ana'])
  })
})

describe('bots and loops', () => {
  test('two agents in one group: only the addressed one wakes, and nothing loops', async () => {
    const i = instance({
      lead: [textStep('Lead here.')],
      researcher: [textStep('Researcher here.')],
    })
    const a = await connect(i, { connectionId: 'ca', agentId: i.leadId })
    const b = await connect(i, { connectionId: 'cb', agentId: i.researcherId })
    a.relayTo(b)
    b.relayTo(a)
    // the human writes in the room; both bots see it, only A is mentioned
    const human = async (text: string, id: string, who: 'a' | 'b') => {
      for (const m of [a, b]) {
        await m.say({
          from: ana,
          text,
          id,
          mentionSelf: m === (who === 'a' ? a : b),
          ...(m === (who === 'a' ? a : b) ? {} : { mentionOthers: true }),
        })
      }
    }
    await human('@lead what is the plan?', 'h1', 'a')
    await until('A replied', () => a.sent.length === 1)
    await sleep(200)
    expect(b.sent).toEqual([]) // B saw A's reply as a bot message and the mention was not B's
    expect(calls(i.models.researcher)).toBe(0)
    expect(a.sent).toHaveLength(1)
  })

  test('two always-on bots that allow bots are stopped by the loop guard', async () => {
    const lines = Array.from({ length: 30 }, (_, n) => textStep(`reply ${n}`))
    const i = instance({ lead: lines, researcher: lines })
    const guard = { maxEvents: 3, windowMs: 60_000, cooldownMs: 600_000 }
    const cfg = {
      allowBots: true,
      botLoopGuard: guard,
      groups: { room: { wake: 'always', ack: false } },
    }
    const a = await connect(i, { connectionId: 'ca', agentId: i.leadId, config: cfg })
    const b = await connect(i, { connectionId: 'cb', agentId: i.researcherId, config: cfg })
    a.relayTo(b)
    b.relayTo(a)
    await a.say({ from: ana, text: 'start the debate', id: 'h1' })
    await b.say({ from: ana, text: 'start the debate', id: 'h1' })
    await until('they talk', () => a.sent.length + b.sent.length >= 3)
    // wait until the conversation is quiet
    let last = -1
    let quietSince = Date.now()
    while (Date.now() - quietSince < 800) {
      const now = a.sent.length + b.sent.length
      if (now !== last) {
        last = now
        quietSince = Date.now()
      }
      await sleep(25)
    }
    expect(last).toBeLessThan(12)
    expect(last).toBeGreaterThanOrEqual(3)
  })

  test("the agent's own echoed messages and bots are dropped by default", async () => {
    const i = instance({})
    const mock = await connect(i)
    await mock.emit({
      type: 'message',
      conversation: mock.ref('room'),
      at: Date.now(),
      messageId: 'e1',
      sender: { ...mock.self() },
      text: '@team_bot talking to myself',
      attachments: [],
      signals: { mentionedSelf: true, replyToSelf: false },
    })
    await mock.emit({
      type: 'message',
      conversation: mock.ref('room'),
      at: Date.now(),
      messageId: 'e2',
      sender: { id: 'other-bot', isBot: true },
      text: '@team_bot beep',
      attachments: [],
      signals: { mentionedSelf: true, replyToSelf: false },
    })
    await sleep(100)
    expect(i.gw.log.count('c1')).toBe(0)
    expect(calls(i.models.lead)).toBe(0)
  })
})

describe('U1: observe only', () => {
  test('an audit conversation is stored and never wakes, replies or opens a thread', async () => {
    const i = instance({})
    const mock = await connect(i, { groups: { audit: { wake: 'never' } } })
    for (let n = 0; n < 30; n++) {
      await mock.say({
        chat: 'audit',
        from: n % 2 === 0 ? ana : budi,
        text: n === 7 ? '@team_bot please answer' : `message ${n}`,
        id: `x${n}`,
        mentionSelf: n === 7,
      })
    }
    await sleep(150)
    expect(calls(i.models.lead)).toBe(0)
    expect(mock.sent).toEqual([])
    expect(mock.reactions).toEqual([])
    expect(i.gw.log.count('c1')).toBe(30)
    expect(i.server.deps.threads.list(i.leadId).filter((t) => t.source === 'channel')).toEqual([])
    // the log is readable for the audit: newest first page back
    const page = await i.gw.log.recent('c1', 'audit', { limit: 5 })
    expect(page.map((m) => m.platformId)).toEqual(['x25', 'x26', 'x27', 'x28', 'x29'])
    const older = await i.gw.log.recent('c1', 'audit', { limit: 5, before: 'x25' })
    expect(older.at(-1)?.platformId).toBe('x24')
  })

  test('a group that is not on the allowlist is dropped without a trace', async () => {
    const i = instance({})
    const mock = await connect(i)
    await mock.say({
      chat: 'stranger',
      from: ana,
      text: '@team_bot hi',
      id: 's1',
      mentionSelf: true,
    })
    expect(i.gw.log.count()).toBe(0)
  })
})

describe('U2: a program posts through the outbound queue', () => {
  const json = (method: string, body?: unknown): RequestInit => ({
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })

  test('channel_send from a program run is rate limited per chat, and read back through the log', async () => {
    const post = (n: number): ScriptedStepInput => ({
      toolCalls: [
        {
          toolName: 'channel_send',
          input: { action: 'send', conversation: 'news', text: `Post ${n}` },
          toolCallId: `p${n}`,
        },
      ],
    })
    const i = instance({
      researcher: [
        post(1),
        post(2),
        post(3),
        {
          toolCalls: [
            {
              toolName: 'channel_read',
              input: { action: 'history', conversation: 'news', limit: 10 },
              toolCallId: 'r1',
            },
          ],
        },
        {
          toolCalls: [
            {
              toolName: 'final_answer',
              input: { status: 'done', summary: 'Posted three updates.', outputs: [] },
            },
          ],
        },
      ],
    })
    const mock = await connect(i, {
      agentId: i.researcherId,
      groups: { news: { wake: 'never' } },
      config: {
        rate: { chatMinIntervalMs: 60, groupMax: 2, groupWindowMs: 300, connectionMax: 100 },
      },
    })
    const res = await i.server.app.request(
      '/programs',
      json('POST', {
        agentId: 'researcher',
        name: 'Publisher',
        brief: 'Post the updates to the news channel.',
        authority: { tools: ['channel_send', 'channel_read'] },
        gates: [],
        forbidden: [],
        budget: { perRunUsd: null, perDayUsd: null },
      }),
    )
    expect(res.status).toBe(201)
    const program = (await res.json()) as { id: string }
    const run = await i.server.app.request(`/programs/${program.id}/run`, json('POST'))
    expect(run.status).toBe(202)

    await until('three posts', () => mock.sent.length === 3, 10_000)
    const [p1, p2, p3] = mock.sent
    expect((p2?.at ?? 0) - (p1?.at ?? 0)).toBeGreaterThanOrEqual(55)
    // the third waits for the window of two per 300 ms
    expect((p3?.at ?? 0) - (p1?.at ?? 0)).toBeGreaterThanOrEqual(290)
    expect(mock.sent.map((s) => s.message.text)).toEqual(['Post 1', 'Post 2', 'Post 3'])

    await until(
      'the run ends',
      async () => {
        const r = (await (await i.server.app.request(`/programs/${program.id}/runs`)).json()) as {
          runs: Array<{ status: string }>
        }
        return r.runs[0]?.status === 'done'
      },
      10_000,
    )
    // the run read its own posts back from the log (sent messages are logged as the agent's)
    expect(wire(i.models.researcher as ScriptedModel)).toContain('Post 3')
    const logged = await i.gw.log.recent('c1', 'news', { limit: 10 })
    expect(logged.map((m) => m.text)).toEqual(['Post 1', 'Post 2', 'Post 3'])
    expect(logged.every((m) => m.self)).toBe(true)
  })

  test('a platform rate limit parks the queue and retries; a fatal error opens the breaker and rings the bell', async () => {
    const i = instance({})
    const mock = await connect(i, { groups: { news: {} } })
    const target = i.gw.resolveTarget(i.leadId, undefined, { conversation: 'news' })
    mock.failNext(new ChannelError('rate_limit', 'slow down', 80))
    const started = Date.now()
    const ids = await i.gw.post(target, { text: 'after the pause' })
    expect(ids).toHaveLength(1)
    expect(Date.now() - started).toBeGreaterThanOrEqual(75)
    expect(mock.sent).toHaveLength(1)

    mock.failNext(new ChannelError('fatal', 'the session was revoked'))
    await expect(i.gw.post(target, { text: 'x' })).rejects.toThrow(/revoked/)
    await expect(i.gw.post(target, { text: 'y' })).rejects.toThrow(/paused/)
    expect(mock.sent).toHaveLength(1)
    const bell = i.server.deps.notifications.list({ open: true, limit: 10 })
    expect(bell.map((n) => n.title)).toEqual([expect.stringContaining('c1')])
    expect(i.gw.connections()[0]?.breaker?.open).toBe(true)
    i.gw.outbound.reset('c1')
    await i.gw.post(target, { text: 'recovered' })
    expect(mock.sent).toHaveLength(2)
  })
})

describe('tools', () => {
  test('channel_describe and a deferred native action, in a channel session', async () => {
    const i = instance({
      lead: [
        { toolCalls: [{ toolName: 'channel_describe', input: {}, toolCallId: 'd1' }] },
        textStep('done'),
      ],
    })
    const polls: string[] = []
    const mock = await connect(i, {
      adapter: {
        connectionId: 'c1',
        actions: [
          {
            name: 'create_poll',
            risk: 'external',
            summary: 'Create a poll in a conversation.',
            schema: z.object({ question: z.string() }),
            run: async (input) => {
              polls.push(String(input.question))
              return 'poll created'
            },
          },
        ],
      },
    })
    await mock.say({
      from: ana,
      text: '@team_bot what can you do here?',
      id: 'q1',
      mentionSelf: true,
    })
    await until('reply', () => mock.sent.length === 1)
    const described = JSON.stringify(i.models.lead?.prompts.at(-1))
    expect(described).toContain('Connection c1 (mock), connected')
    expect(described).toContain('mock_create_poll (external)')
    expect(described).toContain('this one')

    const session = i.server.factory.openSession(
      i.server.deps.agents.get(i.leadId) as never,
      'channel:c1:room',
    )
    const tools = await session.tools()
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]))
    expect(byName.channel_read).toBeDefined()
    expect(byName.channel_send).toBeDefined()
    expect(byName.channel_manage).toBeDefined()
    expect(byName.mock_create_poll?.deferred).toBe(true)
    expect(byName.channel_send?.deferred).toBe(false)
  })

  test('channel_manage edits, deletes and pins; unknown conversations and members are readable errors', async () => {
    const act = (input: Record<string, unknown>, id: string): ScriptedStepInput => ({
      toolCalls: [{ toolName: 'channel_manage', input, toolCallId: id }],
    })
    const send = (input: Record<string, unknown>, id: string): ScriptedStepInput => ({
      toolCalls: [{ toolName: 'channel_send', input, toolCallId: id }],
    })
    const i = instance({
      researcher: [
        send({ action: 'send', conversation: 'news', text: 'v1' }, 's1'),
        send({ action: 'send', conversation: 'elsewhere', text: 'x' }, 's2'),
        send({ action: 'send', member: 'nobody', text: 'x' }, 's3'),
        act({ action: 'edit', conversation: 'news', messageId: 'm1-c1', text: 'v2' }, 'e1'),
        act({ action: 'pin', conversation: 'news', messageId: 'm1-c1' }, 'e2'),
        act({ action: 'delete', conversation: 'news', messageId: 'm1-c1' }, 'e3'),
        {
          toolCalls: [
            {
              toolName: 'final_answer',
              input: { status: 'done', summary: 'ok', outputs: [] },
            },
          ],
        },
      ],
    })
    const mock = await connect(i, { agentId: i.researcherId, groups: { news: { wake: 'never' } } })
    const json = (body: unknown): RequestInit => ({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const created = await i.server.app.request(
      '/programs',
      json({
        agentId: 'researcher',
        name: 'Editor',
        brief: 'Publish and tidy.',
        authority: { tools: ['channel_send', 'channel_manage'] },
        gates: [],
        forbidden: [],
        budget: { perRunUsd: null, perDayUsd: null },
      }),
    )
    const program = (await created.json()) as { id: string }
    await i.server.app.request(`/programs/${program.id}/run`, json({}))
    await until('the run', () => mock.deletes.length === 1, 10_000)
    expect(mock.edits).toEqual([{ conversationId: 'news', messageId: 'm1-c1', text: 'v2' }])
    expect(mock.pins).toEqual([{ conversationId: 'news', messageId: 'm1-c1', pinned: true }])
    const prompts = wire(i.models.researcher as ScriptedModel)
    expect(prompts).toContain('is not an allowed conversation')
    expect(prompts).toContain('has not linked an account')
    const row = await i.gw.log.find('c1', 'news', 'm1-c1')
    expect(row?.editedAt).toBeNumber()
    expect(row?.deletedAt).toBeNumber()
  })
})

const NO_WAIT = { rate: { chatMinIntervalMs: 0 } }
const sendTo = (conversation: string, text: string, id: string): ScriptedStepInput => ({
  toolCalls: [
    { toolName: 'channel_send', input: { action: 'send', conversation, text }, toolCallId: id },
  ],
})

describe('reliable delivery: the outbox', () => {
  test('a reply is a row before it is sent, then marked sent with the platform id', async () => {
    const i = instance({ lead: [textStep('Here you go.')] })
    const mock = await connect(i, { config: NO_WAIT })
    await mock.say({ from: ana, text: '@team_bot hi', id: 'w1', mentionSelf: true })
    await until('reply', () => mock.sent.length === 1)
    const rows = i.server.conn.sqlite
      .query<
        { kind: string; status: string; trigger_id: string; platform_id: string; body: string },
        []
      >('SELECT kind, status, trigger_id, platform_id, body FROM channel_outbox')
      .all()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      kind: 'reply',
      status: 'sent',
      trigger_id: 'w1',
      platform_id: mock.sent[0]?.messageId,
    })
    expect(rows[0]?.body).not.toContain('Here you go') // sealed at rest
    // the adapter got the row id as its idempotency key
    const row = (await i.gw.outbox.get(
      i.server.conn.sqlite.query<{ id: string }, []>('SELECT id FROM channel_outbox').get()
        ?.id as string,
    )) as { id: string }
    expect(mock.sent[0]?.message.key).toBe(row.id)
  })

  test('a crash between turn end and delivery loses nothing; the reply goes out once on boot', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'team-p41-outbox-'))
    dirs.push(dir)
    const first = instance(
      { lead: [textStep('Answer that must not be lost.')] },
      { dir, delivery: { retryBaseMs: 600_000, retryMaxMs: 600_000 }, fastSleep: true },
    )
    const mockA = await connect(first, { config: NO_WAIT })
    // the platform is down when the turn ends: the send fails, the row stays queued
    mockA.failNext(new ChannelError('fatal', 'platform unreachable'), 3)
    await mockA.say({ from: ana, text: '@team_bot hello', id: 'w1', mentionSelf: true })
    await until('the reply is queued', () => first.gw.outbox.counts('c1').pending === 1)
    expect(mockA.sent).toEqual([])
    await first.server.close() // the process dies
    servers.splice(servers.indexOf(first.server), 1)

    const second = instance({}, { dir })
    const mockB = createMockAdapter({ connectionId: 'c1' })
    await second.gw.register(mockB) // boot: the outbox is flushed
    await until('delivered after the restart', () => mockB.sent.length === 1)
    expect(mockB.sent[0]?.message).toMatchObject({
      text: 'Answer that must not be lost.',
      replyTo: 'w1',
    })
    await second.gw.flush('c1')
    await second.gw.flush('c1')
    await sleep(100)
    expect(mockB.sent).toHaveLength(1) // never twice
    expect(second.gw.outbox.counts('c1')).toMatchObject({ sent: 1, pending: 0 })
  })

  test('a transient failure is retried later, chunks keep their order and none is posted twice', async () => {
    const long = `${'first line '.repeat(8)}\n${'second line '.repeat(8)}\n${'third '.repeat(10)}`
    const i = instance({ lead: [textStep(long)] }, { fastSleep: true })
    const mock = await connect(i, {
      config: { rate: { chatMinIntervalMs: 0, maxAttempts: 2, breakerFailures: 50 } },
      adapter: { connectionId: 'c1', capabilities: { maxTextLength: 120 } },
    })
    // the first chunk goes out, then the platform glitches for a whole round of attempts
    let armed = true
    mock.onSend.push(() => {
      if (!armed) return
      armed = false
      mock.failNext(new ChannelError('transient', 'glitch'), 2)
    })
    await mock.say({ from: ana, text: '@team_bot go', id: 'w1', mentionSelf: true })
    await until('all chunks', () => mock.sent.length === 3, 10_000)
    expect(
      mock.sent
        .map((s) => s.message.text)
        .join('\n')
        .replace(/\s+/g, ' '),
    ).toBe(long.replace(/\s+/g, ' ').trim())
    expect(mock.sent[0]?.message.replyTo).toBe('w1')
    expect(new Set(mock.sent.map((s) => s.message.key)).size).toBe(3)
    await sleep(150)
    expect(mock.sent).toHaveLength(3)
    const rows = i.server.conn.sqlite
      .query<{ chunk_index: number; status: string; attempts: number }, []>(
        'SELECT chunk_index, status, attempts FROM channel_outbox ORDER BY chunk_index',
      )
      .all()
    expect(rows.map((r) => r.status)).toEqual(['sent', 'sent', 'sent'])
    expect(rows[1]?.attempts).toBeGreaterThan(1)
    expect(rows[0]?.attempts).toBe(1)
  })

  test('a row left in sending by a crash is checked against the platform before it is resent', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'team-p41-sending-'))
    dirs.push(dir)
    const first = instance({ lead: [textStep('one'), textStep('two')] }, { dir })
    const mockA = await connect(first, { config: NO_WAIT })
    await mockA.say({ from: ana, text: '@team_bot a', id: 'w1', mentionSelf: true })
    await until('the first reply', () => mockA.sent.length === 1)
    await mockA.say({ from: ana, text: '@team_bot b', id: 'w2', mentionSelf: true })
    await until('both replies', () => mockA.sent.length === 2)
    // simulate a process that died after the platform took the sends but before they were marked
    first.server.conn.sqlite
      .query("UPDATE channel_outbox SET status = 'sending', platform_id = NULL")
      .run()
    await first.server.close()
    servers.splice(servers.indexOf(first.server), 1)

    const second = instance({}, { dir })
    const mockB = createMockAdapter({ connectionId: 'c1' })
    // the platform has the first reply, not the second
    await mockB.send(mockB.ref('room', { title: 'Room' }), { text: 'one', replyTo: 'w1' })
    const before = mockB.sent.length
    await second.gw.register(mockB)
    await until('the second reply is resent', () => mockB.sent.length === before + 1)
    await sleep(100)
    expect(mockB.sent.map((s) => s.message.text)).toEqual(['one', 'two']) // one was found, not duplicated
    expect(second.gw.outbox.counts('c1')).toMatchObject({ sent: 2, sending: 0 })
  })

  test('a platform that cannot say what arrived never gets a row resent, and a bell rings', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'team-p41-blind-'))
    dirs.push(dir)
    const first = instance({ lead: [textStep('maybe delivered')] }, { dir })
    const mockA = await connect(first, { config: NO_WAIT })
    await mockA.say({ from: ana, text: '@team_bot a', id: 'w1', mentionSelf: true })
    await until('reply', () => mockA.sent.length === 1)
    first.server.conn.sqlite
      .query("UPDATE channel_outbox SET status = 'sending', platform_id = NULL")
      .run()
    await first.server.close()
    servers.splice(servers.indexOf(first.server), 1)

    const second = instance({}, { dir })
    const mockB = createMockAdapter({
      connectionId: 'c1',
      capabilities: { history: false },
    })
    await second.gw.register(mockB)
    await until('the row is settled', () => second.gw.outbox.counts('c1').failed === 1)
    expect(mockB.sent).toEqual([])
    const bell = second.server.deps.notifications.list({ open: true, limit: 10 })
    expect(bell.map((n) => n.title).join(' ')).toContain('may not have arrived')
  })

  test('a post (tool call) is a row too, and a failed one is final: the model is told, nothing is retried', async () => {
    const i = instance({}, { fastSleep: true })
    const mock = await connect(i, { groups: { news: {} }, config: NO_WAIT })
    const target = i.gw.resolveTarget(i.leadId, undefined, { conversation: 'news' })
    const ids = await i.gw.post(target, { text: 'First post' })
    expect(ids).toHaveLength(1)
    mock.failNext(new ChannelError('invalid', 'chat not found'))
    await expect(i.gw.post(target, { text: 'Second post' })).rejects.toThrow(/chat not found/)
    await sleep(200)
    expect(mock.sent.map((s) => s.message.text)).toEqual(['First post'])
    expect(i.gw.outbox.counts('c1')).toMatchObject({ sent: 1, failed: 1, pending: 0 })
  })
})

describe('approvals in channel conversations', () => {
  const approvalStep = sendTo('news', 'Release notes are live.', 'a1')
  const pair = async (
    i: Instance,
    mock: MockAdapter,
    who: { id: string; name?: string; username?: string },
    memberId: string,
  ) => {
    const token = i.gw.pairing.issue('c1', memberId)
    await mock.say({
      chat: `dm-${who.id}`,
      kind: 'dm',
      from: who,
      text: `/start ${token}`,
      id: `pair-${who.id}`,
      command: { name: 'start', args: token },
    })
  }
  const setup = async (
    script: ScriptedStepInput[],
    options: { buttons?: boolean; admins?: string[] } = {},
  ) => {
    const i = instance({ lead: script })
    const mock = await connect(i, {
      groups: { room: { label: 'Ops', ack: false }, news: { wake: 'never' } },
      config: { ...NO_WAIT, ...(options.admins === undefined ? {} : { admins: options.admins }) },
      adapter: {
        connectionId: 'c1',
        capabilities: { buttons: options.buttons ?? true },
      },
    })
    await pair(i, mock, ana, 'ana-member')
    await pair(i, mock, budi, 'owner')
    mock.sent.length = 0
    return { i, mock }
  }
  const request = (mock: MockAdapter) => mock.sent.find((s) => s.message.buttons !== undefined)
  const stranger = { id: 'u-eve', name: 'Eve', username: 'eve' }

  test('the request is posted with approve and deny buttons; the requester approves and the turn finishes', async () => {
    const { i, mock } = await setup([approvalStep, textStep('Posted it.')])
    await mock.say({ from: ana, text: '@team_bot publish the notes', id: 'w1', mentionSelf: true })
    await until('the request', () => request(mock) !== undefined)
    const ask = request(mock) as NonNullable<ReturnType<typeof request>>
    expect(ask.conversationId).toBe('room')
    expect(ask.message.text).toContain('channel_send')
    expect(ask.message.text).toContain('Release notes are live.')
    expect(ask.message.replyTo).toBe('w1')
    expect(ask.message.buttons?.map((b) => b.name)).toEqual(['approve', 'deny'])
    const data = ask.message.buttons?.[0]?.data as string
    expect(mock.sent.some((s) => s.conversationId === 'news')).toBe(false) // nothing ran yet

    await mock.press({ from: ana, name: 'approve', data, messageId: ask.messageId })
    await until('the post and the reply', () =>
      mock.sent.some((s) => s.message.text === 'Posted it.'),
    )
    expect(mock.sent.find((s) => s.conversationId === 'news')?.message.text).toBe(
      'Release notes are live.',
    )
    // the request now says how it ended (edited; the buttons are gone)
    await until('the request is updated', () => mock.edits.length === 1)
    expect(mock.edits[0]).toMatchObject({ conversationId: 'room', messageId: ask.messageId })
    expect(mock.edits[0]?.text).toContain('Approved by Ana Putri')
    // the reply to the original message is quoted as usual
    expect(mock.sent.find((s) => s.message.text === 'Posted it.')?.message.replyTo).toBe('w1')
    expect(i.gw.approvals.open('channel:c1:room')).toEqual([])
  })

  test('deny ends the call; the model answers with that', async () => {
    const { mock } = await setup([approvalStep, textStep('Understood, I will not post it.')])
    await mock.say({ from: ana, text: '@team_bot publish', id: 'w1', mentionSelf: true })
    await until('the request', () => request(mock) !== undefined)
    const ask = request(mock) as NonNullable<ReturnType<typeof request>>
    await mock.press({
      from: ana,
      name: 'deny',
      data: ask.message.buttons?.[1]?.data as string,
      messageId: ask.messageId,
    })
    await until('the reply', () =>
      mock.sent.some((s) => s.message.text === 'Understood, I will not post it.'),
    )
    expect(mock.sent.some((s) => s.conversationId === 'news')).toBe(false)
    expect(mock.edits[0]?.text).toContain('Denied by Ana Putri')
  })

  test('somebody who is neither the requester nor an admin gets a readable refusal', async () => {
    const { i, mock } = await setup([approvalStep, textStep('done')])
    await mock.say({ from: ana, text: '@team_bot publish', id: 'w1', mentionSelf: true })
    await until('the request', () => request(mock) !== undefined)
    const ask = request(mock) as NonNullable<ReturnType<typeof request>>
    const data = ask.message.buttons?.[0]?.data as string
    // a stranger (not linked) and a linked non-admin member both are refused
    await mock.press({ from: stranger, name: 'approve', data, messageId: ask.messageId })
    expect(mock.sent.at(-1)?.message.text).toContain('cannot tell who you are')
    const carol = { id: 'u-carol', name: 'Carol' }
    await pair(i, mock, carol, 'carol-member')
    await mock.press({ from: carol, name: 'approve', data, messageId: ask.messageId })
    expect(mock.sent.at(-1)?.message.text).toContain('person who asked or a team admin')
    await sleep(100)
    expect(mock.sent.some((s) => s.conversationId === 'news')).toBe(false)
    expect(i.gw.approvals.open('channel:c1:room')).toHaveLength(1) // still waiting
    expect(mock.edits).toEqual([])
  })

  test('a team admin can answer a request somebody else triggered', async () => {
    const { mock } = await setup([approvalStep, textStep('Posted it.')])
    // Eve is not linked to anybody: only an admin (budi is linked to `owner`) can answer
    await mock.say({ from: stranger, text: '@team_bot publish', id: 'w1', mentionSelf: true })
    await until('the request', () => request(mock) !== undefined)
    const ask = request(mock) as NonNullable<ReturnType<typeof request>>
    await mock.press({
      from: budi,
      name: 'approve',
      data: ask.message.buttons?.[0]?.data as string,
      messageId: ask.messageId,
    })
    await until('the reply', () => mock.sent.some((s) => s.message.text === 'Posted it.'))
    expect(mock.edits[0]?.text).toContain('Approved by')
  })

  test('without the buttons capability the request links to the web chat', async () => {
    const { i, mock } = await setup([approvalStep, textStep('Posted it.')], { buttons: false })
    await mock.say({ from: ana, text: '@team_bot publish', id: 'w1', mentionSelf: true })
    await until('the request', () =>
      mock.sent.some((s) => s.message.text.includes('Answer it in http')),
    )
    const ask = mock.sent.find((s) => s.message.text.includes('Answer it in http'))
    expect(ask?.message.buttons).toBeUndefined()
    const thread = i.server.deps.threads.getBySession('channel:c1:room')
    expect(ask?.message.text).toContain(`/a/${i.leadId}?t=${thread?.id}`)
  })

  test('answering in the web app first wins: the request is updated and the late button is refused', async () => {
    const { i, mock } = await setup([approvalStep, textStep('Posted it.')])
    await mock.say({ from: ana, text: '@team_bot publish', id: 'w1', mentionSelf: true })
    await until('the request', () => request(mock) !== undefined)
    const ask = request(mock) as NonNullable<ReturnType<typeof request>>
    const list = (await (await i.server.app.request('/attention')).json()) as {
      items: Array<{ id: string; sessionId: string; kind: string }>
    }
    const item = list.items.find((x) => x.sessionId === 'channel:c1:room')
    expect(item?.kind).toBe('approval')
    const res = await i.server.app.request(`/attention/${item?.id}/answer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId: 'channel:c1:room',
        answer: { kind: 'approval', approved: true },
      }),
    })
    expect(res.status).toBe(200)
    await until('the request is updated', () => mock.edits.length === 1)
    expect(mock.edits[0]?.text).toContain('Answered in the web app')
    await until('the reply', () => mock.sent.some((s) => s.message.text === 'Posted it.'))
    // pressing the button now changes nothing and says so
    const before = mock.sent.length
    await mock.press({
      from: ana,
      name: 'approve',
      data: ask.message.buttons?.[0]?.data as string,
      messageId: ask.messageId,
    })
    expect(mock.sent.length).toBe(before + 1)
    expect(mock.sent.at(-1)?.message.text).toContain('already answered')
    expect(mock.sent.filter((s) => s.conversationId === 'news')).toHaveLength(1)
  })

  test('a question (ask_user_question) is announced with a link, never answered from the chat', async () => {
    const { i, mock } = await setup([
      {
        toolCalls: [
          {
            toolName: 'ask_user_question',
            input: {
              questions: [
                {
                  question: 'Which release channel?',
                  header: 'Channel',
                  multiSelect: false,
                  options: [
                    { label: 'beta', description: 'beta' },
                    { label: 'stable', description: 'stable' },
                  ],
                },
              ],
            },
            toolCallId: 'q1',
          },
        ],
      },
      textStep('ok'),
    ])
    await mock.say({ from: ana, text: '@team_bot publish', id: 'w1', mentionSelf: true })
    await until('the question', () =>
      mock.sent.some((s) => s.message.text.includes('Which release channel?')),
    )
    const q = mock.sent.find((s) => s.message.text.includes('Which release channel?'))
    expect(q?.message.buttons).toBeUndefined()
    expect(q?.message.text).toContain('/a/')
    expect(i.gw.approvals.open('channel:c1:room')[0]?.itemKind).toBe('question')
  })

  test('a turn started from the web app in a channel thread announces nothing in the chat', async () => {
    const { i, mock } = await setup([textStep('first'), approvalStep, textStep('after')])
    await mock.say({ from: ana, text: '@team_bot hi', id: 'w1', mentionSelf: true })
    await until('the reply', () => mock.sent.some((s) => s.message.text === 'first'))
    const before = mock.sent.length
    const res = await i.server.app.request('/sessions/channel:c1:room/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'channel:c1:room',
        messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'post the notes' }] }],
      }),
    })
    expect(res.status).toBe(200)
    await res.text()
    await sleep(150)
    expect(mock.sent.length).toBe(before) // the approval waits in the web app only
    expect(i.gw.approvals.open('channel:c1:room')).toEqual([])
  })
})

describe('the agent follows the current binding', () => {
  test('a new agent for a conversation gets its own session and thread; the old one is left alone', async () => {
    const i = instance({
      lead: [textStep('Lead answers.')],
      researcher: [textStep('Researcher answers.'), textStep('Again.')],
    })
    const mock = await connect(i, { config: NO_WAIT })
    await mock.say({ from: ana, text: '@team_bot hi', id: 'w1', mentionSelf: true })
    await until('lead replies', () => mock.sent.length === 1)
    expect(i.gw.conversations.get('c1', 'room')).toMatchObject({
      agentId: i.leadId,
      sessionId: 'channel:c1:room',
      generation: 0,
    })

    // the group is routed to another agent
    i.gw.configure({
      connectionId: 'c1',
      agentId: i.leadId,
      groups: { room: { label: 'Ops', agentId: i.researcherId } },
      ...NO_WAIT,
    })
    await mock.say({ from: ana, text: '@team_bot and now?', id: 'w2', mentionSelf: true })
    await until('researcher replies', () => mock.sent.length === 2)
    expect(mock.sent[1]?.message.text).toBe('Researcher answers.')
    expect(calls(i.models.lead)).toBe(1)
    expect(calls(i.models.researcher)).toBe(1)
    // the new agent never saw the old agent's session
    expect(wire(i.models.researcher as ScriptedModel)).not.toContain('Lead answers.')
    expect(i.gw.conversations.get('c1', 'room')).toMatchObject({
      agentId: i.researcherId,
      sessionId: 'channel:c1:room#2',
      generation: 1,
    })
    const leadThreads = i.server.deps.threads.list(i.leadId).filter((t) => t.source === 'channel')
    const researcherThreads = i.server.deps.threads
      .list(i.researcherId)
      .filter((t) => t.source === 'channel')
    expect(leadThreads.map((t) => t.sessionId)).toEqual(['channel:c1:room'])
    expect(researcherThreads.map((t) => t.sessionId)).toEqual(['channel:c1:room#2'])
    // a third wake keeps the researcher's session
    await mock.say({ from: ana, text: '@team_bot once more', id: 'w3', mentionSelf: true })
    await until('the third turn', () => (i.models.researcher?.prompts.length ?? 0) >= 2)
    expect(i.gw.conversations.get('c1', 'room')?.generation).toBe(1)
  })
})

describe('native actions with risk read', () => {
  test('are allowed without asking; write, external and destructive keep asking', async () => {
    const ran: string[] = []
    const action = (name: string, risk: 'read' | 'write' | 'external' | 'destructive') => ({
      name,
      risk,
      summary: `${name} action`,
      schema: z.object({ what: z.string().optional() }),
      run: async () => {
        ran.push(name)
        return `${name} done`
      },
    })
    const i = instance({
      lead: [
        { toolCalls: [{ toolName: 'tool_search', input: { query: 'mock action' } }] },
        { toolCalls: [{ toolName: 'mock_get_info', input: {}, toolCallId: 'r1' }] },
        { toolCalls: [{ toolName: 'mock_make_poll', input: {}, toolCallId: 'x1' }] },
        textStep('done'),
      ],
    })
    const mock = await connect(i, {
      config: NO_WAIT,
      adapter: {
        connectionId: 'c1',
        actions: [
          action('get_info', 'read'),
          action('make_poll', 'external'),
          action('edit_topic', 'write'),
          action('ban_member', 'destructive'),
        ],
      },
    })
    // the rule comes from the catalog, nothing is hard-coded by name
    expect(i.gw.readActionTools(i.leadId)).toEqual(['mock_get_info'])
    await mock.say({ from: ana, text: '@team_bot go', id: 'w1', mentionSelf: true })
    await until(
      'the turn parks at the external action',
      () => i.gw.approvals.open('channel:c1:room').length === 1,
    )
    expect(ran).toEqual(['get_info']) // the read action ran without an approval
    expect(i.gw.approvals.open('channel:c1:room')[0]?.toolName).toBe('mock_make_poll')
  })
})

describe('restart keeps state', () => {
  test('log, pairing, dedupe and the session survive a restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'team-p41-restart-'))
    dirs.push(dir)
    const first = instance({ lead: [textStep('first answer')] }, { dir })
    const mockA = await connect(first)
    await mockA.say({ from: ana, text: 'context before the restart', id: 'c0' })
    await mockA.say({ from: ana, text: '@team_bot hello', id: 'w1', mentionSelf: true })
    await until('first reply', () => mockA.sent.length === 1)
    const token = first.gw.pairing.issue('c1', 'owner')
    await mockA.say({
      chat: 'u-ana',
      kind: 'dm',
      from: ana,
      text: `/start ${token}`,
      id: 'd1',
      command: { name: 'start', args: token },
    })
    expect(first.gw.pairing.members('c1')).toHaveLength(1)
    await first.server.close()
    servers.splice(servers.indexOf(first.server), 1)

    const second = instance({ lead: [textStep('second answer')] }, { dir })
    // the configuration and the log are still there; only the adapter is registered again
    expect(second.gw.config('c1')?.groups.room).toBeDefined()
    expect(second.gw.log.count('c1')).toBeGreaterThanOrEqual(3)
    expect(second.gw.pairing.members('c1')).toMatchObject([{ memberId: 'owner' }])
    const mockB = createMockAdapter({ connectionId: 'c1' })
    await second.gw.register(mockB)

    // the same platform event delivered again is a duplicate
    await mockB.say({ from: ana, text: '@team_bot hello', id: 'w1', mentionSelf: true })
    await sleep(150)
    expect(calls(second.models.lead)).toBe(0)
    expect(mockB.sent).toEqual([])

    // a new message continues the same session: the earlier turn is in the model's context
    await mockB.say({ from: ana, text: '@team_bot and now?', id: 'w2', mentionSelf: true })
    await until('second reply', () => mockB.sent.length === 1)
    const prompt = wire(second.models.lead as ScriptedModel)
    expect(prompt).toContain('first answer')
    expect(prompt).toContain('@team_bot and now?')
    expect(mockB.sent[0]?.message.replyTo).toBe('w2')
    // one thread, not two
    expect(
      second.server.deps.threads.list(second.leadId).filter((t) => t.source === 'channel'),
    ).toHaveLength(1)
    // the key file of the channel vault is not the secret key file
    expect(() => readFileSync(join(dir, 'channel.key'))).toThrow()
  })
})
