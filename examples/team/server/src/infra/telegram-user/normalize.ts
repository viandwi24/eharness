/**
 * Pure mapping of MTProto messages to the channels contract (P41 L5.4).
 *
 * Native ids (the same shape as the bot transport, so a chat seen by both is easy to relate):
 *   chat          `<marked chat id>` (a person is the positive id, a basic group `-<id>`, a channel or supergroup `-100<id>`)
 *   forum topic   `<chat>/<topic id>`; General is `<chat>/0`
 *   message       `<message id>`; person `<user id>`
 */
import type {
  HistoryEntry,
  Identity,
  InboundAttachment,
  NodeInfo,
  NodeRef,
  RemoteEvent,
} from '../channels/types.ts'
import type { TgChatKind, TgMessage } from './client.ts'

/** Bumped when the mapping changes in a way that would give another result for the same message. */
export const NORMALIZER_VERSION = 1

/** A node id: the chat, or `<chat>/<topic>` in a forum. */
export const nativeIdOf = (chatId: string, topicId?: number | string): string =>
  topicId === undefined ? chatId : `${chatId}/${topicId}`

export function splitNativeId(id: string): { chatId: string; topicId?: string } {
  const at = id.indexOf('/')
  return at < 0 ? { chatId: id } : { chatId: id.slice(0, at), topicId: id.slice(at + 1) }
}

/** A chat kind from a marked id when the dialog list does not say (positive = a person). */
export const kindOfChatId = (chatId: string): TgChatKind =>
  chatId.startsWith('-') ? 'group' : 'dm'

export interface ChatLike {
  id: string
  kind: TgChatKind
  title?: string | undefined
  forum?: boolean | undefined
  username?: string | undefined
  admin?: boolean | undefined
}

/** The node of a chat (a forum is a container that holds no messages of its own). */
export function chatNode(chat: ChatLike): NodeInfo {
  const title = chat.title === undefined || chat.title === '' ? undefined : chat.title
  const meta = {
    chatId: chat.id,
    ...(chat.username === undefined ? {} : { username: chat.username }),
    ...(chat.forum === true ? { isForum: true } : {}),
  }
  if (chat.kind === 'dm') {
    return {
      nativeId: chat.id,
      kind: 'direct',
      platformType: 'telegram-user:private',
      ...(title === undefined ? {} : { title }),
      traits: { multiUser: false, threading: 'none' },
      meta,
    }
  }
  return {
    nativeId: chat.id,
    kind: 'room',
    platformType: `telegram-user:${chat.kind}`,
    ...(title === undefined ? {} : { title }),
    traits:
      chat.kind === 'channel'
        ? { multiUser: false, broadcast: true, threading: 'relation' }
        : chat.forum === true
          ? { multiUser: true, container: true, postable: false, threading: 'node' }
          : { multiUser: true, threading: 'relation' },
    meta,
    ...(chat.admin === undefined
      ? {}
      : { access: { member: chat.admin ? ('admin' as const) : ('member' as const) } }),
  }
}

/** A forum topic; without a title the stored one stays (the adapter fetches it, `adapter.ts`). */
export function topicNode(chatId: string, topicId: number, title?: string): NodeInfo {
  const named = topicId === 0 ? 'General' : title
  return {
    nativeId: nativeIdOf(chatId, topicId),
    kind: 'thread',
    platformType: topicId === 0 ? 'telegram-user:forum_general' : 'telegram-user:forum_topic',
    ...(named === undefined || named === '' ? {} : { title: named }),
    parent: chatId,
    traits: { multiUser: true, threading: 'relation' },
    meta: { chatId, topicId },
  }
}

/** The node of a message and its ancestors, leaf first. A topic only counts for forum chats. */
export function chainOfMessage(m: TgMessage): NodeInfo[] {
  const room = chatNode({ ...m.chat })
  if (!m.chat.forum) return [room]
  return [topicNode(m.chat.id, m.topicId ?? 0, m.topicTitle), room]
}

export const refOfMessage = (m: TgMessage): NodeRef => {
  const chain = chainOfMessage(m)
  return { nativeId: (chain[0] as NodeInfo).nativeId, chain }
}

export function identityOf(sender: TgMessage['sender']): Identity {
  if (sender === undefined) return { id: 'unknown', name: 'Unknown' }
  return {
    id: sender.id,
    name: sender.name,
    ...(sender.username === undefined ? {} : { username: sender.username }),
    ...(sender.isBot ? { isBot: true, kind: 'bot' as const } : {}),
  }
}

/** `/command@x args` at the start of a message. */
export function commandOf(text: string): { name: string; args: string } | undefined {
  const m = /^\/([A-Za-z0-9_]{1,32})(?:@\w+)?(?:\s+([\s\S]*))?$/.exec(text.trim())
  return m === null
    ? undefined
    : { name: (m[1] as string).toLowerCase(), args: (m[2] ?? '').trim() }
}

export function attachmentsOf(
  m: TgMessage,
  fetch: (m: TgMessage, attachmentId: string) => InboundAttachment['fetch'],
): InboundAttachment[] {
  return m.attachments.map((a) => ({
    id: a.id,
    kind: a.kind,
    ...(a.name === undefined ? {} : { name: a.name }),
    ...(a.mediaType === undefined ? {} : { mediaType: a.mediaType }),
    ...(a.size === undefined ? {} : { size: a.size }),
    fetch: fetch(m, a.id),
  }))
}

export interface NormalizeOptions {
  selfId: string
  fetch: (m: TgMessage, attachmentId: string) => InboundAttachment['fetch']
}

const senderIdentity = (m: TgMessage, selfId: string): Identity =>
  m.outgoing || m.sender?.id === selfId
    ? { ...identityOf(m.sender), id: selfId, isSelf: true }
    : identityOf(m.sender)

/** A new message (live or from history). */
export function normalizeMessage(
  m: TgMessage,
  o: NormalizeOptions,
): Extract<RemoteEvent, { type: 'message.created' }> {
  const sender = senderIdentity(m, o.selfId)
  const command = commandOf(m.text)
  const replyToSelf = m.replyTo?.senderId !== undefined && m.replyTo.senderId === o.selfId
  return {
    type: 'message.created',
    dedupeKey: `tgu:m:${m.chat.id}:${m.id}`,
    at: m.at,
    node: refOfMessage(m),
    message: {
      nativeId: String(m.id),
      sender,
      text: m.text,
      attachments: attachmentsOf(m, o.fetch),
      ...(m.replyTo === undefined
        ? {}
        : {
            replyTo: {
              messageId: String(m.replyTo.id),
              ...(m.replyTo.senderId === undefined ? {} : { senderId: m.replyTo.senderId }),
              ...(m.replyTo.senderName === undefined ? {} : { senderName: m.replyTo.senderName }),
              ...(m.replyTo.text === undefined ? {} : { text: m.replyTo.text }),
            },
          }),
      sortKey: String(m.id).padStart(12, '0'),
      direction: m.outgoing || sender.isSelf === true ? 'out' : 'in',
    },
    signals: {
      mentionedSelf: m.mention,
      ...(m.mentionsOthers && !m.mention ? { mentionedOthers: true } : {}),
      replyToSelf,
      ...(command === undefined ? {} : { command }),
    },
  }
}

export function normalizeEdit(
  m: TgMessage,
  o: NormalizeOptions,
): Extract<RemoteEvent, { type: 'message.edited' }> {
  return {
    type: 'message.edited',
    dedupeKey: `tgu:e:${m.chat.id}:${m.id}:${m.editedAt ?? 0}`,
    at: m.editedAt ?? m.at,
    node: refOfMessage(m),
    message: {
      nativeId: String(m.id),
      sender: senderIdentity(m, o.selfId),
      text: m.text,
    },
  }
}

export function historyEntryOf(m: TgMessage): HistoryEntry {
  return {
    nativeId: String(m.id),
    at: m.at,
    sender: identityOf(m.sender),
    text: m.text,
    attachments: m.attachments.map((a) => ({
      id: a.id,
      ...(a.name === undefined ? {} : { name: a.name }),
      ...(a.mediaType === undefined ? {} : { mediaType: a.mediaType }),
      ...(a.size === undefined ? {} : { size: a.size }),
    })),
    ...(m.replyTo === undefined ? {} : { replyToId: String(m.replyTo.id) }),
  }
}
