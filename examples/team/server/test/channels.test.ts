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
import { traitsOf } from '../src/infra/channels/model.ts'
import type { ScopeNode, ScopePolicy } from '../src/infra/channels/policy.ts'
import {
  ConnectionConfigSchema,
  createLoopGuard,
  decideWake,
  matchesAlias,
  neutralize,
  resolveScope,
  splitText,
} from '../src/infra/channels/policy.ts'
import { channelSessionId } from '../src/infra/channels/sessions.ts'
import type { ChannelNode, InboundSignals } from '../src/infra/channels/types.ts'
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
    /** Model catalog (`inputModalities`) of the agents. */
    catalog?: ModelConfig['catalog']
    /** Where the web app lives (default: the loopback default, which never goes into a chat). */
    webUrl?: string
  } = {},
): Instance {
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), 'team-p41-'))
  if (options.dir === undefined) dirs.push(dir)
  const models: Record<string, ScriptedModel> = {}
  for (const [slug, steps] of Object.entries(script)) models[slug] = scriptedModel(steps)
  const config: ModelConfig = {
    provider: 'scripted',
    defaultModel: 'none',
    ...(options.catalog === undefined ? {} : { catalog: options.catalog }),
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
    ...(options.webUrl === undefined ? {} : { webUrl: options.webUrl }),
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

/** The groups of before L5 (`groups: { chat: { ...policy, topics: { t: {...} } } }`) as nodes with settings. */
function applyGroups(
  gw: ChannelGateway,
  connectionId: string,
  groups: Record<string, Record<string, unknown>>,
): void {
  for (const [native, raw] of Object.entries(groups)) {
    const { topics, ...policy } = raw as {
      topics?: Record<string, Record<string, unknown>>
    } & Record<string, unknown>
    const room = gw.settings.ensureNode(connectionId, { nativeId: native, kind: 'room' })
    gw.settings.set(room.id, { enabled: true, ...policy } as never)
    for (const [t, tp] of Object.entries(topics ?? {})) {
      const thread = gw.settings.ensureNode(
        connectionId,
        { nativeId: `${native}/${t}`, kind: 'thread', title: t },
        native,
      )
      gw.settings.set(thread.id, tp as never)
    }
  }
}

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
    // the tests of L1 to L5 are about delivery, wake and approvals: their people act as admins unless a test says otherwise
    people: { defaultRole: 'admin', policy: {} },
    ...options.config,
  })
  applyGroups(i.gw, connectionId, options.groups ?? { room: { label: 'Ops' } })
  const mock = createMockAdapter({ connectionId, ...options.adapter })
  await i.gw.register(mock)
  return mock
}

/** The node id of a chat (or `chat/topic`) of a connection, as the platform names it. */
const nid = (i: Instance, native: string, connectionId = 'c1'): string => {
  const node = i.gw.nodes.byNative(connectionId, native)
  if (node === undefined) throw new Error(`no node ${native} on ${connectionId}`)
  return node.id
}
/** The session of a chat (or `chat/topic`). */
const sid = (i: Instance, native: string, connectionId = 'c1'): string => {
  const row = i.gw.sessions.get(connectionId, nid(i, native, connectionId))
  if (row === undefined) throw new Error(`no session for ${native}`)
  return row.sessionId
}

const textStep = (text: string): ScriptedStepInput => ({ text })

/** A node as an adapter receives it to act on (for calling a mock directly). */
const chatNode = (native: string): ChannelNode => ({
  id: native,
  connectionId: 'c1',
  nativeId: native,
  kind: 'room',
  traits: traitsOf({ multiUser: true }),
  platformType: 'mock:group',
  title: 'Room',
  parentNativeId: undefined,
  meta: {},
})

describe('policy (pure)', () => {
  const cfg = ConnectionConfigSchema.parse({ connectionId: 'c', agentId: 'lead' })
  /** Settings of a node and its ancestors, root first. */
  const chain = (
    ...levels: Array<{ kind?: 'room' | 'thread' | 'direct'; settings?: ScopePolicy }>
  ) =>
    levels.map(
      (l, n): ScopeNode => ({
        node: { id: `n${n}`, kind: l.kind ?? 'room' },
        settings: l.settings ?? {},
      }),
    )
  const ops = { kind: 'room' as const, settings: { enabled: true, wake: 'mention' as const } }
  const billing = { kind: 'thread' as const, settings: { agentId: 'finance' } }
  const quiet = { kind: 'thread' as const, settings: { wake: 'never' as const } }
  const news = { kind: 'room' as const, settings: { enabled: true, wake: 'always' as const } }
  const msg = (over: { text?: string; signals?: Partial<InboundSignals> } = {}) => ({
    text: over.text ?? 'hello',
    signals: { mentionedSelf: false, replyToSelf: false, ...over.signals },
  })
  const self = { id: 'bot', username: 'team_bot', isSelf: true }

  test('allowlist, inheritance down the tree and defaults', () => {
    // a room is allowed when it is switched on; a node without any entry is not
    expect(resolveScope(cfg, chain(ops)).allowed).toBe(true)
    expect(resolveScope(cfg, chain({})).allowed).toBe(false)
    const open = ConnectionConfigSchema.parse({
      connectionId: 'c',
      agentId: 'a',
      groupPolicy: 'open',
    })
    expect(resolveScope(open, chain({})).allowed).toBe(true)
    // a topic inherits from its room and says so only to differ
    const topic = resolveScope(cfg, chain(ops, billing))
    expect(topic).toMatchObject({
      allowed: true,
      agentId: 'finance',
      ownTopic: true,
      wake: 'mention',
    })
    expect(topic.origin.wake).toEqual({ from: 'ancestor', nodeId: 'n0' })
    expect(topic.origin.agentId).toEqual({ from: 'node', nodeId: 'n1' })
    expect(resolveScope(cfg, chain(ops, quiet)).wake).toBe('never')
    // a topic can switch itself off, a closed room can have an open topic
    expect(
      resolveScope(cfg, chain(ops, { kind: 'thread', settings: { enabled: false } })).allowed,
    ).toBe(false)
    expect(
      resolveScope(cfg, chain({}, { kind: 'thread', settings: { enabled: true } })).allowed,
    ).toBe(true)
    expect(resolveScope(cfg, chain(ops)).quote).toBe('first')
    expect(resolveScope(cfg, chain({ kind: 'direct' })).quote).toBe('off')
    // the connection's defaults sit below the nodes and above the product's
    const withDefaults = ConnectionConfigSchema.parse({
      connectionId: 'c',
      agentId: 'a',
      defaults: { retentionDays: 7, delivery: 'message_tool' },
    })
    const r = resolveScope(
      withDefaults,
      chain({ settings: { enabled: true, retentionDays: 3 } }, { kind: 'thread' }),
    )
    expect(r).toMatchObject({ retentionDays: 3, delivery: 'message_tool', observe: true })
    expect(r.origin.delivery).toEqual({ from: 'connection' })
    expect(r.origin.observe).toEqual({ from: 'default' })
    // a label names one node: it is not inherited
    expect(
      resolveScope(cfg, chain({ settings: { label: 'Ops' } }, { kind: 'thread' })).label,
    ).toBeUndefined()
    // session scope and redaction come from the tree too
    const shared = resolveScope(
      cfg,
      chain({ settings: { sessionScope: 'room', redactOnDelete: true } }, { kind: 'thread' }),
    )
    expect(shared).toMatchObject({ sessionScope: 'room', redactOnDelete: true })
  })

  test('wake decisions: mention, reply, alias, others mentioned, own topic, never, always', () => {
    const scope = resolveScope(cfg, chain(ops))
    const d = (m: ReturnType<typeof msg>, s = scope) => decideWake(m, s, self).action
    expect(d(msg())).toBe('observe')
    expect(d(msg({ signals: { mentionedSelf: true } }))).toBe('wake')
    expect(d(msg({ signals: { replyToSelf: true } }))).toBe('wake')
    expect(d(msg({ signals: { mentionedOthers: true } }))).toBe('observe')
    expect(d(msg({ text: 'hey @team_bot look' }))).toBe('wake')
    expect(d(msg({ text: 'hey @team_botx look' }))).toBe('observe')
    expect(d(msg(), resolveScope(cfg, chain(ops, billing)))).toBe('wake')
    expect(d(msg(), resolveScope(cfg, chain(ops, quiet)))).toBe('observe')
    expect(d(msg(), resolveScope(cfg, chain(news)))).toBe('wake')
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
      .query<{ content: string }, []>('SELECT content FROM ch_messages')
      .all()
    expect(raw).toHaveLength(1)
    expect(raw[0]?.content).not.toContain('payroll')
    expect(raw[0]?.content.startsWith('v2.')).toBe(true)

    await mock.userEdit({ from: ana, id: 'm1', text: 'a different text' })
    await mock.userDelete({ ids: ['m1'] })
    const row = await i.gw.log.find(nid(i, 'room'), 'm1')
    expect(row).toMatchObject({
      text: 'a different text',
      edits: [{ text: 'a secret about payroll' }],
    })
    expect(row?.editedAt).toBeNumber()
    // the content of a deleted message stays for audit (until the node's retention)
    expect(row?.deletedAt).toBeNumber()
    expect(row?.deletedHasContent).toBe(true)
    // the platform event log holds facts, not text
    const events = i.server.conn.sqlite
      .query<{ type: string; payload: string }, []>(
        "SELECT type, payload FROM ch_events WHERE type NOT LIKE 'gateway.%'",
      )
      .all()
    expect(events.map((e) => e.type)).toEqual([
      'message.created',
      'message.created',
      'message.edited',
      'message.deleted',
    ])
    expect(JSON.stringify(events)).not.toContain('payroll')
  })

  test('redactOnDelete drops the content of a deleted message; the tombstone stays', async () => {
    const i = instance({})
    const mock = await connect(i, { groups: { room: { redactOnDelete: true } } })
    await mock.say({ from: ana, text: 'delete me please', id: 'r1' })
    await mock.userEdit({ from: ana, id: 'r1', text: 'delete me now' })
    await mock.userDelete({ ids: ['r1'] })
    const row = await i.gw.log.find(nid(i, 'room'), 'r1')
    expect(row).toMatchObject({ text: '', deletedHasContent: false })
    expect(row?.deletedAt).toBeNumber()
    expect(row?.edits).toBeUndefined()
  })

  test('a deletion that names no chat is placed by the message id, or recorded until it can be', async () => {
    const i = instance({})
    const mock = await connect(i, { groups: { room: {}, other: {} } })
    await mock.say({ from: ana, text: 'one', id: 'u1' })
    await mock.say({ from: ana, text: 'twin a', id: 'dup', chat: 'room' })
    await mock.say({ from: ana, text: 'twin b', id: 'dup', chat: 'other' })
    await mock.userDelete({ ids: ['u1'], unplaced: true })
    expect((await i.gw.log.find(nid(i, 'room'), 'u1'))?.deletedAt).toBeNumber()
    // the same id in two chats: not guessed, kept unresolved
    await mock.userDelete({ ids: ['dup'], unplaced: true })
    expect((await i.gw.log.find(nid(i, 'room'), 'dup'))?.deletedAt).toBeUndefined()
    expect(i.gw.events.unresolved('c1')).toHaveLength(1)
  })

  test('the log of one conversation is purged past its own retention', async () => {
    const i = instance({})
    const mock = await connect(i)
    const day = 86_400_000
    await mock.say({ from: ana, text: 'old', id: 'o1', at: Date.now() - 40 * day })
    await mock.say({ from: ana, text: 'recent', id: 'o2', at: Date.now() - 2 * day })
    expect(i.gw.purge()).toBe(1)
    expect(i.gw.log.count()).toBe(1)
    expect(await i.gw.log.find(nid(i, 'room'), 'o1')).toBeUndefined()
  })

  test('an account is linked by id (the person disappears from "not linked yet"); the link is replaced by a new one', () => {
    const i = instance({})
    i.gw.configure({ connectionId: 'c1', agentId: i.leadId })
    const linked = i.gw.pairing.link('c1', '42', 'owner', 'Ana')
    expect(linked).toMatchObject({ peerId: '42', memberId: 'owner', name: 'Ana' })
    expect(i.gw.pairing.members('c1')).toHaveLength(1)
    // linking the same account again moves it
    i.gw.pairing.link('c1', '42', 'carol')
    expect(i.gw.pairing.members('c1')).toMatchObject([{ peerId: '42', memberId: 'carol' }])
    expect(() => i.gw.pairing.link('nope', '1', 'owner')).toThrow('No such connection')
    expect(i.gw.pairing.unlink('c1', '42')).toBe(true)
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
    expect(JSON.stringify(system)).toContain('topic \\"T1\\" of the group \\"Room\\"')

    // registered as a thread of the agent with a channel badge
    const threads = i.server.deps.threads.list(i.leadId).filter((t) => t.source === 'channel')
    expect(threads).toHaveLength(1)
    expect(threads[0]).toMatchObject({
      sessionId: sid(i, 'room/T1'),
      sourceLabel: 'mock · Room / T1',
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
    const open = await i.server.app.request(
      `/sessions/${encodeURIComponent(sid(i, 'room/T1'))}/messages`,
    )
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
      i.gw.sessions
        .list('c1')
        .map((c) => c.nodeId)
        .sort(),
    ).toEqual([nid(i, 'room/A'), nid(i, 'room/B')].sort())
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

  test('a turn that fails tells the chat in one generic line instead of leaving it in silence', async () => {
    const i = instance({
      lead: [
        () => {
          throw new Error('provider exploded: key sk-secret-123 account 99')
        },
        textStep('Back again.'),
      ],
    })
    const mock = await connect(i)
    await mock.say({ from: ana, text: '@team_bot go', id: 'w1', mentionSelf: true })
    await until('the notice', () => mock.sent.length === 1)
    const notice = mock.sent[0]?.message
    expect(notice?.text).toContain('could not answer')
    expect(notice?.text).not.toContain('sk-secret')
    expect(notice?.replyTo).toBe('w1')
    await mock.say({ from: ana, text: '@team_bot again', id: 'w2', mentionSelf: true })
    await until('the next answer', () => mock.sent.some((s) => s.message.text === 'Back again.'))
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

  test('an image for a text-only model keeps the text; the model sees a note and later turns work', async () => {
    const i = instance(
      { lead: [textStep('Got the text.'), textStep('Second.')] },
      { catalog: () => ({ inputModalities: ['text'] }) },
    )
    const mock = await connect(i)
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3])
    await mock.say({
      from: ana,
      text: '@team_bot look',
      id: 'n1',
      mentionSelf: true,
      attachments: [{ name: 'shot.png', mediaType: 'image/png', bytes: png }],
    })
    await until('reply', () => mock.sent.some((s) => s.message.text === 'Got the text.'))
    expect(wire(i.models.lead as ScriptedModel)).toContain('does not accept image input')
    await mock.say({ from: ana, text: '@team_bot and now?', id: 'n2', mentionSelf: true })
    await until('second reply', () => mock.sent.some((s) => s.message.text === 'Second.'))
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

describe('DMs: only linked employees; strangers get silence', () => {
  test('an unlinked DM is recorded (who, never what) and gets no reply; a link by id makes the DM wake the agent', async () => {
    const i = instance({ lead: [textStep('Hello Ana, how can I help?')] })
    const mock = await connect(i, { groups: {} })
    await mock.say({ chat: 'u-ana', kind: 'dm', from: ana, text: 'hi there SECRET-TEXT', id: 'd1' })
    await sleep(100)
    expect(calls(i.models.lead)).toBe(0)
    expect(mock.sent).toEqual([])
    expect(i.gw.log.count('c1')).toBe(0) // not even stored
    expect(i.gw.unlinked.list('c1')).toMatchObject([
      { peerId: 'u-ana', name: 'Ana Putri', username: 'ana', messageCount: 1, ignored: false },
    ])

    // an old or made-up /start token is not special any more: silence, counted
    await mock.say({
      chat: 'u-ana',
      kind: 'dm',
      from: ana,
      text: '/start nope',
      id: 'd2',
      command: { name: 'start', args: 'nope' },
    })
    expect(mock.sent).toEqual([])
    expect(i.gw.unlinked.list('c1')[0]?.messageCount).toBe(2)
    // no message text was stored anywhere for the stranger
    const dump = JSON.stringify([
      i.server.conn.sqlite.query('SELECT * FROM ch_identities').all(),
      i.server.conn.sqlite.query('SELECT * FROM ch_events').all(),
      i.server.conn.sqlite.query('SELECT * FROM ch_nodes').all(),
    ])
    expect(dump).not.toContain('SECRET-TEXT')
    expect(dump).not.toContain('nope')

    i.gw.pairing.link('c1', 'u-ana', 'owner')
    expect(i.gw.pairing.members('c1')).toMatchObject([{ peerId: 'u-ana', memberId: 'owner' }])
    expect(i.gw.unlinked.list('c1')).toEqual([]) // no longer "not linked yet"

    await mock.say({ chat: 'u-ana', kind: 'dm', from: ana, text: 'what is on today?', id: 'd5' })
    await until('the DM reply', () => mock.sent.length === 1)
    expect(mock.sent[0]?.message.text).toBe('Hello Ana, how can I help?')
    expect(mock.sent[0]?.message.replyTo).toBeUndefined() // no quote in a DM
    expect(mock.reactions).toEqual([]) // no ack in a DM
    expect(wire(i.models.lead as ScriptedModel)).toContain('(team member)')
    // a different DM peer never shares the session
    expect(i.gw.sessions.list('c1').map((c) => c.sessionId)).toEqual([sid(i, 'u-ana')])
  })

  test('ignore hides a person and they stay silent; "reply to unknown people" sends one neutral line, rarely', async () => {
    const i = instance({})
    const mock = await connect(i, { groups: {}, config: { replyToUnknown: true } })
    await mock.say({ chat: 'u-ana', kind: 'dm', from: ana, text: 'hello', id: 'd1' })
    expect(mock.sent).toHaveLength(1)
    expect(mock.sent[0]?.message.text).toContain("can't chat")
    await mock.say({ chat: 'u-ana', kind: 'dm', from: ana, text: 'hello again', id: 'd2' })
    expect(mock.sent).toHaveLength(1) // not twice in a row
    expect(i.gw.unlinked.ignore('c1', 'u-ana', true)).toBe(true)
    expect(i.gw.unlinked.list('c1')).toEqual([])
    expect(i.gw.unlinked.list('c1', { includeIgnored: true })).toHaveLength(1)
    expect(i.gw.unlinked.ignore('c1', 'nobody', true)).toBe(false)
    // the default of a new connection is silence
    expect(ConnectionConfigSchema.parse({ connectionId: 'x', agentId: 'a' }).replyToUnknown).toBe(
      false,
    )
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
    const cfg = { allowBots: true, botLoopGuard: guard }
    const groups = { room: { wake: 'always', ack: false } }
    const a = await connect(i, { connectionId: 'ca', agentId: i.leadId, config: cfg, groups })
    const b = await connect(i, {
      connectionId: 'cb',
      agentId: i.researcherId,
      config: cfg,
      groups,
    })
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

  test("the agent's own echoes are kept in the log but never acted on; bots are dropped by default", async () => {
    const i = instance({})
    const mock = await connect(i)
    await mock.emit({
      type: 'message.created',
      dedupeKey: 'own-1',
      node: mock.ref('room'),
      at: Date.now(),
      message: {
        nativeId: 'e1',
        sender: { ...mock.self() },
        text: '@team_bot talking to myself',
        attachments: [],
      },
      signals: { mentionedSelf: true, replyToSelf: false },
    })
    await mock.emit({
      type: 'message.created',
      dedupeKey: 'bot-1',
      node: mock.ref('room'),
      at: Date.now(),
      message: {
        nativeId: 'e2',
        sender: { id: 'other-bot', isBot: true },
        text: '@team_bot beep',
        attachments: [],
      },
      signals: { mentionedSelf: true, replyToSelf: false },
    })
    await sleep(100)
    // what this identity sent (from another device, or echoed back) belongs to the full log
    const own = await i.gw.log.find(nid(i, 'room'), 'e1')
    expect(own).toMatchObject({ self: true, text: '@team_bot talking to myself' })
    expect(await i.gw.log.find(nid(i, 'room'), 'e2')).toBeUndefined()
    expect(i.gw.log.count('c1')).toBe(1)
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
    const page = await i.gw.log.recent(nid(i, 'audit'), { limit: 5 })
    expect(page.map((m) => m.nativeId)).toEqual(['x25', 'x26', 'x27', 'x28', 'x29'])
    const older = await i.gw.log.recent(nid(i, 'audit'), { limit: 5, before: 'x25' })
    expect(older.at(-1)?.nativeId).toBe('x24')
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
    const logged = await i.gw.log.recent(nid(i, 'news'), { limit: 10 })
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
    // a topic is a child of its group: the tool lists the places as a tree
    await mock.say({ from: budi, text: 'in a topic', topic: 'T1', id: 't1' })
    await mock.say({
      from: ana,
      text: '@team_bot what can you do here?',
      id: 'q1',
      mentionSelf: true,
    })
    await until('reply', () => mock.sent.length === 1)
    const described = JSON.stringify(i.models.lead?.prompts.at(-1))
    expect(described).toContain('Connection c1 (mock), connected')
    expect(described).toMatch(/Conversation [0-9a-f-]+ \\"Room\\" \(room, allowed\)/)
    expect(described).toMatch(/ {4}Conversation [0-9a-f-]+ \\"T1\\" \(thread, allowed\)/)
    expect(described).toContain('mock_create_poll (external)')
    expect(described).toContain('this one')

    const session = i.server.factory.openSession(
      i.server.deps.agents.get(i.leadId) as never,
      sid(i, 'room'),
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
    const row = await i.gw.log.find(nid(i, 'news'), 'm1-c1')
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
    // the trigger is our id of the message that woke the agent (the platform id is `w1`)
    const trigger = await i.gw.log.find(nid(i, 'room'), 'w1')
    expect(rows[0]).toMatchObject({
      kind: 'reply',
      status: 'sent',
      trigger_id: trigger?.id,
      platform_id: mock.sent[0]?.messageId,
    })
    expect(rows[0]?.body).not.toContain('Here you go') // sealed at rest
    // the adapter got the row id as its idempotency key
    const row = (await i.gw.outbox.get(
      i.server.conn.sqlite.query<{ id: string }, []>('SELECT id FROM channel_outbox').get()
        ?.id as string,
    )) as { id: string }
    expect(mock.sent[0]?.message.sendTxnId).toBe(row.id)
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
    expect(new Set(mock.sent.map((s) => s.message.sendTxnId)).size).toBe(3)
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
    await mockB.send(chatNode('room'), { text: 'one', replyTo: 'w1' })
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

  test('an uncertain message is listed for a person, who can send it again or dismiss it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'team-attention-'))
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
    const mockB = createMockAdapter({ connectionId: 'c1', capabilities: { history: false } })
    await second.gw.register(mockB)
    await until('the row is settled', () => second.gw.outbox.counts('c1').failed === 1)
    const bell = second.server.deps.notifications.list({ open: true, limit: 10 })
    expect(bell.find((n) => n.title.includes('may not have arrived'))?.link).toBe(
      '/channels/c1/delivery#needs-a-look',
    )

    const page = await second.gw.outboxAttention('c1')
    expect(page.items).toHaveLength(1)
    const item = page.items[0]
    expect(item).toMatchObject({
      status: 'failed',
      uncertain: true,
      retryable: true,
      dismissable: true,
      preview: 'maybe delivered',
    })
    expect(await second.gw.retryOutbox('c2', item?.id as string)).toBe('not-found')
    expect(await second.gw.retryOutbox('c1', item?.id as string)).toBe('queued')
    await until('it is sent again', () => mockB.sent.length === 1)
    expect(mockB.sent[0]?.message.text).toBe('maybe delivered')
    expect((await second.gw.outboxAttention('c1')).items).toEqual([])
    expect(await second.gw.retryOutbox('c1', item?.id as string)).toBe('not-allowed')

    // a second failed message can be dismissed instead; it is kept but leaves the count
    const [id] = await second.gw.outbox.enqueue(
      [
        {
          connectionId: 'c1',
          conversationId: item?.chatId as string,
          kind: 'reply',
          triggerId: 'x',
          chunkIndex: 0,
          chunkCount: 1,
          text: 'lost',
        },
      ],
      Date.now(),
    )
    second.gw.outbox.markFailed(id as string, 'boom', Date.now())
    expect(second.gw.outbox.counts('c1').failed).toBe(1)
    expect(await second.gw.dismissOutbox('c1', id as string)).toBe('dismissed')
    expect(await second.gw.dismissOutbox('c1', id as string)).toBe('not-allowed')
    expect(second.gw.outbox.counts('c1').failed).toBe(0)
    expect((await second.gw.outboxAttention('c1')).items).toEqual([])
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
    _mock: MockAdapter,
    who: { id: string; name?: string; username?: string },
    memberId: string,
  ) => {
    i.gw.pairing.link('c1', who.id, memberId, who.name)
    // approvals in a chat are for the team's staff (L6): Ana is an admin by the directory, Budi is the
    // linked owner; Carol (linked, no directory entry) is a member and Eve (unknown) a guest
    if (who.id === ana.id) i.gw.people.setRole('c1', ana.id, { role: 'admin' }, 'test')
  }
  const setup = async (
    script: ScriptedStepInput[],
    options: { buttons?: boolean; admins?: string[]; webUrl?: string } = {},
  ) => {
    const i = instance(
      { lead: script },
      options.webUrl === undefined ? {} : { webUrl: options.webUrl },
    )
    const mock = await connect(i, {
      groups: { room: { label: 'Ops', ack: false }, news: { wake: 'never' } },
      config: {
        ...NO_WAIT,
        people: { defaultRole: 'guest', policy: {} },
        ...(options.admins === undefined ? {} : { admins: options.admins }),
      },
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
    expect(i.gw.approvals.open(sid(i, 'room'))).toEqual([])
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

  test('somebody who is neither the requester nor an admin gets silence: nothing changes', async () => {
    const { i, mock } = await setup([approvalStep, textStep('done')])
    await mock.say({ from: ana, text: '@team_bot publish', id: 'w1', mentionSelf: true })
    await until('the request', () => request(mock) !== undefined)
    const ask = request(mock) as NonNullable<ReturnType<typeof request>>
    const data = ask.message.buttons?.[0]?.data as string
    // a stranger (not linked) and a linked non-admin member both are refused
    const before = mock.sent.length
    await mock.press({ from: stranger, name: 'approve', data, messageId: ask.messageId })
    const carol = { id: 'u-carol', name: 'Carol' }
    await pair(i, mock, carol, 'carol-member')
    await mock.press({ from: carol, name: 'approve', data, messageId: ask.messageId })
    expect(mock.sent).toHaveLength(before) // no refusal text to anybody
    // both presses are in the activity as dropped (not authorized)
    expect(
      i.gw.activity
        .list('c1', { type: 'dropped', limit: 10 })
        .items.filter((e) => e.reason === 'not-authorized'),
    ).toHaveLength(2)
    await sleep(100)
    expect(mock.sent.some((s) => s.conversationId === 'news')).toBe(false)
    expect(i.gw.approvals.open(sid(i, 'room'))).toHaveLength(1) // still waiting
    expect(mock.edits).toEqual([])
  })

  test('a team admin can answer a request somebody else triggered', async () => {
    const { i, mock } = await setup([approvalStep, textStep('Posted it.')])
    // Dan is an admin by the directory and triggers the request; Budi (the linked owner) answers it
    const dan = { id: 'u-dan', name: 'Dan', username: 'dan' }
    i.gw.people.setRole('c1', dan.id, { role: 'admin' }, 'test')
    await mock.say({ from: dan, text: '@team_bot publish', id: 'w1', mentionSelf: true })
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

  test('without the buttons capability the request points at the web app: a link only when it is reachable from outside', async () => {
    const { i, mock } = await setup([approvalStep, textStep('Posted it.')], { buttons: false })
    await mock.say({ from: ana, text: '@team_bot publish', id: 'w1', mentionSelf: true })
    await until('the request', () =>
      mock.sent.some((s) => s.message.text.includes('answer in the team web app')),
    )
    const ask = mock.sent.find((s) => s.message.text.includes('answer in the team web app'))
    expect(ask?.message.buttons).toBeUndefined()
    // never a link to this machine
    expect(JSON.stringify(mock.sent)).not.toContain('localhost')
    void i
    const outside = await setup([approvalStep, textStep('Posted it.')], {
      buttons: false,
      webUrl: 'https://team.example.com',
    })
    await outside.mock.say({ from: ana, text: '@team_bot publish', id: 'w1', mentionSelf: true })
    await until('the request', () =>
      outside.mock.sent.some((s) => s.message.text.includes('answer in https://')),
    )
    const thread = outside.i.server.deps.threads.getBySession(sid(outside.i, 'room'))
    expect(
      outside.mock.sent.find((s) => s.message.text.includes('answer in https://'))?.message.text,
    ).toContain(`https://team.example.com/a/${outside.i.leadId}?t=${thread?.id}`)
  })

  test('answering in the web app first wins: the request is updated and the late button is refused', async () => {
    const { i, mock } = await setup([approvalStep, textStep('Posted it.')])
    await mock.say({ from: ana, text: '@team_bot publish', id: 'w1', mentionSelf: true })
    await until('the request', () => request(mock) !== undefined)
    const ask = request(mock) as NonNullable<ReturnType<typeof request>>
    const list = (await (await i.server.app.request('/attention')).json()) as {
      items: Array<{ id: string; sessionId: string; kind: string }>
    }
    const item = list.items.find((x) => x.sessionId === sid(i, 'room'))
    expect(item?.kind).toBe('approval')
    const res = await i.server.app.request(`/attention/${item?.id}/answer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId: sid(i, 'room'),
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

  const askStep = (
    questions: Array<{
      question: string
      header: string
      options: string[]
      multiSelect?: boolean
    }>,
    id = 'q1',
  ): ScriptedStepInput => ({
    toolCalls: [
      {
        toolName: 'ask_user_question',
        input: {
          questions: questions.map((q) => ({
            question: q.question,
            header: q.header,
            multiSelect: q.multiSelect ?? false,
            options: q.options.map((label) => ({ label, description: `${label} option` })),
          })),
        },
        toolCallId: id,
      },
    ],
  })
  const channelQ = {
    question: 'Which release channel?',
    header: 'Channel',
    options: ['beta', 'stable'],
  }
  const questionMsg = (mock: MockAdapter) =>
    mock.sent.find((s) => s.message.text.includes('Which release channel?'))

  test('a question is posted in the chat with option buttons and no link; the requester answers by writing', async () => {
    const { i, mock } = await setup([askStep([channelQ]), textStep('Going with stable.')])
    await mock.say({ from: ana, text: '@team_bot publish', id: 'w1', mentionSelf: true })
    await until('the question', () => questionMsg(mock) !== undefined)
    const q = questionMsg(mock) as NonNullable<ReturnType<typeof questionMsg>>
    expect(q.message.buttons?.map((b) => b.label)).toEqual(['beta', 'stable'])
    expect(q.message.text).toContain('reply with your own answer')
    expect(q.message.text).not.toContain('localhost')
    expect(q.message.text).not.toContain('http')
    expect(i.gw.approvals.open(sid(i, 'room'))[0]?.itemKind).toBe('question')

    // the next message of the requester (not even addressed to the bot) is the answer
    await mock.say({ from: ana, text: 'stable please', id: 'w2' })
    await until('the reply', () => mock.sent.some((s) => s.message.text === 'Going with stable.'))
    expect(wire(i.models.lead as ScriptedModel)).toContain('The user answered')
    expect(wire(i.models.lead as ScriptedModel)).toContain('other: \\"stable please\\"')
    await until('the announcement is edited', () => mock.edits.length === 1)
    expect(mock.edits[0]?.text).toBe('Answered: "stable please"')
    expect(mock.edits[0]?.messageId).toBe(q.messageId)
    expect(i.gw.approvals.open(sid(i, 'room'))).toEqual([])
    // the answer is not woken a second time: two model calls in all (the question and its continuation)
    expect(calls(i.models.lead)).toBe(2)
  })

  test('tapping an option answers; the text of an option or its number counts as that option', async () => {
    const { i, mock } = await setup([askStep([channelQ]), textStep('Beta it is.')])
    await mock.say({ from: ana, text: '@team_bot publish', id: 'w1', mentionSelf: true })
    await until('the question', () => questionMsg(mock) !== undefined)
    const q = questionMsg(mock) as NonNullable<ReturnType<typeof questionMsg>>
    await mock.press({
      from: ana,
      name: 'o',
      data: q.message.buttons?.[0]?.data as string,
      messageId: q.messageId,
    })
    await until('the reply', () => mock.sent.some((s) => s.message.text === 'Beta it is.'))
    expect(wire(i.models.lead as ScriptedModel)).toContain('Channel: beta')
    await until('edited', () => mock.edits.length === 1)
    expect(mock.edits[0]?.text).toBe('Answered: beta')

    // by number
    const second = await setup([askStep([channelQ]), textStep('Stable then.')])
    await second.mock.say({ from: ana, text: '@team_bot publish', id: 'w1', mentionSelf: true })
    await until('the question', () => questionMsg(second.mock) !== undefined)
    await second.mock.say({ from: ana, text: '2', id: 'w2' })
    await until('the reply', () => second.mock.sent.some((s) => s.message.text === 'Stable then.'))
    expect(wire(second.i.models.lead as ScriptedModel)).toContain('Channel: stable')
  })

  test('other people stay context while a question waits; a stranger cannot tap; an admin may answer', async () => {
    const { i, mock } = await setup([askStep([channelQ]), textStep('Done: stable.')])
    await mock.say({ from: ana, text: '@team_bot publish', id: 'w1', mentionSelf: true })
    await until('the question', () => questionMsg(mock) !== undefined)
    const q = questionMsg(mock) as NonNullable<ReturnType<typeof questionMsg>>
    const carol = { id: 'u-carol', name: 'Carol' }
    await pair(i, mock, carol, 'carol-member')
    const before = mock.sent.length
    await mock.say({ from: carol, text: '@team_bot stable', id: 'c1', mentionSelf: true })
    await mock.press({
      from: stranger,
      name: 'o',
      data: q.message.buttons?.[1]?.data as string,
      messageId: q.messageId,
    })
    await sleep(150)
    expect(mock.sent).toHaveLength(before) // silence: no reply, no change
    expect(calls(i.models.lead)).toBe(1)
    expect(i.gw.approvals.open(sid(i, 'room'))).toHaveLength(1)
    // Carol's message is stored as context, not lost
    const recent = await i.gw.log.recent(nid(i, 'room'), { limit: 20 })
    expect(recent.some((m) => m.text.includes('@team_bot stable'))).toBe(true)
    // Budi (the linked owner) is staff and may answer for Ana
    await mock.say({ from: budi, text: 'stable', id: 'b1' })
    await until('the reply', () => mock.sent.some((s) => s.message.text === 'Done: stable.'))
    expect(mock.edits[0]?.text).toContain('Answered')
  })

  test('a question with several parts is answered in order, or all at once with one line each', async () => {
    const two = [channelQ, { question: 'Announce it?', header: 'Announce', options: ['yes', 'no'] }]
    const { i, mock } = await setup([askStep(two), textStep('Both noted.')])
    await mock.say({ from: ana, text: '@team_bot publish', id: 'w1', mentionSelf: true })
    await until('the question', () => questionMsg(mock) !== undefined)
    const q = questionMsg(mock) as NonNullable<ReturnType<typeof questionMsg>>
    expect(q.message.buttons).toBeUndefined() // several parts: written answers only
    expect(q.message.text).toContain('Question 2 of 2: Announce it?')
    await mock.say({ from: ana, text: 'beta', id: 'w2' })
    await until('the next part is asked', () =>
      mock.sent.some((s) => s.message.text.startsWith('Noted (1 of 2)')),
    )
    expect(calls(i.models.lead)).toBe(1) // the turn waits for the last part
    await mock.say({ from: ana, text: 'no', id: 'w3' })
    await until('the reply', () => mock.sent.some((s) => s.message.text === 'Both noted.'))
    const w = wire(i.models.lead as ScriptedModel)
    expect(w).toContain('Channel: beta')
    expect(w).toContain('Announce: no')
    expect(mock.edits[0]?.text).toBe('Answered: beta; no')

    // all at once
    const all = await setup([askStep(two), textStep('All at once.')])
    await all.mock.say({ from: ana, text: '@team_bot publish', id: 'w1', mentionSelf: true })
    await until('the question', () => questionMsg(all.mock) !== undefined)
    await all.mock.say({ from: ana, text: '1. stable\n2. yes', id: 'w2' })
    await until('the reply', () => all.mock.sent.some((s) => s.message.text === 'All at once.'))
    const w2 = wire(all.i.models.lead as ScriptedModel)
    expect(w2).toContain('Channel: stable')
    expect(w2).toContain('Announce: yes')
  })

  test('a question in a direct chat is answered in the chat too', async () => {
    const { i, mock } = await setup([askStep([channelQ]), textStep('Stable, noted.')])
    await mock.say({ chat: 'u-ana', kind: 'dm', from: ana, text: 'publish the notes', id: 'd1' })
    await until('the question', () => questionMsg(mock) !== undefined)
    const q = questionMsg(mock) as NonNullable<ReturnType<typeof questionMsg>>
    expect(q.conversationId).toBe('u-ana')
    expect(q.message.text).not.toContain('http')
    await mock.say({ chat: 'u-ana', kind: 'dm', from: ana, text: 'stable', id: 'd2' })
    await until('the reply', () => mock.sent.some((s) => s.message.text === 'Stable, noted.'))
    expect(wire(i.models.lead as ScriptedModel)).toContain('Channel: stable')
    void i
  })

  test('without buttons the question still reads as a chat question', async () => {
    const { i, mock } = await setup([askStep([channelQ]), textStep('ok')], { buttons: false })
    await mock.say({ from: ana, text: '@team_bot publish', id: 'w1', mentionSelf: true })
    await until('the question', () => questionMsg(mock) !== undefined)
    const q = questionMsg(mock) as NonNullable<ReturnType<typeof questionMsg>>
    expect(q.message.buttons).toBeUndefined()
    expect(q.message.text).toContain('Reply with a number')
    void i
  })

  test('an expired question is edited to Expired and the model is told it was not answered', async () => {
    const { i, mock } = await setup([askStep([channelQ]), textStep('No answer, moving on.')])
    await mock.say({ from: ana, text: '@team_bot publish', id: 'w1', mentionSelf: true })
    await until('the question', () => questionMsg(mock) !== undefined)
    expect(await i.gw.expireApprovals(Date.now() + 25 * 3_600_000)).toBe(1)
    await until('edited', () => mock.edits.length === 1)
    expect(mock.edits[0]?.text).toContain('Expired')
    await until('the reply', () =>
      mock.sent.some((s) => s.message.text === 'No answer, moving on.'),
    )
  })

  test('nobody is left in silence: a message while the session waits on something no chat shows is answered once', async () => {
    const { i, mock } = await setup([textStep('first'), approvalStep, textStep('after')])
    await mock.say({ from: ana, text: '@team_bot hi', id: 'w1', mentionSelf: true })
    await until('the reply', () => mock.sent.some((s) => s.message.text === 'first'))
    // a turn of the web app parks the session on an approval that is not announced in the chat
    const res = await i.server.app.request(`/sessions/${sid(i, 'room')}/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: sid(i, 'room'),
        messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'post the notes' }] }],
      }),
    })
    await res.text()
    await sleep(150)
    const before = mock.sent.length
    await mock.say({ from: ana, text: '@team_bot hello?', id: 'w2', mentionSelf: true })
    await until('the explanation', () => mock.sent.length === before + 1)
    expect(mock.sent.at(-1)?.message.text).toContain('cannot be answered in a chat')
    expect(mock.sent.at(-1)?.message.text).not.toContain('http')
    // once, not on every message
    await mock.say({ from: ana, text: '@team_bot again', id: 'w3', mentionSelf: true })
    await sleep(150)
    expect(mock.sent).toHaveLength(before + 1)
    expect(calls(i.models.lead)).toBe(2)
  })

  test('somebody else addressing the bot while an approval waits is told once whom it waits for', async () => {
    const { i, mock } = await setup([approvalStep, textStep('Posted it.')])
    await mock.say({ from: ana, text: '@team_bot publish', id: 'w1', mentionSelf: true })
    await until('the request', () => request(mock) !== undefined)
    const carol = { id: 'u-carol', name: 'Carol' }
    await pair(i, mock, carol, 'carol-member')
    const before = mock.sent.length
    await mock.say({ from: carol, text: '@team_bot and me?', id: 'c1', mentionSelf: true })
    await until('the notice', () => mock.sent.length === before + 1)
    expect(mock.sent.at(-1)?.message.text).toContain('waiting for an approval')
    await mock.say({ from: carol, text: '@team_bot hello?', id: 'c2', mentionSelf: true })
    await sleep(100)
    expect(mock.sent).toHaveLength(before + 1)
    expect(i.gw.approvals.open(sid(i, 'room'))).toHaveLength(1)
  })

  test('a turn started from the web app in a channel thread announces nothing in the chat', async () => {
    const { i, mock } = await setup([textStep('first'), approvalStep, textStep('after')])
    await mock.say({ from: ana, text: '@team_bot hi', id: 'w1', mentionSelf: true })
    await until('the reply', () => mock.sent.some((s) => s.message.text === 'first'))
    const before = mock.sent.length
    const res = await i.server.app.request(`/sessions/${sid(i, 'room')}/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: sid(i, 'room'),
        messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'post the notes' }] }],
      }),
    })
    expect(res.status).toBe(200)
    await res.text()
    await sleep(150)
    expect(mock.sent.length).toBe(before) // the approval waits in the web app only
    expect(i.gw.approvals.open(sid(i, 'room'))).toEqual([])
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
    expect(i.gw.sessions.get('c1', nid(i, 'room'))).toMatchObject({
      agentId: i.leadId,
      sessionId: sid(i, 'room'),
      generation: 0,
    })

    // the group is routed to another agent
    i.gw.settings.set(nid(i, 'room'), { agentId: i.researcherId })
    await mock.say({ from: ana, text: '@team_bot and now?', id: 'w2', mentionSelf: true })
    await until('researcher replies', () => mock.sent.length === 2)
    expect(mock.sent[1]?.message.text).toBe('Researcher answers.')
    expect(calls(i.models.lead)).toBe(1)
    expect(calls(i.models.researcher)).toBe(1)
    // the new agent never saw the old agent's session
    expect(wire(i.models.researcher as ScriptedModel)).not.toContain('Lead answers.')
    expect(i.gw.sessions.get('c1', nid(i, 'room'))).toMatchObject({
      agentId: i.researcherId,
      sessionId: channelSessionId('c1', nid(i, 'room'), 1),
      generation: 1,
    })
    const leadThreads = i.server.deps.threads.list(i.leadId).filter((t) => t.source === 'channel')
    const researcherThreads = i.server.deps.threads
      .list(i.researcherId)
      .filter((t) => t.source === 'channel')
    expect(leadThreads.map((t) => t.sessionId)).toEqual([channelSessionId('c1', nid(i, 'room'))])
    expect(researcherThreads.map((t) => t.sessionId)).toEqual([
      channelSessionId('c1', nid(i, 'room'), 1),
    ])
    // a third wake keeps the researcher's session
    await mock.say({ from: ana, text: '@team_bot once more', id: 'w3', mentionSelf: true })
    await until('the third turn', () => (i.models.researcher?.prompts.length ?? 0) >= 2)
    expect(i.gw.sessions.get('c1', nid(i, 'room'))?.generation).toBe(1)
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
      () => i.gw.approvals.open(sid(i, 'room')).length === 1,
    )
    expect(ran).toEqual(['get_info']) // the read action ran without an approval
    expect(i.gw.approvals.open(sid(i, 'room'))[0]?.toolName).toBe('mock_make_poll')
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
    first.gw.pairing.link('c1', 'u-ana', 'owner')
    expect(first.gw.pairing.members('c1')).toHaveLength(1)
    await first.server.close()
    servers.splice(servers.indexOf(first.server), 1)

    const second = instance({ lead: [textStep('second answer')] }, { dir })
    // the configuration and the log are still there; only the adapter is registered again
    expect(second.gw.settings.get(nid(second, 'room'))).toMatchObject({
      enabled: true,
      label: 'Ops',
    })
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

describe('silence for strangers', () => {
  test('non-allowlisted chats, bots, duplicates and unlinked DMs are never answered; each is a dropped event with a reason', async () => {
    const i = instance({ lead: [textStep('hi')] })
    const mock = await connect(i, { config: { replyToUnknown: false } })
    await mock.say({ chat: 'other', from: ana, text: '@team_bot hi', id: 's1', mentionSelf: true })
    await mock.emit({
      type: 'message.created',
      dedupeKey: 'bot-b1',
      node: mock.ref('room'),
      at: Date.now(),
      message: {
        nativeId: 'b1',
        sender: { id: 'other-bot', isBot: true },
        text: '@team_bot beep',
        attachments: [],
      },
      signals: { mentionedSelf: true, replyToSelf: false },
    })
    await mock.say({
      chat: 'u-eve',
      kind: 'dm',
      from: { id: 'u-eve', name: 'Eve' },
      text: 'psst',
      id: 'd1',
    })
    await mock.say({ from: ana, text: 'context', id: 'o1' })
    await mock.say({ from: ana, text: 'context', id: 'o1' }) // a redelivery of a finished one
    await sleep(100)
    expect(mock.sent).toEqual([])
    expect(calls(i.models.lead)).toBe(0)
    const dropped = i.gw.activity
      .list('c1', { type: 'dropped', limit: 20 })
      .items.map((e) => e.reason)
      .sort()
    expect(dropped).toEqual(['bot-sender', 'chat-not-allowed', 'duplicate', 'unlinked-sender'])
    // the stranger's chat is in the inbox with its allowlist state, counted as dropped
    const page = await i.gw.inbox.conversations('c1', { limit: 10 })
    expect(page.items.find((c) => c.conversationId === nid(i, 'other'))).toMatchObject({
      allowed: false,
      dropped: 1,
      woke: 0,
    })
    expect(page.items.find((c) => c.conversationId === nid(i, 'u-eve'))).toMatchObject({
      kind: 'dm',
      allowed: false, // a direct message is allowed only for a linked person
      dropped: 1,
    })
    // a dropped event never carries text
    expect(
      JSON.stringify(i.server.conn.sqlite.query('SELECT * FROM ch_events').all()),
    ).not.toContain('psst')
  })
})

describe('inbox: conversations and their logs', () => {
  const setup = async () => {
    const i = instance({ lead: [textStep('Noted.'), textStep('Still here.')] })
    const mock = await connect(i, {
      groups: { room: { label: 'Ops', ack: false }, audit: { wake: 'never', label: 'Audit' } },
      config: NO_WAIT,
    })
    return { i, mock }
  }

  test('lists conversations newest first with counters, preview, agent and allowlist state, paged by cursor', async () => {
    const { i, mock } = await setup()
    const t = Date.now()
    await mock.say({ chat: 'audit', from: ana, text: 'first audit line', id: 'a1', at: t - 3000 })
    await mock.say({ chat: 'audit', from: budi, text: 'second audit line', id: 'a2', at: t - 2000 })
    await mock.say({ from: ana, text: 'some context', id: 'r1', at: t - 1500 })
    await mock.say({
      from: ana,
      text: '@team_bot status?',
      id: 'r2',
      mentionSelf: true,
      at: t - 1000,
    })
    await until('reply', () => mock.sent.length === 1)
    i.gw.pairing.link('c1', 'u-ana', 'owner', 'Ana')
    await mock.say({
      chat: 'u-ana',
      kind: 'dm',
      from: { ...ana, id: 'u-ana' },
      text: 'dm hello',
      id: 'd1',
      at: t,
    })
    await until('dm reply', () => mock.sent.length === 2)

    const all = await i.gw.inbox.conversations('c1', { limit: 10 })
    expect(all.next).toBeUndefined()
    expect(all.items.map((c) => c.conversationId)).toEqual([
      nid(i, 'u-ana'),
      nid(i, 'room'),
      nid(i, 'audit'),
    ])
    const room = all.items.find((c) => c.conversationId === nid(i, 'room'))
    expect(room).toMatchObject({
      kind: 'group',
      title: 'Room',
      agentId: i.leadId,
      allowed: true,
      woke: 1,
      observed: 1,
      dropped: 0,
    })
    expect(room?.preview).toMatchObject({ text: 'Noted.', self: true })
    expect(room?.threadId).toBeString()
    const audit = all.items.find((c) => c.conversationId === nid(i, 'audit'))
    expect(audit).toMatchObject({ woke: 0, observed: 2, allowed: true })
    expect(audit?.preview).toMatchObject({ text: 'second audit line', sender: 'Budi', self: false })
    expect(audit?.threadId).toBeUndefined() // never woke the agent: no thread

    // paging by cursor
    const p1 = await i.gw.inbox.conversations('c1', { limit: 2 })
    expect(p1.items.map((c) => c.conversationId)).toEqual([nid(i, 'u-ana'), nid(i, 'room')])
    expect(p1.next).toBeString()
    const p2 = await i.gw.inbox.conversations('c1', {
      limit: 2,
      ...(p1.next === undefined ? {} : { cursor: p1.next }),
    })
    expect(p2.items.map((c) => c.conversationId)).toEqual([nid(i, 'audit')])
    expect(p2.next).toBeUndefined()
    expect(await i.gw.inbox.conversations('c1', { limit: 5 }).then((r) => r.items.length)).toBe(3)
    expect((await i.gw.inbox.conversations('nobody', { limit: 5 })).items).toEqual([])
  })

  test('the inbox is a view over nodes, messages and events: a linked DM is allowed, it holds no text of its own', async () => {
    const { i, mock } = await setup()
    const t = Date.now()
    await mock.say({ chat: 'audit', from: ana, text: 'audit line', id: 'a1', at: t - 3000 })
    await mock.say({
      from: ana,
      text: '@team_bot status?',
      id: 'r1',
      mentionSelf: true,
      at: t - 2000,
    })
    await until('reply', () => mock.sent.length === 1)
    i.gw.pairing.link('c1', 'u-ana', 'owner', 'Ana')
    await mock.say({
      chat: 'u-ana',
      kind: 'dm',
      from: { ...ana, id: 'u-ana' },
      text: 'dm hi',
      id: 'd1',
      at: t,
    })
    await until('dm reply', () => mock.sent.length === 2)
    const before = await i.gw.inbox.conversations('c1', { limit: 10 })
    expect(before.items.map((c) => c.conversationId).sort()).toEqual(
      [nid(i, 'audit'), nid(i, 'room'), nid(i, 'u-ana')].sort(),
    )
    const dm = before.items.find((c) => c.conversationId === nid(i, 'u-ana'))
    expect(dm).toMatchObject({ allowed: true, woke: 1, dropped: 0, kind: 'dm' })
    expect(dm?.preview).toMatchObject({ self: true })
    expect(dm?.lastAt).toBeGreaterThan(0)
    const msgs = await i.gw.inbox.messages('c1', nid(i, 'u-ana'), { limit: 10 })
    expect(msgs?.items.map((m) => m.text)).toContain('dm hi')
    // reading it twice gives the same answer, and no table of the inbox holds a text
    expect((await i.gw.inbox.conversations('c1', { limit: 10 })).items).toEqual(before.items)
    expect(
      JSON.stringify(i.server.conn.sqlite.query('SELECT * FROM ch_nodes').all()),
    ).not.toContain('dm hi')
    expect(
      JSON.stringify(i.server.conn.sqlite.query('SELECT * FROM ch_events').all()),
    ).not.toContain('dm hi')
  })

  test('the conversation view shows the log in order with replies, edits and deletions marked, paged back', async () => {
    const { i, mock } = await setup()
    const t = Date.now()
    await mock.say({ from: ana, text: 'context one', id: 'm1', at: t - 5000 })
    await mock.say({ from: budi, text: 'context two', id: 'm2', at: t - 4000 })
    await mock.say({
      from: ana,
      text: '@team_bot summarise',
      id: 'm3',
      mentionSelf: true,
      at: t - 3000,
    })
    await until('reply', () => mock.sent.length === 1)
    await mock.userEdit({ from: budi, id: 'm2', text: 'context two (fixed)', at: t })
    await mock.userDelete({ ids: ['m1'], at: t })

    const page = await i.gw.inbox.messages('c1', nid(i, 'room'), { limit: 10 })
    expect(page?.next).toBeUndefined()
    expect(page?.conversation).toMatchObject({
      conversationId: nid(i, 'room'),
      woke: 1,
      observed: 2,
    })
    expect(page?.items.map((m) => [m.platformId, m.disposition ?? 'self', m.self])).toEqual([
      ['m1', 'observed', false],
      ['m2', 'observed', false],
      ['m3', 'woke', false],
      [mock.sent[0]?.messageId as string, 'self', true],
    ])
    expect(page?.items[0]?.deletedAt).toBeNumber()
    expect(page?.items[1]).toMatchObject({
      text: 'context two (fixed)',
      edits: [{ text: 'context two' }],
    })
    expect(page?.items[3]?.text).toBe('Noted.')

    // paged back: the newest page first, "next" is the id to continue from
    const newest = await i.gw.inbox.messages('c1', nid(i, 'room'), { limit: 2 })
    expect(newest?.items.map((m) => m.platformId)).toEqual([
      'm3',
      mock.sent[0]?.messageId as string,
    ])
    expect(newest?.next).toBeString()
    const older = await i.gw.inbox.messages('c1', nid(i, 'room'), {
      limit: 2,
      ...(newest?.next === undefined ? {} : { before: newest.next }),
    })
    expect(older?.items.map((m) => m.platformId)).toEqual(['m1', 'm2'])
    expect(older?.next).toBeUndefined()
    expect(await i.gw.inbox.messages('c1', 'no-such-node', { limit: 5 })).toBeUndefined()
  })

  test('an approval request carries how it ended', async () => {
    const i = instance({
      lead: [sendTo('news', 'Release notes are live.', 'a1'), textStep('Posted it.')],
    })
    const mock = await connect(i, {
      groups: { room: { label: 'Ops', ack: false }, news: { wake: 'never' } },
      config: NO_WAIT,
    })
    i.gw.pairing.link('c1', 'u-ana', 'owner', 'Ana')
    await mock.say({ from: ana, text: '@team_bot publish', id: 'w1', mentionSelf: true })
    await until('the request', () => mock.sent.some((s) => s.message.buttons !== undefined))
    const ask = mock.sent.find((s) => s.message.buttons !== undefined) as (typeof mock.sent)[number]
    let page = await i.gw.inbox.messages('c1', nid(i, 'room'), { limit: 10 })
    expect(page?.items.find((m) => m.platformId === ask.messageId)?.approval).toMatchObject({
      kind: 'approval',
      toolName: 'channel_send',
      status: 'open',
    })
    await mock.press({
      from: ana,
      name: 'approve',
      data: ask.message.buttons?.[0]?.data as string,
      messageId: ask.messageId,
    })
    await until('answered', () => i.gw.approvals.open(sid(i, 'room')).length === 0)
    page = await i.gw.inbox.messages('c1', nid(i, 'room'), { limit: 10 })
    expect(page?.items.find((m) => m.platformId === ask.messageId)?.approval).toMatchObject({
      status: 'answered',
      outcome: 'approved',
    })
  })
})

describe('activity events', () => {
  test('a wake, its reply and the delivery are events, newest first, filterable and paged', async () => {
    const i = instance({ lead: [textStep('Here.')] }, { fastSleep: true })
    const mock = await connect(i, {
      groups: { room: { label: 'Ops', ack: false }, audit: { wake: 'never' } },
      config: NO_WAIT,
    })
    await mock.say({ chat: 'audit', from: ana, text: 'audit line', id: 'a1' })
    await mock.say({ from: ana, text: '@team_bot hi', id: 'w1', mentionSelf: true })
    await until('reply', () => mock.sent.length === 1)
    await until(
      'sent event',
      () => i.gw.activity.list('c1', { type: 'reply-sent', limit: 5 }).items.length === 1,
    )

    const all = i.gw.activity.list('c1', { limit: 50 }).items
    expect(all.map((e) => e.type)).toEqual(['reply-sent', 'reply-queued', 'woke', 'observed'])
    expect(all[3]).toMatchObject({
      conversationId: nid(i, 'audit'),
      peerName: 'Ana Putri',
      reason: 'wake is never here',
    })
    expect(all[2]).toMatchObject({
      conversationId: nid(i, 'room'),
      reason: 'mentioned',
      platformId: 'w1',
      conversationTitle: 'Room',
    })
    expect(all[1]?.detail).toMatchObject({ kind: 'reply', chunks: 1 })
    expect(all[0]?.detail).toMatchObject({ kind: 'reply' })
    // filters
    expect(i.gw.activity.list('c1', { type: 'woke', limit: 5 }).items).toHaveLength(1)
    expect(
      i.gw.activity
        .list('c1', { conversationId: nid(i, 'audit'), limit: 5 })
        .items.map((e) => e.type),
    ).toEqual(['observed'])
    // paging
    const p1 = i.gw.activity.list('c1', { limit: 3 })
    expect(p1.items).toHaveLength(3)
    expect(p1.next).toBeString()
    const p2 = i.gw.activity.list('c1', {
      limit: 3,
      ...(p1.next === undefined ? {} : { before: p1.next }),
    })
    expect(p2.items.map((e) => e.type)).toEqual(['observed'])
    expect(p2.next).toBeUndefined()
    // retention prunes by age and count
    expect(i.gw.activity.prune({ keepLast: 2 })).toBe(2)
    expect(i.gw.activity.list('c1', { limit: 10 }).items).toHaveLength(2)
    // by age everything goes: the two that are left and the two platform events behind them
    expect(i.gw.activity.prune({ olderThan: Date.now() + 1000 })).toBe(4)
  })

  test('retries, failures, approvals and the breaker show up', async () => {
    const i = instance(
      { lead: [sendTo('news', 'Notes.', 'a1'), textStep('Posted.')] },
      { fastSleep: true },
    )
    const mock = await connect(i, {
      groups: { room: { label: 'Ops', ack: false }, news: { wake: 'never' } },
      config: { rate: { chatMinIntervalMs: 0, breakerFailures: 50 } },
    })
    i.gw.pairing.link('c1', 'u-ana', 'owner', 'Ana')
    // the first send fails for a whole round (retry later), then the platform recovers
    mock.failNext(new ChannelError('transient', 'glitch'), 5)
    await mock.say({ from: ana, text: '@team_bot publish', id: 'w1', mentionSelf: true })
    await until('the request', () => mock.sent.some((s) => s.message.buttons !== undefined))
    const types = () => i.gw.activity.list('c1', { limit: 100 }).items.map((e) => e.type)
    expect(types()).toContain('reply-retried')
    expect(types()).toContain('approval-posted')
    const ask = mock.sent.find((s) => s.message.buttons !== undefined) as (typeof mock.sent)[number]
    await mock.press({
      from: ana,
      name: 'approve',
      data: ask.message.buttons?.[0]?.data as string,
      messageId: ask.messageId,
    })
    await until('answered event', () => types().includes('approval-answered'))
    const answered = i.gw.activity.list('c1', { type: 'approval-answered', limit: 5 }).items[0]
    expect(answered).toMatchObject({
      reason: 'approved',
      peerId: 'u-ana',
      detail: { tool: 'channel_send', via: 'chat' },
    })

    // a final failure and the breaker
    const target = i.gw.resolveTarget(i.leadId, undefined, { conversation: 'news' })
    mock.failNext(new ChannelError('invalid', 'chat not found'))
    await expect(i.gw.post(target, { text: 'x' })).rejects.toThrow()
    mock.failNext(new ChannelError('fatal', 'revoked'))
    await expect(i.gw.post(target, { text: 'y' })).rejects.toThrow()
    expect(types()).toContain('reply-failed')
    expect(
      i.gw.activity.list('c1', { type: 'breaker-opened', limit: 5 }).items[0]?.reason,
    ).toContain('revoked')
  })
})

describe('L5: settings inherit down the tree, the log is full, sessions follow nodes', () => {
  test('observe off stores only what addresses the agent; a mention is still stored and wakes', async () => {
    const i = instance({ lead: [textStep('Here.')] })
    const mock = await connect(i, {
      groups: { room: { observe: false, ack: false } },
      config: NO_WAIT,
    })
    await mock.say({ from: ana, text: 'chatter nobody needs', id: 'c1' })
    expect(await i.gw.log.find(nid(i, 'room'), 'c1')).toBeUndefined()
    expect(
      i.gw.activity.list('c1', { type: 'dropped', limit: 5 }).items.map((e) => e.reason),
    ).toEqual(['not-observed'])
    await mock.say({ from: ana, text: '@team_bot hi', id: 'c2', mentionSelf: true })
    await until('the reply', () => mock.sent.length === 1)
    expect((await i.gw.log.find(nid(i, 'room'), 'c2'))?.disposition).toBe('woke')
    // by default (observe on) the same chatter is kept, sealed, for everybody who needs the history
    const other = instance({})
    const m2 = await connect(other)
    await m2.say({ from: ana, text: 'chatter somebody may need', id: 'c1' })
    expect((await other.gw.log.find(nid(other, 'room'), 'c1'))?.disposition).toBe('observed')
  })

  test('a topic inherits the agent and the wake rule of its room; its own agent makes it its own thread', async () => {
    const i = instance({ lead: [textStep('Lead.')], researcher: [textStep('Researcher.')] })
    const mock = await connect(i, {
      groups: {
        room: { wake: 'mention', ack: false, topics: { fin: { agentId: i.researcherId } } },
      },
      config: NO_WAIT,
    })
    await mock.say({ from: ana, text: '@team_bot a', topic: 'ops', id: 'a1', mentionSelf: true })
    await until('lead in a topic of the room', () => mock.sent.length === 1)
    expect(i.gw.sessions.get('c1', nid(i, 'room/ops'))?.agentId).toBe(i.leadId)
    // `fin` routes to another agent, and (an own agent entry on a topic) wakes without a mention
    await mock.say({ from: ana, text: 'quarter numbers?', topic: 'fin', id: 'f1' })
    await until('the researcher answers', () => mock.sent.length === 2)
    expect(mock.sent[1]?.message.text).toBe('Researcher.')
    expect(i.gw.sessions.get('c1', nid(i, 'room/fin'))?.agentId).toBe(i.researcherId)
    expect(i.gw.settings.resolve(nid(i, 'room/fin'))?.origin.agentId).toEqual({
      from: 'node',
      nodeId: nid(i, 'room/fin'),
    })
    expect(i.gw.settings.resolve(nid(i, 'room/fin'))?.origin.wake).toEqual({
      from: 'ancestor',
      nodeId: nid(i, 'room'),
    })
  })

  test('sessionScope room: the topics of a room share one session and one thread', async () => {
    const i = instance({ lead: [textStep('one'), textStep('two')] })
    const mock = await connect(i, {
      groups: { room: { sessionScope: 'room', ack: false, label: 'Ops' } },
      config: NO_WAIT,
    })
    await mock.say({ from: ana, text: 'context in A', topic: 'A', id: 'a0' })
    await mock.say({ from: budi, text: 'context in B', topic: 'B', id: 'b0' })
    await mock.say({ from: ana, text: '@team_bot first', topic: 'A', id: 'a1', mentionSelf: true })
    await until('first reply', () => mock.sent.length === 1)
    await mock.say({ from: ana, text: '@team_bot second', topic: 'B', id: 'b1', mentionSelf: true })
    await until('second reply', () => mock.sent.length === 2)
    // the reply goes to the topic the message was in
    expect(mock.sent.map((s) => s.conversationId)).toEqual(['room/A', 'room/B'])
    // one session row (owned by the room), one thread
    expect(i.gw.sessions.list('c1').map((r) => r.nodeId)).toEqual([nid(i, 'room')])
    expect(i.server.deps.threads.list(i.leadId).filter((t) => t.source === 'channel')).toHaveLength(
      1,
    )
    // the observed messages of both topics reached the same session's first prompt
    const first = JSON.stringify((i.models.lead as ScriptedModel).prompts[0])
    expect(first).toContain('context in A')
    expect(first).toContain('context in B')
  })

  test('retention is inherited: a room keeps the messages of its topics for its own days', async () => {
    const i = instance({})
    const mock = await connect(i, { groups: { room: { retentionDays: 5, topics: { T: {} } } } })
    const day = 86_400_000
    await mock.say({ from: ana, text: 'old', topic: 'T', id: 'o1', at: Date.now() - 6 * day })
    await mock.say({ from: ana, text: 'new', topic: 'T', id: 'o2', at: Date.now() - 4 * day })
    expect(i.gw.settings.resolve(nid(i, 'room/T'))?.retentionDays).toBe(5)
    expect(i.gw.purge()).toBe(1)
    expect(await i.gw.log.find(nid(i, 'room/T'), 'o1')).toBeUndefined()
    expect(await i.gw.log.find(nid(i, 'room/T'), 'o2')).toBeDefined()
  })

  test('events: a replayed press of a button is ignored, node state and access follow member events', async () => {
    const i = instance({})
    const mock = await connect(i)
    await mock.say({ from: ana, text: 'hi', id: 'h1' })
    const room = nid(i, 'room')
    await mock.emit({
      type: 'member.updated',
      dedupeKey: 'm-1',
      at: Date.now(),
      node: {
        nativeId: 'room',
        chain: [{ nativeId: 'room', access: { member: 'admin', canPost: true } }],
      },
      actor: { ...mock.self() },
      role: 'admin',
    })
    expect(i.gw.nodes.access(room)).toMatchObject({ member: 'admin', canPost: true })
    await mock.emit({
      type: 'member.left',
      dedupeKey: 'm-2',
      at: Date.now(),
      node: { nativeId: 'room' },
      actor: { ...mock.self() },
    })
    expect(i.gw.nodes.get(room)).toMatchObject({ state: 'left', stateReason: 'removed' })
    expect(i.gw.nodes.access(room)?.member).toBe('none')
    // a replay of the same event changes nothing and is told so
    const again = await i.gw.handle('c1', {
      type: 'member.left',
      dedupeKey: 'm-2',
      at: Date.now(),
      node: { nativeId: 'room' },
      actor: { ...mock.self() },
    })
    expect(again).toEqual({ action: 'record', reason: 'replay' })
    // posting to a place the connection is not allowed to post in is refused with a reason
    i.gw.nodes.setAccess(room, 'c1', { member: 'member', canPost: false }, Date.now())
    expect(() => i.gw.resolveTarget(i.leadId, undefined, { conversation: 'room' })).toThrow(
      /cannot post/,
    )
  })

  test('reactions are stored with who and what, and removed when taken back', async () => {
    const i = instance({})
    const mock = await connect(i)
    await mock.say({ from: ana, text: 'nice', id: 'r1' })
    const message = await i.gw.log.find(nid(i, 'room'), 'r1')
    const react = (type: 'reaction.added' | 'reaction.removed', key: string) =>
      mock.emit({
        type,
        dedupeKey: key,
        at: Date.now(),
        node: mock.ref('room'),
        actor: budi,
        messageNativeId: 'r1',
        emoji: '👍',
      })
    await react('reaction.added', 'ra')
    const who = i.gw.identities.byNative('c1', budi.id)
    expect(i.gw.log.reactions(message?.id as string)).toEqual([
      expect.objectContaining({ identityId: who?.id, emoji: '👍' }),
    ])
    await react('reaction.removed', 'rb')
    expect(i.gw.log.reactions(message?.id as string)[0]?.removedAt).toBeNumber()
  })
})
