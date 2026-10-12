/**
 * Anonymized payload shapes of the Telegram Bot API (10.x) for every kind of chat and update the
 * bot adapter normalizes. Ids are made up (users 1001+, the bot 777, chats `-100123450000n`); names
 * are invented. They are the golden input of `telegram-golden.test.ts`: the same updates must
 * always normalize to the same nodes and events (bump `NORMALIZER_VERSION` when that changes on
 * purpose).
 */
import type { Update } from 'grammy/types'

export const BOT = { id: 777, is_bot: true, first_name: 'Team Bot', username: 'team_test_bot' }
export const ANA = {
  id: 1001,
  is_bot: false,
  first_name: 'Ana',
  last_name: 'Putri',
  username: 'ana',
}
export const BUDI = { id: 1002, is_bot: false, first_name: 'Budi' }

export const PRIVATE = {
  id: 1001,
  type: 'private',
  first_name: 'Ana',
  last_name: 'Putri',
  username: 'ana',
} as const
/** A basic group (small negative id). */
export const GROUP = { id: -4005, type: 'group', title: 'Ops Team' } as const
export const SUPERGROUP = {
  id: -1001234500001,
  type: 'supergroup',
  title: 'Engineering',
  username: 'eng_chat',
} as const
export const FORUM = {
  id: -1001234500002,
  type: 'supergroup',
  title: 'Company',
  is_forum: true,
} as const
export const CHANNEL = {
  id: -1001234500003,
  type: 'channel',
  title: 'Company News',
  username: 'company_news',
} as const
/** The discussion group of {@link CHANNEL}. */
export const DISCUSSION = {
  id: -1001234500004,
  type: 'supergroup',
  title: 'Company News Chat',
} as const

let seq = 5000
/** Wrap a message-like payload as an update with the next `update_id`. */
const update = (body: Record<string, unknown>): Update =>
  ({ update_id: ++seq, ...body }) as unknown as Update

export const fixtures = {
  privateMessage: (): Update =>
    update({
      message: {
        message_id: 11,
        date: 1_760_000_000,
        chat: PRIVATE,
        from: ANA,
        text: 'status please',
      },
    }),

  groupMessage: (): Update =>
    update({
      message: {
        message_id: 21,
        date: 1_760_000_010,
        chat: GROUP,
        from: ANA,
        text: 'hi @team_test_bot and @someone',
        entities: [
          { type: 'mention', offset: 3, length: 14 },
          { type: 'mention', offset: 22, length: 8 },
        ],
      },
    }),

  supergroupMessage: (): Update =>
    update({
      message: {
        message_id: 31,
        date: 1_760_000_020,
        chat: SUPERGROUP,
        from: BUDI,
        text: 'see https://example.com/a and **this**',
        entities: [
          { type: 'url', offset: 4, length: 21 },
          { type: 'bold', offset: 34, length: 6 },
        ],
        reply_to_message: {
          message_id: 30,
          date: 1_760_000_000,
          chat: SUPERGROUP,
          from: ANA,
          text: 'earlier message',
        },
      },
    }),

  /** A message in a forum topic (every topic message replies to the topic's first message). */
  forumTopicMessage: (): Update =>
    update({
      message: {
        message_id: 41,
        message_thread_id: 40,
        is_topic_message: true,
        date: 1_760_000_030,
        chat: FORUM,
        from: ANA,
        text: 'billing question',
        reply_to_message: {
          message_id: 40,
          date: 1_760_000_000,
          chat: FORUM,
          from: BUDI,
          forum_topic_created: { name: 'Billing', icon_color: 7322096 },
        },
      },
    }),

  /** A message in the General topic of a forum: no thread id, no topic flag. */
  forumGeneralMessage: (): Update =>
    update({
      message: {
        message_id: 42,
        date: 1_760_000_031,
        chat: FORUM,
        from: BUDI,
        text: 'general chat',
      },
    }),

  forumTopicCreated: (): Update =>
    update({
      message: {
        message_id: 50,
        message_thread_id: 50,
        is_topic_message: true,
        date: 1_760_000_040,
        chat: FORUM,
        from: ANA,
        forum_topic_created: { name: 'Roadmap', icon_color: 9367192 },
      },
    }),

  forumTopicEdited: (): Update =>
    update({
      message: {
        message_id: 51,
        message_thread_id: 50,
        is_topic_message: true,
        date: 1_760_000_050,
        chat: FORUM,
        from: ANA,
        forum_topic_edited: { name: 'Roadmap 2026' },
      },
    }),

  forumTopicClosed: (): Update =>
    update({
      message: {
        message_id: 52,
        message_thread_id: 50,
        is_topic_message: true,
        date: 1_760_000_060,
        chat: FORUM,
        from: ANA,
        forum_topic_closed: {},
      },
    }),

  forumTopicReopened: (): Update =>
    update({
      message: {
        message_id: 53,
        message_thread_id: 50,
        is_topic_message: true,
        date: 1_760_000_070,
        chat: FORUM,
        from: ANA,
        forum_topic_reopened: {},
      },
    }),

  channelPost: (): Update =>
    update({
      channel_post: {
        message_id: 61,
        date: 1_760_000_080,
        chat: CHANNEL,
        sender_chat: CHANNEL,
        text: 'We shipped version 2',
      },
    }),

  editedChannelPost: (): Update =>
    update({
      edited_channel_post: {
        message_id: 61,
        date: 1_760_000_080,
        edit_date: 1_760_000_090,
        chat: CHANNEL,
        sender_chat: CHANNEL,
        text: 'We shipped version 2.1',
      },
    }),

  /** The post of the channel, forwarded by Telegram into the linked discussion group. */
  discussionAutoForward: (): Update =>
    update({
      message: {
        message_id: 71,
        date: 1_760_000_081,
        chat: DISCUSSION,
        from: { id: 777000, is_bot: false, first_name: 'Telegram' },
        sender_chat: CHANNEL,
        is_automatic_forward: true,
        forward_origin: {
          type: 'channel',
          chat: CHANNEL,
          message_id: 61,
          date: 1_760_000_080,
        },
        text: 'We shipped version 2',
      },
    }),

  /** A comment under that post (a reply in the discussion group). */
  discussionComment: (): Update =>
    update({
      message: {
        message_id: 72,
        message_thread_id: 71,
        date: 1_760_000_095,
        chat: DISCUSSION,
        from: BUDI,
        text: 'congrats!',
        reply_to_message: {
          message_id: 71,
          date: 1_760_000_081,
          chat: DISCUSSION,
          sender_chat: CHANNEL,
          text: 'We shipped version 2',
        },
      },
    }),

  /** The basic group became a supergroup: the old chat announces the new id. */
  migrateTo: (): Update =>
    update({
      message: {
        message_id: 81,
        date: 1_760_000_100,
        chat: GROUP,
        from: ANA,
        migrate_to_chat_id: -1001234500009,
      },
    }),

  editedMessage: (): Update =>
    update({
      edited_message: {
        message_id: 21,
        date: 1_760_000_010,
        edit_date: 1_760_000_120,
        chat: GROUP,
        from: ANA,
        text: 'hi @team_test_bot, corrected',
        entities: [{ type: 'mention', offset: 3, length: 14 }],
      },
    }),

  callbackQuery: (): Update =>
    update({
      callback_query: {
        id: 'cb-1',
        from: ANA,
        chat_instance: '123',
        data: 'approve:row-9',
        message: {
          message_id: 91,
          message_thread_id: 40,
          is_topic_message: true,
          date: 1_760_000_130,
          chat: FORUM,
          from: BOT,
          text: 'I need an approval',
        },
      },
    }),

  /** The bot was made an administrator of a supergroup. */
  botPromoted: (): Update =>
    update({
      my_chat_member: {
        chat: SUPERGROUP,
        from: ANA,
        date: 1_760_000_140,
        old_chat_member: { status: 'member', user: BOT },
        new_chat_member: {
          status: 'administrator',
          user: BOT,
          can_be_edited: false,
          can_post_messages: true,
        },
      },
    }),

  botRemoved: (): Update =>
    update({
      my_chat_member: {
        chat: SUPERGROUP,
        from: ANA,
        date: 1_760_000_150,
        old_chat_member: { status: 'administrator', user: BOT },
        new_chat_member: { status: 'kicked', user: BOT, until_date: 0 },
      },
    }),

  /** Somebody else joined (needs admin rights and `allowed_updates` to arrive). */
  memberJoined: (): Update =>
    update({
      chat_member: {
        chat: SUPERGROUP,
        from: ANA,
        date: 1_760_000_160,
        old_chat_member: { status: 'left', user: BUDI },
        new_chat_member: { status: 'member', user: BUDI },
      },
    }),

  /** An admin posting anonymously: the sender is the group itself. */
  anonymousAdmin: (): Update =>
    update({
      message: {
        message_id: 101,
        date: 1_760_000_170,
        chat: SUPERGROUP,
        from: { id: 1087968824, is_bot: true, first_name: 'Group', username: 'GroupAnonymousBot' },
        sender_chat: SUPERGROUP,
        text: 'announcement from the admins',
      },
    }),

  reaction: (): Update =>
    update({
      message_reaction: {
        chat: SUPERGROUP,
        message_id: 31,
        user: ANA,
        date: 1_760_000_180,
        old_reaction: [{ type: 'emoji', emoji: '👍' }],
        new_reaction: [{ type: 'emoji', emoji: '🔥' }],
      },
    }),
}
