/**
 * The real MTProto client: {@link TgUserClient} over `@mtcute/bun` (pinned, pre-1.0). This is the
 * only file that imports mtcute; everything else sees `client.ts`. It runs under Bun only.
 *
 * Storage is in memory: the session string (sealed in the credential store) is the only
 * persistent secret. Update state (pts) is not persisted, so after a restart the adapter fills the
 * gap itself (`backfill.ts` gap fill) and `catchUp` covers what mtcute can.
 *
 * It never calls `readHistory`, `setTyping` or anything that changes presence.
 */
import { createHash } from 'node:crypto'
import {
  type Chat,
  type ChatEvent,
  type DeleteMessageUpdate,
  Long,
  MemoryStorage,
  type Message,
  type Peer,
  TelegramClient,
  type User,
} from '@mtcute/bun'
import type {
  TgAdminEvent,
  TgAttachment,
  TgChat,
  TgChatKind,
  TgClientFactory,
  TgMessage,
  TgUser,
  TgUserClient,
} from './client.ts'

const userOf = (u: User): TgUser => ({
  id: String(u.id),
  name: u.displayName,
  ...(u.username === null ? {} : { username: u.username }),
  ...(u.phoneNumber === null ? {} : { phone: u.phoneNumber }),
  isBot: u.isBot,
})

const chatKindOf = (peer: Peer): TgChatKind => {
  if (peer.type === 'user') return 'dm'
  return peer.chatType === 'channel' || peer.chatType === 'monoforum' ? 'channel' : 'group'
}

const peerName = (p: Peer): string => (p.type === 'user' ? p.displayName : p.title)

function attachmentsOf(m: Message): TgAttachment[] {
  const media = m.media
  if (media === null) return []
  const id = String(m.id)
  switch (media.type) {
    case 'photo':
      return [
        {
          id,
          kind: 'image',
          name: `photo-${m.id}.jpg`,
          mediaType: 'image/jpeg',
          ...(media.fileSize === undefined ? {} : { size: media.fileSize }),
        },
      ]
    case 'video':
      return [
        {
          id,
          kind: 'video',
          ...(media.fileName === null ? {} : { name: media.fileName }),
          mediaType: media.mimeType,
          ...(media.fileSize === undefined ? {} : { size: media.fileSize }),
        },
      ]
    case 'audio':
    case 'voice':
      return [
        {
          id,
          kind: 'audio',
          ...(media.fileName === null ? {} : { name: media.fileName }),
          mediaType: media.mimeType,
          ...(media.fileSize === undefined ? {} : { size: media.fileSize }),
        },
      ]
    case 'document':
      return [
        {
          id,
          kind: 'file',
          ...(media.fileName === null ? {} : { name: media.fileName }),
          mediaType: media.mimeType,
          ...(media.fileSize === undefined ? {} : { size: media.fileSize }),
        },
      ]
    default:
      return []
  }
}

function messageOf(m: Message, me: { id: string; username?: string }): TgMessage {
  const chat = m.chat
  const sender = m.sender
  const entities = m.entities
  const mentions = entities.filter((e) => e.kind === 'mention' || e.kind === 'text_mention')
  const mentionsSelf = mentions.some((e) => {
    if (e.kind === 'text_mention') return String((e.params as { userId?: number }).userId) === me.id
    return (
      me.username !== undefined &&
      m.text.slice(e.offset, e.offset + e.length).toLowerCase() === `@${me.username.toLowerCase()}`
    )
  })
  const topic = m.isTopicMessage
    ? (m.replyToMessage?.threadId ?? m.replyToMessage?.id ?? undefined)
    : undefined
  const replyId = m.replyToMessage?.id ?? null
  const isReplyOnlyTopic = m.isTopicMessage && replyId !== null && replyId === topic
  return {
    chat: {
      id: String(chat.id),
      kind: chatKindOf(chat),
      title: peerName(chat),
      forum: chat.type === 'chat' && chat.isForum,
      ...(chat.username === null || chat.username === undefined ? {} : { username: chat.username }),
    },
    id: m.id,
    ...(topic === undefined || topic === null ? {} : { topicId: topic }),
    at: m.date.getTime(),
    ...(m.editDate === null ? {} : { editedAt: m.editDate.getTime() }),
    text: m.text,
    sender: {
      id: String(sender.id),
      name: peerName(sender as Peer),
      ...((sender as Peer).username == null
        ? {}
        : { username: (sender as Peer).username as string }),
      isBot: sender.type === 'user' && sender.isBot,
    },
    outgoing: m.isOutgoing,
    ...(replyId === null || isReplyOnlyTopic ? {} : { replyTo: { id: replyId } }),
    mention: m.isMention || mentionsSelf,
    mentionsOthers: mentions.length > 0 && !mentionsSelf,
    attachments: attachmentsOf(m),
    service: m.isService,
  }
}

/** A stable 64-bit random id from the outbox key: Telegram drops a second send with the same one. */
const randomIdOf = (key: string): Long => {
  const h = createHash('sha256').update(key).digest()
  return Long.fromBytesLE([...h.subarray(0, 8)])
}

function adminEventOf(e: ChatEvent): TgAdminEvent {
  const a = e.action
  const base = {
    id: String(e.id),
    at: e.date.getTime(),
    actor: { id: String(e.actor.id), name: e.actor.displayName },
  }
  if (a === null) return { ...base, kind: 'other' }
  switch (a.type) {
    case 'msg_deleted':
      return {
        ...base,
        kind: 'delete',
        messageId: a.message.id,
        text: a.message.text,
        ...(a.message.sender === undefined
          ? {}
          : {
              target: { id: String(a.message.sender.id), name: peerName(a.message.sender as Peer) },
            }),
      }
    case 'msg_edited':
      return {
        ...base,
        kind: 'edit',
        messageId: a.new.id,
        text: a.new.text,
        previousText: a.old.text,
      }
    case 'user_perms_changed': {
      const banned = a.new.status === 'banned'
      return {
        ...base,
        kind: banned ? 'ban' : a.old.status === 'banned' ? 'unban' : 'restrict',
        target: { id: String(a.new.user.id), name: a.new.user.displayName },
      }
    }
    case 'user_admin_perms_changed':
      return {
        ...base,
        kind: a.new.status === 'admin' ? 'promote' : 'demote',
        target: { id: String(a.new.user.id), name: a.new.user.displayName },
      }
    case 'user_joined':
    case 'user_joined_invite':
    case 'user_joined_approved':
      return { ...base, kind: 'join' }
    case 'user_left':
      return { ...base, kind: 'leave' }
    case 'user_invited':
      return {
        ...base,
        kind: 'invite',
        target: { id: String(a.member.user.id), name: a.member.user.displayName },
      }
    case 'msg_pinned':
      return { ...base, kind: 'pin', ...(a.message === null ? {} : { messageId: a.message.id }) }
    default:
      return { ...base, kind: 'other', detail: a.type }
  }
}

export interface MtcuteOptions {
  /** Device name Telegram shows in the account's active sessions (so staff recognise it). */
  deviceModel?: string
}

export function createMtcuteClient(mt: MtcuteOptions = {}): TgClientFactory {
  return ({ apiId, apiHash, session }) => {
    const tg = new TelegramClient({
      apiId,
      apiHash,
      storage: new MemoryStorage(),
      updates: { catchUp: true },
      initConnectionOptions: {
        deviceModel: mt.deviceModel ?? 'Team agent (company account)',
      },
    } as ConstructorParameters<typeof TelegramClient>[0])
    let me: { id: string; username?: string } | undefined
    let imported = false
    const ready = async (): Promise<void> => {
      if (session !== undefined && !imported) {
        imported = true
        await tg.importSession(session)
      }
    }
    const self = async (): Promise<{ id: string; username?: string }> => {
      if (me === undefined) {
        await ready()
        const u = await tg.getMe()
        me = { id: String(u.id), ...(u.username === null ? {} : { username: u.username }) }
      }
      return me
    }
    const client: TgUserClient = {
      async sendCode(phone) {
        const r = await tg.sendCode({ phone })
        if ('phoneCodeHash' in r) {
          return {
            phoneCodeHash: r.phoneCodeHash,
            type: r.type,
            nextType: r.nextType,
            timeoutSec: r.timeout,
          }
        }
        return { signedIn: userOf(r) }
      },
      async resendCode(phone, phoneCodeHash) {
        const r = await tg.resendCode({ phone, phoneCodeHash })
        return {
          phoneCodeHash: r.phoneCodeHash,
          type: r.type,
          nextType: r.nextType,
          timeoutSec: r.timeout,
        }
      },
      async signIn(phone, phoneCodeHash, phoneCode) {
        return userOf(await tg.signIn({ phone, phoneCodeHash, phoneCode }))
      },
      async checkPassword(password) {
        return userOf(await tg.checkPassword(password))
      },
      async signInQr(o) {
        const user = await tg.signInQr({
          abortSignal: o.signal,
          onUrlUpdated: (url, expires) => o.onUrl(url, expires.getTime()),
          ...(o.onScanned === undefined ? {} : { onQrScanned: o.onScanned }),
          password: () => o.password(),
          invalidPasswordCallback: () => o.onBadPassword?.(),
        })
        return userOf(user)
      },
      async getMe() {
        await ready()
        return userOf(await tg.getMe())
      },
      exportSession: () => tg.exportSession(),
      async listChats() {
        await ready()
        const out: TgChat[] = []
        for await (const d of tg.iterDialogs({ archived: 'keep', limit: 1000 })) {
          const p = d.peer
          out.push({
            id: String(p.id),
            kind: chatKindOf(p),
            title: peerName(p),
            ...(p.username == null ? {} : { username: p.username }),
            forum: p.type === 'chat' && p.isForum,
            admin: p.type === 'chat' && (p.isAdmin || p.isCreator),
            ...(p.type === 'chat' && p.membersCount !== null ? { members: p.membersCount } : {}),
          })
        }
        return out
      },
      async startUpdates(h, o) {
        const who = await self()
        // `catchUp` is a constructor option of mtcute (below); a caller asking for none is not supported
        void o
        tg.onNewMessage.add((m: Message) => h.message(messageOf(m, who)))
        tg.onEditMessage.add((m: Message) => h.edit(messageOf(m, who)))
        tg.onDeleteMessage.add((d: DeleteMessageUpdate) =>
          h.delete({
            ids: d.messageIds,
            ...(d.channelId === null ? {} : { chatId: String(d.channelId) }),
          }),
        )
        tg.onError.add((e: unknown) => h.error(e))
        await tg.startUpdatesLoop()
      },
      async stop() {
        await tg.destroy()
      },
      async history(chatId, o) {
        await ready()
        const who = await self()
        const list = await tg.getHistory(Number(chatId), {
          limit: o.limit,
          ...(o.offsetId === undefined ? {} : { offset: { id: o.offsetId, date: 0 } }),
        })
        return list.map((m) => messageOf(m, who))
      },
      async messagesById(chatId, ids) {
        const who = await self()
        const list = await tg.getMessages(Number(chatId), ids)
        return list.map((m) => (m === null ? null : messageOf(m, who)))
      },
      async adminLog(chatId, o) {
        const events = await tg.getChatEventLog(Number(chatId), {
          limit: o.limit,
          ...(o.minId === undefined ? {} : { minId: Long.fromString(o.minId) }),
          ...(o.maxId === undefined ? {} : { maxId: Long.fromString(o.maxId) }),
        })
        return events.map(adminEventOf)
      },
      async forumTopics(chatId, o) {
        await ready()
        const ids = o?.ids ?? []
        const list =
          ids.length > 0
            ? await tg.getForumTopicsById(Number(chatId), ids)
            : await tg.getForumTopics(Number(chatId), { limit: o?.limit ?? 100 })
        return list
          .filter((t) => t !== null && !t.titleMissing)
          .map((t) => {
            const topic = t as NonNullable<typeof t>
            return { id: topic.id, title: topic.title, closed: topic.isClosed }
          })
      },
      async members(chatId, limit) {
        const list = await tg.getChatMembers(Number(chatId), { limit, type: 'recent' })
        return list.map((m) => userOf(m.user))
      },
      async sendText(chatId, text, o) {
        const m = await tg.sendText(Number(chatId), text, {
          ...(o?.replyTo === undefined ? {} : { replyTo: o.replyTo }),
          ...(o?.topicId === undefined ? {} : { threadId: o.topicId }),
          ...(o?.silent === true ? { silent: true } : {}),
          ...(o?.key === undefined ? {} : { randomId: randomIdOf(o.key) }),
          disableWebPreview: true,
        })
        return { id: m.id }
      },
      async sendFiles(chatId, files, caption, o) {
        const common = {
          ...(o?.replyTo === undefined ? {} : { replyTo: o.replyTo }),
          ...(o?.topicId === undefined ? {} : { threadId: o.topicId }),
          ...(o?.silent === true ? { silent: true } : {}),
        }
        const media = files.map((f) => ({
          type: f.mediaType.startsWith('image/') ? ('photo' as const) : ('document' as const),
          file: f.bytes,
          fileName: f.name,
          fileMime: f.mediaType,
        }))
        if (media.length === 1) {
          const m = await tg.sendMedia(
            Number(chatId),
            { ...(media[0] as (typeof media)[0]), caption },
            {
              ...common,
              ...(o?.key === undefined ? {} : { randomId: randomIdOf(o.key) }),
            },
          )
          return { id: m.id }
        }
        const first = { ...(media[0] as (typeof media)[0]), caption }
        const list = await tg.sendMediaGroup(Number(chatId), [first, ...media.slice(1)], common)
        return { id: (list[0] as Message).id }
      },
      async editText(chatId, id, text) {
        await tg.editMessage({ chatId: Number(chatId), message: id, text })
      },
      async deleteMessages(chatId, ids) {
        await tg.deleteMessagesById(Number(chatId), ids, { revoke: true })
      },
      async pin(chatId, id, pinned) {
        if (pinned) await tg.pinMessage({ chatId: Number(chatId), message: id })
        else await tg.unpinMessage({ chatId: Number(chatId), message: id })
      },
      async react(chatId, id, emoji) {
        await tg.sendReaction({ chatId: Number(chatId), message: id, emoji })
      },
      async download(chatId, id) {
        const [m] = await tg.getMessages(Number(chatId), [id])
        const media = m?.media
        if (m === undefined || m === null || media === null || media === undefined) {
          throw new Error('the message has no downloadable file')
        }
        const location = media as unknown as Parameters<typeof tg.downloadAsBuffer>[0]
        const bytes = await tg.downloadAsBuffer(location)
        const meta = attachmentsOf(m)[0]
        return {
          bytes,
          ...(meta?.mediaType === undefined ? {} : { mediaType: meta.mediaType }),
          ...(meta?.name === undefined ? {} : { name: meta.name }),
        }
      },
    }
    return client
  }
}

export type { Chat }
