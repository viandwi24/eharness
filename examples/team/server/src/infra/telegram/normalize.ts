/**
 * Telegram Bot API updates to channel events (pure: no network). The adapter gives the bot identity
 * and a downloader; everything here is a function of the update. Raw payloads are kept on the event
 * for the adapter's use only (the gateway stores them sealed, and only when asked to).
 *
 * Native ids (documented in `idFormats`, covered by `test/telegram-golden.test.ts`):
 *   private chat    `<chat id>` (the user id)            kind `direct`
 *   group, supergroup, channel   `<chat id>`             kind `room` (a forum is a container that holds no messages of its own)
 *   forum topic     `<chat id>/<topic id>`               kind `thread`, child of the forum; General is `<chat id>/0`
 *   message         `<message id>`                       unique per chat
 *   person          `<user id>`; a chat that speaks as itself (channel posts, anonymous admins) `chat:<chat id>`
 */
import type { Chat, Message, MessageEntity, Update, User } from 'grammy/types'
import type { MessageEntity as Entity, MemberRole } from '../channels/model.ts'
import type {
  Identity,
  InboundAttachment,
  InboundSignals,
  NodeInfo,
  NodeRef,
  RemoteEvent,
  ReplyInfo,
} from '../channels/types.ts'

/** Bumped when the mapping below changes in a way that would give another result for the same update. */
export const NORMALIZER_VERSION = 2

export interface NormalizeContext {
  botId: number
  botUsername: string
  /** Downloads a file of a message through `getFile` (the 20 MB cap is the adapter's). */
  download(fileId: string, size: number | undefined): Promise<{ bytes: Uint8Array }>
}

export interface Normalized {
  events: RemoteEvent[]
  /** A callback query to acknowledge (`answerCallbackQuery`). */
  callbackId?: string
}

/** Telegram's own account that forwards channel posts into discussion groups. */
const FORWARDER_ID = 777000

const personName = (u: { first_name?: string; last_name?: string }): string =>
  [u.first_name, u.last_name].filter((p) => p !== undefined && p !== '').join(' ')

export function identityOfUser(user: User, botId: number): Identity {
  return {
    id: String(user.id),
    name: personName(user),
    ...(user.username === undefined ? {} : { username: user.username }),
    ...(user.is_bot ? { isBot: true, kind: 'bot' as const } : {}),
    ...(user.id === botId ? { isSelf: true } : {}),
  }
}

/** A chat that speaks as itself: a channel, or a group as an anonymous admin. */
export function identityOfChat(chat: Chat, kind: 'channel' | 'anonymous'): Identity {
  return {
    id: `chat:${chat.id}`,
    name: 'title' in chat && chat.title !== undefined ? chat.title : String(chat.id),
    ...('username' in chat && chat.username !== undefined ? { username: chat.username } : {}),
    kind,
  }
}

/**
 * The sender: a person, or (channel posts, anonymous admins, the account that forwards channel
 * posts) the chat speaking as itself. An anonymous admin is the group itself (`sender_chat` = the
 * group); a channel posting in itself, or any other `sender_chat`, is a channel.
 */
export function senderOf(message: Message, botId: number): Identity {
  if (message.sender_chat !== undefined) {
    return identityOfChat(
      message.sender_chat,
      message.sender_chat.id === message.chat.id && message.chat.type !== 'channel'
        ? 'anonymous'
        : 'channel',
    )
  }
  if (message.from !== undefined && message.from.id !== FORWARDER_ID) {
    return identityOfUser(message.from, botId)
  }
  // a channel post has no `from`; the account that forwards posts is not a person either
  return identityOfChat(message.chat, 'channel')
}

// --- nodes -------------------------------------------------------------------------------------

type ChatLike = Chat | Message['chat']

const titleOfChat = (chat: ChatLike): string | undefined =>
  chat.type === 'private' ? personName(chat) || undefined : 'title' in chat ? chat.title : undefined

const usernameOf = (chat: ChatLike): string | undefined =>
  'username' in chat && chat.username !== undefined ? chat.username : undefined

/** The node of a chat (the forum itself for a forum supergroup). */
export function chatNode(chat: ChatLike): NodeInfo {
  const username = usernameOf(chat)
  const title = titleOfChat(chat)
  if (chat.type === 'private') {
    return {
      nativeId: String(chat.id),
      kind: 'direct',
      platformType: 'telegram:private',
      ...(title === undefined || title === '' ? {} : { title }),
      traits: { multiUser: false, threading: 'none' },
      meta: { chatId: String(chat.id), ...(username === undefined ? {} : { username }) },
    }
  }
  const isForum = chat.type === 'supergroup' && 'is_forum' in chat && chat.is_forum === true
  return {
    nativeId: String(chat.id),
    kind: 'room',
    platformType: `telegram:${chat.type}`,
    ...(title === undefined ? {} : { title }),
    traits:
      chat.type === 'channel'
        ? { multiUser: false, broadcast: true, threading: 'relation', postable: true }
        : isForum
          ? { multiUser: true, container: true, postable: false, threading: 'node' }
          : { multiUser: true, threading: 'relation', postable: true },
    meta: {
      chatId: String(chat.id),
      ...(username === undefined ? {} : { username }),
      ...(isForum ? { isForum: true } : {}),
    },
  }
}

/** A forum topic: a thread node, child of its forum. `name` is the patch (absent = unchanged). */
export function topicNode(chatId: number | string, topicId: number, name?: string): NodeInfo {
  return {
    nativeId: `${chatId}/${topicId}`,
    kind: 'thread',
    platformType: topicId === 0 ? 'telegram:forum_general' : 'telegram:forum_topic',
    ...(name === undefined ? (topicId === 0 ? { title: 'General' } : {}) : { title: name }),
    parent: String(chatId),
    traits: { multiUser: true, threading: 'relation', postable: true },
    meta: { chatId: String(chatId), topicId },
  }
}

const isForumChat = (chat: ChatLike): boolean =>
  chat.type === 'supergroup' && 'is_forum' in chat && chat.is_forum === true

/** The topic a message is in (a forum's General topic is 0), or undefined outside forums. */
export const topicIdOf = (m: Message): number | undefined =>
  !isForumChat(m.chat)
    ? undefined
    : m.is_topic_message === true && m.message_thread_id !== undefined
      ? m.message_thread_id
      : 0

/** The node of a message and its ancestors, leaf first. */
export function chainOfMessage(m: Message): NodeInfo[] {
  const room = chatNode(m.chat)
  const topic = topicIdOf(m)
  if (topic === undefined) return [room]
  const created = m.forum_topic_created ?? m.reply_to_message?.forum_topic_created
  return [topicNode(m.chat.id, topic, created?.name), room]
}

const refOfMessage = (m: Message): NodeRef => {
  const chain = chainOfMessage(m)
  return { nativeId: (chain[0] as NodeInfo).nativeId, chain }
}

/** The topic of a message at its first reply (root) is the topic itself, not a reply. */
const isTopicRoot = (m: Message, reply: Message | undefined): boolean =>
  reply !== undefined &&
  (reply.forum_topic_created !== undefined ||
    (m.is_topic_message === true && reply.message_id === m.message_thread_id))

// --- entities ----------------------------------------------------------------------------------

// Telegram offsets count UTF-16 code units, like JavaScript strings
const entityText = (text: string, e: MessageEntity): string =>
  text.slice(e.offset, e.offset + e.length)

const ENTITY: Partial<Record<MessageEntity['type'], Entity['type']>> = {
  url: 'link',
  text_link: 'link',
  bold: 'bold',
  italic: 'italic',
  underline: 'underline',
  strikethrough: 'strike',
  code: 'code',
  pre: 'pre',
  blockquote: 'quote',
  expandable_blockquote: 'quote',
  spoiler: 'spoiler',
  bot_command: 'command',
  hashtag: 'hashtag',
}

/** Normalized entities of a text (mentions by user id when the platform gives it, never by guessing a handle). */
export function entitiesOf(text: string, entities: readonly MessageEntity[] | undefined): Entity[] {
  const out: Entity[] = []
  for (const e of entities ?? []) {
    const base = { offset: e.offset, length: e.length }
    if (e.type === 'mention') {
      out.push({ type: 'mention', ...base, handle: entityText(text, e).replace(/^@/, '') })
    } else if (e.type === 'text_mention') {
      out.push({ type: 'mention', ...base, identity: String(e.user.id) })
    } else {
      const type = ENTITY[e.type]
      if (type === undefined) continue
      out.push({
        type,
        ...base,
        ...(e.type === 'text_link' ? { url: e.url } : {}),
        ...(e.type === 'url' ? { url: entityText(text, e) } : {}),
        ...(e.type === 'pre' && e.language !== undefined ? { language: e.language } : {}),
      })
    }
  }
  return out
}

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
  const replyToSelf = reply?.from?.id === ctx.botId && !isTopicRoot(message, reply)
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
  if (r === undefined || isTopicRoot(message, r)) return undefined
  const text = r.text ?? r.caption
  const from = r.from === undefined ? undefined : personName(r.from) || r.from.username
  return {
    messageId: String(r.message_id),
    ...(r.from === undefined ? {} : { senderId: String(r.from.id) }),
    ...(from === undefined ? {} : { senderName: from }),
    ...(text === undefined ? {} : { text }),
  }
}

/** The origin of a forwarded message (a snapshot, not a link). */
function forwardOf(message: Message): Record<string, unknown> | undefined {
  const o = message.forward_origin
  if (o === undefined) return undefined
  const name =
    'sender_user' in o && o.sender_user !== undefined
      ? personName(o.sender_user) || o.sender_user.username
      : 'sender_user_name' in o && typeof o.sender_user_name === 'string'
        ? o.sender_user_name
        : 'chat' in o && o.chat !== undefined && 'title' in o.chat
          ? o.chat.title
          : undefined
  return {
    type: o.type,
    at: o.date * 1000,
    ...(name === undefined || name === '' ? {} : { name }),
    ...('chat' in o && o.chat !== undefined ? { chat: String(o.chat.id) } : {}),
    ...('sender_user' in o && o.sender_user !== undefined
      ? { user: String(o.sender_user.id) }
      : {}),
    ...('message_id' in o && o.message_id !== undefined ? { messageId: String(o.message_id) } : {}),
  }
}

/** Callback data: `<name>:<data>` (Telegram allows 64 bytes). */
export const encodeCallback = (name: string, data: string | undefined): string =>
  data === undefined ? name : `${name}:${data}`
export function decodeCallback(value: string): { name: string; data?: string } {
  const i = value.indexOf(':')
  return i < 0 ? { name: value } : { name: value.slice(0, i), data: value.slice(i + 1) }
}

const ROLE: Record<string, MemberRole> = {
  creator: 'owner',
  administrator: 'admin',
  member: 'member',
  restricted: 'member',
  left: 'none',
  kicked: 'none',
}

/** The administrator rights of a chat member, `can_*` flags by name. Empty for anybody else. */
export function rightsOf(member: unknown): Record<string, boolean> {
  const out: Record<string, boolean> = {}
  if (typeof member !== 'object' || member === null) return out
  for (const [k, v] of Object.entries(member))
    if (k.startsWith('can_') && typeof v === 'boolean') out[k] = v
  return out
}

/** The custom title of an administrator, as the per-chat profile of the identity. */
export function withTitle(identity: Identity, member: unknown): Identity {
  const title = (member as { custom_title?: unknown } | null)?.custom_title
  return typeof title === 'string' && title !== ''
    ? { ...identity, profile: { roles: [title] } }
    : identity
}

const key = (update: Update, suffix?: string): string =>
  `tg:upd:${update.update_id}${suffix === undefined ? '' : `:${suffix}`}`

// --- the update --------------------------------------------------------------------------------

/** Service messages: topic and chat changes, joins and leaves, an id that changed. */
function serviceEvents(update: Update, m: Message, at: number): RemoteEvent[] {
  const out: RemoteEvent[] = []
  const chain = chainOfMessage(m)
  const node: NodeRef = { nativeId: (chain[0] as NodeInfo).nativeId, chain }
  const base = (suffix: string) => ({ dedupeKey: key(update, suffix), at, node, raw: update })
  if (m.forum_topic_created !== undefined) {
    const topic = topicNode(m.chat.id, m.message_thread_id ?? 0, m.forum_topic_created.name)
    const ref: NodeRef = { nativeId: topic.nativeId, chain: [topic, chatNode(m.chat)] }
    out.push({
      type: 'node.created',
      dedupeKey: key(update, 'topic-created'),
      at,
      node: ref,
      raw: update,
    })
  }
  if (m.forum_topic_edited !== undefined && m.message_thread_id !== undefined) {
    const e = m.forum_topic_edited
    const topic = topicNode(m.chat.id, m.message_thread_id, e.name)
    out.push({
      type: 'node.updated',
      dedupeKey: key(update, 'topic-edited'),
      at,
      node: { nativeId: topic.nativeId, chain: [topic, chatNode(m.chat)] },
      raw: update,
    })
  }
  if (m.forum_topic_closed !== undefined && m.message_thread_id !== undefined) {
    out.push({
      type: 'node.state_changed',
      dedupeKey: key(update, 'topic-closed'),
      at,
      node: {
        nativeId: `${m.chat.id}/${m.message_thread_id}`,
        chain: [topicNode(m.chat.id, m.message_thread_id), chatNode(m.chat)],
      },
      state: 'closed',
      raw: update,
    })
  }
  if (m.forum_topic_reopened !== undefined && m.message_thread_id !== undefined) {
    out.push({
      type: 'node.state_changed',
      dedupeKey: key(update, 'topic-reopened'),
      at,
      node: {
        nativeId: `${m.chat.id}/${m.message_thread_id}`,
        chain: [topicNode(m.chat.id, m.message_thread_id), chatNode(m.chat)],
      },
      state: 'active',
      raw: update,
    })
  }
  if (m.new_chat_title !== undefined) {
    out.push({
      type: 'node.updated',
      ...base('title'),
      node: {
        nativeId: String(m.chat.id),
        chain: [{ ...chatNode(m.chat), title: m.new_chat_title }],
      },
    })
  }
  if (m.migrate_to_chat_id !== undefined) {
    // the basic group became a supergroup: the new id is the node from now on
    out.push({
      type: 'node.migrated',
      dedupeKey: key(update, 'migrated'),
      at,
      node: {
        nativeId: String(m.migrate_to_chat_id),
        chain: [
          {
            nativeId: String(m.migrate_to_chat_id),
            kind: 'room',
            platformType: 'telegram:supergroup',
            ...(titleOfChat(m.chat) === undefined ? {} : { title: titleOfChat(m.chat) }),
            traits: { multiUser: true, threading: 'relation', postable: true },
            meta: { chatId: String(m.migrate_to_chat_id) },
          },
        ],
      },
      from: String(m.chat.id),
      raw: update,
    })
  }
  for (const u of m.new_chat_members ?? []) {
    out.push({
      type: 'member.joined',
      dedupeKey: key(update, `joined:${u.id}`),
      at,
      node,
      actor: identityOfUser(u, 0),
      raw: update,
    })
  }
  if (m.left_chat_member !== undefined) {
    out.push({
      type: 'member.left',
      dedupeKey: key(update, `left:${m.left_chat_member.id}`),
      at,
      node,
      actor: identityOfUser(m.left_chat_member, 0),
      raw: update,
    })
  }
  return out
}

export function normalizeUpdate(update: Update, ctx: NormalizeContext): Normalized {
  const fresh = update.message ?? update.channel_post
  if (fresh !== undefined) {
    const m = fresh
    const at = m.date * 1000
    const events: RemoteEvent[] = serviceEvents(update, m, at)
    const attachments = attachmentsOf(m, ctx)
    const text = m.text ?? m.caption ?? ''
    // service messages carry no text and no files
    if (text === '' && attachments.length === 0) return { events }
    // a post of a channel forwarded into its discussion group: the group is a discussion of the channel
    const chain = chainOfMessage(m)
    const forwarded = m.forward_origin
    if (m.is_automatic_forward === true && forwarded?.type === 'channel') {
      const channel = chatNode(forwarded.chat)
      events.push({
        type: 'node.updated',
        dedupeKey: key(update, 'channel'),
        at,
        node: { nativeId: channel.nativeId, chain: [channel] },
        raw: update,
      })
      const room = chain.at(-1) as NodeInfo
      room.links = [{ rel: 'discussion_of', to: channel.nativeId }]
    }
    const replyTo = replyInfoOf(m)
    const entities = entitiesOf(text, m.entities ?? m.caption_entities)
    const fwd = forwardOf(m)
    events.push({
      type: 'message.created',
      dedupeKey: key(update),
      at,
      node: { nativeId: (chain[0] as NodeInfo).nativeId, chain },
      message: {
        nativeId: String(m.message_id),
        sender: senderOf(m, ctx.botId),
        text,
        attachments,
        ...(entities.length === 0 ? {} : { entities }),
        ...(replyTo === undefined ? {} : { replyTo }),
        ...(m.message_thread_id !== undefined && m.is_topic_message !== true && !isForumChat(m.chat)
          ? { threadRoot: String(m.message_thread_id) }
          : {}),
        ...(fwd === undefined ? {} : { forwardOf: fwd }),
        sortKey: String(m.message_id).padStart(12, '0'),
        ...(m.from?.id === ctx.botId ? { direction: 'out' as const } : {}),
      },
      signals: signalsOf(m, ctx),
      raw: update,
    })
    return { events }
  }
  const edited = update.edited_message ?? update.edited_channel_post
  if (edited !== undefined) {
    const m = edited
    const entities = entitiesOf(m.text ?? m.caption ?? '', m.entities ?? m.caption_entities)
    return {
      events: [
        {
          type: 'message.edited',
          dedupeKey: key(update),
          at: (m.edit_date ?? m.date) * 1000,
          node: refOfMessage(m),
          message: {
            nativeId: String(m.message_id),
            sender: senderOf(m, ctx.botId),
            text: m.text ?? m.caption ?? '',
            ...(entities.length === 0 ? {} : { entities }),
          },
          raw: update,
        },
      ],
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
          dedupeKey: key(update),
          at: Date.now(),
          node: refOfMessage(m as Message),
          name,
          actor: identityOfUser(cb.from, ctx.botId),
          ...(data === undefined ? {} : { data }),
          messageNativeId: String(m.message_id),
          raw: update,
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
    const actor: Identity =
      r.user === undefined
        ? identityOfChat(r.actor_chat ?? r.chat, 'channel')
        : identityOfUser(r.user, ctx.botId)
    const room = chatNode(r.chat)
    const events: RemoteEvent[] = []
    const push = (emoji: string, added: boolean): void => {
      events.push({
        type: added ? 'reaction.added' : 'reaction.removed',
        dedupeKey: key(update, `${added ? 'add' : 'rm'}:${emoji}`),
        at: r.date * 1000,
        node: { nativeId: room.nativeId, chain: [room] },
        actor,
        messageNativeId: String(r.message_id),
        emoji,
        raw: update,
      })
    }
    for (const emoji of after) if (!before.has(emoji)) push(emoji, true)
    for (const emoji of before) if (!after.has(emoji)) push(emoji, false)
    return { events }
  }
  const mine = update.my_chat_member
  if (mine !== undefined) {
    // what the bot is in a chat now (added, promoted, removed); the page lists chats from these
    const status = mine.new_chat_member.status
    const role = ROLE[status] ?? 'unknown'
    const canPost =
      status === 'administrator'
        ? (mine.new_chat_member as { can_post_messages?: boolean }).can_post_messages !== false
        : status === 'member'
    const room: NodeInfo = {
      ...chatNode(mine.chat),
      access: {
        member: role,
        canPost: role === 'none' ? false : canPost,
        // the bot's own administrator rights, by Bot API name (`channel_status` reads them)
        rights: rightsOf(mine.new_chat_member),
      },
      ...(role === 'none'
        ? { state: 'left' as const, stateReason: status }
        : { state: 'active' as const }),
    }
    const node: NodeRef = { nativeId: room.nativeId, chain: [room] }
    return {
      events: [
        {
          type: role === 'none' ? 'member.left' : 'member.updated',
          dedupeKey: key(update),
          at: mine.date * 1000,
          node,
          actor: { ...identityOfUser(mine.new_chat_member.user, ctx.botId), isSelf: true },
          role,
          raw: update,
        },
      ],
    }
  }
  const join = update.chat_join_request
  if (join !== undefined) {
    // somebody asks to join: a chat event with the person as actor (the agent reads the details with
    // `telegram_join_requests list` and answers with approve / decline)
    const room = chatNode(join.chat)
    return {
      events: [
        {
          type: 'node.updated',
          dedupeKey: key(update),
          at: join.date * 1000,
          node: { nativeId: room.nativeId, chain: [room] },
          actor: identityOfUser(join.from, ctx.botId),
          raw: update,
        },
      ],
    }
  }
  const other = update.chat_member
  if (other !== undefined) {
    const status = other.new_chat_member.status
    const was = other.old_chat_member.status
    const role = ROLE[status] ?? 'unknown'
    const room = chatNode(other.chat)
    const joined = (was === 'left' || was === 'kicked') && role !== 'none'
    return {
      events: [
        {
          type: role === 'none' ? 'member.left' : joined ? 'member.joined' : 'member.updated',
          dedupeKey: key(update),
          at: other.date * 1000,
          node: { nativeId: room.nativeId, chain: [room] },
          actor: withTitle(
            identityOfUser(other.new_chat_member.user, ctx.botId),
            other.new_chat_member,
          ),
          role,
          raw: update,
        },
      ],
    }
  }
  return { events: [] }
}
