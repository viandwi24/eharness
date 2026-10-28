/**
 * Managing chats with the Telegram user account (`manage.ts`): create groups and channels, add
 * people with the privacy fallback (never a cold message), visibility, join requests, invite links,
 * permissions, deletion, contacts, roles, readable errors and the audit trail. A fake client: no
 * network, no Telegram.
 */
import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { createGovernor, governAdapter } from '../src/infra/channels/governor.ts'
import { sqliteNodeStore } from '../src/infra/channels/nodes.ts'
import { decideTool } from '../src/infra/channels/roles.ts'
import type { ChannelAdapter, NativeAction } from '../src/infra/channels/types.ts'
import { openDatabase } from '../src/infra/db/client.ts'
import { accountActions } from '../src/infra/telegram-user/actions.ts'
import type {
  TgAdminRights,
  TgChat,
  TgInviteLink,
  TgUser,
  TgUserClient,
} from '../src/infra/telegram-user/client.ts'
import { classifyError, describeError, TgRpcError } from '../src/infra/telegram-user/errors.ts'
import { AUTO_FLOOD_WAIT_S } from '../src/infra/telegram-user/manage.ts'
import { nodeChatStore } from '../src/infra/telegram-user/store.ts'

const CONN = 'c1'
const GROUP = '-1001'
const CHANNEL = '-1002'
const PLAIN = '-1003'
const NOW = Date.UTC(2026, 9, 15, 12, 0)

const user = (id: string, name: string, username?: string): TgUser => ({
  id,
  name,
  ...(username === undefined ? {} : { username }),
  isBot: false,
})

interface Rig {
  by(name: string): NativeAction
  all: NativeAction[]
  calls: string[]
  sent: Array<{ to: string; text: string }>
  created: TgChat[]
  counters: Map<string, number>
}

function build(
  client: Partial<TgUserClient>,
  opts: {
    dialogs?: TgChat[]
    files?: Record<string, { bytes: Uint8Array; mediaType: string }>
    sleep?: (ms: number) => Promise<void>
    callOpts?: Array<{ storm?: boolean } | undefined>
  } = {},
): Rig {
  const conn = openDatabase(':memory:')
  const nodes = sqliteNodeStore(conn.sqlite)
  const chats = nodeChatStore({ sqlite: conn.sqlite, nodes, allowed: () => true })
  const group = (
    id: string,
    title: string,
    admin: boolean,
    kind: 'group' | 'channel' = 'group',
  ): TgChat => ({
    id,
    kind,
    title,
    forum: false,
    admin,
  })
  const list = opts.dialogs ?? [
    group(GROUP, 'Company', true),
    group(CHANNEL, 'News', true, 'channel'),
    group(PLAIN, 'Lounge', false),
  ]
  for (const c of list) {
    if (c.kind !== 'dm') {
      chats.upsertDialog(CONN, c, 1)
      chats.setSelected(CONN, c.id, true, 1)
    }
  }
  const counters = new Map<string, number>()
  const calls: string[] = []
  const sent: Array<{ to: string; text: string }> = []
  const created: TgChat[] = []
  const wrapped = {
    sendText: async (to: string, text: string) => {
      sent.push({ to, text })
      return { id: 1 }
    },
    ...client,
  } as unknown as TgUserClient
  const all = accountActions({
    connectionId: CONN,
    client: wrapped,
    chats,
    counters: {
      get: (_c, key) => counters.get(key) ?? 0,
      add: (_c, key, _now, n = 1) => void counters.set(key, (counters.get(key) ?? 0) + n),
    },
    settings: () => ({ dmDailyMax: 30, dailyMax: 300, adminLogEveryMs: 4 * 3_600_000 }),
    selfId: '1',
    dialogs: async () => list,
    call: async (_c, fn, callOpts) => {
      opts.callOpts?.push(callOpts)
      try {
        return await fn()
      } catch (error) {
        throw new Error(describeError(classifyError(error)))
      }
    },
    blocked: () => undefined,
    learnTopics: () => undefined,
    timezone: () => 'UTC',
    now: () => NOW,
    sleep: opts.sleep ?? (async () => undefined),
    ...(opts.files === undefined ? {} : { readFile: async (p: string) => opts.files?.[p] }),
    hooks: {
      chatCreated: async (chat) => {
        created.push(chat)
      },
    },
  })
  return {
    all,
    calls,
    sent,
    created,
    counters,
    by(name) {
      const a = all.find((x) => x.name === name)
      if (a === undefined) throw new Error(`no action ${name}`)
      return a
    },
  }
}

describe('create group and channel', () => {
  test('a group with members: per-person results, the chat is adopted, the link comes back', async () => {
    const r = build({
      createSupergroup: async (o) => ({
        id: '-1009',
        kind: 'group',
        title: o.title,
        forum: o.forum === true,
        admin: true,
      }),
      getUserInfo: async (ref) => user(ref, `User ${ref}`),
      addMember: async (_c, u) => ({ added: u !== '22' }),
      primaryInviteLink: async () => ({ link: 'https://t.me/+abc' }),
    })
    const out = await r.by('create_group').run({ title: 'Ops', forum: true, members: ['21', '22'] })
    expect(out).toContain('Created forum group "Ops" (-1009)')
    expect(out).toContain('21')
    expect(out).toContain('added')
    expect(out).toContain('NOT added')
    expect(out).toContain('https://t.me/+abc')
    expect(r.created.map((c) => c.id)).toEqual(['-1009'])
    expect(r.sent).toEqual([])
    expect(r.by('create_group').risk).toBe('external')
  })

  test('the daily creation cap refuses', async () => {
    const r = build({
      createSupergroup: async () => ({
        id: '-1',
        kind: 'group',
        title: 'x',
        forum: false,
        admin: true,
      }),
    })
    r.counters.set('create', 5)
    expect(await r.by('create_group').run({ title: 'x' })).toContain('created 5 chats today')
  })

  test('a channel with a public username, and a taken username is readable', async () => {
    const r = build({
      createChannel: async (o) => ({
        id: '-1008',
        kind: 'channel',
        title: o.title,
        forum: false,
        admin: true,
      }),
      setChatUsername: async (_c, name) => {
        if (name === 'taken_name') throw new TgRpcError('USERNAME_OCCUPIED')
      },
      primaryInviteLink: async () => ({ link: 'https://t.me/+zzz' }),
    })
    const ok = await r.by('create_channel').run({ title: 'Daily', username: 'daily_news' })
    expect(ok).toContain('https://t.me/daily_news')
    expect(r.created[0]?.kind).toBe('channel')
    const taken = await r.by('create_channel').run({ title: 'Daily2', username: 'taken_name' })
    expect(taken).toContain('already taken')
    expect(taken).toContain('https://t.me/+zzz')
    expect(await r.by('create_channel').run({ title: 'x', username: 'a b' })).toContain(
      'not a valid public username',
    )
  })
})

describe('add_members', () => {
  const dm = (id: string): TgChat => ({
    id,
    kind: 'dm',
    title: `P${id}`,
    forum: false,
    admin: false,
  })
  const dialogs: TgChat[] = [
    { id: GROUP, kind: 'group', title: 'Company', forum: false, admin: true },
    dm('2'),
  ]
  const outcomes: Record<string, string | { added: boolean }> = {
    '1': { added: true },
    '2': 'USER_PRIVACY_RESTRICTED',
    '3': 'USER_ALREADY_PARTICIPANT',
    '4': 'USER_KICKED',
    '5': 'USER_CHANNELS_TOO_MUCH',
    '6': 'USER_NOT_MUTUAL_CONTACT',
    '7': 'USER_BANNED_IN_CHANNEL',
  }
  const client = (): Partial<TgUserClient> => ({
    addMember: async (_c, u) => {
      const o = outcomes[u]
      if (typeof o === 'string') throw new TgRpcError(o)
      return o ?? { added: true }
    },
    primaryInviteLink: async () => ({ link: 'https://t.me/+inv' }),
  })

  test('mixed results per person; the link goes by DM only where a conversation exists', async () => {
    const r = build(client(), { dialogs })
    const out = await r.by('add_members').run({
      chat: GROUP,
      users: ['1', '2', '3', '4', '5', '6', '7'],
      send_link_to: 'dm',
    })
    expect(out).toContain('- 1: added')
    expect(out).toContain('- 3: already in the chat')
    expect(out).toContain('removed from this chat') // USER_KICKED
    expect(out).toContain('most chats Telegram allows') // USER_CHANNELS_TOO_MUCH
    expect(out).toContain('limited from adding people') // USER_BANNED_IN_CHANNEL
    // 2 has a conversation: DM; 6 has none: never cold-messaged
    expect(r.sent.map((s) => s.to)).toEqual(['2'])
    expect(r.sent[0]?.text).toContain('https://t.me/+inv')
    expect(out).toContain('- 2: invite link sent by direct message')
    expect(out).toContain('Invite link for 6: https://t.me/+inv')
    expect(out).toContain('never starts one')
  })

  test('without send_link_to nothing is sent, the link is handed back', async () => {
    const r = build(client(), { dialogs })
    const out = await r.by('add_members').run({ chat: GROUP, users: ['2'] })
    expect(r.sent).toEqual([])
    expect(out).toContain('https://t.me/+inv')
  })

  test('a flood stops the batch; the cap is in the schema; daily cap refuses the rest', async () => {
    const r = build(
      {
        addMember: async (_c, u) => {
          if (u === '2') throw new TgRpcError('PEER_FLOOD')
          return { added: true }
        },
      },
      { dialogs },
    )
    const out = await r.by('add_members').run({ chat: GROUP, users: ['1', '2', '3'] })
    expect(out).toContain('- 3: not attempted')
    const schema = r.by('add_members').schema
    expect(
      schema.safeParse({ chat: GROUP, users: Array.from({ length: 21 }, (_, i) => String(i + 1)) })
        .success,
    ).toBe(false)
    const capped = build({ addMember: async () => ({ added: true }) }, { dialogs })
    capped.counters.set('invite', 60)
    expect(await capped.by('add_members').run({ chat: GROUP, users: ['9'] })).toContain('daily cap')
  })

  test('only a chat the account administers', async () => {
    const r = build(client(), {
      dialogs: [
        ...dialogs,
        { id: PLAIN, kind: 'group', title: 'Lounge', forum: false, admin: false },
      ],
    })
    expect(await r.by('add_members').run({ chat: PLAIN, users: ['1'] })).toContain('not an admin')
  })
})

describe('chat info, visibility, permissions', () => {
  test('set_chat_info: title, description, photo from the library, signatures only in channels', async () => {
    const log: string[] = []
    const r = build(
      {
        setChatTitle: async (_c, t) => void log.push(`title:${t}`),
        setChatDescription: async (_c, t) => void log.push(`about:${t}`),
        setChatPhoto: async (_c, f) => void log.push(`photo:${f.name}`),
        setChannelSignatures: async (_c, on) => void log.push(`sig:${on}`),
      },
      {
        files: {
          '/library/logo.png': { bytes: new Uint8Array([1]), mediaType: 'image/png' },
          '/library/a.pdf': { bytes: new Uint8Array([1]), mediaType: 'application/pdf' },
        },
      },
    )
    const out = await r.by('set_chat_info').run({
      chat: CHANNEL,
      title: 'New',
      description: 'About',
      photo: '/library/logo.png',
      post_signatures: true,
    })
    expect(out).toContain('title "New"')
    expect(log).toEqual(['title:New', 'about:About', 'photo:logo.png', 'sig:true'])
    expect(await r.by('set_chat_info').run({ chat: GROUP, post_signatures: true })).toContain(
      'channels only',
    )
    expect(await r.by('set_chat_info').run({ chat: GROUP, photo: '/library/a.pdf' })).toContain(
      'not an image',
    )
    expect(await r.by('set_chat_info').run({ chat: GROUP })).toContain('ERROR')
  })

  test('visibility: public, occupied, invalid, private, join requests', async () => {
    const names: Array<string | null> = []
    const approvals: boolean[] = []
    const r = build({
      setChatUsername: async (_c, n) => {
        names.push(n)
        if (n === 'busy_name') throw new TgRpcError('USERNAME_OCCUPIED')
        if (n === 'too_many') throw new TgRpcError('CHANNELS_ADMIN_PUBLIC_TOO_MUCH')
      },
      setJoinRequests: async (_c, on) => void approvals.push(on),
    })
    const v = r.by('set_chat_visibility')
    expect(
      await v.run({ chat: GROUP, visibility: 'public', username: 'https://t.me/open_group' }),
    ).toContain('https://t.me/open_group')
    expect(await v.run({ chat: GROUP, visibility: 'public', username: 'busy_name' })).toContain(
      'already taken',
    )
    expect(await v.run({ chat: GROUP, visibility: 'public', username: 'too_many' })).toContain(
      'most public chats',
    )
    expect(await v.run({ chat: GROUP, visibility: 'public', username: '1bad' })).toContain(
      'not a valid username',
    )
    expect(await v.run({ chat: GROUP, visibility: 'public' })).toContain('needs a username')
    expect(await v.run({ chat: GROUP, visibility: 'private', join_requests: true })).toContain(
      'private',
    )
    expect(names.at(-1)).toBeNull()
    expect(approvals).toEqual([true])
    expect(await v.run({ chat: GROUP })).toContain('ERROR')
  })

  test('join requests: list and answer, all needs confirm', async () => {
    const answered: Array<Record<string, unknown>> = []
    const r = build({
      listJoinRequests: async () => [
        { user: user('7', 'Rin', 'rin'), at: NOW - 60_000, bio: 'hello' },
      ],
      answerJoinRequests: async (_c, o) => void answered.push(o),
    })
    const list = await r.by('list_join_requests').run({ chat: GROUP })
    expect(list).toContain('Rin (id 7, @rin)')
    expect(r.by('list_join_requests').risk).toBe('read')
    expect(
      await r.by('answer_join_request').run({ chat: GROUP, action: 'approve', user: '7' }),
    ).toContain('Approved the request of user 7')
    expect(
      await r.by('answer_join_request').run({ chat: GROUP, action: 'decline', all: true }),
    ).toContain('needs confirm: true')
    expect(answered).toHaveLength(1)
    expect(
      await r
        .by('answer_join_request')
        .run({ chat: GROUP, action: 'decline', all: true, confirm: true }),
    ).toContain('Declined all')
    expect(answered[1]).toMatchObject({ action: 'decline', all: true })
  })

  test('invite links: list, edit, revoke, create with a title', async () => {
    const link: TgInviteLink = {
      link: 'https://t.me/+one',
      title: 'Launch',
      primary: false,
      revoked: false,
      expiresAt: NOW + 86_400_000,
      usageLimit: 10,
      usage: 3,
      withApproval: true,
      pendingRequests: 2,
    }
    const edits: Array<Record<string, unknown>> = []
    const revoked: string[] = []
    const created: Array<Record<string, unknown>> = []
    const r = build({
      listInviteLinks: async () => [link],
      editInviteLink: async (_c, _l, o) => {
        edits.push(o)
        return { ...link, usageLimit: undefined as never }
      },
      revokeInviteLink: async (_c, l) => void revoked.push(l),
      createInviteLink: async (_c, o) => {
        created.push(o)
        return { link: 'https://t.me/+new' }
      },
    })
    const list = await r.by('list_invite_links').run({ chat: GROUP })
    expect(list).toContain('https://t.me/+one "Launch"')
    expect(list).toContain('joined 3/10')
    expect(list).toContain('needs approval (2 waiting)')
    expect(
      await r.by('edit_invite_link').run({
        chat: GROUP,
        link: 'https://t.me/+one',
        expires_days: 0,
        usage_limit: 0,
        title: 'x',
      }),
    ).toContain('Updated')
    expect(edits[0]).toEqual({ expiresAt: 0, usageLimit: 0, title: 'x' })
    expect(
      await r.by('edit_invite_link').run({ chat: GROUP, link: 'https://t.me/+one' }),
    ).toContain('ERROR')
    expect(
      await r.by('revoke_invite_link').run({ chat: GROUP, link: 'https://t.me/+one' }),
    ).toContain('Revoked')
    expect(revoked).toEqual(['https://t.me/+one'])
    await r
      .by('create_invite_link')
      .run({ chat: GROUP, expires_days: 2, usage_limit: 5, with_approval: true, title: 'Friends' })
    expect(created[0]).toMatchObject({ usageLimit: 5, withApproval: true, title: 'Friends' })
  })

  test('default permissions, slow mode and forum', async () => {
    const changes: unknown[] = []
    const slow: number[] = []
    const forum: boolean[] = []
    const r = build({
      setDefaultPermissions: async (_c, c) => void changes.push(c),
      setSlowMode: async (_c, s) => void slow.push(s),
      setForum: async (_c, on) => void forum.push(on),
    })
    const a = r.by('set_default_permissions')
    const out = await a.run({
      chat: GROUP,
      send_media: false,
      invite_users: true,
      slow_mode_seconds: 60,
      forum: true,
    })
    expect(out).toContain('send_media=no')
    expect(changes).toEqual([{ sendMedia: false, inviteUsers: true }])
    expect(slow).toEqual([60])
    expect(forum).toEqual([true])
    expect(await a.run({ chat: GROUP, slow_mode_seconds: 45 })).toContain('slow mode is one of')
    expect(await a.run({ chat: CHANNEL, send_media: false })).toContain(
      'channels have no member permissions',
    )
    expect(await a.run({ chat: GROUP })).toContain('ERROR')
  })

  test('channel settings: signatures, discussion link and unlink, auto delete, reactions', async () => {
    const log: string[] = []
    const r = build({
      setChannelSignatures: async (_c, on) => void log.push(`sig:${on}`),
      linkDiscussionGroup: async (c, g) => void log.push(`link:${c}:${g}`),
      setChatTtl: async (_c, s) => void log.push(`ttl:${s}`),
      setReactions: async (_c, o) => void log.push(`react:${o.mode}:${(o.emojis ?? []).join('')}`),
    })
    const m = r.by('manage_chat_settings')
    expect(await m.run({ chat: CHANNEL, action: 'signatures', enabled: true })).toContain('signed')
    expect(await m.run({ chat: CHANNEL, action: 'link_discussion', group: GROUP })).toContain(
      'discussion group',
    )
    expect(await m.run({ chat: CHANNEL, action: 'unlink_discussion' })).toContain(
      'no discussion group',
    )
    expect(await m.run({ chat: GROUP, action: 'auto_delete', period: '1w' })).toContain('a week')
    expect(
      await m.run({ chat: GROUP, action: 'reactions', mode: 'some', emojis: ['👍'] }),
    ).toContain('👍')
    expect(await m.run({ chat: GROUP, action: 'reactions', mode: 'some' })).toContain(
      'needs emojis',
    )
    expect(await m.run({ chat: GROUP, action: 'signatures', enabled: true })).toContain(
      'channels only',
    )
    expect(log).toEqual([
      `sig:true`,
      `link:${CHANNEL}:${GROUP}`,
      `link:${CHANNEL}:null`,
      'ttl:604800',
      'react:some:👍',
    ])
  })
})

describe('delete, ownership, admins', () => {
  test('delete_chat: owner only, refuses without confirm, deletes with it', async () => {
    const deleted: string[] = []
    const r = build({ deleteChat: async (c) => void deleted.push(c) })
    const a = r.by('delete_chat')
    expect(a.ownerOnly).toBe(true)
    expect(a.risk).toBe('destructive')
    expect(await a.run({ chat: GROUP })).toContain('cannot be undone')
    expect(deleted).toEqual([])
    expect(await a.run({ chat: GROUP, confirm: true })).toContain('Deleted "Company"')
    expect(deleted).toEqual([GROUP])
  })

  test('transfer_ownership explains and never touches the client', async () => {
    const r = build({})
    const a = r.by('transfer_ownership')
    expect(a.ownerOnly).toBe(true)
    const out = await a.run({ chat: GROUP, user: '5' })
    expect(out).toContain('two-step verification password')
    expect(out).toContain('Telegram app')
    expect(out).toContain('Do not ask for the password')
  })

  test('destructive tools are owner only', () => {
    const r = build({})
    for (const name of [
      'delete_chat',
      'transfer_ownership',
      'clear_history',
      'delete_forum_topic',
      'kick_member',
      'promote_member',
      'ban_member',
    ]) {
      expect(r.by(name).ownerOnly).toBe(true)
      expect(r.by(name).risk).toBe('destructive')
    }
  })

  test('clear history and topic deletion need confirm', async () => {
    const r = build(
      { clearHistory: async () => undefined, deleteTopic: async () => undefined },
      {
        dialogs: [{ id: GROUP, kind: 'group', title: 'Company', forum: true, admin: true }],
      },
    )
    expect(await r.by('clear_history').run({ chat: GROUP, for: 'everyone' })).toContain(
      'cannot be undone',
    )
    expect(
      await r.by('clear_history').run({ chat: GROUP, for: 'everyone', confirm: true }),
    ).toContain('for everybody')
    expect(await r.by('delete_forum_topic').run({ chat: GROUP, topic: 4 })).toContain(
      'confirm: true',
    )
    expect(
      await r.by('delete_forum_topic').run({ chat: GROUP, topic: 4, confirm: true }),
    ).toContain('Deleted topic 4')
  })

  test('promote hands out every right, member_info shows the exact rights and the promoter', async () => {
    let got: TgAdminRights | undefined
    const r = build({
      promoteMember: async (_c, _u, rights) => {
        got = rights
      },
      getMember: async () => ({
        user: user('42', 'Mia'),
        status: 'admin',
        title: 'Boss',
        rights: ['change_info', 'add_admins'],
        promotedBy: { id: '9', name: 'Zed' },
        canEdit: false,
      }),
    })
    const out = await r.by('promote_member').run({
      chat: CHANNEL,
      user: '42',
      rights: [
        'post_messages',
        'edit_messages',
        'delete_messages',
        'invite_users',
        'add_admins',
        'anonymous',
        'manage_video_chats',
      ],
    })
    expect(out).toContain('post_messages')
    expect(got).toMatchObject({
      postMessages: true,
      editMessages: true,
      addAdmins: true,
      anonymous: true,
      manageCall: true,
    })
    const info = await r.by('member_info').run({ chat: GROUP, user: '42' })
    expect(info).toContain('Admin rights: change_info, add_admins')
    expect(info).toContain('Promoted by Zed')
    expect(info).toContain('cannot change them')
  })
})

describe('contacts', () => {
  test('add_contact and list_contacts (no phone numbers)', async () => {
    const added: Array<Record<string, unknown>> = []
    const r = build({
      addContact: async (o) => {
        added.push(o)
        return user('5', 'Eka Putri')
      },
      listContacts: async () => [
        { ...user('5', 'Eka Putri', 'eka'), phone: '+000', mutual: true },
        { ...user('6', 'Bayu'), mutual: false },
      ],
    })
    const out = await r.by('add_contact').run({ user: '5', first_name: 'Eka', last_name: 'Putri' })
    expect(out).toContain('phone number was not shared')
    expect(out).toContain('also have this account in their contacts')
    expect(added[0]).toMatchObject({ sharePhone: false, firstName: 'Eka' })
    const list = await r.by('list_contacts').run({})
    expect(list).toContain('Eka Putri (id 5, @eka), mutual')
    expect(list).not.toContain('+000')
    expect(r.by('list_contacts').risk).toBe('read')
  })
})

describe('roles and readable errors', () => {
  test('a member or guest of the team never gets these tools; staff does', () => {
    const r = build({})
    const names = [
      'create_group',
      'add_members',
      'set_chat_visibility',
      'set_default_permissions',
      'edit_invite_link',
      'delete_chat',
    ]
    for (const name of names) {
      const a = r.by(name)
      const tool = `telegram_user_${name}`
      expect(decideTool('member', tool, a.risk).allowed).toBe(false)
      expect(decideTool('guest', tool, a.risk).allowed).toBe(false)
      expect(decideTool('admin', tool, a.risk).allowed).toBe(true)
      expect(decideTool('owner', tool, a.risk).allowed).toBe(true)
    }
  })

  test('risks: reads read, changes external, deletes destructive', () => {
    const r = build({})
    for (const n of [
      'list_join_requests',
      'list_invite_links',
      'list_contacts',
      'member_info',
      'poll_results',
      'post_stats',
      'resolve_chat',
      'check_invite_link',
      'chat_stats',
    ])
      expect(r.by(n).risk).toBe('read')
    for (const n of [
      'create_group',
      'create_channel',
      'add_members',
      'set_chat_info',
      'set_chat_visibility',
      'set_default_permissions',
      'manage_chat_settings',
      'answer_join_request',
      'edit_invite_link',
      'revoke_invite_link',
      'add_contact',
      'copy_message',
      'comment_on_post',
      'send_album',
    ])
      expect(r.by(n).risk).toBe('external')
    for (const n of [
      'delete_chat',
      'transfer_ownership',
      'kick_member',
      'clear_history',
      'delete_forum_topic',
    ])
      expect(r.by(n).risk).toBe('destructive')
  })

  test('new RPC errors are request errors with a sentence, never breaker material', () => {
    const codes = [
      'USER_PRIVACY_RESTRICTED',
      'USER_NOT_MUTUAL_CONTACT',
      'USER_CHANNELS_TOO_MUCH',
      'USER_KICKED',
      'USER_BANNED_IN_CHANNEL',
      'USER_ALREADY_PARTICIPANT',
      'USERNAME_OCCUPIED',
      'USERNAME_INVALID',
      'CHANNELS_ADMIN_PUBLIC_TOO_MUCH',
      'CHAT_ADMIN_REQUIRED',
      'RIGHT_FORBIDDEN',
      'USER_ADMIN_INVALID',
      'CHAT_CREATOR_REQUIRED',
      'CHAT_LINK_EXISTS',
      'INVITE_HASH_EXPIRED',
      'HIDE_REQUESTER_MISSING',
      'PARTICIPANTS_TOO_FEW',
      'STATS_MIGRATE_4',
    ]
    for (const code of codes) {
      const k = classifyError(new TgRpcError(code))
      expect(k.kind).toBe('invalid')
      const sentence = describeError(k)
      expect(sentence).not.toBe(`Telegram refused the request (${k.text}).`)
      expect(sentence.length).toBeGreaterThan(30)
    }
  })

  test('admin errors say what to do', () => {
    const say = (code: string) => describeError(classifyError(new TgRpcError(code)))
    expect(say('USER_ADMIN_INVALID')).toContain('not promoted by this account')
    expect(say('CHAT_ADMIN_REQUIRED')).toContain('lacks the admin right')
    expect(say('RIGHT_FORBIDDEN')).toContain('only give rights it holds itself')
  })

  test('a Telegram refusal answers as text and does not throw', async () => {
    const r = build({
      setChatTitle: async () => {
        throw new TgRpcError('CHAT_ADMIN_REQUIRED')
      },
    })
    const out = await r.by('set_chat_info').run({ chat: GROUP, title: 'X' })
    expect(out.startsWith('ERROR:')).toBe(true)
    expect(out).toContain('lacks the admin right')
  })
})

function governed(client: Partial<TgUserClient>, opts: Parameters<typeof build>[1] = {}) {
  const r = build(client, opts)
  const rows: Array<{
    action: string
    result: string
    kind: string
    target?: unknown
    summary?: string
    note?: string
    context?: { role?: string; requester?: string }
  }> = []
  const governor = createGovernor({
    limitsOf: () => ({
      read: { burst: 50, perMinute: 6000 },
      edit: { burst: 50, perMinute: 6000 },
      admin: { burst: 50, perMinute: 6000 },
      global: { burst: 100, perMinute: 6000 },
      gap: { edit: { minMs: 0, maxMs: 0 }, admin: { minMs: 0, maxMs: 0 } },
      parkWaitMs: 1000,
      floodStorm: { count: 3, windowMs: 60_000 },
    }),
    audit: (a) => void rows.push(a as never),
  })
  const adapter = governAdapter(
    { connectionId: CONN, actions: r.all } as unknown as ChannelAdapter,
    { governor },
  )
  const act = (name: string): NativeAction => {
    const a = adapter.actions?.find((x) => x.name === name)
    if (a === undefined) throw new Error(name)
    return a
  }
  return { rows, governor, act }
}

describe('audit trail', () => {
  test('every action leaves a row: who, what, target, parameters, result, duration', async () => {
    const g = governed({
      listContacts: async () => [],
      setChatTitle: async () => undefined,
      deleteChat: async () => undefined,
    })
    await g.governor.within(
      { role: 'owner', requester: 'web owner', sessionId: 's1', agentId: 'a1', origin: 'dm' },
      async () => {
        await g.act('set_chat_info').run({ chat: GROUP, title: 'Renamed' })
        await g.act('list_contacts').run({})
        await g.act('delete_chat').run({ chat: GROUP })
      },
    )
    const [info, contacts, del] = g.rows
    expect(info).toMatchObject({
      action: 'set_chat_info',
      result: 'ok',
      kind: 'action',
      target: { chat: GROUP },
    })
    expect(info?.summary).toContain('title=Renamed')
    expect(info?.context).toMatchObject({ role: 'owner', requester: 'web owner' })
    expect(contacts).toMatchObject({ action: 'list_contacts', kind: 'read', result: 'ok' })
    // the confirmation is missing: refused, with the reason
    expect(del).toMatchObject({ action: 'delete_chat', result: 'refused' })
    expect(del?.note).toContain('cannot be undone')
  })

  test('a Telegram error is audited as error; message bodies stay out of the summary', async () => {
    const g = governed({
      commentOnPost: async () => {
        throw new TgRpcError('CHAT_WRITE_FORBIDDEN')
      },
    })
    await g.act('comment_on_post').run({ chat: GROUP, post: 3, text: 'very private words' })
    expect(g.rows[0]?.result).toBe('error')
    expect(g.rows[0]?.summary).toContain('text=<18 chars>')
    expect(JSON.stringify(g.rows)).not.toContain('private words')
  })

  test('governor.record writes a refusal that never reached the action (role policy)', () => {
    const g = governed({})
    g.governor.within({ role: 'member', requester: 'Mia', origin: 'dm' }, () =>
      g.governor.record(
        { connectionId: CONN, action: 'create_group', kind: 'action', args: { title: 'x' } },
        'refused',
        { note: 'denied by role policy' },
      ),
    )
    expect(g.rows[0]).toMatchObject({ result: 'refused', action: 'create_group' })
    expect(g.rows[0]?.context?.role).toBe('member')
  })
})

describe('schemas', () => {
  test('every new tool has a strict object schema', () => {
    const r = build({})
    for (const a of r.all) expect(a.schema).toBeInstanceOf(z.ZodObject)
    const names = r.all.map((a) => a.name)
    expect(new Set(names).size).toBe(names.length)
  })
})

describe('pacing of chat changes', () => {
  /** An error shaped like mtcute's: the number cut out of the text, kept in `seconds`. */
  const flood = (seconds: number): Error =>
    Object.assign(new Error(`Telegram API error 420: FLOOD_WAIT_%d`), {
      text: 'FLOOD_WAIT_%d',
      seconds,
    })

  test('chat changes are admin calls; posts and reads keep their class', () => {
    const r = build({})
    for (const name of ['set_chat_visibility', 'set_chat_info', 'add_members', 'kick_member'])
      expect(r.by(name).rate).toBe('admin')
    for (const name of ['copy_message', 'send_album', 'list_contacts', 'pin_message'])
      expect(r.by(name).rate).toBeUndefined()
  })

  test('a short flood wait is sat out and the change tried once more', async () => {
    const sleeps: number[] = []
    const callOpts: Array<{ storm?: boolean } | undefined> = []
    let n = 0
    const r = build(
      {
        setChatUsername: async () => {
          n++
          if (n === 1) throw flood(5)
        },
      },
      { sleep: async (ms) => void sleeps.push(ms), callOpts },
    )
    const out = await r
      .by('set_chat_visibility')
      .run({ chat: CHANNEL, visibility: 'public', username: 'newsroom_five' })
    expect(out).toContain('public at https://t.me/newsroom_five')
    expect(n).toBe(2)
    expect(sleeps).toHaveLength(1)
    expect(sleeps[0]).toBeGreaterThanOrEqual(5000)
    // a chat change never counts toward the flood storm that pauses sending
    expect(callOpts.every((o) => o?.storm === false)).toBe(true)
  })

  test('a long flood wait parks chat changes only and says until when, never retried tight', async () => {
    let n = 0
    const g = governed({
      setChatUsername: async () => {
        n++
        throw flood(AUTO_FLOOD_WAIT_S + 270)
      },
      setChatTitle: async () => undefined,
      listContacts: async () => [],
    })
    const out = await g
      .act('set_chat_visibility')
      .run({ chat: CHANNEL, visibility: 'public', username: 'newsroom_five' })
    expect(n).toBe(1)
    expect(out).toContain('FLOOD_WAIT_300')
    expect(out).toContain('Chat changes are paused until')
    expect(out).toContain('do not sleep in code')
    expect(g.rows.at(-1)).toMatchObject({ action: 'set_chat_visibility', result: 'rate_limited' })
    expect(g.governor.state(CONN).classes.map((c) => c.cls)).toEqual(['admin'])
    // the next chat change waits for the park instead of hitting Telegram again
    const next = await g.act('set_chat_info').run({ chat: GROUP, title: 'X' })
    expect(next).toMatch(/^ERROR: rate limited, retry in \d+ s/)
    // reads go on
    expect(await g.act('list_contacts').run({})).not.toContain('rate limited')
  })
})
