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
  type ChatJoinRequestUpdate,
  type ChatMember,
  type ChatMemberUpdate,
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
  TgInviteLink,
  TgMember,
  TgMemberUpdate,
  TgMention,
  TgMessage,
  TgUser,
  TgUserClient,
} from './client.ts'
import { rpcText, TgRpcError } from './errors.ts'

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

/** mtcute's member update kinds, folded into the ones the adapter reports. */
const memberUpdateType = (t: ChatMemberUpdate['type']): TgMemberUpdate['type'] => {
  switch (t) {
    case 'joined':
    case 'added':
    case 'left':
    case 'kicked':
    case 'unkicked':
    case 'restricted':
    case 'unrestricted':
      return t
    case 'promoted':
    case 'unrestricted_promoted':
      return 'promoted'
    case 'demoted':
    case 'demoted_restricted':
      return 'demoted'
    case 'demoted_kicked':
      return 'kicked'
    case 'old_owner':
    case 'new_owner':
      return 'owner_changed'
    default:
      return 'other'
  }
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

const snake = (k: string): string => k.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`)
/** The rights set to true in a raw rights object, as snake_case names. */
const trueKeys = (raw: object | null | undefined): string[] =>
  raw === null || raw === undefined
    ? []
    : Object.entries(raw)
        .filter(([k, v]) => v === true && k !== '_')
        .map(([k]) => snake(k))

/** A member with the exact rights (admins) or limits (restricted, banned) Telegram reports. */
function memberOf(m: ChatMember): TgMember {
  const rights = m.status === 'admin' ? trueKeys(m.permissions) : undefined
  const forbidden =
    m.status === 'restricted' || m.status === 'banned' ? trueKeys(m.restrictions?.raw) : undefined
  const by = m.status === 'admin' ? m.promotedBy : null
  const canEdit = (m.raw as { canEdit?: boolean }).canEdit
  return {
    user: userOf(m.user),
    status: m.status,
    ...(m.title === null ? {} : { title: m.title }),
    ...(m.joinedDate === null ? {} : { joinedAt: m.joinedDate.getTime() }),
    ...(rights === undefined ? {} : { rights }),
    ...(forbidden === undefined ? {} : { forbidden }),
    ...(by === null || by === undefined
      ? {}
      : { promotedBy: { id: String(by.id), name: by.displayName } }),
    ...(canEdit === undefined ? {} : { canEdit }),
  }
}

/** An invite link as the plain client types say it (from the raw `chatInviteExported`). */
function inviteOf(raw: {
  link: string
  revoked?: boolean
  permanent?: boolean
  requestNeeded?: boolean
  expireDate?: number
  usageLimit?: number
  usage?: number
  requested?: number
  title?: string
}): TgInviteLink {
  return {
    link: raw.link,
    ...(raw.title === undefined || raw.title === '' ? {} : { title: raw.title }),
    primary: raw.permanent === true,
    revoked: raw.revoked === true,
    ...(raw.expireDate === undefined || raw.expireDate === 0
      ? {}
      : { expiresAt: raw.expireDate * 1000 }),
    ...(raw.usageLimit === undefined || raw.usageLimit === 0 ? {} : { usageLimit: raw.usageLimit }),
    usage: raw.usage ?? 0,
    withApproval: raw.requestNeeded === true,
    pendingRequests: raw.requested ?? 0,
  }
}

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
        if (h.member !== undefined) {
          const onMember = h.member
          tg.onChatMemberUpdate.add((u: ChatMemberUpdate) => {
            const c = u.chat
            const status = u.newMember?.status
            onMember({
              chat: {
                id: String(c.id),
                kind: chatKindOf(c),
                title: peerName(c),
                forum: c.type === 'chat' && c.isForum,
                ...(c.username == null ? {} : { username: c.username }),
              },
              user: userOf(u.user),
              ...(u.isSelfMade ? {} : { actor: userOf(u.actor) }),
              type: memberUpdateType(u.type),
              status:
                status === 'creator'
                  ? 'creator'
                  : status === 'admin'
                    ? 'admin'
                    : status === 'restricted'
                      ? 'restricted'
                      : status === 'banned'
                        ? 'banned'
                        : status === 'left' || u.newMember === null
                          ? 'left'
                          : 'member',
              ...(u.inviteLink === null ? {} : { link: u.inviteLink.link }),
              at: u.date.getTime(),
            })
          })
        }
        if (h.joinRequests !== undefined) {
          const onRequests = h.joinRequests
          tg.onChatJoinRequest.add((u: ChatJoinRequestUpdate) => {
            // the update names the chat by id only: the adapter fills the title from its dialogs
            onRequests({
              chat: {
                id: String(u.chatId),
                kind: u.chatId < -1_000_000_000_000 ? 'channel' : 'group',
                title: '',
                forum: false,
              },
              users: u.recentRequesters.map(userOf),
              total: u.totalPending,
              at: Date.now(),
            })
          })
        }
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
          members: list.map(memberOf),
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
            ...(r.addAdmins === true ? { addAdmins: true } : {}),
            ...(r.anonymous === true ? { anonymous: true } : {}),
            ...(r.postMessages === true ? { postMessages: true } : {}),
            ...(r.editMessages === true ? { editMessages: true } : {}),
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
            ...(r.manageTopics === true ? { manageTopics: true } : {}),
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
        // a title (a note only admins see) needs the raw call: the high-level one has no such field
        if (o.title !== undefined) {
          const res = await tg.call({
            _: 'messages.exportChatInvite',
            peer: await tg.resolvePeer(Number(chatId)),
            ...(o.expiresAt === undefined ? {} : { expireDate: Math.floor(o.expiresAt / 1000) }),
            ...(o.usageLimit === undefined ? {} : { usageLimit: o.usageLimit }),
            ...(o.withApproval === true ? { requestNeeded: true } : {}),
            title: o.title,
          })
          if (res._ !== 'chatInviteExported')
            throw new Error('Telegram did not return an invite link')
          return { link: res.link }
        }
        const l = await tg.createInviteLink(Number(chatId), {
          ...(o.expiresAt === undefined ? {} : { expires: o.expiresAt }),
          ...(o.usageLimit === undefined ? {} : { usageLimit: o.usageLimit }),
          ...(o.withApproval === true ? { withApproval: true } : {}),
        })
        return { link: l.link }
      },
      async primaryInviteLink(chatId) {
        await ready()
        return { link: (await tg.getPrimaryInviteLink(Number(chatId))).link }
      },
      async listInviteLinks(chatId, o) {
        await ready()
        const list = await tg.getInviteLinks(Number(chatId), { revoked: o.revoked, limit: o.limit })
        return list.map((l) => inviteOf(l.raw))
      },
      async editInviteLink(chatId, link, o) {
        await ready()
        const res = await tg.call({
          _: 'messages.editExportedChatInvite',
          peer: await tg.resolvePeer(Number(chatId)),
          link,
          // 0 clears an expiry or a limit
          ...(o.expiresAt === undefined
            ? {}
            : { expireDate: o.expiresAt === 0 ? 0 : Math.floor(o.expiresAt / 1000) }),
          ...(o.usageLimit === undefined ? {} : { usageLimit: o.usageLimit }),
          ...(o.withApproval === undefined ? {} : { requestNeeded: o.withApproval }),
          ...(o.title === undefined ? {} : { title: o.title }),
        })
        if (res._ === 'messages.exportedChatInviteReplaced') return inviteOf(res.newInvite as never)
        return inviteOf(res.invite as never)
      },
      async revokeInviteLink(chatId, link) {
        await ready()
        await tg.revokeInviteLink(Number(chatId), link)
      },
      async listJoinRequests(chatId, o) {
        await ready()
        const list = await tg.getInviteLinkMembers(Number(chatId), {
          requested: true,
          limit: o.limit,
          ...(o.link === undefined ? {} : { link: o.link }),
        })
        return list.map((m) => ({
          user: userOf(m.user),
          at: m.date.getTime(),
          ...(m.bio === null || m.bio === '' ? {} : { bio: m.bio }),
        }))
      },
      async answerJoinRequests(chatId, o) {
        await ready()
        if (o.all === true) {
          await tg.hideAllJoinRequests({
            chatId: Number(chatId),
            action: o.action,
            ...(o.link === undefined ? {} : { link: o.link }),
          })
          return
        }
        await tg.hideJoinRequest({
          chatId: Number(chatId),
          user: peerRef(o.userId as string),
          action: o.action,
        })
      },
      async createSupergroup(o) {
        await ready()
        const c = await tg.createSupergroup({
          title: o.title,
          ...(o.description === undefined ? {} : { description: o.description }),
          ...(o.forum === true ? { forum: true } : {}),
        })
        return { ...chatOf(c), admin: true }
      },
      async createChannel(o) {
        await ready()
        const c = await tg.createChannel({
          title: o.title,
          ...(o.description === undefined ? {} : { description: o.description }),
        })
        return { ...chatOf(c), admin: true }
      },
      async addMember(chatId, userRef) {
        await ready()
        // `missing` lists people Telegram skipped without failing (privacy settings)
        const missing = await tg.addChatMembers(Number(chatId), peerRef(userRef), {
          forwardCount: 0,
        })
        return { added: missing.length === 0 }
      },
      async setChatTitle(chatId, title) {
        await ready()
        await tg.setChatTitle(Number(chatId), title)
      },
      async setChatDescription(chatId, description) {
        await ready()
        await tg.setChatDescription(Number(chatId), description)
      },
      async setChatPhoto(chatId, file) {
        await ready()
        await tg.setChatPhoto({ chatId: Number(chatId), type: 'photo', media: file.bytes })
      },
      async setChatUsername(chatId, username) {
        await ready()
        await tg.setChatUsername(Number(chatId), username)
      },
      async setJoinRequests(chatId, enabled) {
        await ready()
        await tg.toggleJoinRequests(Number(chatId), enabled)
      },
      async setDefaultPermissions(chatId, change) {
        await ready()
        const chat = await tg.getChat(Number(chatId))
        const perms = chat.defaultPermissions
        if (perms === null) throw new Error('this chat has no member permissions to set')
        // start from what is forbidden now, then apply the change (true allows, false forbids)
        const { _, untilDate, ...current } = perms.raw
        void _
        void untilDate
        const next: Record<string, boolean | undefined> = { ...current }
        const set = (keys: string[], allowed: boolean | undefined): void => {
          if (allowed === undefined) return
          for (const k of keys) next[k] = allowed ? undefined : true
        }
        set(['sendMessages'], change.sendMessages)
        set(['sendMedia'], change.sendMedia)
        set(['sendStickers', 'sendGifs', 'sendGames', 'sendInline'], change.sendStickers)
        set(['sendPolls'], change.sendPolls)
        set(['embedLinks'], change.embedLinks)
        set(['inviteUsers'], change.inviteUsers)
        set(['pinMessages'], change.pinMessages)
        set(['changeInfo'], change.changeInfo)
        set(['manageTopics'], change.manageTopics)
        const restrictions = Object.fromEntries(
          Object.entries(next).filter(([, v]) => v === true),
        ) as Parameters<typeof tg.setChatDefaultPermissions>[1]
        await tg.setChatDefaultPermissions(Number(chatId), restrictions)
      },
      async setSlowMode(chatId, seconds) {
        await ready()
        await tg.setSlowMode(Number(chatId), seconds)
      },
      async setForum(chatId, enabled) {
        await ready()
        await tg.updateForumSettings(
          Number(chatId),
          enabled ? { isForum: true, threadsMode: 'list' } : null,
        )
      },
      async deleteChat(chatId) {
        await ready()
        const chat = await tg.getChat(Number(chatId))
        if (chat.chatType === 'group') await tg.deleteGroup(Number(chatId))
        else await tg.deleteChannel(Number(chatId))
      },
      async setChannelSignatures(chatId, enabled) {
        await ready()
        await tg.call({
          _: 'channels.toggleSignatures',
          channel: await tg.resolveChannel(Number(chatId)),
          ...(enabled ? { signaturesEnabled: true } : {}),
        })
      },
      async linkDiscussionGroup(channelId, groupId) {
        await ready()
        await tg.call({
          _: 'channels.setDiscussionGroup',
          broadcast: await tg.resolveChannel(Number(channelId)),
          group:
            groupId === null
              ? { _: 'inputChannelEmpty' }
              : await tg.resolveChannel(Number(groupId)),
        })
      },
      async addContact(o) {
        await ready()
        const u = await tg.addContact({
          userId: peerRef(o.user),
          firstName: o.firstName,
          ...(o.lastName === undefined ? {} : { lastName: o.lastName }),
          ...(o.phone === undefined ? {} : { phone: o.phone }),
          sharePhone: o.sharePhone,
        })
        return userOf(u)
      },
      async listContacts() {
        await ready()
        return (await tg.getContacts()).map((u) => ({ ...userOf(u), mutual: u.isMutualContact }))
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
      async getMember(chatId, userId) {
        await ready()
        const m = await tg.getChatMember({ chatId: Number(chatId), userId: peerRef(userId) })
        return m === null ? null : memberOf(m)
      },
      async kickMember(chatId, userId) {
        await ready()
        await tg.kickChatMember({ chatId: Number(chatId), userId: peerRef(userId) })
      },
      async setChatTtl(chatId, seconds) {
        await ready()
        await tg.setChatTtl(Number(chatId), seconds)
      },
      async setContentProtection(chatId, enabled) {
        await ready()
        await tg.toggleContentProtection(Number(chatId), enabled)
      },
      async setMembersHidden(chatId, hidden) {
        await ready()
        await tg.call({
          _: 'channels.toggleParticipantsHidden',
          channel: await tg.resolveChannel(Number(chatId)),
          enabled: hidden,
        })
      },
      async setHistoryVisible(chatId, visible) {
        await ready()
        await tg.call({
          _: 'channels.togglePreHistoryHidden',
          channel: await tg.resolveChannel(Number(chatId)),
          enabled: !visible,
        })
      },
      async setReactions(chatId, o) {
        await ready()
        await tg.call({
          _: 'messages.setChatAvailableReactions',
          peer: await tg.resolvePeer(Number(chatId)),
          availableReactions:
            o.mode === 'all'
              ? { _: 'chatReactionsAll' }
              : o.mode === 'none'
                ? { _: 'chatReactionsNone' }
                : {
                    _: 'chatReactionsSome',
                    reactions: (o.emojis ?? []).map((emoticon) => ({
                      _: 'reactionEmoji' as const,
                      emoticon,
                    })),
                  },
        })
      },
      async setDefaultSendAs(chatId, asChatId) {
        await ready()
        await tg.call({
          _: 'messages.saveDefaultSendAs',
          peer: await tg.resolvePeer(Number(chatId)),
          sendAs: await tg.resolvePeer(Number(asChatId)),
        })
      },
      async setTopicPinned(chatId, topicId, pinned) {
        await ready()
        await tg.toggleForumTopicPinned({ chatId: Number(chatId), topicId, pinned })
      },
      async deleteTopic(chatId, topicId) {
        await ready()
        await tg.deleteForumTopicHistory(Number(chatId), topicId)
      },
      async setGeneralHidden(chatId, hidden) {
        await ready()
        await tg.toggleGeneralTopicHidden({ chatId: Number(chatId), hidden })
      },
      async markRead(chatId) {
        await ready()
        await tg.readHistory(Number(chatId))
      },
      async clearHistory(chatId, mode) {
        await ready()
        const chat = await tg.getChat(Number(chatId))
        // supergroups and channels have their own call (deleteHistory covers private chats and basic groups)
        if (chat.chatType !== 'group') {
          await tg.call({
            _: 'channels.deleteHistory',
            channel: await tg.resolveChannel(Number(chatId)),
            maxId: 0,
            ...(mode === 'revoke' ? { forEveryone: true } : {}),
          })
          return
        }
        await tg.deleteHistory(Number(chatId), { mode })
      },
      async pinWithOptions(chatId, id, o) {
        await ready()
        await tg.pinMessage({ chatId: Number(chatId), message: id, notify: o.notify })
      },
      async unpinAll(chatId, topicId) {
        await ready()
        await tg.unpinAllMessages(Number(chatId), topicId === undefined ? {} : { topicId })
      },
      async getPoll(chatId, id) {
        await ready()
        const poll = await tg.getPollResults({ chatId: Number(chatId), message: id })
        return {
          question: poll.question,
          closed: poll.isClosed,
          quiz: poll.isQuiz,
          multiple: poll.isMultiple,
          public: poll.isPublic,
          totalVoters: poll.voters,
          options: poll.answers.map((a) => ({
            text: a.text,
            voters: a.voters,
            ...(poll.isQuiz ? { correct: a.correct } : {}),
            recentVoters: a.recentVoters.map((v) => ({ id: String(v.id), name: peerName(v) })),
          })),
        }
      },
      async stopPoll(chatId, id) {
        await ready()
        await tg.closePoll({ chatId: Number(chatId), message: id })
      },
      async copyMessage(fromChatId, id, toChatId, o) {
        await ready()
        const m = await tg.sendCopy({
          fromChatId: Number(fromChatId),
          message: id,
          toChatId: Number(toChatId),
          ...(o?.topicId === undefined ? {} : { threadId: o.topicId }),
          ...(o?.silent === true ? { silent: true } : {}),
        })
        return { id: m.id }
      },
      async messageStats(chatId, ids) {
        await ready()
        const list = await tg.getMessages(Number(chatId), ids)
        return list.flatMap((m) =>
          m === null
            ? []
            : [
                {
                  id: m.id,
                  ...(m.views === null ? {} : { views: m.views }),
                  ...(m.forwards === null ? {} : { forwards: m.forwards }),
                  ...(m.replies === null ? {} : { replies: m.replies.count }),
                  ...(m.replies === null ? {} : { hasComments: m.replies.hasComments }),
                  reactions: (m.reactions?.reactions ?? []).map((r) => ({
                    emoji: String(r.emoji),
                    count: r.count,
                  })),
                },
              ],
        )
      },
      async commentOnPost(chatId, postId, text) {
        await ready()
        const [post] = await tg.getMessages(Number(chatId), [postId])
        if (post === null || post === undefined) throw new TgRpcError('MSG_ID_INVALID')
        const m = await tg.commentText(post, text, { disableWebPreview: true })
        return { id: m.id }
      },
      async resolveChat(ref) {
        await ready()
        const t = ref
          .trim()
          .replace(/^https?:\/\//i, '')
          .replace(/^(?:www\.)?(?:t|telegram)\.me\//i, '')
          .replace(/^@/, '')
        const username = /^[A-Za-z][A-Za-z0-9_]{3,31}$/.exec(t.split(/[/?]/)[0] ?? '')?.[0]
        if (username === undefined)
          throw new TgRpcError('USERNAME_INVALID', 'not a public username or t.me link')
        const peer = await tg.getPeer(username)
        if (peer.type === 'user') {
          return {
            id: String(peer.id),
            kind: 'user' as const,
            title: peer.displayName,
            ...(peer.username === null ? {} : { username: peer.username }),
          }
        }
        let description: string | undefined
        try {
          const full = await tg.getFullChat(peer.id)
          if (full.bio !== '') description = full.bio
        } catch {
          // the preview works without the description
        }
        return {
          id: String(peer.id),
          kind: chatKindOf(peer),
          title: peer.title,
          ...(peer.username === null ? {} : { username: peer.username }),
          ...(peer.membersCount === null ? {} : { members: peer.membersCount }),
          ...(description === undefined ? {} : { description }),
          joined: peer.isMember,
        }
      },
      async checkInviteLink(link) {
        await ready()
        try {
          const p = await tg.getChatPreview(link)
          return {
            kind: p.type === 'channel' ? ('channel' as const) : ('group' as const),
            title: p.title,
            members: p.memberCount,
            withApproval: p.withApproval,
            joined: false,
          }
        } catch (error) {
          // already a member: mtcute asks to read the chat itself
          if (
            /already|MtPeerNotFound/i.test(
              error instanceof Error ? `${error.name} ${error.message}` : '',
            )
          ) {
            return { kind: 'group' as const, title: '(a chat the account is in)', joined: true }
          }
          throw error
        }
      },
      async chatStats(chatId) {
        await ready()
        const chat = await tg.getChat(Number(chatId))
        const channel = await tg.resolveChannel(Number(chatId))
        const pair = (label: string, v: { current: number; previous: number }): string =>
          `${label}: ${v.current} (before: ${v.previous})`
        if (chat.chatType === 'channel') {
          const st = await tg.call({ _: 'stats.getBroadcastStats', channel })
          return {
            kind: 'channel' as const,
            lines: [
              pair('Followers', st.followers),
              pair('Views per post', st.viewsPerPost),
              pair('Shares per post', st.sharesPerPost),
              pair('Reactions per post', st.reactionsPerPost),
              `Notifications on: ${Math.round((st.enabledNotifications.part / Math.max(1, st.enabledNotifications.total)) * 100)}%`,
            ],
          }
        }
        const st = await tg.call({ _: 'stats.getMegagroupStats', channel })
        return {
          kind: 'group' as const,
          lines: [
            pair('Members', st.members),
            pair('Messages', st.messages),
            pair('Active viewers', st.viewers),
            pair('Active posters', st.posters),
          ],
        }
      },
      async muteChat(chatId, untilMs) {
        await ready()
        const seconds =
          untilMs === null
            ? 0
            : !Number.isFinite(untilMs)
              ? 2_147_483_647
              : Math.min(2_147_483_647, Math.floor(untilMs / 1000))
        await tg.call({
          _: 'account.updateNotifySettings',
          peer: { _: 'inputNotifyPeer', peer: await tg.resolvePeer(Number(chatId)) },
          settings: { _: 'inputPeerNotifySettings', muteUntil: seconds },
        })
      },
      async archiveChat(chatId, archived) {
        await ready()
        if (archived) await tg.archiveChats(Number(chatId))
        else await tg.unarchiveChats(Number(chatId))
      },
      async pinDialog(chatId, pinned) {
        await ready()
        await tg.call({
          _: 'messages.toggleDialogPin',
          peer: { _: 'inputDialogPeer', peer: await tg.resolvePeer(Number(chatId)) },
          pinned,
        })
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
      'primaryInviteLink',
      'listInviteLinks',
      'editInviteLink',
      'revokeInviteLink',
      'listJoinRequests',
      'answerJoinRequests',
      'addMember',
      'setChatTitle',
      'setChatDescription',
      'setChatPhoto',
      'setChatUsername',
      'setJoinRequests',
      'setDefaultPermissions',
      'setSlowMode',
      'setForum',
      'deleteChat',
      'setChannelSignatures',
      'linkDiscussionGroup',
      'getMember',
      'kickMember',
      'setChatTtl',
      'setContentProtection',
      'setMembersHidden',
      'setHistoryVisible',
      'setReactions',
      'setDefaultSendAs',
      'setTopicPinned',
      'deleteTopic',
      'setGeneralHidden',
      'markRead',
      'clearHistory',
      'pinWithOptions',
      'unpinAll',
      'getPoll',
      'stopPoll',
      'copyMessage',
      'messageStats',
      'commentOnPost',
      'chatStats',
      'muteChat',
      'archiveChat',
      'pinDialog',
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
