/** Pure mapping of MTProto messages to the channels contract. */
import type {
  ConversationKind,
  ConversationRef,
  HistoryEntry,
  Identity,
  InboundAttachment,
  InboundEvent,
} from '../channels/types.ts'
import type { TgChatKind, TgMessage } from './client.ts'

const KIND: Record<TgChatKind, ConversationKind> = { dm: 'dm', group: 'group', channel: 'channel' }

/** A conversation id: the chat, or `<chat>/<topic>` in a forum (the same shape as the bot transport). */
export const conversationId = (chatId: string, topicId?: number): string =>
  topicId === undefined ? chatId : `${chatId}/${topicId}`

export function splitConversationId(id: string): { chatId: string; topicId?: string } {
  const at = id.indexOf('/')
  return at < 0 ? { chatId: id } : { chatId: id.slice(0, at), topicId: id.slice(at + 1) }
}

/** A chat kind from a marked id when the dialog list does not say (positive = a person). */
export const kindOfChatId = (chatId: string): ConversationKind =>
  chatId.startsWith('-') ? 'group' : 'dm'

export function refOf(
  connectionId: string,
  chat: { id: string; kind: TgChatKind | ConversationKind; title?: string | undefined },
  topicId?: number | string,
): ConversationRef {
  return {
    id: topicId === undefined ? chat.id : `${chat.id}/${topicId}`,
    connectionId,
    container: chat.id,
    ...(topicId === undefined ? {} : { topic: String(topicId) }),
    kind: KIND[chat.kind as TgChatKind] ?? (chat.kind as ConversationKind),
    ...(chat.title === undefined ? {} : { title: chat.title }),
  }
}

export function identityOf(sender: TgMessage['sender']): Identity {
  if (sender === undefined) return { id: 'unknown', name: 'Unknown' }
  return {
    id: sender.id,
    name: sender.name,
    ...(sender.username === undefined ? {} : { username: sender.username }),
    ...(sender.isBot ? { isBot: true } : {}),
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
  connectionId: string
  selfId: string
  fetch: (m: TgMessage, attachmentId: string) => InboundAttachment['fetch']
}

/** A new message. A topic only counts for forum chats. */
export function normalizeMessage(m: TgMessage, o: NormalizeOptions): InboundEvent {
  const ref = refOf(o.connectionId, m.chat, m.chat.forum ? m.topicId : undefined)
  const sender: Identity =
    m.outgoing || m.sender?.id === o.selfId
      ? { ...identityOf(m.sender), id: o.selfId, isSelf: true }
      : identityOf(m.sender)
  const command = commandOf(m.text)
  const replyToSelf = m.replyTo?.senderId !== undefined && m.replyTo.senderId === o.selfId
  return {
    type: 'message',
    conversation: ref,
    at: m.at,
    messageId: String(m.id),
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
    signals: {
      mentionedSelf: m.mention,
      ...(m.mentionsOthers && !m.mention ? { mentionedOthers: true } : {}),
      replyToSelf,
      ...(command === undefined ? {} : { command }),
    },
  }
}

export function normalizeEdit(m: TgMessage, o: NormalizeOptions): InboundEvent {
  const ref = refOf(o.connectionId, m.chat, m.chat.forum ? m.topicId : undefined)
  return {
    type: 'edit',
    conversation: ref,
    at: m.editedAt ?? m.at,
    messageId: String(m.id),
    sender:
      m.outgoing || m.sender?.id === o.selfId
        ? { ...identityOf(m.sender), id: o.selfId, isSelf: true }
        : identityOf(m.sender),
    text: m.text,
  }
}

export function historyEntryOf(m: TgMessage): HistoryEntry {
  return {
    messageId: String(m.id),
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
