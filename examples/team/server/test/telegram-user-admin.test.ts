/**
 * Telegram user account: admin log collection (on by default, one-time migration), a fresh and
 * filtered `admin_log`, the "may have been deleted" hint, and `promote_member` / `demote_member`.
 * Component level with an inline fake client: no network, no Telegram.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { sqliteNodeStore } from '../src/infra/channels/nodes.ts'
import { openDatabase } from '../src/infra/db/client.ts'
import { accountActions } from '../src/infra/telegram-user/actions.ts'
import {
  ADMIN_EVENT_KINDS,
  type AdminLogQuery,
  createAdminLog,
  storedAdminEvents,
} from '../src/infra/telegram-user/adminlog.ts'
import type {
  TgAdminEvent,
  TgAdminRights,
  TgChat,
  TgMessage,
  TgUserClient,
} from '../src/infra/telegram-user/client.ts'
import { classifyError, describeError, TgRpcError } from '../src/infra/telegram-user/errors.ts'
import { nodeChatStore } from '../src/infra/telegram-user/store.ts'

const CONN = 'c1'
const GROUP = '-1001'
const PLAIN = '-1002'

function setup() {
  const conn = openDatabase(':memory:')
  const nodes = sqliteNodeStore(conn.sqlite)
  const chats = nodeChatStore({ sqlite: conn.sqlite, nodes, allowed: () => true })
  const dialog = (id: string, title: string, admin: boolean): TgChat => ({
    id,
    kind: 'group',
    title,
    forum: false,
    admin,
  })
  chats.upsertDialog(CONN, dialog(GROUP, 'Company', true), 1)
  chats.upsertDialog(CONN, dialog(PLAIN, 'Lounge', false), 1)
  return { conn, nodes, chats }
}

const noopHooks = {
  onFatal: () => undefined,
  onPark: () => undefined,
  onStorm: () => undefined,
  warn: () => undefined,
}

describe('admin log collection defaults', () => {
  test('a chat is collected unless the owner turned it off; null restores the default', () => {
    const { chats } = setup()
    expect(chats.get(CONN, GROUP)?.adminLogEnabled).toBe(true)
    chats.setAdminLog(CONN, GROUP, false, 2)
    expect(chats.get(CONN, GROUP)?.adminLogEnabled).toBe(false)
    chats.setAdminLog(CONN, GROUP, true, 3)
    expect(chats.get(CONN, GROUP)?.adminLogEnabled).toBe(true)
    chats.setAdminLog(CONN, GROUP, false, 4)
    chats.setAdminLog(CONN, GROUP, null, 5)
    expect(chats.get(CONN, GROUP)?.adminLogEnabled).toBe(true)
  })

  test('the migration forgets the old default "off" for admin chats, keeps an explicit choice', () => {
    const { conn, nodes, chats } = setup()
    const idOf = (native: string) => (nodes.byNative(CONN, native) as { id: string }).id
    // the old state: enabled=false written by the legacy migration, no `explicit`
    nodes.patchExtra(idOf(GROUP), CONN, { adminLog: { enabled: false, count: 3 } }, 2)
    nodes.patchExtra(idOf(PLAIN), CONN, { adminLog: { enabled: false } }, 2)
    chats.upsertDialog(
      CONN,
      { id: '-1003', kind: 'group', title: 'Ops', forum: false, admin: true },
      1,
    )
    chats.setAdminLog(CONN, '-1003', false, 3) // an owner's choice after the change
    const sql = readFileSync(
      new URL('../drizzle/0037_admin_log_default_on.sql', import.meta.url),
      'utf8',
    )
    conn.sqlite.run(sql)
    expect(chats.get(CONN, GROUP)?.adminLogEnabled).toBe(true)
    expect(chats.get(CONN, GROUP)?.adminLogCount).toBe(3)
    // not an admin: the stored value is left alone
    expect(chats.get(CONN, PLAIN)?.adminLogEnabled).toBe(false)
    expect(chats.get(CONN, '-1003')?.adminLogEnabled).toBe(false)
  })
})

describe('admin log polling', () => {
  const event = (id: string, extra: Partial<TgAdminEvent> = {}): TgAdminEvent => ({
    id,
    at: 1000 + Number(id),
    kind: 'delete',
    ...extra,
  })

  function logWith(
    client: Partial<TgUserClient>,
    s: ReturnType<typeof setup>,
    recorded: string[] = [],
  ) {
    return createAdminLog({
      connectionId: CONN,
      client: client as TgUserClient,
      chats: s.chats,
      record: async (_chat, e) => {
        recorded.push(e.id)
        return true
      },
      allowed: () => true,
      everyMs: () => 4 * 3_600_000,
      hooks: noopHooks,
      now: () => 50_000,
      sleep: async () => undefined,
    })
  }

  test('pollChat reads now (ignoring the interval) and stores the events', async () => {
    const s = setup()
    const recorded: string[] = []
    let calls = 0
    const log = logWith(
      {
        adminLog: async () => {
          calls++
          return calls === 1 ? [event('2'), event('1')] : []
        },
      },
      s,
      recorded,
    )
    expect(await log.pollChat(GROUP)).toEqual({ status: 'ok' })
    expect(recorded).toEqual(['1', '2'])
    // the periodic poll would skip it (just read); a forced poll reads again
    await log.runDue()
    expect(calls).toBe(1)
    expect((await log.pollChat(GROUP)).status).toBe('ok')
    expect(calls).toBe(2)
  })

  test('a flood park, a switch that is off and a missing admin right are said, not read', async () => {
    const s = setup()
    let calls = 0
    const log = logWith(
      {
        adminLog: async () => {
          calls++
          throw new TgRpcError('FLOOD_WAIT_30')
        },
      },
      s,
    )
    expect((await log.pollChat(GROUP)).status).toBe('parked')
    expect(calls).toBe(1)
    // now parked: no second call
    expect((await log.pollChat(GROUP)).status).toBe('parked')
    expect(calls).toBe(1)
    s.chats.setParked(CONN, GROUP, null, 1)
    s.chats.setAdminLog(CONN, GROUP, false, 2)
    expect((await log.pollChat(GROUP)).status).toBe('off')
    expect((await log.pollChat(PLAIN)).status).toBe('not-admin')
    expect(calls).toBe(1)
  })

  test('CHAT_ADMIN_REQUIRED from Telegram says the account lacks the right', async () => {
    const s = setup()
    const log = logWith(
      {
        adminLog: async () => {
          throw new TgRpcError('CHAT_ADMIN_REQUIRED')
        },
      },
      s,
    )
    const r = await log.pollChat(GROUP)
    expect(r.status).toBe('not-admin')
    expect(r.text).toContain('not an admin')
  })

  test('stored events are filtered by kind, words, time and person', () => {
    const s = setup()
    const room = s.nodes.byNative(CONN, GROUP) as { id: string; path: string }
    const put = (n: string, at: number, content: string, meta: Record<string, unknown>): void => {
      s.conn.sqlite
        .query(
          `INSERT INTO ch_messages (id, connection_id, node_id, native_id, sent_at, kind, content, meta)
           VALUES (?, ?, ?, ?, ?, 'system', ?, ?)`,
        )
        .run(
          `m${n}`,
          CONN,
          room.id,
          `admin:${n}`,
          at,
          content,
          JSON.stringify({ adminEvent: meta }),
        )
    }
    put('1', 1000, '[admin log] Budi deleted message 5: "the budget is 5000"', {
      kind: 'delete',
      actorId: '7',
      actorName: 'Budi',
      messageId: 5,
    })
    put('2', 2000, '[admin log] Budi edited message 6', {
      kind: 'edit',
      actorId: '7',
      actorName: 'Budi',
    })
    put('3', 3000, '[admin log] Sari banned Joko', {
      kind: 'ban',
      actorId: '8',
      actorName: 'Sari',
      targetId: '9',
      targetName: 'Joko',
    })
    const q = (o: Partial<AdminLogQuery>) =>
      storedAdminEvents(s.conn.sqlite, CONN, room.path, { limit: 30, ...o })
    expect(q({}).map((r) => r.sent_at)).toEqual([3000, 2000, 1000])
    expect(q({ kind: 'delete' })).toHaveLength(1)
    expect(q({ query: 'budget' })[0]?.content).toContain('5000')
    expect(q({ from: 1500, to: 2500 })).toHaveLength(1)
    expect(q({ user: '9' })[0]?.content).toContain('banned Joko')
    expect(q({ user: 'budi' })).toHaveLength(2)
    expect(q({ kind: 'delete', user: '8' })).toHaveLength(0)
    expect(ADMIN_EVENT_KINDS).toContain('delete')
  })
})

describe('platform actions', () => {
  const chat = (admin: boolean, kind: 'group' | 'channel' = 'group'): TgChat => ({
    id: GROUP,
    kind,
    title: 'Company',
    forum: false,
    admin,
  })

  function build(
    client: Partial<TgUserClient>,
    opts: { admin?: boolean; read?: (chatId: string, q: AdminLogQuery) => Promise<string> } = {},
  ) {
    const s = setup()
    const list = [chat(opts.admin ?? true)]
    const actions = accountActions({
      connectionId: CONN,
      client: client as TgUserClient,
      chats: s.chats,
      counters: { get: () => 0, add: () => undefined },
      settings: () => ({ dmDailyMax: 30, dailyMax: 300, adminLogEveryMs: 4 * 3_600_000 }),
      selfId: '1',
      dialogs: async () => list,
      call: async (_c, fn) => {
        try {
          return await fn()
        } catch (error) {
          throw new Error(describeError(classifyError(error)))
        }
      },
      blocked: () => undefined,
      learnTopics: () => undefined,
      timezone: () => 'UTC',
      now: () => Date.UTC(2026, 9, 15, 12, 0),
      hooks: { ...(opts.read === undefined ? {} : { adminLogRead: opts.read }) },
    })
    const by = (name: string) => {
      const a = actions.find((x) => x.name === name)
      if (a === undefined) throw new Error(`no action ${name}`)
      return a
    }
    return { by, s }
  }

  const message = (id: number): TgMessage => ({
    chat: chat(true),
    id,
    at: 1,
    text: 'hi',
    outgoing: false,
    mention: false,
    mentionsOthers: false,
    attachments: [],
    service: false,
  })

  test('admin_log reads fresh through the hook with the filters, and stays a read', async () => {
    let seen: { chat: string; q: AdminLogQuery } | undefined
    const { by } = build(
      {},
      {
        read: async (c, q) => {
          seen = { chat: c, q }
          return 'EVENTS'
        },
      },
    )
    const a = by('admin_log')
    expect(a.risk).toBe('read')
    const out = await a.run({
      chat: 'Company',
      kind: 'delete',
      query: 'budget',
      from_time: '2026-10-14',
      to_time: '2026-10-15 09:30',
      user: '7',
      limit: 10,
    })
    expect(out).toBe('EVENTS')
    expect(seen?.chat).toBe(GROUP)
    expect(seen?.q).toEqual({
      limit: 10,
      kind: 'delete',
      query: 'budget',
      from: Date.UTC(2026, 9, 14),
      to: Date.UTC(2026, 9, 15, 9, 30),
      user: '7',
    })
    expect(await a.run({ chat: 'Company', from_time: 'yesterday' })).toContain('ERROR')
  })

  test('admin_log says clearly when the account is not an admin', async () => {
    const { by } = build({}, { admin: false, read: async () => 'EVENTS' })
    expect(await by('admin_log').run({ chat: 'Company' })).toContain('not an admin')
  })

  test('an empty search or a missing message id hints at the admin log, only for an admin', async () => {
    const client = {
      searchMessages: async () => [],
      messagesById: async () => [null],
    } satisfies Partial<TgUserClient>
    const admin = build(client, { admin: true })
    expect(await admin.by('search_messages').run({ chat: GROUP, query: 'budget' })).toContain(
      'admin_log of that chat shows deleted messages',
    )
    expect(await admin.by('get_message').run({ chat: GROUP, ids: [5] })).toContain(
      'Telegram keeps them about 48 hours',
    )
    const plain = build(client, { admin: false })
    expect(await plain.by('search_messages').run({ chat: GROUP, query: 'budget' })).toBe(
      'Nothing found in "Company".',
    )
    expect(await plain.by('get_message').run({ chat: GROUP, ids: [5] })).not.toContain('admin_log')
    // a found message gets no hint
    const found = build({ messagesById: async () => [message(5)] }, { admin: true })
    expect(await found.by('get_message').run({ chat: GROUP, ids: [5] })).not.toContain('admin_log')
  })

  describe('promote_member / demote_member', () => {
    test('they are owner only and destructive, so they always ask for approval', () => {
      const { by } = build({})
      for (const name of ['promote_member', 'demote_member']) {
        expect(by(name).ownerOnly).toBe(true)
        expect(by(name).risk).toBe('destructive')
      }
    })

    test('only the safe rights go through, with the title', async () => {
      const calls: Array<{ rights: TgAdminRights; title: string | undefined }> = []
      const { by } = build({
        promoteMember: async (_c, _u, rights, title) => {
          calls.push({ rights, title })
        },
      })
      const out = await by('promote_member').run({
        chat: GROUP,
        user: '42',
        rights: ['delete_messages', 'pin_messages', 'manage_video_chats'],
        title: 'Mod',
      })
      expect(out).toContain('Made user 42 an admin')
      expect(calls).toEqual([
        { rights: { deleteMessages: true, pinMessages: true, manageCall: true }, title: 'Mod' },
      ])
    })

    test('every Telegram admin right can be given; an unknown right is refused before any call', async () => {
      let got: TgAdminRights | undefined
      let calls = 0
      const { by } = build({
        promoteMember: async (_c: string, _u: string, r: TgAdminRights) => {
          calls++
          got = r
        },
      })
      const bad = await by('promote_member').run({
        chat: GROUP,
        user: '42',
        rights: ['post_stories'],
      })
      expect(bad).toContain('ERROR')
      expect(bad).toContain('not an admin right')
      expect(calls).toBe(0)
      const ok = await by('promote_member').run({
        chat: GROUP,
        user: '42',
        rights: ['delete_messages', 'add_admins', 'anonymous', 'post_messages', 'edit_messages'],
      })
      expect(ok).toContain('add_admins')
      expect(got).toMatchObject({
        deleteMessages: true,
        addAdmins: true,
        anonymous: true,
        postMessages: true,
        editMessages: true,
      })
    })

    test('the account must be an admin, and cannot change itself', async () => {
      const client = { promoteMember: async () => undefined, demoteMember: async () => undefined }
      const plain = build(client, { admin: false })
      expect(
        await plain.by('promote_member').run({ chat: GROUP, user: '42', rights: ['ban_users'] }),
      ).toContain('not an admin')
      expect(await plain.by('demote_member').run({ chat: GROUP, user: '42' })).toContain(
        'not an admin',
      )
      const admin = build(client)
      expect(
        await admin.by('promote_member').run({ chat: GROUP, user: '1', rights: ['ban_users'] }),
      ).toContain('own admin rights')
    })

    test('demote removes the rights and tells the creator rule', async () => {
      const demoted: string[] = []
      const { by } = build({
        demoteMember: async (_c, u) => {
          demoted.push(u)
        },
      })
      const out = await by('demote_member').run({ chat: GROUP, user: '42' })
      expect(demoted).toEqual(['42'])
      expect(out).toContain('promoted itself')
    })

    test('Telegram refusals are readable sentences', async () => {
      const cases: Array<[string, string]> = [
        ['CHAT_ADMIN_REQUIRED', 'not an admin of that chat'],
        ['RIGHT_FORBIDDEN', 'rights it holds itself'],
        ['USER_NOT_MUTUAL_CONTACT', 'mutual contact'],
        ['ADMINS_TOO_MUCH', 'most admins'],
        ['USER_CREATOR', 'created the chat'],
        ['USER_ADMIN_INVALID', 'not promoted by this account'],
      ]
      for (const [code, text] of cases) {
        const { by } = build({
          promoteMember: async () => {
            throw new TgRpcError(code)
          },
          demoteMember: async () => {
            throw new TgRpcError(code)
          },
        })
        await expect(
          by('promote_member').run({ chat: GROUP, user: '42', rights: ['ban_users'] }),
        ).rejects.toThrow(text)
        await expect(by('demote_member').run({ chat: GROUP, user: '42' })).rejects.toThrow(text)
      }
    })
  })
})
