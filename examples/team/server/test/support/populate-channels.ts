/**
 * Fills the CHANNELS, PEOPLE and REMINDERS features of a composed server for the backup tests:
 * a chat connection on the in-memory mock adapter (bound to an agent), chats and a topic, people
 * who wrote in them, roles and notes through the real directory ports, proactive posts, channel and
 * web reminders (one of them already fired), a Telegram user account's settings, and a person with
 * linked accounts. Message logs are NOT part of it.
 *
 * Real paths: the gateway (`configure`, `register`, `settings`, `people`, `notes`, `reminders`,
 * `proactive`, `identities`, `sessions`, `directory`) and the mock adapter's `say()`. Two spots use
 * a store or SQL because only a live transport writes them (see the comments at `tgu_chats`).
 */
import { createMockAdapter, type MockAdapter } from '../../src/infra/channels/index.ts'
import { sqliteSettingsStore } from '../../src/infra/telegram-user/store.ts'
import type { Server } from '../../src/main.ts'
import type { BaseWorld } from './backup-world.ts'

export interface ChannelsWorld {
  /** The mock chat connection (bound to the analyst). */
  connectionId: string
  /** The Telegram user account connection (settings and chat row only; no live client). */
  userConnectionId: string
  /** Chat (room) node. */
  chatNodeId: string
  /** A topic (thread) of the chat. */
  topicNodeId: string
  /** A second chat that is a discussion of the first (linked). */
  discussionNodeId: string
  /** A direct chat node. */
  directNodeId: string
  /** Identity ids (ours) of the people who wrote. */
  identityIds: { ana: string; budi: string; sari: string }
  /** The person linked to a platform account (the directory person of the base world). */
  personId: string
  /** A second person made here, with two accounts. */
  secondPersonId: string
  /** The held proactive post. */
  proactiveId: string
  /** Active reminder in the chat (repeating, has a sys:reminder routine). */
  activeReminderId: string
  /** Reminder already fired (done). */
  doneReminderId: string
  /** Active web (thread) reminder. */
  webReminderId: string
  mock: MockAdapter
}

const ana = {
  id: 'u-ana',
  name: 'Ana Pütri 🌿',
  username: 'ana_example',
  aliases: [
    { kind: 'phone', value: '+620000000001' },
    { kind: 'lid', value: 'lid-ana-1' },
  ],
  profile: { nick: 'Ana (ops)', roles: ['moderator', 'ünïcode'] },
}
const budi = { id: 'u-budi', name: 'Budi Example', username: 'budi_example' }
const sari = { id: 'u-sari', name: 'Sari Example' }

export async function populateChannels(server: Server, world: BaseWorld): Promise<ChannelsWorld> {
  const gw = server.channels
  const connectionId = 'mock-1'
  const userConnectionId = 'tgu-1'

  gw.configure({
    connectionId,
    agentId: world.analystId,
    people: { defaultRole: 'member', policy: {} },
  })
  // the second connection stands in for a Telegram user account: a mock transport, no live client
  gw.configure({ connectionId: userConnectionId, agentId: world.leadId })
  await gw.register(createMockAdapter({ connectionId: userConnectionId }))
  const mock = createMockAdapter({ connectionId })
  await gw.register(mock)

  // chats and a topic, switched on but observe-only (no model is ever called)
  const room = gw.settings.ensureNode(connectionId, {
    nativeId: 'ops-room',
    kind: 'room',
    title: 'Ops 🛠',
  })
  gw.settings.set(room.id, {
    enabled: true,
    label: 'Ops',
    wake: 'never',
    retentionDays: 30,
    proactive: { allowed: true, digestMinutes: 10, maxMentions: 2 },
  })
  const topic = gw.settings.ensureNode(
    connectionId,
    { nativeId: 'ops-room/billing', kind: 'thread', title: 'Billing' },
    'ops-room',
  )
  gw.settings.set(topic.id, { wake: 'never', agentId: world.leadId })
  const discussion = gw.settings.ensureNode(connectionId, {
    nativeId: 'ops-discussion',
    kind: 'room',
    title: 'Ops discussion',
  })
  gw.nodes.link(discussion.id, room.id, 'discussion_of', { source: 'populate', note: 'ünï' })
  gw.nodes.setAccess(
    room.id,
    connectionId,
    { member: 'admin', canPost: true, canRead: true, muted: false, lastReadNativeId: '3' },
    Date.now(),
  )
  gw.nodes.setAccess(
    discussion.id,
    connectionId,
    { member: 'member', canPost: null, canRead: null, muted: true },
    Date.now(),
  )

  // people write in the chat (the gateway records nodes, identities, aliases, profiles, members)
  await mock.say({ chat: 'ops-room', kind: 'group', from: ana, text: 'Morning team', id: 'm1' })
  await mock.say({
    chat: 'ops-room',
    topic: 'billing',
    kind: 'group',
    from: budi,
    text: 'Invoice 42 is overdue',
    id: 'm2',
  })
  await mock.say({ chat: 'ops-room', kind: 'group', from: sari, text: 'Hello', id: 'm3' })
  const identityOf = (nativeId: string): string => {
    const row = gw.identities.byNative(connectionId, nativeId)
    if (row === undefined) throw new Error(`identity ${nativeId} missing`)
    return row.id
  }
  const identityIds = {
    ana: identityOf(ana.id),
    budi: identityOf(budi.id),
    sari: identityOf(sari.id),
  }
  gw.identities.setMembership(room.id, identityIds.ana, {
    role: 'admin',
    joinedAt: Date.now() - 1000,
  })
  gw.identities.setMembership(room.id, identityIds.sari, {
    role: 'member',
    joinedAt: Date.now() - 2000,
    leftAt: Date.now() - 500,
  })
  // a direct chat from somebody not linked yet (counts the DM, never the text)
  const direct = gw.settings.ensureNode(connectionId, {
    nativeId: 'dm-sari',
    kind: 'direct',
    title: 'Sari Example',
  })
  gw.identities.noteDirect(identityIds.sari, Date.now())

  // the session of the chat (bound to an agent)
  gw.sessions.ensure(
    { connectionId, nodeId: room.id, agentId: world.analystId, label: 'Ops chat' },
    Date.now(),
  )

  // people directory of the connection: roles, divisions, notes
  gw.people.setRole(connectionId, ana.id, { role: 'admin', divisions: [topic.id] }, 'owner')
  gw.people.setRole(connectionId, budi.id, { role: 'guest' }, 'owner')
  gw.notes.set(
    connectionId,
    identityIds.ana,
    'Prefers short messages, writes in English',
    'owner',
    Date.now(),
  )
  gw.notes.set(connectionId, identityIds.budi, 'Finance contact ünï', undefined, Date.now())

  // the people directory (persons and platform accounts, with their history)
  const people = server.deps.people
  await people.link(world.personId, { connectionId, peerId: 'u-dewi', label: 'work chat' })
  const second = await people.create({
    displayName: 'Rina Example',
    nickname: 'Rin',
    role: 'member',
    divisions: [topic.id],
    fields: { branch: 'South', phone: null },
    notes: 'Second person',
  })
  await people.link(second.id, { connectionId, peerId: 'u-rina' })
  await people.link(second.id, {
    connectionId: userConnectionId,
    peerId: '777001',
    label: 'user account',
  })
  await people.update(second.id, { notes: 'Second person, updated', status: 'active' })

  // proactive: the first goes out, the next is held by the digest
  const submit = (text: string) =>
    gw.proactive.submit({
      connectionId,
      nodeId: room.id,
      agentId: world.analystId,
      text,
      mentions: [identityIds.ana],
    })
  await submit('Weekly numbers are ready')
  const held = await submit('Margin is flat, see the report')
  if (held.status !== 'held') throw new Error(`proactive was ${held.status}: ${held.message}`)
  const proactiveRow = server.conn.sqlite
    .query<{ id: string }, []>("SELECT id FROM ch_proactive WHERE status = 'held' LIMIT 1")
    .get()
  if (proactiveRow === null) throw new Error('no held proactive post')

  // reminders: a repeating one (active), a single one that fires (done), a web one
  const made = (r: { reminder: { id: string } } | { error: string }): string => {
    if ('error' in r) throw new Error(r.error)
    return r.reminder.id
  }
  const activeReminderId = made(
    gw.reminders.create({
      connectionId,
      nodeId: topic.id,
      agentId: world.analystId,
      text: 'Send the weekly report ünï',
      mentions: [identityIds.ana],
      when: { repeat: 'weekdays', time: '09:00' },
      createdBy: { identityId: identityIds.ana, name: ana.name, role: 'admin' },
    }),
  )
  const doneReminderId = made(
    gw.reminders.create({
      connectionId,
      nodeId: room.id,
      agentId: world.analystId,
      text: 'Stand-up in five minutes',
      mentions: [],
      when: { inMinutes: 5 },
    }),
  )
  await gw.reminders.fire(doneReminderId, { slot: Date.now() })
  const webReminderId = made(
    gw.reminders.createInThread({
      sessionId: 'thread-populate-channels',
      agentId: world.analystId,
      text: 'Call the vendor',
      when: { repeat: 'daily', time: '16:30' },
      createdBy: { name: 'Dewi Example', role: 'owner' },
    }),
  )

  // Telegram user account: its settings through the store (a live MTProto client is not needed)
  sqliteSettingsStore(server.conn.sqlite).set(userConnectionId, {}, Date.now())

  // `tgu_chats` is a LEGACY table: only the migration of old databases reads it and nothing writes
  // it any more, so this one row is raw SQL (the shape the old transport wrote).
  server.conn.sqlite
    .query(
      `INSERT INTO tgu_chats (connection_id, chat_id, kind, title, username, forum, admin, selected, high_id, first_live_id, backfill_days, backfill_state,
         backfill_oldest_id, backfill_oldest_at, backfill_count, parked_until, admin_log_enabled, admin_log_last_id, admin_log_last_at, admin_log_count, updated_at)
       VALUES (?, '-100777', 'group', 'Audit ünï', 'audit_chat', 0, 1, 1, 900, 800, 30, 'done', 640, ?, 260, NULL, 1, '555', ?, 7, ?)`,
    )
    .run(userConnectionId, Date.now() - 86_400_000, Date.now(), Date.now())

  return {
    connectionId,
    userConnectionId,
    chatNodeId: room.id,
    topicNodeId: topic.id,
    discussionNodeId: discussion.id,
    directNodeId: direct.id,
    identityIds,
    personId: world.personId,
    secondPersonId: second.id,
    proactiveId: proactiveRow.id,
    activeReminderId,
    doneReminderId,
    webReminderId,
    mock,
  }
}
