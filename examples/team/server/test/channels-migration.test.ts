/**
 * The data migration of L5: a database as L1-L4 left it (conversations, sealed messages, inbox,
 * events, known chats, links, an outbox row, an account's chats) becomes nodes, settings,
 * identities, sessions, messages and events when the new code boots on it. Idempotent; old tables
 * stay (read by nothing).
 */

import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'
import { webCryptoVault } from 'eharness/providers'
import { scriptedModel } from 'eharness/testing'
import {
  migrateLegacyMessages,
  migrateLegacyStructure,
} from '../src/infra/channels/legacy-migration.ts'
import { scriptedModelConfig } from '../src/infra/eh/provider.ts'
import { compose, type Server } from '../src/main.ts'

const KEY = new Uint8Array(32).fill(9)
const vault = webCryptoVault(KEY)
const DRIZZLE = new URL('../drizzle', import.meta.url).pathname
const servers: Server[] = []
const dirs: string[] = []
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** A database at migration 0025: the migrations of the repo up to the last one before L5. */
function oldDatabase(file: string): Database {
  const journal = JSON.parse(readFileSync(join(DRIZZLE, 'meta/_journal.json'), 'utf8')) as {
    entries: Array<{ idx: number; tag: string }>
    [k: string]: unknown
  }
  const before = journal.entries.filter((e) => e.idx <= 25)
  const tmp = mkdtempSync(join(tmpdir(), 'team-oldmig-'))
  dirs.push(tmp)
  mkdirSync(join(tmp, 'meta'))
  for (const e of before) cpSync(join(DRIZZLE, `${e.tag}.sql`), join(tmp, `${e.tag}.sql`))
  writeFileSync(join(tmp, 'meta/_journal.json'), JSON.stringify({ ...journal, entries: before }))
  const db = new Database(file, { create: true, strict: true })
  db.run('PRAGMA journal_mode = WAL')
  migrate(drizzle({ client: db }), { migrationsFolder: tmp })
  return db
}

interface OldBody {
  sender?: { id: string; name?: string; username?: string; isBot?: boolean; isSelf?: boolean }
  text: string
  attachments?: Array<{
    id: string
    kind?: string
    name?: string
    mediaType?: string
    size?: number
  }>
  replyTo?: { messageId: string; senderName?: string; text?: string }
  edits?: Array<{ at: number; text: string }>
}

/** Recent enough that the retention at boot (30 days, 3 for one topic) keeps everything. */
const T0 = Date.now() - 36 * 3_600_000

/** Everything the old code wrote, for a bot connection `c1` and an account `acc1`. */
async function seed(db: Database): Promise<{ messageIds: string[] }> {
  const run = (sql: string, ...args: unknown[]): void =>
    void db.query(sql).run(...(args as never[]))
  const ref = (container: string, kind: string, title: string, topic?: string) =>
    JSON.stringify({
      id: topic === undefined ? container : `${container}/${topic}`,
      connectionId: 'c1',
      container,
      ...(topic === undefined ? {} : { topic }),
      kind,
      title,
    })
  run(
    'INSERT INTO channel_connections (connection_id, config, updated_at) VALUES (?, ?, ?)',
    'c1',
    JSON.stringify({
      connectionId: 'c1',
      agentId: 'lead-agent',
      groupPolicy: 'allowlist',
      groups: {
        '-100200': { enabled: true, wake: 'mention', retentionDays: 14, label: 'Ops' },
        '-100300': {
          wake: 'always',
          ack: false,
          topics: { '7': { wake: 'never' }, '8': { enabled: false } },
        },
        '*': { delivery: 'message_tool' },
      },
      defaults: { retentionDays: 30 },
    }),
    T0,
  )
  run(
    'INSERT INTO channel_connections (connection_id, config, updated_at) VALUES (?, ?, ?)',
    'acc1',
    JSON.stringify({
      connectionId: 'acc1',
      agentId: 'lead-agent',
      groups: { '-100500': { enabled: true, wake: 'never', label: 'Audit' } },
    }),
    T0,
  )

  // chats the bot knows: a group, a forum with a topic, a channel
  for (const [chat, kind, title, forum, topics, status] of [
    ['-100200', 'group', 'Ops', 0, '{}', 'administrator'],
    ['-100300', 'group', 'Company', 1, '{"5":"Billing"}', 'member'],
    ['-100400', 'channel', 'News', 0, '{}', 'kicked'],
  ] as const) {
    run(
      `INSERT INTO channel_known_chats (connection_id, chat_id, kind, title, username, forum, topics, bot_status, can_post, first_seen, last_seen)
       VALUES ('c1', ?, ?, ?, NULL, ?, ?, ?, 1, ?, ?)`,
      chat,
      kind,
      title,
      forum,
      topics,
      status,
      T0,
      T0 + 5000,
    )
  }
  // conversations the agent was woken in (sessions keep their key)
  for (const [conv, session, label, r, retention] of [
    ['-100200', 'channel:c1:-100200', 'Ops', ref('-100200', 'group', 'Ops'), null],
    ['-100300/7', 'channel:c1:-100300/7', 'Company', ref('-100300', 'group', 'Company', '7'), 3],
    ['-100300', 'channel:c1:-100300', 'Company', ref('-100300', 'group', 'Company'), null],
    ['42', 'channel:c1:42', 'Ana', ref('42', 'dm', 'Ana'), null],
  ] as const) {
    run(
      `INSERT INTO channel_conversations (connection_id, conversation_id, session_id, agent_id, ref, label, retention_days, created_at, generation)
       VALUES ('c1', ?, ?, 'lead-agent', ?, ?, ?, ?, 0)`,
      conv,
      session,
      r,
      label,
      retention,
      T0 + 100,
    )
    run(
      `INSERT INTO channel_inbox (connection_id, conversation_id, ref, woke, observed, dropped, first_at, last_at)
       VALUES ('c1', ?, ?, 1, 1, 0, ?, ?)`,
      conv,
      r,
      T0 + 100,
      T0 + 9000,
    )
  }
  // a conversation that only ever dropped messages
  run(
    `INSERT INTO channel_inbox (connection_id, conversation_id, ref, woke, observed, dropped, first_at, last_at)
     VALUES ('c1', 'stranger', ?, 0, 0, 3, ?, ?)`,
    ref('stranger', 'group', 'Strangers'),
    T0 + 50,
    T0 + 60,
  )

  // sealed messages as the old log wrote them (context `channel-message:<id>`)
  const ids: string[] = []
  const put = async (
    id: string,
    conv: string,
    platformId: string,
    at: number,
    over: {
      self?: boolean
      body: OldBody
      pending?: boolean
      disposition?: string
      deleted?: boolean
      edited?: number
      rev: number
    },
  ): Promise<void> => {
    ids.push(id)
    run(
      `INSERT INTO channel_messages (id, connection_id, conversation_id, platform_id, at, self, pending, handled, edited_at, deleted_at, rev, disposition, body)
       VALUES (?, 'c1', ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
      id,
      conv,
      platformId,
      at,
      over.self === true ? 1 : 0,
      over.pending === true ? 1 : 0,
      over.edited ?? null,
      over.deleted === true ? at + 1 : null,
      over.rev,
      over.disposition ?? null,
      await vault.seal(JSON.stringify(over.body), `channel-message:${id}`),
    )
  }
  const ana = { id: '42', name: 'Ana Putri', username: 'ana' }
  const budi = { id: '43', name: 'Budi' }
  const bot = { id: '777', name: 'Team Bot', username: 'team_bot', isBot: true, isSelf: true }
  await put('01900000-0000-7000-8000-000000000001', '-100200', '1', T0 + 1000, {
    body: { sender: ana, text: 'deploy failed twice' },
    pending: true,
    disposition: 'observed',
    rev: 1,
  })
  await put('01900000-0000-7000-8000-000000000002', '-100200', '2', T0 + 2000, {
    body: {
      sender: budi,
      text: 'seen it, fixing (v2)',
      edits: [
        { at: T0 + 2500, text: 'seen it' },
        { at: T0 + 2600, text: 'seen it, fixing' },
      ],
      replyTo: { messageId: '1', senderName: 'Ana Putri', text: 'deploy failed twice' },
    },
    edited: T0 + 2600,
    disposition: 'woke',
    rev: 3,
  })
  await put('01900000-0000-7000-8000-000000000003', '-100200', '3', T0 + 3000, {
    self: true,
    body: { sender: bot, text: 'Looking into it.' },
    rev: 4,
  })
  await put('01900000-0000-7000-8000-000000000004', '-100300/7', '9', T0 + 4000, {
    body: {
      sender: ana,
      text: 'a photo for the topic',
      attachments: [{ id: 'f1', kind: 'image', name: 'x.png', mediaType: 'image/png', size: 12 }],
    },
    disposition: 'observed',
    deleted: true,
    rev: 5,
  })
  await put('01900000-0000-7000-8000-000000000005', '-100300', '70', T0 + 5000, {
    body: { sender: ana, text: 'general chat of the forum' },
    disposition: 'woke',
    rev: 6,
  })
  await put('01900000-0000-7000-8000-000000000006', '42', '100', T0 + 6000, {
    body: { sender: ana, text: 'a direct message' },
    disposition: 'woke',
    rev: 7,
  })

  run(
    `INSERT INTO channel_events (id, connection_id, at, type, reason, conversation_id, peer_id, peer_name, platform_id, detail)
     VALUES ('01900000-0000-7000-8000-0000000000e1', 'c1', ?, 'woke', 'mentioned', '-100200', '42', 'Ana Putri', '2', NULL),
            ('01900000-0000-7000-8000-0000000000e2', 'c1', ?, 'dropped', 'chat-not-allowed', 'stranger', '99', 'Eve', NULL, '{"kind":"group"}')`,
    T0 + 2000,
    T0 + 55,
  )

  // linking: Ana is the owner; Eve wrote and is not linked (ignored)
  run(
    "INSERT INTO channel_identities (connection_id, peer_id, member_id, name, linked_at) VALUES ('c1', '42', 'owner', 'Ana Putri', ?)",
    T0 + 10,
  )
  run(
    "INSERT INTO channel_unlinked (connection_id, peer_id, name, username, first_seen, last_seen, message_count, ignored) VALUES ('c1', '99', 'Eve', 'eve', ?, ?, 4, 1)",
    T0 + 20,
    T0 + 30,
  )

  // an outbox row still waiting, and an approval announced in the group
  run(
    `INSERT INTO channel_outbox (id, connection_id, conversation_id, session_id, kind, trigger_id, chunk_index, chunk_count, body, status, attempts, next_at, created_at, updated_at)
     VALUES ('01900000-0000-7000-8000-0000000000a1', 'c1', '-100200', 'channel:c1:-100200', 'reply', '2', 0, 1, ?, 'pending', 0, 0, ?, ?)`,
    await vault.seal(
      JSON.stringify({ ref: JSON.parse(ref('-100200', 'group', 'Ops')), text: 'queued reply' }),
      'channel-outbox:01900000-0000-7000-8000-0000000000a1',
    ),
    T0 + 7000,
    T0 + 7000,
  )
  run(
    `INSERT INTO channel_approvals (id, connection_id, conversation_id, session_id, agent_id, item_id, item_kind, tool_name, trigger_id, status, consumed, created_at)
     VALUES ('01900000-0000-7000-8000-0000000000b1', 'c1', '-100200', 'channel:c1:-100200', 'lead-agent', 'ap1', 'approval', 'channel_send', '2', 'open', 0, ?)`,
    T0 + 7100,
  )

  // the account: a chosen supergroup with a backfill under way and the admin log on
  run(
    `INSERT INTO tgu_chats (connection_id, chat_id, kind, title, username, forum, admin, selected, high_id, first_live_id, backfill_days, backfill_state,
       backfill_oldest_id, backfill_oldest_at, backfill_count, parked_until, admin_log_enabled, admin_log_last_id, admin_log_last_at, admin_log_count, updated_at)
     VALUES ('acc1', '-100500', 'group', 'Audit', 'audit_chat', 0, 1, 1, 900, 800, 30, 'running', 640, ?, 260, NULL, 1, '555', ?, 7, ?)`,
    T0 - 86_400_000,
    T0 + 1,
    T0 + 2,
  )
  return { messageIds: ids }
}

function boot(file: string): Server {
  const server = compose({
    dbFile: file,
    env: {},
    models: scriptedModelConfig(scriptedModel([])),
    reconcile: { onBoot: false, everyMs: 0 },
    routines: { tickMs: 0 },
    channels: { vault, purgeEveryMs: 0 },
  })
  servers.push(server)
  return server
}

const count = (db: Database, table: string): number =>
  (db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n

describe('L5 data migration of an old channels database', () => {
  test('conversations, settings, sessions, identities, events, messages and the outbox move to the new model', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'team-l5mig-'))
    dirs.push(dir)
    const file = join(dir, 'team.db')
    const old = oldDatabase(file)
    const { messageIds } = await seed(old)
    old.close()

    // boot the new code on it: drizzle adds the tables, the gateway moves the rows
    const server = boot(file)
    await server.channels.ready()
    const gw = server.channels
    const db = server.conn.sqlite
    const node = (conn: string, native: string) => {
      const n = gw.nodes.byNative(conn, native)
      if (n === undefined) throw new Error(`no node ${native}`)
      return n
    }

    // nodes: rooms, a forum with General and a topic, topics of a group, a direct chat
    const ops = node('c1', '-100200')
    expect(ops).toMatchObject({
      kind: 'room',
      title: 'Ops',
      legacyRefId: '-100200',
      parentId: null,
    })
    expect(ops.traits).toMatchObject({ multiUser: true, container: false, postable: true })
    const forum = node('c1', '-100300')
    const topic7 = node('c1', '-100300/7')
    expect(topic7).toMatchObject({ kind: 'thread', parentId: forum.id, legacyRefId: '-100300/7' })
    expect(topic7.path).toBe(`${forum.path}/${topic7.id}`)
    // a forum is a container; its old container-level conversation was its General topic
    expect(forum).toMatchObject({ kind: 'room', legacyRefId: null })
    expect(forum.traits).toMatchObject({ container: true, postable: false, threading: 'node' })
    const general = node('c1', '-100300/0')
    expect(general).toMatchObject({
      kind: 'thread',
      parentId: forum.id,
      legacyRefId: '-100300',
      title: 'General',
    })
    expect(node('c1', '-100300/5')).toMatchObject({ title: 'Billing', parentId: forum.id })
    expect(node('c1', '42')).toMatchObject({ kind: 'direct', legacyRefId: '42' })
    expect(node('c1', '-100400').traits.broadcast).toBe(true)
    expect(node('c1', '-100400').state).toBe('left') // the bot was kicked from the channel
    // a native id wins over an old conversation id: `-100300` is the forum; the old conversation is General
    expect(gw.nodeOf('c1', '-100300')?.id).toBe(forum.id)
    expect(gw.nodes.byLegacy('c1', '-100300')?.id).toBe(general.id)

    // settings: the group and topic overrides are inherited settings now; `*` joined the defaults
    expect(gw.settings.get(ops.id)).toEqual({
      enabled: true,
      wake: 'mention',
      retentionDays: 14,
      label: 'Ops',
    })
    expect(gw.settings.get(topic7.id)).toEqual({ wake: 'never', retentionDays: 3 })
    expect(gw.settings.get(node('c1', '-100300/8').id)).toEqual({ enabled: false })
    expect(gw.settings.get(forum.id)).toEqual({ enabled: true, wake: 'always', ack: false })
    // the connection's `*` entry became a default of the connection
    expect(gw.settings.resolve(topic7.id)).toMatchObject({ allowed: true, wake: 'never' })
    expect(gw.settings.resolve(node('c1', '-100300/8').id)?.allowed).toBe(false)
    expect(gw.settings.resolve(general.id)).toMatchObject({ allowed: true, wake: 'always' })
    const config = gw.config('c1')
    expect(config?.defaults).toMatchObject({ retentionDays: 30, delivery: 'message_tool' })
    expect(
      db
        .query<{ config: string }, []>(
          "SELECT config FROM channel_connections WHERE connection_id = 'c1'",
        )
        .get()?.config,
    ).not.toContain('"groups"')
    // the account's chosen chat: enabled, observe-only, its jobs on the node
    const audit = node('acc1', '-100500')
    expect(gw.settings.get(audit.id)).toMatchObject({
      enabled: true,
      wake: 'never',
      label: 'Audit',
    })
    expect(gw.nodes.access(audit.id)).toMatchObject({
      member: 'admin',
      history: {
        days: 30,
        state: 'running',
        oldestNativeId: '640',
        count: 260,
        highNativeId: '900',
        firstLiveNativeId: '800',
      },
      extra: { adminLog: { enabled: true, lastId: '555', count: 7 } },
    })
    expect(gw.nodes.access(ops.id)).toMatchObject({ member: 'admin', canPost: true })

    // sessions keep their old key, so threads and approvals keep working
    expect(gw.sessions.get('c1', ops.id)?.sessionId).toBe('channel:c1:-100200')
    expect(gw.sessions.get('c1', general.id)?.sessionId).toBe('channel:c1:-100300')
    expect(gw.sessions.get('c1', topic7.id)).toMatchObject({
      sessionId: 'channel:c1:-100300/7',
      agentId: 'lead-agent',
    })
    expect(gw.conversationOf('channel:c1:42')?.node.id).toBe(node('c1', '42').id)

    // identities and the "not linked yet" list
    expect(gw.pairing.members('c1')).toMatchObject([
      { peerId: '42', memberId: 'owner', name: 'Ana Putri' },
    ])
    expect(gw.unlinked.list('c1')).toEqual([]) // Eve is ignored
    expect(gw.unlinked.list('c1', { includeIgnored: true })).toMatchObject([
      { peerId: '99', name: 'Eve', username: 'eve', messageCount: 4, ignored: true },
    ])
    expect(gw.identities.byNative('c1', '43')?.displayName).toBe('Budi') // a sender of a message
    expect(gw.identities.byNative('c1', '777')).toMatchObject({ isSelf: true, kind: 'bot' })

    // activity events, outbox and approvals point at nodes
    const act = gw.activity.list('c1', { limit: 10 }).items
    // newest first (events keep their ids)
    expect(act.map((e) => [e.type, e.reason, e.conversationId])).toEqual([
      ['dropped', 'chat-not-allowed', node('c1', 'stranger').id],
      ['woke', 'mentioned', ops.id],
    ])
    expect(gw.outbox.counts('c1').pending).toBe(1)
    expect(
      db.query<{ conversation_id: string }, []>('SELECT conversation_id FROM channel_outbox').get()
        ?.conversation_id,
    ).toBe(ops.id)
    expect(gw.approvals.open('channel:c1:-100200')[0]?.conversationId).toBe(ops.id)

    // messages: same ids, sealed again, edits as revisions, tombstone, sender identity, change counter
    expect(count(db, 'ch_messages')).toBe(messageIds.length)
    const edited = await gw.log.find(ops.id, '2')
    expect(edited).toMatchObject({
      id: messageIds[1],
      text: 'seen it, fixing (v2)',
      sender: { id: '43', name: 'Budi' },
      replyTo: { messageId: '1', senderName: 'Ana Putri', text: 'deploy failed twice' },
      disposition: 'woke',
      rev: 3,
      editedAt: T0 + 2600,
    })
    expect(edited?.edits?.map((e) => e.text)).toEqual(['seen it', 'seen it, fixing'])
    expect(await gw.log.find(ops.id, '3')).toMatchObject({ self: true, text: 'Looking into it.' })
    const gone = await gw.log.find(topic7.id, '9')
    expect(gone).toMatchObject({ deletedHasContent: true, text: 'a photo for the topic' })
    expect(gone?.deletedAt).toBe(T0 + 4001)
    expect(gone?.attachments).toEqual([
      { id: 'f1', kind: 'image', name: 'x.png', mediaType: 'image/png', size: 12 },
    ])
    expect((await gw.log.find(general.id, '70'))?.text).toBe('general chat of the forum')
    expect((await gw.log.changes('c1', 5, 10)).map((m) => m.rev)).toEqual([6, 7])
    // observed messages still wait for the next wake
    expect((await gw.log.pending([ops.id], 10)).map((m) => m.nativeId)).toEqual(['1'])
    // still sealed at rest
    expect(
      db
        .query<{ content: string }, []>('SELECT content FROM ch_messages')
        .all()
        .every((r) => !r.content.includes('deploy')),
    ).toBe(true)

    // the inbox reads the new model
    const inbox = await gw.inbox.conversations('c1', { limit: 20 })
    const opsView = inbox.items.find((c) => c.conversationId === ops.id)
    expect(opsView).toMatchObject({
      kind: 'group',
      title: 'Ops',
      woke: 1,
      observed: 1,
      allowed: true,
    })
    expect(inbox.items.find((c) => c.conversationId === node('c1', 'stranger').id)).toMatchObject({
      dropped: 1,
      allowed: false,
    })
    expect(inbox.items.find((c) => c.conversationId === node('c1', '42').id)).toMatchObject({
      kind: 'dm',
      allowed: true,
    })
    expect(
      (await gw.inbox.messages('c1', ops.id, { limit: 10 }))?.items.map((m) => m.platformId),
    ).toEqual(['1', '2', '3'])

    // the old tables are left alone
    expect(count(db, 'channel_messages')).toBe(messageIds.length)
    expect(count(db, 'channel_conversations')).toBe(4)
  })

  test('running it again changes nothing, even without the markers', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'team-l5mig-'))
    dirs.push(dir)
    const file = join(dir, 'team.db')
    const old = oldDatabase(file)
    await seed(old)
    old.close()
    const server = boot(file)
    await server.channels.ready()
    const db = server.conn.sqlite
    const tables = [
      'ch_nodes',
      'ch_node_settings',
      'ch_node_sessions',
      'ch_identities',
      'ch_messages',
      'ch_message_revisions',
      'ch_events',
      'ch_memberships',
      'ch_node_access',
    ]
    const before = tables.map((t) => count(db, t))
    // the markers say it is done
    expect(migrateLegacyStructure(db, Date.now()).skipped).toBe(true)
    expect((await migrateLegacyMessages(db, vault)).skipped).toBe(true)
    // forget the markers: the unique keys keep it from duplicating anything
    db.run("DELETE FROM ch_meta WHERE key LIKE 'legacy_%'")
    const names = () =>
      db
        .query<{ native_id: string }, []>('SELECT native_id FROM ch_nodes ORDER BY native_id')
        .all()
        .map((r) => r.native_id)
    const had = names()
    const again = migrateLegacyStructure(db, Date.now())
    expect(names()).toEqual(had)
    expect(again.skipped).toBe(false)
    expect(again.nodes).toBe(0)
    expect(again.sessions).toBe(0)
    expect(again.events).toBe(0)
    expect((await migrateLegacyMessages(db, vault)).messages).toBe(0)
    expect(tables.map((t) => count(db, t))).toEqual(before)
  })

  test('a database that never had channel data boots clean', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'team-l5mig-'))
    dirs.push(dir)
    const old = oldDatabase(join(dir, 'team.db'))
    old.close()
    const server = boot(join(dir, 'team.db'))
    await server.channels.ready()
    expect(count(server.conn.sqlite, 'ch_nodes')).toBe(0)
    expect(
      server.conn.sqlite
        .query<{ key: string }, []>('SELECT key FROM ch_meta ORDER BY key')
        .all()
        .map((r) => r.key),
    ).toEqual(['legacy_messages_migrated', 'legacy_structure_migrated'])
  })
})
