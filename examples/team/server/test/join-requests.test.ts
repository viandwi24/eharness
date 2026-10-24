/**
 * Join requests as first-class events and as durable state: the bot (`chat_join_request`) and the
 * user account (pending-requests update, member updates) announce them as `member.join_requested`
 * / `member.join_request_resolved`, the requests survive a restart in `ch_join_requests`, and the
 * tools `join_requests` / `list_join_requests` read the saved list.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createJoinRequestStore,
  sqliteJoinRequestStore,
} from '../src/infra/channels/join-requests.ts'
import { sqliteNodeStore } from '../src/infra/channels/nodes.ts'
import type { AdapterHost, NativeAction, RemoteEvent } from '../src/infra/channels/types.ts'
import { openDatabase } from '../src/infra/db/client.ts'
import { createTelegramAdapter, type TelegramAdapter } from '../src/infra/telegram/adapter.ts'
import { createTelegramUserAdapter } from '../src/infra/telegram-user/adapter.ts'
import type {
  TgChat,
  TgJoinRequestsUpdate,
  TgMemberUpdate,
  TgUpdateHandlers,
  TgUserClient,
} from '../src/infra/telegram-user/client.ts'
import { nodeChatStore } from '../src/infra/telegram-user/store.ts'
import { fakeTelegram, tg } from './support/fake-telegram.ts'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function until(what: string, cond: () => boolean, ms = 5000) {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`)
    await sleep(10)
  }
}
const host: AdapterHost = { isAllowed: () => true, locate: () => [], isOwn: () => false }

const dirs: string[] = []
const stops: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const s of stops.splice(0)) await s()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const request = (userId: number, name: string, over: Record<string, unknown> = {}) => ({
  chat_join_request: {
    chat: tg.group(-1001, 'Ops'),
    from: tg.user(userId, name),
    user_chat_id: userId,
    date: Math.floor(Date.now() / 1000),
    bio: 'hello',
    invite_link: {
      invite_link: 'https://t.me/+xyz',
      creator: tg.user(1),
      creates_join_request: true,
      is_primary: false,
      is_revoked: false,
    },
    ...over,
  },
})

describe('the saved list', () => {
  test('a request is new once; a later one revives it; resolve removes it from the pending list', () => {
    const conn = openDatabase(':memory:')
    const store = sqliteJoinRequestStore(conn.sqlite, 'c1', () => 1_000)
    const r = { chatId: '-1001', chatTitle: 'Ops', userId: '55', name: 'Zed', at: 1_000 }
    expect(store.note(r)).toBe(true)
    expect(store.note({ ...r, bio: 'later bio' })).toBe(false)
    expect(store.list()).toHaveLength(1)
    expect(store.list()[0]).toMatchObject({ bio: 'later bio', userId: '55' })
    expect(store.list('-999')).toEqual([])
    expect(store.resolve('-1001', '55', 'approved', 'a bot')?.name).toBe('Zed')
    expect(store.list()).toEqual([])
    expect(store.resolve('-1001', '55', 'declined')).toBeUndefined()
    // asking again after an answer is a new request
    expect(store.note(r)).toBe(true)
    // a connection sees its own requests only
    expect(sqliteJoinRequestStore(conn.sqlite, 'c2').list()).toEqual([])
  })

  test('requests older than a week leave the pending list; the memory store behaves the same', () => {
    const conn = openDatabase(':memory:')
    let now = 0
    const store = sqliteJoinRequestStore(conn.sqlite, 'c1', () => now)
    store.note({ chatId: '-1', chatTitle: 'A', userId: '1', name: 'A', at: 0 })
    now = 8 * 86_400_000
    expect(store.list()).toEqual([])
    const mem = createJoinRequestStore(() => now)
    mem.note({ chatId: '-1', chatTitle: 'A', userId: '1', name: 'A', at: 0 })
    expect(mem.list()).toEqual([])
  })
})

describe('the bot', () => {
  function bot(file: string, name = 'tg1') {
    const fake = fakeTelegram(4980 + Math.floor(Math.random() * 15))
    const conn = openDatabase(file)
    const adapter: TelegramAdapter = createTelegramAdapter({
      connectionId: name,
      token: fake.token,
      apiRoot: fake.url,
      pollTimeoutSec: 1,
      joinRequests: sqliteJoinRequestStore(conn.sqlite, name),
    })
    const events: RemoteEvent[] = []
    const tool = (action: string) => {
      const a = (adapter.actions as NativeAction[]).find((x) => x.name === 'join_requests')
      if (a === undefined) throw new Error('no tool')
      return a.run({ action })
    }
    const run = (input: Record<string, unknown>) =>
      (adapter.actions as NativeAction[])
        .find((x) => x.name === 'join_requests')
        ?.run(input) as Promise<string>
    stops.push(async () => {
      await adapter.stop()
      fake.stop()
      conn.close()
    })
    return {
      fake,
      adapter,
      events,
      tool,
      run,
      start: () => adapter.start(async (e) => void events.push(e), host),
    }
  }

  test('the request is an event with the applicant as actor, saved, and still listed after a restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'team-join-'))
    dirs.push(dir)
    const file = join(dir, 'team.db')
    const a = bot(file)
    await a.start()
    a.fake.push(request(55, 'Zed'))
    await until('event', () => a.events.length === 1)
    expect(a.events[0]).toMatchObject({
      type: 'member.join_requested',
      actor: { id: '55', name: 'Zed', username: 'zed' },
      request: { link: 'https://t.me/+xyz', hasBio: true },
      node: { nativeId: '-1001' },
    })
    // the bio text is saved for the tool, not carried by the event
    expect(
      JSON.stringify(a.events[0]?.type === 'member.join_requested' ? a.events[0].request : {}),
    ).not.toContain('hello')
    await a.adapter.stop()

    // the process restarted: a new adapter over the same database still knows the request
    const b = bot(file)
    const list = (await b.tool('list')) as string
    expect(list).toContain('Zed (id 55, @zed)')
    expect(list).toContain('bio: hello')
    expect(list).toContain('1 pending join request')
  })

  test('answering resolves it, tells the gateway, and the list is empty; another admin approving is seen as joining', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'team-join-'))
    dirs.push(dir)
    const a = bot(join(dir, 'team.db'))
    await a.start()
    a.fake.push(request(55, 'Zed'))
    a.fake.push(request(56, 'Yan', { bio: undefined, invite_link: undefined }))
    await until('both', () => a.events.length === 2)
    expect(await a.run({ action: 'approve', chat: '-1001', user: 55 })).toContain('approved')
    await until('resolved event', () =>
      a.events.some((e) => e.type === 'member.join_request_resolved'),
    )
    expect(a.events.find((e) => e.type === 'member.join_request_resolved')).toMatchObject({
      resolution: 'approved',
      bySelf: true,
      actor: { id: '55' },
    })
    expect(await a.run({ action: 'list' })).not.toContain('Zed')

    // somebody else approves Yan in the Telegram app: the bot sees the member join
    a.fake.push({
      chat_member: {
        chat: tg.group(-1001, 'Ops'),
        from: tg.user(1, 'Ana'),
        date: Math.floor(Date.now() / 1000),
        old_chat_member: { status: 'left', user: tg.user(56, 'Yan') },
        new_chat_member: { status: 'member', user: tg.user(56, 'Yan') },
      },
    })
    await until('joined', () => a.events.some((e) => e.type === 'member.joined'))
    const resolved = a.events.filter((e) => e.type === 'member.join_request_resolved')
    expect(resolved).toHaveLength(2)
    expect(resolved[1]).toMatchObject({
      resolution: 'approved',
      bySelf: false,
      actor: { id: '56' },
    })
    expect(await a.run({ action: 'list' })).toContain('No pending')
    // the member event says who made the change
    expect(a.events.find((e) => e.type === 'member.joined')).toMatchObject({ by: { id: '1' } })
  })
})

describe('the user account', () => {
  const GROUP = '-1001'
  const dialog: TgChat = { id: GROUP, kind: 'group', title: 'Company', forum: false, admin: true }

  function account(
    file = ':memory:',
    live: { users: Array<{ id: string; name: string }> } = { users: [] },
  ) {
    const conn = openDatabase(file)
    const nodes = sqliteNodeStore(conn.sqlite)
    const chats = nodeChatStore({ sqlite: conn.sqlite, nodes, allowed: () => true })
    chats.upsertDialog('c1', dialog, 1)
    chats.setSelected('c1', GROUP, true, 1)
    let handlers: TgUpdateHandlers | undefined
    const answered: Array<Record<string, unknown>> = []
    const client = {
      startUpdates: async (h: TgUpdateHandlers) => {
        handlers = h
      },
      stop: async () => undefined,
      listChats: async () => [dialog],
      listJoinRequests: async () =>
        live.users.map((u) => ({ user: { id: u.id, name: u.name, isBot: false }, at: Date.now() })),
      answerJoinRequests: async (_c: string, o: Record<string, unknown>) => void answered.push(o),
      getChatInfo: async () => dialog,
    } as unknown as TgUserClient
    const adapter = createTelegramUserAdapter({
      connectionId: 'c1',
      client,
      me: { id: '1', name: 'Me', isBot: false },
      chats,
      counters: { get: () => 0, add: () => undefined },
      settings: () => ({ dmDailyMax: 30, dailyMax: 300, adminLogEveryMs: 3_600_000 }),
      joinRequests: sqliteJoinRequestStore(conn.sqlite, 'c1'),
      hooks: { onFatal: () => undefined, warn: () => undefined },
      sleep: async () => undefined,
    })
    const events: RemoteEvent[] = []
    stops.push(async () => {
      await adapter.stop()
      conn.close()
    })
    const tool = (name: string) => {
      const a = adapter.actions?.find((x) => x.name === name)
      if (a === undefined) throw new Error(`no tool ${name}`)
      return a
    }
    return {
      adapter,
      events,
      answered,
      tool,
      async start() {
        await adapter.start(async (e) => void events.push(e), { ...host, isAllowed: () => true })
        return handlers as TgUpdateHandlers
      },
    }
  }

  const pending = (
    users: Array<{ id: string; name: string; username?: string }>,
    total = users.length,
  ): TgJoinRequestsUpdate => ({
    chat: { id: GROUP, kind: 'group', title: '', forum: false },
    users: users.map((u) => ({ ...u, isBot: false })),
    total,
    at: Date.now(),
  })

  test('pending requests become events once each, with the chat title from the dialogs', async () => {
    const a = account()
    const h = await a.start()
    h.joinRequests?.(pending([{ id: '55', name: 'Zed', username: 'zed' }], 3))
    await until('event', () => a.events.length === 1)
    expect(a.events[0]).toMatchObject({
      type: 'member.join_requested',
      actor: { id: '55', name: 'Zed', username: 'zed' },
      request: { pending: 3 },
      node: { nativeId: GROUP, chain: [{ title: 'Company' }] },
    })
    // the same person listed again (the update repeats the recent requesters): no second event
    h.joinRequests?.(
      pending(
        [
          { id: '55', name: 'Zed' },
          { id: '56', name: 'Yan' },
        ],
        2,
      ),
    )
    await until('second person', () => a.events.length === 2)
    await sleep(30)
    expect(a.events.map((e) => (e.type === 'member.join_requested' ? e.actor?.id : '?'))).toEqual([
      '55',
      '56',
    ])
  })

  test('answering through the tool resolves the saved requests and emits resolved events', async () => {
    const a = account(':memory:', { users: [{ id: '55', name: 'Zed' }] })
    const h = await a.start()
    h.joinRequests?.(
      pending([
        { id: '55', name: 'Zed' },
        { id: '56', name: 'Yan' },
      ]),
    )
    await until('two events', () => a.events.length === 2)
    const out = await a
      .tool('answer_join_request')
      .run({ chat: GROUP, action: 'approve', user: '55' })
    expect(out).toContain('Approved')
    await until('resolved', () => a.events.some((e) => e.type === 'member.join_request_resolved'))
    expect(a.events.find((e) => e.type === 'member.join_request_resolved')).toMatchObject({
      resolution: 'approved',
      bySelf: true,
      actor: { id: '55' },
    })
    // answering all declines the rest
    await a
      .tool('answer_join_request')
      .run({ chat: GROUP, action: 'decline', all: true, confirm: true })
    await until(
      'second resolved',
      () => a.events.filter((e) => e.type === 'member.join_request_resolved').length === 2,
    )
    expect(a.events.filter((e) => e.type === 'member.join_request_resolved')[1]).toMatchObject({
      resolution: 'declined',
      actor: { id: '56' },
    })
  })

  test('the list tool reads Telegram, and falls back to the saved list when Telegram cannot be asked', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'team-join-'))
    dirs.push(dir)
    const file = join(dir, 'team.db')
    const a = account(file)
    const h = await a.start()
    h.joinRequests?.(pending([{ id: '55', name: 'Zed' }]))
    await until('event', () => a.events.length === 1)
    await a.adapter.stop()

    // after a restart, with Telegram unreachable, the saved list answers
    const conn = openDatabase(file)
    const nodes = sqliteNodeStore(conn.sqlite)
    const chats = nodeChatStore({ sqlite: conn.sqlite, nodes, allowed: () => true })
    chats.upsertDialog('c1', dialog, 1)
    chats.setSelected('c1', GROUP, true, 1)
    const broken = {
      startUpdates: async () => undefined,
      stop: async () => undefined,
      listChats: async () => [dialog],
      listJoinRequests: async () => {
        throw new Error('network is down')
      },
    } as unknown as TgUserClient
    const b = createTelegramUserAdapter({
      connectionId: 'c1',
      client: broken,
      me: { id: '1', name: 'Me', isBot: false },
      chats,
      counters: { get: () => 0, add: () => undefined },
      settings: () => ({ dmDailyMax: 30, dailyMax: 300, adminLogEveryMs: 3_600_000 }),
      joinRequests: sqliteJoinRequestStore(conn.sqlite, 'c1'),
      hooks: { onFatal: () => undefined, warn: () => undefined },
    })
    stops.push(() => conn.close())
    const text = (await b.actions
      ?.find((x) => x.name === 'list_join_requests')
      ?.run({ chat: GROUP })) as string
    expect(text).toContain('saved list')
    expect(text).toContain('Zed (id 55)')
  })

  test('members joining, leaving and promoted become member events with who did it', async () => {
    const a = account()
    const h = await a.start()
    const at = Date.now()
    const base = { chat: { id: GROUP, kind: 'group' as const, title: 'Company', forum: false }, at }
    const user = (id: string, name: string) => ({ id, name, isBot: false })
    const member = (u: Partial<TgMemberUpdate>): TgMemberUpdate => ({
      ...base,
      user: user('55', 'Zed'),
      type: 'joined',
      status: 'member',
      ...u,
    })
    h.member?.(member({ type: 'added', actor: user('1', 'Me'), at: at + 1 }))
    h.member?.(member({ type: 'kicked', status: 'banned', actor: user('2', 'Ana'), at: at + 2 }))
    h.member?.(member({ type: 'promoted', status: 'admin', actor: user('2', 'Ana'), at: at + 3 }))
    h.member?.(member({ type: 'unkicked', status: 'left', at: at + 4 }))
    await until('events', () => a.events.length === 3)
    await sleep(20)
    expect(a.events.map((e) => e.type)).toEqual(['member.joined', 'member.left', 'member.updated'])
    expect(a.events[2]).toMatchObject({
      role: 'admin',
      actor: { id: '55' },
      by: { id: '2', name: 'Ana' },
    })
    expect(a.events[0]).toMatchObject({ by: { id: '1' } })
  })
})
