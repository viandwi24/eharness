/**
 * Golden fixtures of the Telegram bot adapter (P41 L5.3): anonymized payload shapes of every kind of
 * chat and update (private chat, group, supergroup, forum topic with General as topic 0,
 * `forum_topic_created` / `edited` / `closed`, channel post, linked discussion group,
 * `migrate_to_chat_id`, edited message, callback query, `my_chat_member`, `chat_member`, anonymous
 * admin) must normalize to the same nodes and events, and the platform neutral gateway must turn
 * those events into the same tree. A new platform needs an adapter and fixtures like these, nothing
 * else.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { webCryptoVault } from 'eharness/providers'
import { scriptedModel } from 'eharness/testing'
import { createMockAdapter } from '../src/infra/channels/index.ts'
import type { RemoteEvent } from '../src/infra/channels/types.ts'
import { scriptedModelConfig } from '../src/infra/eh/provider.ts'
import {
  NORMALIZER_VERSION,
  type Normalized,
  normalizeUpdate,
} from '../src/infra/telegram/normalize.ts'
import { compose, type Server } from '../src/main.ts'
import { ANA, BOT, fixtures } from './fixtures/telegram-updates.ts'

const ctx = {
  botId: BOT.id,
  botUsername: BOT.username,
  download: async () => ({ bytes: new Uint8Array() }),
}

/** Events as plain data: no raw payload, attachments as a count (they carry a download function). */
const plain = (n: Normalized): unknown[] =>
  JSON.parse(
    JSON.stringify(
      n.events.map((e) => ({
        ...e,
        raw: undefined,
        ...('message' in e && 'attachments' in e.message
          ? { message: { ...e.message, attachments: e.message.attachments.length } }
          : {}),
      })),
    ),
  )

const norm = (name: keyof typeof fixtures): Normalized => normalizeUpdate(fixtures[name](), ctx)
/** `[native id, kind, title]` of the chain of an event, leaf first. */
const chainOf = (
  e: RemoteEvent | undefined,
): Array<[string, string | undefined, string | undefined]> =>
  (e?.node?.chain ?? []).map((c) => [c.nativeId, c.kind, c.title as string | undefined])

const FORUM = '-1001234500002'
const SUPER = '-1001234500001'
const CHANNEL = '-1001234500003'
const DISCUSSION = '-1001234500004'

describe('golden: nodes and events of every update shape', () => {
  test('the normalizer version is part of the contract', () => {
    expect(NORMALIZER_VERSION).toBe(1)
  })

  test('private chat: a direct node keyed by the user id', () => {
    expect(plain(norm('privateMessage'))).toEqual([
      {
        type: 'message.created',
        dedupeKey: 'tg:upd:5001',
        at: 1_760_000_000_000,
        node: {
          nativeId: '1001',
          chain: [
            {
              nativeId: '1001',
              kind: 'direct',
              platformType: 'telegram:private',
              title: 'Ana Putri',
              traits: { multiUser: false, threading: 'none' },
              meta: { chatId: '1001', username: 'ana' },
            },
          ],
        },
        message: {
          nativeId: '11',
          sender: { id: '1001', name: 'Ana Putri', username: 'ana' },
          text: 'status please',
          attachments: 0,
          sortKey: '000000000011',
        },
        signals: { mentionedSelf: false, replyToSelf: false },
      },
    ])
  })

  test('group and supergroup: rooms; mentions are entities and signals relative to the bot', () => {
    const group = norm('groupMessage').events[0]
    expect(chainOf(group)).toEqual([['-4005', 'room', 'Ops Team']])
    expect(group).toMatchObject({
      node: { chain: [{ platformType: 'telegram:group', traits: { multiUser: true } }] },
      signals: { mentionedSelf: true, mentionedOthers: true, replyToSelf: false },
      message: {
        entities: [
          { type: 'mention', offset: 3, length: 14, handle: 'team_test_bot' },
          { type: 'mention', offset: 22, length: 8, handle: 'someone' },
        ],
      },
    })
    const sup = norm('supergroupMessage').events[0]
    expect(chainOf(sup)).toEqual([[SUPER, 'room', 'Engineering']])
    expect(sup).toMatchObject({
      node: { chain: [{ platformType: 'telegram:supergroup', meta: { username: 'eng_chat' } }] },
      message: {
        replyTo: {
          messageId: '30',
          senderId: '1001',
          senderName: 'Ana Putri',
          text: 'earlier message',
        },
        entities: [
          { type: 'link', url: 'https://example.com/a' },
          { type: 'bold', offset: 34, length: 6 },
        ],
      },
    })
  })

  test('forum: a topic is a thread node under a container that holds no messages; General is topic 0', () => {
    const topic = norm('forumTopicMessage').events[0]
    expect(chainOf(topic)).toEqual([
      [`${FORUM}/40`, 'thread', 'Billing'],
      [FORUM, 'room', 'Company'],
    ])
    expect(topic).toMatchObject({
      node: {
        chain: [
          { parent: FORUM, meta: { topicId: 40 } },
          {
            traits: { container: true, postable: false, threading: 'node' },
            meta: { isForum: true },
          },
        ],
      },
      // the first message of a topic is not a reply to anybody
      signals: { replyToSelf: false },
    })
    expect(topic?.type === 'message.created' && topic.message.replyTo).toBeUndefined()
    const general = norm('forumGeneralMessage').events[0]
    expect(chainOf(general)).toEqual([
      [`${FORUM}/0`, 'thread', 'General'],
      [FORUM, 'room', 'Company'],
    ])
  })

  test('forum_topic_created / edited / closed / reopened are node events with patch semantics', () => {
    const created = norm('forumTopicCreated').events
    expect(created.map((e) => e.type)).toEqual(['node.created'])
    expect(chainOf(created[0])).toEqual([
      [`${FORUM}/50`, 'thread', 'Roadmap'],
      [FORUM, 'room', 'Company'],
    ])
    const edited = norm('forumTopicEdited').events[0]
    expect(edited?.type).toBe('node.updated')
    expect(edited?.node?.chain?.[0]?.title).toBe('Roadmap 2026')
    const closed = norm('forumTopicClosed').events[0]
    expect(closed).toMatchObject({ type: 'node.state_changed', state: 'closed' })
    // a state change does not say the name: the title is left unchanged, not cleared
    expect(closed?.node?.chain?.[0]).not.toHaveProperty('title')
    expect(norm('forumTopicReopened').events[0]).toMatchObject({
      type: 'node.state_changed',
      state: 'active',
    })
  })

  test('channel post: a broadcast room, the sender is the channel itself; an edit is an edit event', () => {
    const post = norm('channelPost').events[0]
    expect(post).toMatchObject({
      type: 'message.created',
      node: {
        nativeId: CHANNEL,
        chain: [
          {
            kind: 'room',
            platformType: 'telegram:channel',
            traits: { broadcast: true, multiUser: false },
          },
        ],
      },
      message: { sender: { id: `chat:${CHANNEL}`, name: 'Company News', kind: 'channel' } },
    })
    expect(norm('editedChannelPost').events[0]).toMatchObject({
      type: 'message.edited',
      message: { nativeId: '61', text: 'We shipped version 2.1', sender: { kind: 'channel' } },
    })
  })

  test('linked discussion group: the forwarded post makes the group a discussion of the channel', () => {
    const [channel, forwarded] = norm('discussionAutoForward').events
    // the channel node is told first, so the gateway can link to it
    expect(channel).toMatchObject({ type: 'node.updated', node: { nativeId: CHANNEL } })
    expect(forwarded).toMatchObject({
      type: 'message.created',
      node: {
        nativeId: DISCUSSION,
        chain: [{ links: [{ rel: 'discussion_of', to: CHANNEL }] }],
      },
      message: {
        sender: { kind: 'channel' },
        forwardOf: { type: 'channel', chat: CHANNEL, messageId: '61' },
      },
    })
    // a comment is a reply chain, not a node: the thread root is a relation
    expect(norm('discussionComment').events[0]).toMatchObject({
      node: { nativeId: DISCUSSION },
      message: { threadRoot: '71', replyTo: { messageId: '71' } },
    })
  })

  test('migrate_to_chat_id: the new id is the node, the old one is named', () => {
    expect(norm('migrateTo').events[0]).toMatchObject({
      type: 'node.migrated',
      from: '-4005',
      node: {
        nativeId: '-1001234500009',
        chain: [{ platformType: 'telegram:supergroup', title: 'Ops Team' }],
      },
    })
  })

  test('edited message, callback query (an action in its topic), reactions', () => {
    expect(norm('editedMessage').events[0]).toMatchObject({
      type: 'message.edited',
      node: { nativeId: '-4005' },
      message: { nativeId: '21', text: 'hi @team_test_bot, corrected', sender: { id: '1001' } },
    })
    const cb = norm('callbackQuery')
    expect(cb.callbackId).toBe('cb-1')
    expect(cb.events[0]).toMatchObject({
      type: 'action',
      name: 'approve',
      data: 'row-9',
      messageNativeId: '91',
      actor: { id: '1001' },
      node: { nativeId: `${FORUM}/40` },
    })
    const reactions = norm('reaction').events
    expect(reactions.map((e) => [e.type, 'emoji' in e ? e.emoji : ''])).toEqual([
      ['reaction.added', '🔥'],
      ['reaction.removed', '👍'],
    ])
    // two events of one update must not share a dedupe key
    expect(new Set(reactions.map((e) => e.dedupeKey)).size).toBe(2)
  })

  test('my_chat_member and chat_member: what the bot is in a chat, who joined', () => {
    expect(norm('botPromoted').events[0]).toMatchObject({
      type: 'member.updated',
      role: 'admin',
      actor: { id: '777', isSelf: true, kind: 'bot' },
      node: { chain: [{ access: { member: 'admin', canPost: true }, state: 'active' }] },
    })
    expect(norm('botRemoved').events[0]).toMatchObject({
      type: 'member.left',
      role: 'none',
      node: {
        chain: [
          { access: { member: 'none', canPost: false }, state: 'left', stateReason: 'kicked' },
        ],
      },
    })
    expect(norm('memberJoined').events[0]).toMatchObject({
      type: 'member.joined',
      role: 'member',
      actor: { id: '1002' },
    })
  })

  test('anonymous admin: the sender is the group itself, never a person', () => {
    expect(norm('anonymousAdmin').events[0]).toMatchObject({
      message: { sender: { id: `chat:${SUPER}`, kind: 'anonymous', name: 'Engineering' } },
    })
  })

  test('every event of every fixture has a unique dedupe key per update', () => {
    const keys = new Set<string>()
    for (const name of Object.keys(fixtures) as Array<keyof typeof fixtures>) {
      for (const e of norm(name).events) {
        expect(keys.has(e.dedupeKey)).toBe(false)
        keys.add(e.dedupeKey)
        expect(e.dedupeKey.startsWith('tg:upd:')).toBe(true)
      }
    }
  })
})

describe('golden: the gateway builds the tree from those events', () => {
  const servers: Server[] = []
  const dirs: string[] = []
  afterEach(async () => {
    for (const s of servers.splice(0)) await s.close()
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  test('forum, topics, General, channel and its discussion, migration, states and identities', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'team-golden-'))
    dirs.push(dir)
    const server = compose({
      dbFile: join(dir, 'team.db'),
      env: {},
      models: scriptedModelConfig(scriptedModel([])),
      reconcile: { onBoot: false, everyMs: 0 },
      routines: { tickMs: 0 },
      channels: { vault: webCryptoVault(new Uint8Array(32).fill(3)), purgeEveryMs: 0 },
    })
    servers.push(server)
    const gw = server.channels
    const lead = server.deps.agents.getBySlug('lead') as { id: string }
    // an open policy: every chat the bot is in is allowed, so everything below is stored
    gw.configure({ connectionId: 'tg', agentId: lead.id, groupPolicy: 'open' })
    // an adapter of any platform: the gateway only sees the events
    const adapter = createMockAdapter({ connectionId: 'tg', self: { id: String(BOT.id) } })
    await gw.register(adapter)

    for (const name of [
      'forumTopicCreated',
      'forumTopicMessage',
      'forumGeneralMessage',
      'forumTopicEdited',
      'forumTopicClosed',
      'channelPost',
      'discussionAutoForward',
      'discussionComment',
      'botPromoted',
      'anonymousAdmin',
      'privateMessage',
    ] as const) {
      for (const e of norm(name).events) await gw.handle('tg', e)
    }
    const node = (native: string) => {
      const n = gw.nodes.byNative('tg', native)
      if (n === undefined) throw new Error(`no node ${native}`)
      return n
    }

    // the forum is a container with its topics as children; General is a child too
    const forum = node(FORUM)
    expect(forum).toMatchObject({
      kind: 'room',
      parentId: null,
      traits: { container: true, postable: false, threading: 'node' },
      title: 'Company',
    })
    expect(
      gw.nodes
        .children(forum.id)
        .map((c) => [c.nativeId, c.title, c.state])
        .sort(),
    ).toEqual([
      [`${FORUM}/0`, 'General', 'active'],
      [`${FORUM}/40`, 'Billing', 'active'],
      [`${FORUM}/50`, 'Roadmap 2026', 'closed'],
    ])
    expect(node(`${FORUM}/40`).path).toBe(`${forum.path}/${node(`${FORUM}/40`).id}`)
    // the topic was named by its creation, renamed by an edit and closed without losing the name
    expect(node(`${FORUM}/50`)).toMatchObject({ title: 'Roadmap 2026', state: 'closed' })
    // messages live in topics; the forum itself holds none
    const billing = await gw.log.recent(node(`${FORUM}/40`).id, { limit: 5 })
    expect(billing.map((m) => [m.nativeId, m.text, m.sender?.name])).toEqual([
      ['41', 'billing question', 'Ana Putri'],
    ])
    expect((await gw.log.recent(node(`${FORUM}/0`).id, { limit: 5 })).map((m) => m.text)).toEqual([
      'general chat',
    ])
    expect(await gw.log.recent(forum.id, { limit: 5 })).toEqual([])

    // the channel, its discussion group and the link between them
    expect(node(CHANNEL).traits.broadcast).toBe(true)
    expect(gw.nodes.links(node(DISCUSSION).id)).toEqual([
      expect.objectContaining({
        fromNodeId: node(DISCUSSION).id,
        toNodeId: node(CHANNEL).id,
        rel: 'discussion_of',
      }),
    ])

    // the bot's access to a chat comes from my_chat_member
    expect(gw.nodes.access(node(SUPER).id)).toMatchObject({ member: 'admin', canPost: true })
    // identities: a person, a channel speaking as itself, an anonymous admin
    expect(gw.identities.byNative('tg', `chat:${CHANNEL}`)?.kind).toBe('channel')
    expect(gw.identities.byNative('tg', `chat:${SUPER}`)?.kind).toBe('anonymous')
    expect(gw.identities.byNative('tg', String(ANA.id))?.kind).toBe('human')

    // a topic inherits what its forum sets; closing a topic keeps its settings
    gw.settings.set(forum.id, { wake: 'never' })
    expect(gw.settings.resolve(node(`${FORUM}/40`).id)).toMatchObject({
      allowed: true,
      wake: 'never',
    })

    // a replayed update is recognized by its dedupe key; the group became a supergroup: sessions follow
    const migrated = norm('migrateTo').events[0] as RemoteEvent
    await gw.handle('tg', fixtureOfGroup())
    gw.settings.set(node('-4005').id, { enabled: true, label: 'Ops' })
    await gw.handle('tg', migrated)
    await gw.handle('tg', migrated)
    expect(node('-4005')).toMatchObject({ state: 'deleted', stateReason: 'migrated' })
    expect(gw.nodes.links(node('-1001234500009').id)).toEqual([
      expect.objectContaining({ rel: 'migrated_from', toNodeId: node('-4005').id }),
    ])
    // settings carried over to the new id
    expect(gw.settings.get(node('-1001234500009').id)).toMatchObject({
      enabled: true,
      label: 'Ops',
    })
    expect(gw.events.count('tg', 'node.migrated')).toBe(1)
  })
})

/** A first message in the basic group, so the node exists before it migrates. */
function fixtureOfGroup(): RemoteEvent {
  return normalizeUpdate(fixtures.groupMessage(), ctx).events[0] as RemoteEvent
}
