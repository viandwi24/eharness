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
  thtml,
  type User,
} from '@mtcute/bun'
import type {
  TgAdminEvent,
  TgAttachment,
  TgChat,
  TgChatKind,
  TgClientFactory,
  TgMention,
  TgMessage,
  TgUser,
  TgUserClient,
} from './client.ts'
import { rpcText } from './errors.ts'

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

/** A chat as the plain client types say it. */
const chatOf = (p: Peer): TgChat => ({
  id: String(p.id),
  kind: chatKindOf(p),
  title: peerName(p),
  ...(p.username == null ? {} : { username: p.username }),
  forum: p.type === 'chat' && p.isForum,
  admin: p.type === 'chat' && (p.isAdmin || p.isCreator),
  ...(p.type === 'chat' && p.membersCount !== null ? { members: p.membersCount } : {}),
})

/**
 * A text with its mentions as Telegram entities: an `@handle` is a mention entity (Telegram pings by
 * username), a name is a mention by id (mtcute resolves the user; one it cannot resolve stays text).
 */
const withMentions = (
  text: string,
  mentions: TgMention[] | undefined,
): string | { text: string; entities: never[] } =>
  mentions === undefined || mentions.length === 0
    ? text
    : {
        text,
        entities: mentions.map((m) =>
          m.byHandle
            ? { _: 'messageEntityMention', offset: m.offset, length: m.length }
            : {
                _: 'messageEntityMentionName',
                offset: m.offset,
                length: m.length,
                userId: Number(m.userId),
              },
        ) as never[],
      }

/** Telegram HTML as text + entities; each `@handle` given gets a mention entity. Plain text when it does not parse. */
function fromHtml(
  source: string,
  handles: readonly string[],
): string | { text: string; entities: never[] } {
  try {
    const parsed = thtml(source)
    const entities = [...(parsed.entities ?? [])] as unknown[]
    // bare URLs get an entity too: with explicit entities Telegram links nothing on its own
    const taken = (o: number, l: number): boolean =>
      (entities as Array<{ offset: number; length: number }>).some(
        (e) => o < e.offset + e.length && e.offset < o + l,
      )
    for (const u of parsed.text.matchAll(/https?:\/\/[^\s<>"]+/g)) {
      const url = u[0].replace(/[.,;:!?)\]]+$/, '')
      const at = u.index as number
      if (!taken(at, url.length))
        entities.push({ _: 'messageEntityUrl', offset: at, length: url.length })
    }
    let from = 0
    for (const h of handles) {
      const at = parsed.text.indexOf(`@${h}`, from)
      if (at < 0) continue
      entities.push({ _: 'messageEntityMention', offset: at, length: h.length + 1 })
      from = at + h.length + 1
    }
    return { text: parsed.text, entities: entities as never[] }
  } catch {
    return source
      .replace(/<[^>]+>/g, '')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, '&')
  }
}

/** A person reference: a numeric id, or a username (with or without `@`). */
const peerRef = (ref: string): number | string => {
  const t = ref.trim()
  return /^-?\d+$/.test(t) ? Number(t) : t.replace(/^@/, '')
}

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

/** Image types Telegram accepts as a photo. Everything else (gif, svg, bmp, tiff, heic, ...) goes as a document. */
const PHOTO_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp'])

/** A rejection of the image as a photo: the same bytes are accepted as a document. */
const isPhotoRejection = (error: unknown): boolean =>
  /^(?:PHOTO_|IMAGE_PROCESS_FAILED)/.test(rpcText(error).toUpperCase())

/** The two send calls `sendFilesWith` needs (a fake in tests). */
export interface MediaSender {
  sendMedia(chatId: number, media: never, params?: never): Promise<{ id: number }>
  sendMediaGroup(chatId: number, media: never, params?: never): Promise<Array<{ id: number }>>
}

/**
 * Send files as photos (jpeg, png, webp) or documents (all else). If Telegram refuses a photo
 * (`PHOTO_EXT_INVALID`, `PHOTO_INVALID_DIMENSIONS`, `IMAGE_PROCESS_FAILED`), the send is retried
 * once with every file as a document.
 */
export async function sendFilesWith(
  tg: MediaSender,
  chatId: string,
  files: ReadonlyArray<{ name: string; mediaType: string; bytes: Uint8Array }>,
  caption: string | undefined,
  o: { replyTo?: number; topicId?: number; silent?: boolean; key?: string } | undefined,
  randomIdOf: (key: string) => unknown,
): Promise<{ id: number }> {
  const common = {
    ...(o?.replyTo === undefined ? {} : { replyTo: o.replyTo }),
    ...(o?.topicId === undefined ? {} : { threadId: o.topicId }),
    ...(o?.silent === true ? { silent: true } : {}),
  }
  const build = (asPhoto: boolean) =>
    files.map((f) => ({
      type: asPhoto && PHOTO_TYPES.has(f.mediaType) ? ('photo' as const) : ('document' as const),
      file: f.bytes,
      fileName: f.name,
      fileMime: f.mediaType,
    }))
  const attempt = async (media: ReturnType<typeof build>): Promise<{ id: number }> => {
    if (media.length === 1) {
      const m = await tg.sendMedia(
        Number(chatId),
        { ...(media[0] as (typeof media)[0]), caption } as never,
        {
          ...common,
          ...(o?.key === undefined ? {} : { randomId: randomIdOf(o.key) }),
        } as never,
      )
      return { id: m.id }
    }
    const first = { ...(media[0] as (typeof media)[0]), caption }
    const list = await tg.sendMediaGroup(
      Number(chatId),
      [first, ...media.slice(1)] as never,
      common as never,
    )
    return { id: (list[0] as { id: number }).id }
  }
  const media = build(true)
  try {
    return await attempt(media)
  } catch (error) {
    if (!media.some((m) => m.type === 'photo') || !isPhotoRejection(error)) throw error
    return attempt(build(false))
  }
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
    // The session lives in memory only (no peer files): after a start, or for a chat joined since
    // the dialogs were last read, mtcute knows no access hash for a chat id and refuses it ("not
    // found in local cache"). Reading the dialogs fills the cache; at most once a minute.
    let dialogsReadAt = 0
    const readDialogs = async (): Promise<boolean> => {
      if (Date.now() - dialogsReadAt < 60_000) return false
      dialogsReadAt = Date.now()
      await ready()
      for await (const d of tg.iterDialogs({ archived: 'keep', limit: 1000 })) void d
      return true
    }
    const peerUnknown = (error: unknown): boolean =>
      /not found in local cache|PEER_ID_INVALID|CHANNEL_INVALID|CHAT_ID_INVALID/i.test(
        error instanceof Error ? `${error.name} ${error.message}` : String(error),
      )
    /** Run `op`; a chat unknown to the peer cache gets one retry after the dialogs were read. */
    const withPeer = async <T>(op: () => Promise<T>): Promise<T> => {
      try {
        return await op()
      } catch (error) {
        if (peerUnknown(error) && (await readDialogs())) return op()
        throw error
      }
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
        dialogsReadAt = Date.now()
        const out: TgChat[] = []
        for await (const d of tg.iterDialogs({ archived: 'keep', limit: 1000 })) {
          out.push(chatOf(d.peer))
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
        // a forum topic: the server-side search of that thread (getHistory has no topic filter)
        if (o.topicId !== undefined) {
          const found = await tg.searchMessages({
            chatId: Number(chatId),
            query: '',
            threadId: o.topicId,
            limit: o.limit,
            ...(o.offsetId === undefined ? {} : { offset: o.offsetId }),
          })
          return found.map((m) => messageOf(m, who))
        }
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
      async getChatInfo(chatId) {
        await ready()
        const c = await tg.getFullChat(Number(chatId))
        return {
          ...chatOf(c),
          ...(c.bio === '' ? {} : { description: c.bio }),
          ...(c.membersCount > 0 ? { members: c.membersCount } : {}),
          ...(c.adminsCount > 0 ? { admins: c.adminsCount } : {}),
          ...(c.linkedChat === null ? {} : { linkedChatId: String(c.linkedChat.id) }),
          canListMembers: c.canViewParticipants,
        }
      },
      async getUserInfo(ref) {
        await ready()
        return userOf(await tg.getUser(peerRef(ref)))
      },
      async listMembers(chatId, o) {
        await ready()
        const list = await tg.getChatMembers(Number(chatId), {
          type: o.type,
          limit: o.limit,
          ...(o.query === undefined ? {} : { query: o.query }),
        })
        return {
          total: list.total,
          members: list.map((m) => ({
            user: userOf(m.user),
            status: m.status,
            ...(m.title === null ? {} : { title: m.title }),
            ...(m.joinedDate === null ? {} : { joinedAt: m.joinedDate.getTime() }),
          })),
        }
      },
      async searchMessages(chatId, o) {
        await ready()
        const who = await self()
        const list = await tg.searchMessages({
          chatId: Number(chatId),
          query: o.query,
          limit: o.limit,
          ...(o.fromUser === undefined ? {} : { fromUser: peerRef(o.fromUser) }),
          ...(o.topicId === undefined ? {} : { threadId: o.topicId }),
          ...(o.minDate === undefined ? {} : { minDate: new Date(o.minDate) }),
          ...(o.maxDate === undefined ? {} : { maxDate: new Date(o.maxDate) }),
        })
        return list.map((m) => messageOf(m, who))
      },
      async forwardMessages(fromChatId, ids, toChatId, o) {
        await ready()
        const list = await tg.forwardMessagesById({
          fromChatId: Number(fromChatId),
          messages: ids,
          toChatId: Number(toChatId),
          ...(o?.topicId === undefined ? {} : { toThreadId: o.topicId }),
          ...(o?.silent === true ? { silent: true } : {}),
          ...(o?.at === undefined ? {} : { schedule: o.at }),
          ...(o?.dropAuthor === true ? { noAuthor: true } : {}),
        })
        return list.map((m) => m.id)
      },
      async sendPoll(chatId, poll, o) {
        await ready()
        const base = {
          question: poll.question,
          answers: poll.options,
          ...(poll.multiple === true ? { multiple: true } : {}),
          ...(poll.publicVoters === true ? { public: true } : {}),
        }
        const m = await tg.sendMedia(
          Number(chatId),
          poll.correct === undefined
            ? { type: 'poll', ...base }
            : { type: 'quiz', ...base, correct: poll.correct },
          {
            ...(o?.topicId === undefined ? {} : { threadId: o.topicId }),
            ...(o?.silent === true ? { silent: true } : {}),
            ...(o?.at === undefined ? {} : { schedule: o.at }),
          },
        )
        return { id: m.id }
      },
      async scheduleText(chatId, text, o) {
        await ready()
        const m = await tg.sendText(Number(chatId), text, {
          schedule: o.at,
          ...(o.topicId === undefined ? {} : { threadId: o.topicId }),
          ...(o.silent === true ? { silent: true } : {}),
          disableWebPreview: true,
        })
        return { id: m.id }
      },
      async listScheduled(chatId) {
        await ready()
        const list = await tg.getAllScheduledMessages(Number(chatId))
        return list.map((m) => {
          const topic = m.isTopicMessage ? m.replyToMessage?.threadId : undefined
          return {
            id: m.id,
            at: m.date.getTime(),
            text: m.text,
            ...(topic === undefined || topic === null ? {} : { topicId: topic }),
          }
        })
      },
      async cancelScheduled(chatId, ids) {
        await ready()
        await tg.deleteScheduledMessages(Number(chatId), ids)
      },
      async createTopic(chatId, title) {
        await ready()
        const m = await tg.createForumTopic({ chatId: Number(chatId), title })
        return { id: m.id }
      },
      async editTopic(chatId, topicId, title) {
        await ready()
        await tg.editForumTopic({ chatId: Number(chatId), topicId, title })
      },
      async setTopicClosed(chatId, topicId, closed) {
        await ready()
        await tg.toggleForumTopicClosed({ chatId: Number(chatId), topicId, closed })
      },
      async banMember(chatId, userId, untilMs) {
        await ready()
        await tg.banChatMember({
          chatId: Number(chatId),
          participantId: peerRef(userId),
          ...(untilMs === undefined ? {} : { untilDate: new Date(untilMs) }),
        })
      },
      async unbanMember(chatId, userId) {
        await ready()
        await tg.unbanChatMember({ chatId: Number(chatId), participantId: peerRef(userId) })
      },
      async promoteMember(chatId, userId, r, title) {
        await ready()
        await tg.editAdminRights({
          chatId: Number(chatId),
          userId: peerRef(userId),
          rights: {
            ...(r.changeInfo === true ? { changeInfo: true } : {}),
            ...(r.deleteMessages === true ? { deleteMessages: true } : {}),
            ...(r.banUsers === true ? { banUsers: true } : {}),
            ...(r.inviteUsers === true ? { inviteUsers: true } : {}),
            ...(r.pinMessages === true ? { pinMessages: true } : {}),
            ...(r.manageTopics === true ? { manageTopics: true } : {}),
            ...(r.manageCall === true ? { manageCall: true } : {}),
          },
          ...(title === undefined ? {} : { rank: title }),
        })
      },
      async demoteMember(chatId, userId) {
        await ready()
        await tg.editAdminRights({ chatId: Number(chatId), userId: peerRef(userId), rights: {} })
      },
      async restrictMember(chatId, userId, r, untilMs) {
        await ready()
        await tg.restrictChatMember({
          chatId: Number(chatId),
          userId: peerRef(userId),
          restrictions: {
            ...(r.sendMessages === true ? { sendMessages: true } : {}),
            ...(r.sendMedia === true ? { sendMedia: true } : {}),
            ...(r.sendPolls === true ? { sendPolls: true } : {}),
            ...(r.sendOther === true
              ? { sendStickers: true, sendGifs: true, sendGames: true, sendInline: true }
              : {}),
            ...(r.embedLinks === true ? { embedLinks: true } : {}),
            ...(r.inviteUsers === true ? { inviteUsers: true } : {}),
            ...(r.pinMessages === true ? { pinMessages: true } : {}),
            ...(r.changeInfo === true ? { changeInfo: true } : {}),
          },
          ...(untilMs === undefined ? {} : { until: untilMs }),
        })
      },
      async deleteMemberMessages(chatId, userId) {
        await ready()
        await tg.deleteUserHistory({ chatId: Number(chatId), participantId: peerRef(userId) })
      },
      async createInviteLink(chatId, o) {
        await ready()
        const l = await tg.createInviteLink(Number(chatId), {
          ...(o.expiresAt === undefined ? {} : { expires: o.expiresAt }),
          ...(o.usageLimit === undefined ? {} : { usageLimit: o.usageLimit }),
          ...(o.withApproval === true ? { withApproval: true } : {}),
        })
        return { link: l.link }
      },
      async joinChat(ref) {
        await ready()
        const r = await tg.joinChat(ref.trim())
        if (r.status === 'ok') return { status: 'joined', chat: chatOf(r.chat) }
        return { status: 'requested' }
      },
      async leaveChat(chatId) {
        await ready()
        await tg.leaveChat(Number(chatId))
      },
      async members(chatId, limit) {
        const list = await tg.getChatMembers(Number(chatId), { limit, type: 'recent' })
        return list.map((m) => userOf(m.user))
      },
      async sendText(chatId, text, o) {
        const input =
          o?.html !== undefined ? fromHtml(text, o.html.handles) : withMentions(text, o?.mentions)
        const m = await tg.sendText(Number(chatId), input, {
          ...(o?.replyTo === undefined ? {} : { replyTo: o.replyTo }),
          ...(o?.topicId === undefined ? {} : { threadId: o.topicId }),
          ...(o?.silent === true ? { silent: true } : {}),
          ...(o?.key === undefined ? {} : { randomId: randomIdOf(o.key) }),
          disableWebPreview: true,
        })
        return { id: m.id }
      },
      async sendFiles(chatId, files, caption, o) {
        return sendFilesWith(tg, chatId, files, caption, o, randomIdOf)
      },
      async editText(chatId, id, text, html) {
        await tg.editMessage({
          chatId: Number(chatId),
          message: id,
          text: html === undefined ? text : fromHtml(text, html.handles),
        })
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
    // every call that names a chat: a cache miss is healed once (nothing was sent when it failed)
    const byChat = [
      'history',
      'messagesById',
      'adminLog',
      'forumTopics',
      'members',
      'getChatInfo',
      'listMembers',
      'searchMessages',
      'forwardMessages',
      'sendPoll',
      'scheduleText',
      'listScheduled',
      'cancelScheduled',
      'createTopic',
      'editTopic',
      'setTopicClosed',
      'banMember',
      'unbanMember',
      'promoteMember',
      'demoteMember',
      'restrictMember',
      'deleteMemberMessages',
      'createInviteLink',
      'leaveChat',
      'sendText',
      'sendFiles',
      'editText',
      'deleteMessages',
      'pin',
      'react',
      'download',
    ] as const
    const methods = client as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>
    for (const name of byChat) {
      const op = methods[name] as (...args: unknown[]) => Promise<unknown>
      methods[name] = (...args: unknown[]) => withPeer(() => op.apply(client, args))
    }
    return client
  }
}

export type { Chat }
