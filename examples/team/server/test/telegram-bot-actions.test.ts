/**
 * The Bot API platform tools (`src/infra/telegram/actions.ts`) against a fake Bot API: each family
 * works with an admin bot, a missing right is explained, destructive calls need confirm, owner-only
 * tools are flagged for the plugin's role check, join requests reach the agent, the Bot API limits
 * are answered readably, and every call leaves a complete audit row through the governor.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import {
  type AuditRecord,
  BOT_GOVERNOR,
  createGovernor,
  governAdapter,
} from '../src/infra/channels/governor.ts'
import type { AdapterHost, RemoteEvent } from '../src/infra/channels/types.ts'
import { createTelegramAdapter, type TelegramAdapter } from '../src/infra/telegram/adapter.ts'
import { type FakeTelegram, fakeTelegram, tg } from './support/fake-telegram.ts'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function until(what: string, cond: () => boolean, ms = 5000) {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`)
    await sleep(10)
  }
}
const host: AdapterHost = { isAllowed: () => true, locate: () => [], isOwn: () => false }

let port = 0
const fakes: FakeTelegram[] = []
const adapters: TelegramAdapter[] = []
afterEach(async () => {
  for (const a of adapters.splice(0)) await a.stop()
  for (const f of fakes.splice(0)) f.stop()
})

function setup() {
  const fake = fakeTelegram(4960 + (port++ % 8))
  fakes.push(fake)
  const adapter = createTelegramAdapter({
    connectionId: 'tg1',
    token: fake.token,
    apiRoot: fake.url,
    pollTimeoutSec: 1,
  })
  adapters.push(adapter)
  const events: RemoteEvent[] = []
  const rows: AuditRecord[] = []
  const governor = createGovernor({
    limitsOf: () => BOT_GOVERNOR,
    audit: (r) => rows.push(r),
  })
  const governed = governAdapter(adapter, { governor })
  const tool = (name: string) => {
    const a = governed.actions?.find((x) => x.name === name)
    if (a === undefined) throw new Error(`no tool ${name}`)
    return (input: Record<string, unknown>, who?: { requester: string; role: string }) =>
      who === undefined
        ? a.run(input)
        : governor.within(
            {
              requester: who.requester,
              role: who.role,
              origin: 'chat',
              sessionId: 's1',
              agentId: 'a1',
            },
            () => a.run(input),
          )
  }
  return {
    fake,
    adapter,
    events,
    rows,
    tool,
    start: () => adapter.start(async (e) => void events.push(e), host),
  }
}

const notEnough = {
  error_code: 400,
  description: 'Bad Request: not enough rights to restrict/unrestrict chat member',
}

describe('telegram bot tools: catalog and roles', () => {
  test('owner-only tools are flagged; reads and topics are not', () => {
    const { adapter } = setup()
    const by = Object.fromEntries((adapter.actions ?? []).map((a) => [a.name, a]))
    for (const n of [
      'chat_settings',
      'chat_members',
      'chat_invites',
      'bot_profile',
      'chat_destructive',
    ]) {
      expect(by[n]?.ownerOnly).toBe(true)
    }
    for (const n of ['chat_info', 'join_requests', 'chat_messages', 'chat_topics']) {
      expect(by[n]?.ownerOnly).toBeUndefined()
    }
    expect(by.chat_destructive?.risk).toBe('destructive')
  })
})

describe('telegram bot tools: families with an admin bot', () => {
  test('chat info: chat, administrators with exact rights, one member, count', async () => {
    const { fake, tool } = setup()
    fake.reply('getChat', {
      id: -1001,
      type: 'supergroup',
      title: 'Ops',
      slow_mode_delay: 30,
      permissions: { can_send_messages: true, can_send_polls: false },
    })
    expect(await tool('chat_info')({ action: 'chat', chat: '-1001' })).toContain('Slow mode: 30 s')
    fake.reply('getChatAdministrators', [
      { status: 'creator', user: { id: 1, is_bot: false, first_name: 'Ana' } },
      {
        status: 'administrator',
        user: { id: 2, is_bot: false, first_name: 'Bo' },
        can_pin_messages: true,
        can_delete_messages: true,
        can_post_messages: false,
        custom_title: 'Mod',
      },
    ])
    const admins = await tool('chat_info')({ action: 'administrators', chat: '-1001' })
    expect(admins).toContain('Ana (id 1): creator (all rights)')
    expect(admins).toContain('rights: can_delete_messages, can_pin_messages')
    expect(admins).toContain('"Mod"')
    fake.reply('getChatMember', {
      status: 'administrator',
      user: { id: 2, first_name: 'Bo' },
      can_be_edited: false,
      can_invite_users: true,
    })
    expect(await tool('chat_info')({ action: 'member', chat: '-1001', user: 2 })).toContain(
      'may NOT edit this admin',
    )
    fake.reply('getChatMemberCount', 12)
    expect(await tool('chat_info')({ action: 'member_count', chat: '-1001' })).toBe('12 members.')
    expect(await tool('chat_info')({ action: 'limits' })).toContain('cannot create groups')
  })

  test('settings: title, permissions (independent) and the things a bot cannot do', async () => {
    const { fake, tool } = setup()
    expect(await tool('chat_settings')({ action: 'set_title', chat: '-1001', title: 'New' })).toBe(
      'Title changed.',
    )
    expect(fake.callsOf('setChatTitle')[0]?.params).toMatchObject({ chat_id: -1001, title: 'New' })
    await tool('chat_settings')({
      action: 'set_permissions',
      chat: '-1001',
      permissions: ['can_send_messages'],
      independent: true,
    })
    const p = fake.callsOf('setChatPermissions')[0]?.params as Record<string, unknown>
    expect(p.use_independent_chat_permissions).toBe(true)
    expect(p.permissions).toMatchObject({ can_send_messages: true, can_send_polls: false })
    expect(await tool('chat_settings')({ action: 'slow_mode', chat: '-1001' })).toContain(
      'no slow mode',
    )
    expect(await tool('chat_settings')({ action: 'create_chat' })).toContain(
      'cannot create groups or channels',
    )
  })

  test('members: ban with until, kick, restrict, promote with every right, demote, title', async () => {
    const { fake, tool } = setup()
    await tool('chat_members')({ action: 'ban', chat: '-1001', user: 9, for_minutes: 60 })
    const ban = fake.callsOf('banChatMember')[0]?.params as Record<string, unknown>
    expect(Number(ban.until_date)).toBeGreaterThan(Date.now() / 1000)
    await tool('chat_members')({ action: 'kick', chat: '-1001', user: 9 })
    expect(fake.callsOf('banChatMember')).toHaveLength(2)
    expect(fake.callsOf('unbanChatMember')[0]?.params).toMatchObject({ only_if_banned: true })
    await tool('chat_members')({
      action: 'restrict',
      chat: '-1001',
      user: 9,
      permissions: ['can_send_messages'],
      for_minutes: 10,
    })
    expect(fake.callsOf('restrictChatMember')[0]?.params).toMatchObject({ user_id: 9 })
    await tool('chat_members')({
      action: 'promote',
      chat: '-1002',
      user: 9,
      rights: ['can_post_messages', 'can_edit_messages', 'can_manage_video_chats'],
    })
    expect(fake.callsOf('promoteChatMember')[0]?.params).toMatchObject({
      can_post_messages: true,
      can_edit_messages: true,
      can_manage_video_chats: true,
      can_delete_messages: false,
      can_promote_members: false,
      is_anonymous: false,
      can_post_stories: false,
    })
    await tool('chat_members')({ action: 'demote', chat: '-1002', user: 9 })
    const demote = fake.callsOf('promoteChatMember')[1]?.params as Record<string, unknown>
    expect(Object.values(demote).filter((v) => v === true)).toHaveLength(0)
    await tool('chat_members')({ action: 'admin_title', chat: '-1001', user: 9, title: 'Captain' })
    expect(fake.callsOf('setChatAdministratorCustomTitle')[0]?.params).toMatchObject({
      custom_title: 'Captain',
    })
    await tool('chat_members')({ action: 'ban_sender_chat', chat: '-1001', sender_chat: -100777 })
    expect(fake.callsOf('banChatSenderChat')).toHaveLength(1)
  })

  test('bots cannot add members: the answer names the invite link workaround', async () => {
    const { fake, tool } = setup()
    const text = await tool('chat_members')({ action: 'add_member', chat: '-1001', user: 9 })
    expect(text).toContain('Bots cannot add people')
    expect(text).toContain('invite link')
    expect(fake.callsOf('addChatMember')).toHaveLength(0)
  })

  test('invites: create (approval link), revoke; approval links cannot have a limit', async () => {
    const { fake, tool } = setup()
    fake.reply('createChatInviteLink', {
      invite_link: 'https://t.me/+abc',
      creates_join_request: true,
      creator: {},
      is_primary: false,
      is_revoked: false,
    })
    const made = await tool('chat_invites')({
      action: 'create_link',
      chat: '-1001',
      name: 'press',
      requires_approval: true,
      expire_minutes: 30,
    })
    expect(made).toContain('https://t.me/+abc')
    expect(fake.callsOf('createChatInviteLink')[0]?.params).toMatchObject({
      name: 'press',
      creates_join_request: true,
    })
    expect(
      await tool('chat_invites')({
        action: 'create_link',
        chat: '-1001',
        requires_approval: true,
        member_limit: 5,
      }),
    ).toContain('cannot also have a member limit')
    fake.reply('revokeChatInviteLink', { invite_link: 'https://t.me/+abc', is_revoked: true })
    expect(
      await tool('chat_invites')({
        action: 'revoke_link',
        chat: '-1001',
        link: 'https://t.me/+abc',
      }),
    ).toContain('revoked')
  })

  test('messages: quiz poll, pin, copy and forward many', async () => {
    const { fake, tool } = setup()
    fake.reply('sendPoll', {
      message_id: 77,
      date: 1,
      chat: { id: -1001, type: 'supergroup' },
      poll: {},
    })
    const poll = await tool('chat_messages')({
      action: 'send_poll',
      chat: '-1001',
      question: 'Capital?',
      options: ['Paris', 'Rome'],
      quiz: true,
      correct_option: 0,
      explanation: 'Obviously',
      open_seconds: 60,
    })
    expect(poll).toContain('message 77')
    expect(fake.callsOf('sendPoll')[0]?.params).toMatchObject({
      type: 'quiz',
      open_period: 60,
      explanation: 'Obviously',
    })
    expect(
      await tool('chat_messages')({
        action: 'send_poll',
        chat: '-1001',
        question: 'Q?',
        options: ['a', 'b'],
        quiz: true,
      }),
    ).toContain('needs correct_option')
    await tool('chat_messages')({ action: 'pin', chat: '-1001', message: 5 })
    expect(fake.callsOf('pinChatMessage')[0]?.params).toMatchObject({ disable_notification: true })
    fake.reply('copyMessages', [{ message_id: 1 }, { message_id: 2 }])
    expect(
      await tool('chat_messages')({
        action: 'copy',
        chat: '-1001',
        to_chat: '-1002',
        messages: [1, 2],
      }),
    ).toContain('Copied 2')
    fake.reply('forwardMessages', [{ message_id: 3 }])
    expect(
      await tool('chat_messages')({
        action: 'forward',
        chat: '-1001',
        to_chat: '-1002',
        messages: [1],
      }),
    ).toContain('Forwarded')
  })

  test('topics and the General topic', async () => {
    const { fake, tool } = setup()
    fake.reply('createForumTopic', { message_thread_id: 12, name: 'Ideas' })
    expect(await tool('chat_topics')({ action: 'create', chat: '-1001', name: 'Ideas' })).toContain(
      'topic id 12',
    )
    await tool('chat_topics')({ action: 'close', chat: '-1001', topic: 12 })
    await tool('chat_topics')({ action: 'general_hide', chat: '-1001' })
    expect(fake.callsOf('closeForumTopic')).toHaveLength(1)
    expect(fake.callsOf('hideGeneralForumTopic')).toHaveLength(1)
  })

  test('bot profile', async () => {
    const { fake, tool } = setup()
    await tool('bot_profile')({
      action: 'set_commands',
      commands: [{ command: '/Help', description: 'Help' }],
    })
    expect(fake.callsOf('setMyCommands')[0]?.params).toMatchObject({
      commands: [{ command: 'help', description: 'Help' }],
    })
    await tool('bot_profile')({ action: 'set_name', text: 'Helper' })
    expect(fake.callsOf('setMyName')).toHaveLength(1)
  })
})

describe('telegram bot tools: refusals', () => {
  test('a missing right is named, and the audit row says refused', async () => {
    const { fake, tool, rows } = setup()
    fake.fail('banChatMember', notEnough)
    const text = await tool('chat_members')(
      { action: 'ban', chat: '-1001', user: 9 },
      { requester: 'Ana', role: 'owner' },
    )
    expect(text).toContain('chat_members.ban')
    expect(text).toContain('Ban users')
    expect(text).toContain('can_restrict_members')
    expect(text).not.toContain(fake.token)
    expect(rows.at(-1)).toMatchObject({ action: 'chat_members', result: 'refused', kind: 'action' })
  })

  test('promoting an admin the bot did not promote is explained', async () => {
    const { fake, tool } = setup()
    fake.fail('promoteChatMember', {
      error_code: 400,
      description: 'Bad Request: user is an administrator of the chat',
    })
    expect(
      await tool('chat_members')({ action: 'edit_admin', chat: '-1001', user: 3, rights: [] }),
    ).toContain('promoted itself')
  })

  test('destructive calls need confirm and do nothing without it', async () => {
    const { fake, tool, rows } = setup()
    for (const input of [
      { action: 'delete_topic', chat: '-1001', topic: 5 },
      { action: 'delete_messages', chat: '-1001', messages: [1, 2, 3] },
      { action: 'leave_chat', chat: '-1001' },
    ]) {
      expect(await tool('chat_destructive')(input)).toContain('confirm: true')
    }
    expect(
      await tool('chat_members')({ action: 'ban', chat: '-1001', user: 9, revoke_messages: true }),
    ).toContain('confirm: true')
    expect(
      fake.calls.filter((c) =>
        ['deleteForumTopic', 'deleteMessages', 'leaveChat', 'banChatMember'].includes(c.method),
      ),
    ).toHaveLength(0)
    expect(rows.filter((r) => r.result === 'refused')).toHaveLength(4)
    expect(
      await tool('chat_destructive')({
        action: 'delete_topic',
        chat: '-1001',
        topic: 5,
        confirm: true,
      }),
    ).toContain('deleted')
    expect(
      await tool('chat_destructive')({ action: 'leave_chat', chat: '-1001', confirm: true }),
    ).toContain('left the chat')
    expect(fake.callsOf('deleteForumTopic')).toHaveLength(1)
  })

  test('a Telegram error never throws and never reaches the outbound breaker (plain text answer)', async () => {
    const { fake, tool } = setup()
    fake.fail('getChat', { error_code: 400, description: 'Bad Request: chat not found' })
    expect(await tool('chat_info')({ action: 'chat', chat: '-999' })).toContain('not in that chat')
  })
})

describe('telegram bot tools: join requests', () => {
  test('a chat_join_request update reaches the gateway, is listed, and approve works', async () => {
    const { fake, events, tool, start } = setup()
    await start()
    fake.push({
      chat_join_request: {
        chat: tg.group(-1001, 'Ops'),
        from: tg.user(55, 'Zed'),
        user_chat_id: 55,
        date: Math.floor(Date.now() / 1000),
        bio: 'hi there',
        invite_link: {
          invite_link: 'https://t.me/+xyz',
          creator: tg.user(1),
          creates_join_request: true,
          is_primary: false,
          is_revoked: false,
        },
      },
    })
    await until('event', () => events.length === 1)
    expect(events[0]).toMatchObject({
      type: 'member.join_requested',
      actor: { id: '55', name: 'Zed' },
      request: { link: 'https://t.me/+xyz', hasBio: true },
    })
    const list = await tool('join_requests')({ action: 'list' })
    expect(list).toContain('Zed (id 55, @zed)')
    expect(list).toContain('"Ops"')
    expect(list).toContain('bio: hi there')
    expect(await tool('join_requests')({ action: 'approve', chat: '-1001', user: 55 })).toContain(
      'approved',
    )
    expect(fake.callsOf('approveChatJoinRequest')[0]?.params).toMatchObject({
      chat_id: -1001,
      user_id: 55,
    })
    expect(await tool('join_requests')({ action: 'list' })).toContain('No pending')
    fake.fail('declineChatJoinRequest', {
      error_code: 400,
      description: 'Bad Request: HIDE_REQUESTER_MISSING',
    })
    expect(await tool('join_requests')({ action: 'decline', chat: '-1001', user: 55 })).toContain(
      'no pending join request',
    )
  })
})

describe('telegram bot tools: audit', () => {
  test('every call leaves a row with who, role, target, parameter summary and duration; reads too', async () => {
    const { tool, rows, fake } = setup()
    fake.reply('getChatMemberCount', 3)
    await tool('chat_info')(
      { action: 'member_count', chat: '-1001' },
      { requester: 'Ana', role: 'owner' },
    )
    await tool('chat_members')(
      { action: 'ban', chat: '-1001', user: 9, for_minutes: 5 },
      { requester: 'web owner', role: 'owner' },
    )
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({
      kind: 'read',
      action: 'chat_info',
      result: 'ok',
      context: { requester: 'Ana', role: 'owner', sessionId: 's1', agentId: 'a1', origin: 'chat' },
    })
    expect(rows[1]).toMatchObject({
      kind: 'action',
      action: 'chat_members',
      result: 'ok',
      target: { chat: '-1001', user: '9' },
    })
    expect(rows[1]?.summary).toContain('action=ban')
    expect(rows[1]?.summary).toContain('for_minutes=5')
    expect(typeof rows[1]?.durationMs).toBe('number')
  })
})
