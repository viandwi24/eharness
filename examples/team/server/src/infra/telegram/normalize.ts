/**
 * Telegram updates to channel events (pure: no network). The adapter gives the bot identity and a
 * downloader; everything here is a function of the update. Raw payloads are kept on the event for
 * the adapter only (never stored, never shown to a model).
 */
import type { Chat, Message, MessageEntity, Update, User } from 'grammy/types'
import type {
  ConversationKind,
  ConversationRef,
  Identity,
  InboundAttachment,
  InboundEvent,
  InboundSignals,
  ReplyInfo,
} from '../channels/types.ts'

export interface NormalizeContext {
  connectionId: string
  botId: number
  botUsername: string
  /** Downloads a file of a message through `getFile` (the 20 MB cap is the adapter's). */
  download(fileId: string, size: number | undefined): Promise<{ bytes: Uint8Array }>
}

/** What an update says about a chat the bot can see (for the "known chats" list). */
export interface SeenChat {
  chatId: string
  kind: ConversationKind
  title: string
  username?: string
  /** The chat is a forum (has topics). */
  forum: boolean
  /** A topic seen in this update (id and, when the update says, its name). */
  topic?: { id: string; name?: string }
  /** `my_chat_member`: what the bot is in this chat now. */
  botStatus?: string
  canPost?: boolean
  at: number
}

export interface Normalized {
  events: InboundEvent[]
  chat?: SeenChat
  /** A callback query to acknowledge (`answerCallbackQuery`). */
  callbackId?: string
}

const kindOf = (chat: Chat): ConversationKind =>
  chat.type === 'private' ? 'dm' : chat.type === 'channel' ? 'channel' : 'group'

const personName = (u: { first_name?: string; last_name?: string }): string =>
  [u.first_name, u.last_name].filter((p) => p !== undefined && p !== '').join(' ')

export function identityOfUser(user: User, botId: number): Identity {
  return {
    id: String(user.id),
    name: personName(user),
    ...(user.username === undefined ? {} : { username: user.username }),
    ...(user.is_bot ? { isBot: true } : {}),
    ...(user.id === botId ? { isSelf: true } : {}),
  }
}

/** The sender: a person, or (channel posts, anonymous admins) the chat speaking as itself. */
export function senderOf(message: Message, botId: number): Identity {
  if (message.from !== undefined && message.from.id !== 777000 && !message.sender_chat) {
    return identityOfUser(message.from, botId)
  }
  const chat = message.sender_chat ?? message.chat
  return {
    id: `chat:${chat.id}`,
    name: 'title' in chat && chat.title !== undefined ? chat.title : String(chat.id),
    ...('username' in chat && chat.username !== undefined ? { username: chat.username } : {}),
  }
}

const isTopicMessage = (m: Message): boolean => m.is_topic_message === true
const topicOf = (m: Message): string | undefined =>
  isTopicMessage(m) && m.message_thread_id !== undefined ? String(m.message_thread_id) : undefined

export function refOf(message: Message, connectionId: string): ConversationRef {
  const container = String(message.chat.id)
  const topic = topicOf(message)
  const title =
    message.chat.type === 'private'
      ? personName(message.chat)
      : 'title' in message.chat
        ? message.chat.title
        : undefined
  return {
    id: topic === undefined ? container : `${container}/${topic}`,
    connectionId,
    container,
    ...(topic === undefined ? {} : { topic }),
    kind: kindOf(message.chat),
    ...(title === undefined || title === '' ? {} : { title }),
  }
}

// Telegram offsets count UTF-16 code units, like JavaScript strings
const entityText = (text: string, e: MessageEntity): string =>
  text.slice(e.offset, e.offset + e.length)

/** Mentions and commands of a message, relative to this bot. */
export function signalsOf(message: Message, ctx: NormalizeContext): InboundSignals {
  const text = message.text ?? message.caption ?? ''
  const entities = message.entities ?? message.caption_entities ?? []
  const me = `@${ctx.botUsername}`.toLowerCase()
  let mentionedSelf = false
  let mentionedOthers = false
  let command: { name: string; args: string } | undefined
  for (const e of entities) {
    if (e.type === 'mention') {
      if (entityText(text, e).toLowerCase() === me) mentionedSelf = true
      else mentionedOthers = true
    } else if (e.type === 'text_mention') {
      if (e.user.id === ctx.botId) mentionedSelf = true
      else mentionedOthers = true
    } else if (e.type === 'bot_command' && e.offset === 0 && command === undefined) {
      const raw = entityText(text, e).slice(1)
      const at = raw.indexOf('@')
      const name = (at < 0 ? raw : raw.slice(0, at)).toLowerCase()
      const target = at < 0 ? undefined : raw.slice(at + 1).toLowerCase()
      if (target === undefined || target === ctx.botUsername.toLowerCase()) {
        command = { name, args: text.slice(e.offset + e.length).trim() }
      } else {
        // a command for another bot: it is not for us (and counts as addressing someone else)
        mentionedOthers = true
      }
    }
  }
  const reply = message.reply_to_message
  // inside a forum topic every message "replies" to the topic's first message: not a real reply
  const topicRoot =
    reply !== undefined &&
    (reply.forum_topic_created !== undefined ||
      (isTopicMessage(message) && reply.message_id === message.message_thread_id))
  const replyToSelf = reply?.from?.id === ctx.botId && !topicRoot
  return {
    mentionedSelf,
    ...(mentionedOthers ? { mentionedOthers: true } : {}),
    replyToSelf,
    ...(command === undefined ? {} : { command }),
  }
}

function attachmentsOf(message: Message, ctx: NormalizeContext): InboundAttachment[] {
  const out: InboundAttachment[] = []
  const add = (
    kind: InboundAttachment['kind'],
    fileId: string,
    uniqueId: string,
    size: number | undefined,
    name: string | undefined,
    mediaType: string | undefined,
  ): void => {
    out.push({
      id: uniqueId,
      kind,
      ...(name === undefined ? {} : { name }),
      ...(mediaType === undefined ? {} : { mediaType }),
      ...(size === undefined ? {} : { size }),
      fetch: async () => ({
        ...(await ctx.download(fileId, size)),
        ...(mediaType === undefined ? {} : { mediaType }),
        ...(name === undefined ? {} : { name }),
      }),
    })
  }
  if (message.photo !== undefined && message.photo.length > 0) {
    const best = message.photo.reduce((a, b) =>
      (b.file_size ?? b.width * b.height) >= (a.file_size ?? a.width * a.height) ? b : a,
    )
    add(
      'image',
      best.file_id,
      best.file_unique_id,
      best.file_size,
      `photo-${best.file_unique_id}.jpg`,
      'image/jpeg',
    )
  }
  const d = message.document
  if (d !== undefined) {
    add(
      d.mime_type?.startsWith('image/') ? 'image' : 'file',
      d.file_id,
      d.file_unique_id,
      d.file_size,
      d.file_name,
      d.mime_type,
    )
  }
  const a = message.audio
  if (a !== undefined)
    add('audio', a.file_id, a.file_unique_id, a.file_size, a.file_name, a.mime_type ?? 'audio/mpeg')
  const v = message.voice
  if (v !== undefined)
    add(
      'audio',
      v.file_id,
      v.file_unique_id,
      v.file_size,
      `voice-${v.file_unique_id}.ogg`,
      v.mime_type ?? 'audio/ogg',
    )
  const vid = message.video
  if (vid !== undefined)
    add(
      'video',
      vid.file_id,
      vid.file_unique_id,
      vid.file_size,
      vid.file_name,
      vid.mime_type ?? 'video/mp4',
    )
  return out
}

function replyInfoOf(message: Message): ReplyInfo | undefined {
  const r = message.reply_to_message
  if (r === undefined || r.forum_topic_created !== undefined) return undefined
  if (isTopicMessage(message) && r.message_id === message.message_thread_id) return undefined
  const text = r.text ?? r.caption
  const from = r.from === undefined ? undefined : personName(r.from) || r.from.username
  return {
    messageId: String(r.message_id),
    ...(r.from === undefined ? {} : { senderId: String(r.from.id) }),
    ...(from === undefined ? {} : { senderName: from }),
    ...(text === undefined ? {} : { text }),
  }
}

function seenOf(message: Message, at: number): SeenChat | undefined {
  const kind = kindOf(message.chat)
  if (kind === 'dm') return undefined
  const chat = message.chat
  const forum = 'is_forum' in chat && chat.is_forum === true
  const created = message.forum_topic_created ?? message.reply_to_message?.forum_topic_created
  const topicId = topicOf(message)
  return {
    chatId: String(chat.id),
    kind,
    title: 'title' in chat && chat.title !== undefined ? chat.title : String(chat.id),
    ...('username' in chat && chat.username !== undefined ? { username: chat.username } : {}),
    forum,
    ...(topicId === undefined
      ? {}
      : { topic: { id: topicId, ...(created === undefined ? {} : { name: created.name }) } }),
    at,
  }
}

/** Callback data: `<name>:<data>` (Telegram allows 64 bytes). */
export const encodeCallback = (name: string, data: string | undefined): string =>
  data === undefined ? name : `${name}:${data}`
export function decodeCallback(value: string): { name: string; data?: string } {
  const i = value.indexOf(':')
  return i < 0 ? { name: value } : { name: value.slice(0, i), data: value.slice(i + 1) }
}

export function normalizeUpdate(update: Update, ctx: NormalizeContext): Normalized {
  const fresh = update.message ?? update.channel_post
  if (fresh !== undefined) {
    const m = fresh
    const at = m.date * 1000
    const seen = seenOf(m, at)
    const withSeen = seen === undefined ? {} : { chat: seen }
    // service messages (joins, pins, topic changes) carry no text and no files: discovery only
    const attachments = attachmentsOf(m, ctx)
    const text = m.text ?? m.caption ?? ''
    if (text === '' && attachments.length === 0) return { events: [], ...withSeen }
    const replyTo = replyInfoOf(m)
    return {
      events: [
        {
          type: 'message',
          conversation: refOf(m, ctx.connectionId),
          at,
          messageId: String(m.message_id),
          sender: senderOf(m, ctx.botId),
          text,
          attachments,
          ...(replyTo === undefined ? {} : { replyTo }),
          signals: signalsOf(m, ctx),
        },
      ],
      ...withSeen,
    }
  }
  const edited = update.edited_message ?? update.edited_channel_post
  if (edited !== undefined) {
    const m = edited
    const at = (m.edit_date ?? m.date) * 1000
    const seen = seenOf(m, at)
    return {
      events: [
        {
          type: 'edit',
          conversation: refOf(m, ctx.connectionId),
          at,
          messageId: String(m.message_id),
          sender: senderOf(m, ctx.botId),
          text: m.text ?? m.caption ?? '',
        },
      ],
      ...(seen === undefined ? {} : { chat: seen }),
    }
  }
  const cb = update.callback_query
  if (cb !== undefined) {
    const m = cb.message
    // an inline-mode or inaccessible message has nothing to answer in
    if (m === undefined || !('chat' in m) || m.date === 0) return { events: [], callbackId: cb.id }
    const { name, data } = decodeCallback(cb.data ?? '')
    return {
      callbackId: cb.id,
      events: [
        {
          type: 'action',
          conversation: refOf(m as Message, ctx.connectionId),
          at: Date.now(),
          name,
          sender: identityOfUser(cb.from, ctx.botId),
          ...(data === undefined ? {} : { data }),
          messageId: String(m.message_id),
        },
      ],
    }
  }
  const r = update.message_reaction
  if (r !== undefined) {
    const label = (x: { type: string; emoji?: string }): string =>
      x.type === 'emoji' && x.emoji !== undefined ? x.emoji : x.type
    const before = new Set(r.old_reaction.map(label))
    const after = new Set(r.new_reaction.map(label))
    const sender: Identity =
      r.user === undefined
        ? { id: `chat:${r.actor_chat?.id ?? r.chat.id}` }
        : identityOfUser(r.user, ctx.botId)
    const conversation: ConversationRef = {
      id: String(r.chat.id),
      connectionId: ctx.connectionId,
      container: String(r.chat.id),
      kind: kindOf(r.chat),
      ...('title' in r.chat && r.chat.title !== undefined ? { title: r.chat.title } : {}),
    }
    const events: InboundEvent[] = []
    const push = (emoji: string, added: boolean): void => {
      events.push({
        type: 'reaction',
        conversation,
        at: r.date * 1000,
        messageId: String(r.message_id),
        sender,
        emoji,
        added,
      })
    }
    for (const emoji of after) if (!before.has(emoji)) push(emoji, true)
    for (const emoji of before) if (!after.has(emoji)) push(emoji, false)
    return { events }
  }
  const member = update.my_chat_member
  if (member !== undefined && kindOf(member.chat) !== 'dm') {
    const chat = member.chat
    const status = member.new_chat_member.status
    const canPost =
      status === 'administrator'
        ? (member.new_chat_member as { can_post_messages?: boolean }).can_post_messages !== false
        : status === 'member'
    return {
      events: [],
      chat: {
        chatId: String(chat.id),
        kind: kindOf(chat),
        title: 'title' in chat && chat.title !== undefined ? chat.title : String(chat.id),
        ...('username' in chat && chat.username !== undefined ? { username: chat.username } : {}),
        forum: 'is_forum' in chat && chat.is_forum === true,
        botStatus: status,
        canPost,
        at: member.date * 1000,
      },
    }
  }
  return { events: [] }
}
