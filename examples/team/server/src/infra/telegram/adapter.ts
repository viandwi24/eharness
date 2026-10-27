/**
 * The Telegram Bot API transport (docs/plans/P41-team-channels.md, phase L3): a `ChannelAdapter`
 * over grammY. Long polling through the runner (concurrent, ordered per chat), auto-retry for
 * short flood waits, explicit `allowed_updates`, outbound HTML with a strict escaper, inline
 * keyboards for approvals, file download through `getFile` (20 MB cap), the native action catalog.
 *
 * The token is a secret: it is never logged, and every error text that leaves this module is
 * scrubbed (`scrubToken`); Telegram puts the token in the URL of every request.
 */
import { autoRetry } from '@grammyjs/auto-retry'
import { run, sequentialize } from '@grammyjs/runner'
import { Bot, GrammyError, HttpError, InputFile } from 'grammy'
import type { InlineKeyboardButton, InlineKeyboardMarkup, Update } from 'grammy/types'
import { z } from 'zod'
import { reportFailure } from '../channels/governor.ts'
import {
  createJoinRequestStore,
  type JoinRequest,
  type JoinRequestStore,
  type JoinResolution,
} from '../channels/join-requests.ts'
import { plainMentions } from '../channels/mentions.ts'
import {
  type ChannelAdapter,
  type ChannelCapabilities,
  ChannelError,
  type ChannelNode,
  type CopyOptions,
  type EventSink,
  type Identity,
  MEMBER_RIGHTS,
  type MediaKind,
  type MemberRight,
  type ModerationResult,
  type NativeAction,
  type NodeInfo,
  type OutboundButton,
  type OutboundFile,
  type OutboundMessage,
  type SentMessage,
  type TextFormat,
} from '../channels/types.ts'
import { botActions } from './actions.ts'
import { TELEGRAM_BOT_EVENTS } from './events.ts'
import { escapeHtml, htmlChunks, toTelegramHtml } from './format.ts'
import {
  chatNode,
  encodeCallback,
  identityOfUser,
  type NormalizeContext,
  normalizeUpdate,
} from './normalize.ts'

/** Updates the adapter asks for (the default list omits `chat_member` and `message_reaction`). */
export const ALLOWED_UPDATES = [
  'message',
  'edited_message',
  'channel_post',
  'edited_channel_post',
  'callback_query',
  'my_chat_member',
  'chat_member',
  'message_reaction',
  'message_reaction_count',
  'chat_join_request',
] as const

/** The documented native id formats (see `normalize.ts`). */
export const TELEGRAM_ID_FORMATS =
  'private chat `<user id>`; group, supergroup, channel `<chat id>`; forum topic `<chat id>/<topic id>` (General is `/0`); message `<message id>` (unique per chat); person `<user id>`, a chat speaking as itself `chat:<chat id>`'

export const TELEGRAM_CAPABILITIES: ChannelCapabilities = {
  maxTextLength: 4096,
  maxCaptionLength: 1024,
  // `getFile` serves files up to 20 MB
  maxDownloadBytes: 20 * 1024 * 1024,
  reactions: true,
  edit: true,
  delete: true,
  pin: true,
  typing: true,
  quote: true,
  /** The Bot API has no history method. */
  history: false,
  /** Administrators only (`getChatAdministrators`); the Bot API cannot list all members. */
  members: true,
  membersScope: 'admins',
  upload: true,
  buttons: true,
  /** `<a href="tg://user?id=...">` mentions by user id: they ping people who have no username. */
  mentions: 'id',
  deletions: 'none',
}

/** What the bot can do in one node: a private chat has no member list, a channel no typing. */
export function telegramCapabilitiesOf(node: ChannelNode): ChannelCapabilities {
  return {
    ...TELEGRAM_CAPABILITIES,
    ...(node.kind === 'direct' ? { members: false } : {}),
    ...(node.traits.broadcast ? { typing: false } : {}),
  }
}

/** Setup problems the UI can explain and sometimes fix. */
export class TelegramSetupError extends Error {
  readonly code: 'webhook-set' | 'unauthorized'
  readonly webhookUrl: string | undefined
  constructor(code: 'webhook-set' | 'unauthorized', message: string, webhookUrl?: string) {
    super(message)
    this.name = 'TelegramSetupError'
    this.code = code
    this.webhookUrl = webhookUrl
  }
}

/** Replace every place the token (or a `bot<id>:<secret>` URL part) could appear. */
export function scrubToken(text: string, token?: string): string {
  let out = text
  if (token !== undefined && token.length > 6) out = out.split(token).join('***')
  return out
    .replace(/bot\d{5,}:[A-Za-z0-9_-]{20,}/g, 'bot***')
    .replace(/\b\d{6,}:[A-Za-z0-9_-]{30,}\b/g, '***')
}

/** What an adapter error means for the outbound queue. Never contains the token. */
export function mapTelegramError(error: unknown, token?: string): ChannelError {
  if (error instanceof ChannelError) return error
  if (error instanceof GrammyError) {
    const message = scrubToken(error.description, token)
    const code = error.error_code
    if (code === 429) {
      const after = error.parameters?.retry_after
      return new ChannelError(
        'rate_limit',
        `Telegram asked to slow down: ${message}`,
        (typeof after === 'number' ? after : 5) * 1000,
      )
    }
    if (code === 401)
      return new ChannelError('fatal', `Telegram rejected the bot token: ${message}`)
    if (code === 403) {
      return new ChannelError(
        'invalid',
        /initiate|blocked|deactivated/i.test(message)
          ? `${message}. The person has to open the bot and press Start first.`
          : message,
      )
    }
    if (code === 409) return new ChannelError('transient', message)
    if (code >= 500) return new ChannelError('transient', message)
    return new ChannelError('invalid', message)
  }
  if (error instanceof HttpError) {
    return new ChannelError(
      'transient',
      `Could not reach Telegram: ${scrubToken(String(error.message), token)}`,
    )
  }
  const text = scrubToken(error instanceof Error ? error.message : String(error), token)
  return new ChannelError('transient', text)
}

export interface TelegramBotInfo {
  id: number
  username: string
  name: string
  canReadAllGroupMessages: boolean
  canJoinGroups: boolean
}

export type TelegramFailure = { kind: 'auth' | 'conflict' | 'other'; message: string }

export interface TelegramAdapterOptions {
  connectionId: string
  token: string
  /** Bot API root (default `https://api.telegram.org`); a local Bot API server or a test fake. */
  apiRoot?: string
  /** Fetch of file downloads (default global). */
  fetch?: typeof fetch
  /** A webhook is set on the bot: `refuse` (default) fails the start, `delete` removes it. */
  onWebhook?: 'refuse' | 'delete'
  /** Long-poll timeout in seconds (default 30; tests use 1). */
  pollTimeoutSec?: number
  /** Longest flood wait auto-retry waits for itself (seconds, default 5); longer ones go to the outbox. */
  maxRetryDelaySec?: number
  /**
   * Where pending join requests are kept (default: memory). The app passes the durable store, so a
   * restart loses none and `join_requests` reads what the events announced.
   */
  joinRequests?: JoinRequestStore
  hooks?: {
    /** The runner stopped on its own (bad token, another poller, ...). */
    onFailure?(failure: TelegramFailure): void
    warn?(message: string): void
  }
}

export interface TelegramAdapter extends ChannelAdapter {
  /** The bot as `getMe` reported it (after `start`). */
  info(): TelegramBotInfo | undefined
  /** `getMe` and the webhook state, without starting to poll. */
  probe(): Promise<{ bot: TelegramBotInfo; webhookUrl: string | undefined }>
}

const chatArg = (value: string): number | string => (/^-?\d+$/.test(value) ? Number(value) : value)

/** The chat and topic a node stands for: a topic is a child of its forum, General (`0`) has no thread id. */
export function targetOf(node: ChannelNode): { chat: string; topic: number | undefined } {
  const metaChat = node.meta.chatId
  const chat =
    typeof metaChat === 'string'
      ? metaChat
      : node.kind === 'thread'
        ? (node.parentNativeId ?? node.nativeId.split('/')[0] ?? node.nativeId)
        : node.nativeId
  if (node.kind !== 'thread') return { chat, topic: undefined }
  const topic = Number(
    typeof node.meta.topicId === 'number' ? node.meta.topicId : node.nativeId.split('/')[1],
  )
  return { chat, topic: Number.isFinite(topic) && topic !== 0 ? topic : undefined }
}

const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp'])

/** Generic member rights as Bot API permissions (every other one switched off). */
const BOT_RIGHTS: Record<MemberRight, string[]> = {
  send_messages: ['can_send_messages'],
  send_media: [
    'can_send_audios',
    'can_send_documents',
    'can_send_photos',
    'can_send_videos',
    'can_send_video_notes',
    'can_send_voice_notes',
  ],
  send_polls: ['can_send_polls'],
  send_other: ['can_send_other_messages'],
  add_link_previews: ['can_add_web_page_previews'],
  invite_users: ['can_invite_users'],
  pin_messages: ['can_pin_messages'],
  change_info: ['can_change_info'],
  manage_topics: ['can_manage_topics'],
}
const botPermissions = (allow: readonly MemberRight[]): Record<string, boolean> => {
  const out: Record<string, boolean> = { can_react_to_messages: allow.length > 0 }
  for (const [right, perms] of Object.entries(BOT_RIGHTS) as Array<[MemberRight, string[]]>)
    for (const p of perms) out[p] = allow.includes(right)
  return out
}

/** Telegram HTML as plain text. */
const stripHtml = (html: string): string =>
  html
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')

export function createTelegramAdapter(options: TelegramAdapterOptions): TelegramAdapter {
  const { token } = options
  const warn = (m: string): void => (options.hooks?.warn ?? (() => undefined))(scrubToken(m, token))
  const apiRoot = (options.apiRoot ?? 'https://api.telegram.org').replace(/\/$/, '')
  const bot = new Bot(token, { client: { apiRoot } })
  bot.api.config.use(
    autoRetry({
      maxRetryAttempts: 2,
      maxDelaySeconds: options.maxRetryDelaySec ?? 5,
    }),
  )
  const doFetch = options.fetch ?? fetch
  let botInfo: TelegramBotInfo | undefined
  const joinRequests = options.joinRequests ?? createJoinRequestStore()
  let currentSink: EventSink | undefined
  /** A join request this bot answered: the gateway hears it as `member.join_request_resolved`. */
  const joinResolved = (r: JoinRequest, resolution: JoinResolution): void => {
    const sinkNow = currentSink
    if (sinkNow === undefined) return
    const room = chatNode({ id: Number(r.chatId), type: 'supergroup', title: r.chatTitle })
    void sinkNow({
      type: 'member.join_request_resolved',
      dedupeKey: `tg:jr-resolved:${r.chatId}:${r.userId}:${r.at}:${resolution}`,
      at: Date.now(),
      node: { nativeId: room.nativeId, chain: [room] },
      actor: {
        id: r.userId,
        name: r.name,
        ...(r.username === undefined ? {} : { username: r.username }),
      },
      resolution,
      bySelf: true,
    }).catch((error: unknown) =>
      warn(`telegram ${options.connectionId}: join request event failed: ${String(error)}`),
    )
  }
  let handle: ReturnType<typeof run> | undefined
  let stopping = false
  const sent = new Map<string, SentMessage>()
  const remember = (key: string | undefined, result: SentMessage): SentMessage => {
    if (key !== undefined) {
      sent.set(key, result)
      if (sent.size > 500) sent.delete(sent.keys().next().value as string)
    }
    return result
  }

  const guard = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn()
    } catch (error) {
      throw mapTelegramError(error, token)
    }
  }

  const infoOf = (me: {
    id: number
    username?: string
    first_name: string
    can_read_all_group_messages?: boolean
    can_join_groups?: boolean
  }): TelegramBotInfo => ({
    id: me.id,
    username: me.username ?? '',
    name: me.first_name,
    canReadAllGroupMessages: me.can_read_all_group_messages === true,
    canJoinGroups: me.can_join_groups !== false,
  })

  async function probe(): Promise<{ bot: TelegramBotInfo; webhookUrl: string | undefined }> {
    const me = await guard(() => bot.api.getMe())
    const hook = await guard(() => bot.api.getWebhookInfo())
    botInfo = infoOf(me)
    return { bot: botInfo, webhookUrl: hook.url === '' ? undefined : hook.url }
  }

  const selfIdentity = (): Identity => ({
    id: String(botInfo?.id ?? 0),
    name: botInfo?.name ?? 'Telegram bot',
    ...(botInfo?.username === undefined ? {} : { username: botInfo.username }),
    isBot: true,
    isSelf: true,
  })

  /** Download a file by id; the 20 MB cap holds before and after the request. */
  async function download(
    fileId: string,
    size: number | undefined,
  ): Promise<{ bytes: Uint8Array }> {
    const cap = TELEGRAM_CAPABILITIES.maxDownloadBytes as number
    if (size !== undefined && size > cap) {
      throw new ChannelError(
        'invalid',
        `the file is ${size} bytes; Telegram bots can download up to ${cap}`,
      )
    }
    const file = await guard(() => bot.api.getFile(fileId))
    if (file.file_path === undefined)
      throw new ChannelError('invalid', 'Telegram gave no path for the file')
    if (file.file_size !== undefined && file.file_size > cap) {
      throw new ChannelError(
        'invalid',
        `the file is ${file.file_size} bytes; Telegram bots can download up to ${cap}`,
      )
    }
    try {
      const response = await doFetch(`${apiRoot}/file/bot${token}/${file.file_path}`)
      if (!response.ok)
        throw new ChannelError('transient', `download failed (HTTP ${response.status})`)
      const bytes = new Uint8Array(await response.arrayBuffer())
      if (bytes.byteLength > cap) throw new ChannelError('invalid', `the file is over ${cap} bytes`)
      return { bytes }
    } catch (error) {
      throw mapTelegramError(error, token)
    }
  }

  const normalizeContext = (): NormalizeContext => ({
    botId: botInfo?.id ?? 0,
    botUsername: botInfo?.username ?? '',
    download,
  })

  // --- outbound --------------------------------------------------------------------------------

  const keyboard = (buttons: readonly OutboundButton[]): InlineKeyboardMarkup => {
    const rows = new Map<number, InlineKeyboardButton[]>()
    for (const b of buttons) {
      const row = rows.get(b.row ?? 0) ?? []
      row.push(
        b.url === undefined
          ? { text: b.label, callback_data: encodeCallback(b.name, b.data) }
          : { text: b.label, url: b.url },
      )
      rows.set(b.row ?? 0, row)
    }
    return { inline_keyboard: [...rows.entries()].sort((a, b) => a[0] - b[0]).map(([, r]) => r) }
  }
  const markup = (message: OutboundMessage) =>
    message.buttons === undefined || message.buttons.length === 0
      ? undefined
      : keyboard(message.buttons)

  /** HTML first; when Telegram cannot parse the entities, the same text goes out plain. */
  async function withHtml<T>(html: () => Promise<T>, plain: () => Promise<T>): Promise<T> {
    try {
      return await html()
    } catch (error) {
      if (
        error instanceof GrammyError &&
        error.error_code === 400 &&
        /parse entities|can't parse/i.test(error.description)
      ) {
        return await plain()
      }
      throw error
    }
  }

  /** The text as Telegram HTML in the format it was written in. */
  const htmlOf = (text: string, format: TextFormat | undefined): string =>
    format === 'html' ? text : format === 'plain' ? escapeHtml(text) : toTelegramHtml(text)
  /** The same text without markup (the fallback when Telegram cannot parse the HTML). */
  const plainOf = (text: string, format: TextFormat | undefined): string =>
    format === 'html' ? stripHtml(text) : plainMentions(text)
  /** Message-sized HTML parts. */
  function chunksOf(text: string, format: TextFormat | undefined): string[] {
    const max = TELEGRAM_CAPABILITIES.maxTextLength as number
    if (format === 'html') {
      if (text.length > max)
        throw new ChannelError('invalid', `HTML text is longer than ${max} characters: split it`)
      return [text]
    }
    if (format === 'plain') {
      const out: string[] = []
      for (let i = 0; i < text.length; i += 3500) out.push(escapeHtml(text.slice(i, i + 3500)))
      return out
    }
    return htmlChunks(text, max)
  }

  /** How a file goes out: the kind the caller asked for, else what its media type suggests. */
  const kindOf = (f: OutboundFile): MediaKind => {
    if (f.media !== undefined) return f.media
    if (f.mediaType === 'image/gif') return 'animation'
    if (IMAGE_TYPES.has(f.mediaType)) return 'photo'
    if (f.mediaType.startsWith('audio/')) return 'audio'
    if (f.mediaType === 'video/mp4') return 'video'
    return 'document'
  }
  /** Stickers and video notes carry no caption. */
  const takesCaption = (k: MediaKind): boolean => k !== 'sticker' && k !== 'video_note'
  /** Which files may share an album: photos with videos, documents, or audio. */
  const albumClass = (k: MediaKind): string | undefined =>
    k === 'photo' || k === 'video'
      ? 'visual'
      : k === 'document'
        ? 'document'
        : k === 'audio'
          ? 'audio'
          : undefined

  async function sendFiles(
    node: ChannelNode,
    message: OutboundMessage,
    files: OutboundFile[],
    common: Record<string, unknown>,
  ): Promise<SentMessage> {
    const chat = chatArg(targetOf(node).chat)
    const html = message.text === '' ? '' : htmlOf(message.text, message.format)
    const captionOk = html.length <= (TELEGRAM_CAPABILITIES.maxCaptionLength as number)
    const input = (f: OutboundFile): InputFile | string => {
      if (f.ref !== undefined && f.ref !== '') return f.ref
      if (f.bytes === undefined)
        throw new ChannelError('invalid', `${f.name} has no bytes and no reference`)
      return new InputFile(f.bytes, f.name)
    }
    const kinds = files.map(kindOf)
    const captionAt = html !== '' && captionOk ? kinds.findIndex(takesCaption) : -1
    const ids: string[] = []
    const classes = kinds.map(albumClass)
    const albumable =
      files.length >= 2 && classes[0] !== undefined && classes.every((c) => c === classes[0])
    if (albumable) {
      for (let start = 0; start < files.length; start += 10) {
        const media = files.slice(start, start + 10).map((f, j) => {
          const i = start + j
          return {
            type: kinds[i] as 'photo' | 'video' | 'document' | 'audio',
            media: input(f),
            ...(i === captionAt ? { caption: html, parse_mode: 'HTML' as const } : {}),
          }
        })
        const result = await withHtml(
          () =>
            bot.api.sendMediaGroup(chat, media as never, start === 0 ? common : threadOf(common)),
          () =>
            bot.api.sendMediaGroup(
              chat,
              media.map((m, j) =>
                start + j === captionAt
                  ? {
                      type: m.type,
                      media: m.media,
                      caption: plainOf(message.text, message.format).slice(0, 1024),
                    }
                  : { type: m.type, media: m.media },
              ) as never,
              start === 0 ? common : threadOf(common),
            ),
        )
        for (const r of result) ids.push(String(r.message_id))
      }
    } else {
      for (const [i, f] of files.entries()) {
        const kind = kinds[i] as MediaKind
        const keyboard = i === files.length - 1 ? markup(message) : undefined
        const base = {
          ...(i === 0 ? common : threadOf(common)),
          ...(keyboard === undefined ? {} : { reply_markup: keyboard }),
        }
        const opts = {
          ...base,
          ...(i === captionAt ? { caption: html, parse_mode: 'HTML' as const } : {}),
        }
        const plainOpts = {
          ...base,
          ...(i === captionAt
            ? { caption: plainOf(message.text, message.format).slice(0, 1024) }
            : {}),
        }
        const file = input(f)
        const sendOne = (o: Record<string, unknown>): Promise<{ message_id: number }> => {
          switch (kind) {
            case 'photo':
              return bot.api.sendPhoto(chat, file, o)
            case 'video':
              return bot.api.sendVideo(chat, file, o)
            case 'animation':
              return bot.api.sendAnimation(chat, file, o)
            case 'voice':
              return bot.api.sendVoice(chat, file, o)
            case 'video_note':
              return bot.api.sendVideoNote(chat, file, o)
            case 'audio':
              return bot.api.sendAudio(chat, file, o)
            case 'sticker':
              return bot.api.sendSticker(chat, file, o)
            default:
              return bot.api.sendDocument(chat, file, o)
          }
        }
        const result = await withHtml(
          () => sendOne(opts),
          () => sendOne(plainOpts),
        )
        ids.push(String(result.message_id))
      }
    }
    if (html !== '' && captionAt < 0) {
      // no file takes a caption (stickers, video notes) or it grew over the limit: the text follows
      for (const part of chunksOf(message.text, message.format)) {
        const r = await withHtml(
          () =>
            bot.api.sendMessage(chat, part, {
              ...threadOf(common),
              parse_mode: 'HTML',
              link_preview_options: { is_disabled: message.linkPreview !== true },
            }),
          () => bot.api.sendMessage(chat, stripHtml(part), threadOf(common)),
        )
        ids.push(String(r.message_id))
      }
    }
    return { nativeId: ids[0] as string, ...(ids.length > 1 ? { nativeIds: ids } : {}) }
  }

  /** Only the topic of the common options (later parts of one message are no replies). */
  const threadOf = (common: Record<string, unknown>): Record<string, unknown> => ({
    ...(common.message_thread_id === undefined
      ? {}
      : { message_thread_id: common.message_thread_id }),
    ...(common.disable_notification === undefined
      ? {}
      : { disable_notification: common.disable_notification }),
  })

  async function editCaption(
    chat: string,
    nativeId: string,
    text: string,
    format: TextFormat | undefined,
  ): Promise<void> {
    const html = text === '' ? '' : htmlOf(text, format)
    try {
      await withHtml(
        () =>
          bot.api.editMessageCaption(
            chatArg(chat),
            Number(nativeId),
            html === '' ? {} : { caption: html, parse_mode: 'HTML' as const },
          ),
        () =>
          bot.api.editMessageCaption(chatArg(chat), Number(nativeId), {
            caption: plainOf(text, format).slice(0, 1024),
          }),
      )
    } catch (error) {
      if (error instanceof GrammyError && /not modified/i.test(error.description)) return
      throw error
    }
  }

  /** Copies keep albums together (Telegram groups copied album items again). */
  async function copyTo(
    from: ChannelNode,
    nativeIds: string[],
    to: ChannelNode,
    o: CopyOptions,
  ): Promise<string[]> {
    const source = chatArg(targetOf(from).chat)
    const target = targetOf(to)
    const extra: Record<string, unknown> = {
      ...(target.topic === undefined ? {} : { message_thread_id: target.topic }),
      ...(o.silent === true ? { disable_notification: true } : {}),
    }
    const ids = nativeIds.map(Number).sort((a, b) => a - b)
    const reply =
      o.replyTo === undefined
        ? {}
        : { reply_parameters: { message_id: Number(o.replyTo), allow_sending_without_reply: true } }
    if (o.forward === true) {
      if (ids.length === 1) {
        const r = await bot.api.forwardMessage(
          chatArg(target.chat),
          source,
          ids[0] as number,
          extra,
        )
        return [String(r.message_id)]
      }
      const r = await bot.api.forwardMessages(chatArg(target.chat), source, ids, extra)
      return r.map((m) => String(m.message_id))
    }
    if (ids.length === 1) {
      const r = await bot.api.copyMessage(chatArg(target.chat), source, ids[0] as number, {
        ...extra,
        ...reply,
        ...(o.dropCaptions === true ? { caption: '' } : {}),
      })
      return [String(r.message_id)]
    }
    const r = await bot.api.copyMessages(chatArg(target.chat), source, ids, {
      ...extra,
      ...(o.dropCaptions === true ? { remove_caption: true } : {}),
    })
    return r.map((m) => String(m.message_id))
  }

  async function send(node: ChannelNode, message: OutboundMessage): Promise<SentMessage> {
    const done = message.sendTxnId === undefined ? undefined : sent.get(message.sendTxnId)
    if (done !== undefined) return done
    return guard(async () => {
      const target = targetOf(node)
      const chat = chatArg(target.chat)
      const thread = target.topic
      const common: Record<string, unknown> = {
        ...(thread === undefined ? {} : { message_thread_id: thread }),
        ...(message.silent === true ? { disable_notification: true } : {}),
        ...(message.replyTo === undefined
          ? {}
          : {
              reply_parameters: {
                message_id: Number(message.replyTo),
                allow_sending_without_reply: true,
              },
            }),
      }
      if (message.files !== undefined && message.files.length > 0) {
        return remember(message.sendTxnId, await sendFiles(node, message, message.files, common))
      }
      if (message.text.trim() === '') throw new ChannelError('invalid', 'there is nothing to send')
      const parts = chunksOf(message.text, message.format)
      const plainText = plainOf(message.text, message.format)
      const plainParts = parts.length === 1 ? [plainText.slice(0, 4096)] : undefined
      const ids: string[] = []
      for (const [i, html] of parts.entries()) {
        const last = i === parts.length - 1
        const keyboard = last ? markup(message) : undefined
        const extra = {
          ...(i === 0 ? common : threadOf(common)),
          ...(keyboard === undefined ? {} : { reply_markup: keyboard }),
        }
        const result = await withHtml(
          () =>
            bot.api.sendMessage(chat, html, {
              ...extra,
              parse_mode: 'HTML',
              link_preview_options: { is_disabled: message.linkPreview !== true },
            }),
          () =>
            bot.api.sendMessage(
              chat,
              plainParts?.[0] ?? plainText.slice(i * 4000, (i + 1) * 4000),
              extra,
            ),
        )
        ids.push(String(result.message_id))
      }
      return remember(message.sendTxnId, {
        nativeId: ids[0] as string,
        ...(ids.length > 1 ? { nativeIds: ids } : {}),
      })
    })
  }

  /** A node of this chat as the Bot API describes it (`getChat`). */
  const infoOfChat = async (chatId: string): Promise<NodeInfo | undefined> => {
    const chat = await guard(() => bot.api.getChat(chatArg(chatId)))
    const base = chatNode(chat as never)
    const linked = (chat as { linked_chat_id?: number }).linked_chat_id
    const description = (chat as { description?: string }).description
    return {
      ...base,
      meta: {
        ...(base.meta ?? {}),
        ...(description === undefined ? {} : { description }),
        ...(linked === undefined ? {} : { linkedChatId: String(linked) }),
      },
      ...(linked === undefined
        ? {}
        : { links: [{ rel: 'discussion_of' as const, to: String(linked) }] }),
    }
  }

  const adapter: TelegramAdapter = {
    platform: 'telegram',
    connectionId: options.connectionId,
    idFormats: TELEGRAM_ID_FORMATS,
    self: selfIdentity,
    info: () => botInfo,
    probe,
    getCapabilities: telegramCapabilitiesOf,
    async getNodeInfo(nativeId) {
      const chat = nativeId.split('/')[0] as string
      const info = await infoOfChat(chat)
      return info === undefined || nativeId === chat ? info : undefined
    },
    async getIdentityInfo(nativeId) {
      if (!/^\d+$/.test(nativeId)) return undefined
      const chat = await guard(() => bot.api.getChat(Number(nativeId)))
      if (chat.type !== 'private') return undefined
      return identityOfUser(
        {
          id: chat.id,
          is_bot: false,
          first_name: chat.first_name ?? '',
          ...(chat.last_name === undefined ? {} : { last_name: chat.last_name }),
          ...(chat.username === undefined ? {} : { username: chat.username }),
        },
        botInfo?.id ?? 0,
      )
    },
    async start(sink: EventSink) {
      stopping = false
      currentSink = sink
      const { bot: me, webhookUrl } = await probe()
      void me
      if (webhookUrl !== undefined) {
        if (options.onWebhook === 'delete') {
          await guard(() => bot.api.deleteWebhook({ drop_pending_updates: false }))
        } else {
          throw new TelegramSetupError(
            'webhook-set',
            'A webhook is set on this bot, so polling would get nothing. Remove the webhook to let this app poll.',
            webhookUrl,
          )
        }
      }
      await bot.init()
      bot.use(sequentialize((ctx) => String(ctx.chat?.id ?? ctx.from?.id ?? 'none')))
      bot.use(async (ctx) => {
        const join = (ctx.update as Update).chat_join_request
        if (join !== undefined) {
          // held for the agent (`telegram_join_requests`), and seen by the gateway as a chat event
          joinRequests.note({
            chatId: String(join.chat.id),
            chatTitle:
              'title' in join.chat && join.chat.title !== undefined
                ? join.chat.title
                : String(join.chat.id),
            userId: String(join.from.id),
            name: [join.from.first_name, join.from.last_name].filter(Boolean).join(' '),
            ...(join.from.username === undefined ? {} : { username: join.from.username }),
            ...(join.bio === undefined || join.bio === '' ? {} : { bio: join.bio }),
            ...(join.invite_link === undefined ? {} : { link: join.invite_link.invite_link }),
            at: join.date * 1000,
          })
        }
        // somebody else approved the request in the app: the person is a member now
        const member = (ctx.update as Update).chat_member
        if (member !== undefined) {
          const st = member.new_chat_member.status
          const pending = joinRequests.get(
            String(member.chat.id),
            String(member.new_chat_member.user.id),
          )
          if (
            pending !== undefined &&
            (st === 'member' || st === 'administrator' || st === 'creator')
          ) {
            const r = joinRequests.resolve(
              pending.chatId,
              pending.userId,
              'approved',
              'another admin',
            )
            if (r !== undefined && currentSink !== undefined) {
              const room = chatNode(member.chat)
              await currentSink({
                type: 'member.join_request_resolved',
                dedupeKey: `tg:jr-resolved:${r.chatId}:${r.userId}:${r.at}:approved`,
                at: member.date * 1000,
                node: { nativeId: room.nativeId, chain: [room] },
                actor: {
                  id: r.userId,
                  name: r.name,
                  ...(r.username === undefined ? {} : { username: r.username }),
                },
                resolution: 'approved',
                bySelf: false,
              })
            }
          }
        }
        const normalized = normalizeUpdate(ctx.update as Update, normalizeContext())
        if (normalized.callbackId !== undefined) {
          // stop the spinner on the button at once; the answer to the person is a message
          await bot.api.answerCallbackQuery(normalized.callbackId).catch(() => undefined)
        }
        for (const event of normalized.events) await sink(event)
      })
      bot.catch((error) =>
        warn(`telegram ${options.connectionId}: an update failed: ${String(error.error)}`),
      )
      handle = run(bot, {
        runner: {
          fetch: {
            allowed_updates: [...ALLOWED_UPDATES],
            timeout: options.pollTimeoutSec ?? 30,
          },
        },
      })
      void handle
        .task()
        ?.then(() => undefined)
        .catch((error: unknown) => {
          if (stopping) return
          const mapped = mapTelegramError(error, token)
          const kind =
            mapped.kind === 'fatal'
              ? 'auth'
              : error instanceof GrammyError && error.error_code === 409
                ? 'conflict'
                : 'other'
          options.hooks?.onFailure?.({ kind, message: mapped.message })
        })
    },
    async stop() {
      stopping = true
      const h = handle
      handle = undefined
      if (h?.isRunning()) await h.stop().catch(() => undefined)
    },
    send,
    async edit(node, nativeId, text, format) {
      const { chat } = targetOf(node)
      await guard(async () => {
        const html = chunksOf(text, format)[0] ?? ''
        try {
          await withHtml(
            () =>
              bot.api.editMessageText(chatArg(chat), Number(nativeId), html, {
                parse_mode: 'HTML',
                reply_markup: { inline_keyboard: [] },
                link_preview_options: { is_disabled: true },
              }),
            () =>
              bot.api.editMessageText(
                chatArg(chat),
                Number(nativeId),
                plainOf(text, format).slice(0, 4096),
                { reply_markup: { inline_keyboard: [] } },
              ),
          )
        } catch (error) {
          if (error instanceof GrammyError && /not modified/i.test(error.description)) return
          // a message with a file has a caption, not a text
          if (error instanceof GrammyError && /no text in the message/i.test(error.description))
            return editCaption(chat, nativeId, text, format)
          throw error
        }
      })
    },
    async editButtons(node, nativeId, buttons) {
      try {
        await guard(() =>
          bot.api.editMessageReplyMarkup(chatArg(targetOf(node).chat), Number(nativeId), {
            reply_markup:
              buttons.length === 0 ? { inline_keyboard: [] } : (keyboard(buttons) as never),
          }),
        )
      } catch (error) {
        if (error instanceof ChannelError && /not modified/i.test(error.message)) return
        throw error
      }
    },
    async editCaption(node, nativeId, text, format) {
      await guard(() => editCaption(targetOf(node).chat, nativeId, text, format))
    },
    async delete(node, nativeId) {
      await guard(() => bot.api.deleteMessage(chatArg(targetOf(node).chat), Number(nativeId)))
    },
    async deleteMany(node, nativeIds) {
      const chat = chatArg(targetOf(node).chat)
      // at most 100 per call
      for (let i = 0; i < nativeIds.length; i += 100) {
        const ids = nativeIds.slice(i, i + 100).map(Number)
        await guard(() => bot.api.deleteMessages(chat, ids))
      }
    },
    async copy(from, nativeIds, to, o) {
      return guard(() => copyTo(from, nativeIds, to, o))
    },
    async moderate(node, op) {
      const chat = chatArg(targetOf(node).chat)
      const until = (ms: number | undefined): Record<string, number> =>
        ms === undefined ? {} : { until_date: Math.floor(ms / 1000) }
      return guard(async (): Promise<ModerationResult> => {
        switch (op.action) {
          case 'ban':
            await bot.api.banChatMember(chat, Number(op.user), {
              ...until(op.untilMs),
              ...(op.deleteMessages === true ? { revoke_messages: true } : {}),
            })
            return {}
          case 'unban':
            await bot.api.unbanChatMember(chat, Number(op.user), { only_if_banned: true })
            return {}
          case 'kick':
            await bot.api.banChatMember(chat, Number(op.user))
            await bot.api.unbanChatMember(chat, Number(op.user), { only_if_banned: true })
            return {}
          case 'mute':
          case 'unmute':
          case 'restrict': {
            const allow: readonly MemberRight[] =
              op.action === 'mute' ? [] : op.action === 'unmute' ? MEMBER_RIGHTS : op.allow
            await bot.api.restrictChatMember(
              chat,
              Number(op.user),
              botPermissions(allow) as never,
              {
                ...(op.action === 'unmute' ? {} : until(op.untilMs)),
                use_independent_chat_permissions: true,
              },
            )
            return {}
          }
          case 'approve_join':
          case 'decline_join': {
            if (op.action === 'approve_join')
              await bot.api.approveChatJoinRequest(chat, Number(op.user))
            else await bot.api.declineChatJoinRequest(chat, Number(op.user))
            const resolution: JoinResolution =
              op.action === 'approve_join' ? 'approved' : 'declined'
            const r = joinRequests.resolve(String(chat), op.user, resolution, 'this bot')
            if (r !== undefined) joinResolved(r, resolution)
            return {}
          }
          case 'delete_member_messages':
            throw new ChannelError(
              'invalid',
              'a bot cannot delete everything a person wrote (ban with deleteMessages does it)',
            )
          case 'member': {
            const m = (await bot.api.getChatMember(chat, Number(op.user))) as unknown as {
              status: string
              until_date?: number
              user: { first_name?: string; last_name?: string; username?: string }
            } & Record<string, unknown>
            const status =
              m.status === 'creator'
                ? 'owner'
                : m.status === 'administrator'
                  ? 'admin'
                  : m.status === 'kicked'
                    ? 'banned'
                    : m.status === 'restricted'
                      ? 'restricted'
                      : m.status === 'left'
                        ? 'left'
                        : 'member'
            const name = [m.user.first_name, m.user.last_name].filter(Boolean).join(' ')
            const allow =
              status === 'restricted'
                ? (Object.entries(BOT_RIGHTS) as Array<[MemberRight, string[]]>)
                    .filter(([, perms]) => perms.every((p) => m[p] === true))
                    .map(([r]) => r)
                : undefined
            return {
              member: {
                status,
                ...(name === '' ? {} : { name }),
                ...(m.user.username === undefined ? {} : { username: m.user.username }),
                ...(m.until_date === undefined || m.until_date === 0
                  ? {}
                  : { until: m.until_date * 1000 }),
                ...(allow === undefined ? {} : { allow }),
              },
            }
          }
          case 'invite_link': {
            const link = await bot.api.createChatInviteLink(chat, {
              ...(op.name === undefined ? {} : { name: op.name.slice(0, 32) }),
              ...(op.expiresAt === undefined
                ? {}
                : { expire_date: Math.floor(op.expiresAt / 1000) }),
              ...(op.joinRequest === true
                ? { creates_join_request: true }
                : op.memberLimit === undefined
                  ? {}
                  : { member_limit: op.memberLimit }),
            })
            return { link: link.invite_link }
          }
        }
      })
    },
    async pin(node, nativeId, pinned) {
      const { chat } = targetOf(node)
      await guard(() =>
        pinned
          ? bot.api.pinChatMessage(chatArg(chat), Number(nativeId), {
              disable_notification: true,
            })
          : bot.api.unpinChatMessage(chatArg(chat), Number(nativeId)),
      )
    },
    async react(node, nativeId, emoji, custom) {
      const chat = chatArg(targetOf(node).chat)
      const reaction =
        custom === undefined
          ? [{ type: 'emoji' as const, emoji: emoji as never }]
          : [{ type: 'custom_emoji' as const, custom_emoji_id: custom.customEmojiId }]
      try {
        await guard(() => bot.api.setMessageReaction(chat, Number(nativeId), reaction))
      } catch (error) {
        // a bot may not use custom emoji where the chat does not allow it: the plain emoji instead
        if (custom === undefined || emoji === '' || !(error instanceof ChannelError)) throw error
        await guard(() =>
          bot.api.setMessageReaction(chat, Number(nativeId), [
            { type: 'emoji', emoji: emoji as never },
          ]),
        )
      }
    },
    async typing(node) {
      const { chat, topic } = targetOf(node)
      await guard(() =>
        bot.api.sendChatAction(
          chatArg(chat),
          'typing',
          topic === undefined ? {} : { message_thread_id: topic },
        ),
      )
    },
    async listMembers(node, opts) {
      const admins = await guard(() => bot.api.getChatAdministrators(chatArg(targetOf(node).chat)))
      return {
        scope: 'admins' as const,
        members: admins.slice(0, opts.limit).map((a) => ({
          id: String(a.user.id),
          name: [a.user.first_name, a.user.last_name].filter(Boolean).join(' '),
          ...(a.user.username === undefined ? {} : { username: a.user.username }),
          ...(a.user.is_bot ? { isBot: true, kind: 'bot' as const } : {}),
          // `creator` is the owner of the chat; an administrator may carry a custom title
          role: a.status === 'creator' ? ('owner' as const) : ('admin' as const),
          ...(a.status === 'administrator' && a.custom_title !== undefined && a.custom_title !== ''
            ? { title: a.custom_title }
            : {}),
        })),
      }
    },
    status: (node) => ({
      readsEverything: botInfo?.canReadAllGroupMessages === true,
      notes:
        node.kind === 'direct'
          ? []
          : [
              botInfo?.canReadAllGroupMessages === true
                ? 'privacy mode is off: this bot receives every message of the groups it is in'
                : 'privacy mode is on: without admin rights this bot receives only @mentions, replies to it and commands; as an administrator it receives every message',
            ],
    }),
    openDirect: (identityNativeId) => ({
      nativeId: identityNativeId,
      kind: 'direct',
      platformType: 'telegram:private',
      traits: { multiUser: false, threading: 'none' },
      meta: { chatId: identityNativeId },
    }),
    childNativeId: (parent, key) => `${parent.nativeId}/${key}`,
    // a logged attachment keeps its file_id (`ref`): the bot downloads it again any time
    async fetchAttachment(_node, _messageNativeId, attachmentId, ref) {
      const fileId = ref ?? attachmentId
      const got = await download(fileId, undefined)
      return { bytes: got.bytes }
    },
    actions: nativeActions(bot, token, joinRequests, joinResolved),
    events: TELEGRAM_BOT_EVENTS,
  }
  return adapter
}

// --- native actions ------------------------------------------------------------------------------

/**
 * Telegram operations beyond the common surface: a few tools with an `action` enum (see
 * `actions.ts`). Each tool has a static risk; owner-only ones are refused in code for anybody else.
 */
export function nativeActions(
  bot: Bot,
  token: string,
  joinRequests: JoinRequestStore = createJoinRequestStore(),
  resolved?: (request: JoinRequest, resolution: JoinResolution) => void,
): NativeAction[] {
  return botActions({ bot, token, joinRequests, ...(resolved === undefined ? {} : { resolved }) })
}
