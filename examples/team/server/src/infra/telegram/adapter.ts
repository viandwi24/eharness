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
import type { Update } from 'grammy/types'
import { z } from 'zod'
import { plainMentions } from '../channels/mentions.ts'
import {
  type ChannelAdapter,
  type ChannelCapabilities,
  ChannelError,
  type ChannelNode,
  type EventSink,
  type Identity,
  type NativeAction,
  type NodeInfo,
  type OutboundFile,
  type OutboundMessage,
  type SentMessage,
} from '../channels/types.ts'
import { htmlChunks, toTelegramHtml } from './format.ts'
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

  const markup = (message: OutboundMessage) =>
    message.buttons === undefined || message.buttons.length === 0
      ? undefined
      : {
          inline_keyboard: [
            message.buttons.map((b) => ({
              text: b.label,
              callback_data: encodeCallback(b.name, b.data),
            })),
          ],
        }

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

  async function sendFiles(
    node: ChannelNode,
    message: OutboundMessage,
    files: OutboundFile[],
    common: Record<string, unknown>,
  ): Promise<SentMessage> {
    const chat = chatArg(targetOf(node).chat)
    const html = toTelegramHtml(message.text)
    const captionOk = html.length <= (TELEGRAM_CAPABILITIES.maxCaptionLength as number)
    const caption = message.text === '' ? undefined : captionOk ? html : undefined
    const input = (f: OutboundFile): InputFile => new InputFile(f.bytes, f.name)
    const albumable =
      files.length >= 2 && files.length <= 10 && files.every((f) => IMAGE_TYPES.has(f.mediaType))
    let first: SentMessage | undefined
    if (albumable) {
      const media = files.map((f, i) => ({
        type: 'photo' as const,
        media: input(f),
        ...(i === 0 && caption !== undefined ? { caption, parse_mode: 'HTML' as const } : {}),
      }))
      const result = await withHtml(
        () => bot.api.sendMediaGroup(chat, media, common),
        () =>
          bot.api.sendMediaGroup(
            chat,
            media.map((m) => ({ type: m.type, media: m.media })),
            common,
          ),
      )
      first = { nativeId: String(result[0]?.message_id) }
    } else {
      for (const [i, f] of files.entries()) {
        const opts = {
          ...common,
          ...(i === 0 && caption !== undefined ? { caption, parse_mode: 'HTML' as const } : {}),
        }
        const plainOpts = { ...common }
        const send = (o: typeof opts | typeof plainOpts): Promise<{ message_id: number }> => {
          if (IMAGE_TYPES.has(f.mediaType)) return bot.api.sendPhoto(chat, input(f), o)
          if (f.mediaType.startsWith('audio/')) return bot.api.sendAudio(chat, input(f), o)
          if (f.mediaType === 'video/mp4') return bot.api.sendVideo(chat, input(f), o)
          return bot.api.sendDocument(chat, input(f), o)
        }
        const result = await withHtml(
          () => send(opts),
          () => send(plainOpts),
        )
        first ??= { nativeId: String(result.message_id) }
      }
    }
    if (caption === undefined && message.text !== '') {
      // a caption that grew over the limit as HTML goes out as its own message
      await bot.api
        .sendMessage(chat, html, { ...common, parse_mode: 'HTML' })
        .catch(() => undefined)
    }
    return first as SentMessage
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
      const parts = htmlChunks(message.text, TELEGRAM_CAPABILITIES.maxTextLength)
      const plainText = plainMentions(message.text)
      const plainParts = parts.length === 1 ? [plainText.slice(0, 4096)] : undefined
      let first: SentMessage | undefined
      for (const [i, html] of parts.entries()) {
        const last = i === parts.length - 1
        const keyboard = last ? markup(message) : undefined
        const extra = {
          ...(i === 0 ? common : thread === undefined ? {} : { message_thread_id: thread }),
          ...(keyboard === undefined ? {} : { reply_markup: keyboard }),
        }
        const result = await withHtml(
          () =>
            bot.api.sendMessage(chat, html, {
              ...extra,
              parse_mode: 'HTML',
              link_preview_options: { is_disabled: true },
            }),
          () =>
            bot.api.sendMessage(
              chat,
              plainParts?.[0] ?? plainText.slice(i * 4000, (i + 1) * 4000),
              extra,
            ),
        )
        first ??= { nativeId: String(result.message_id) }
      }
      return remember(message.sendTxnId, first as SentMessage)
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
    async edit(node, nativeId, text) {
      const { chat } = targetOf(node)
      await guard(async () => {
        const html = htmlChunks(text, TELEGRAM_CAPABILITIES.maxTextLength)[0] ?? ''
        try {
          await withHtml(
            () =>
              bot.api.editMessageText(chatArg(chat), Number(nativeId), html, {
                parse_mode: 'HTML',
                reply_markup: { inline_keyboard: [] },
                link_preview_options: { is_disabled: true },
              }),
            () =>
              bot.api.editMessageText(chatArg(chat), Number(nativeId), text.slice(0, 4096), {
                reply_markup: { inline_keyboard: [] },
              }),
          )
        } catch (error) {
          if (error instanceof GrammyError && /not modified/i.test(error.description)) return
          throw error
        }
      })
    },
    async delete(node, nativeId) {
      await guard(() => bot.api.deleteMessage(chatArg(targetOf(node).chat), Number(nativeId)))
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
    async react(node, nativeId, emoji) {
      await guard(() =>
        bot.api.setMessageReaction(chatArg(targetOf(node).chat), Number(nativeId), [
          { type: 'emoji', emoji: emoji as never },
        ]),
      )
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
    actions: nativeActions(bot, token),
  }
  return adapter
}

// --- native actions ------------------------------------------------------------------------------

const chat = z.string().min(1).describe('Chat id (e.g. -1001234567890) or @channelusername')
const intId = z.coerce.number().int()

/**
 * Telegram operations beyond the common surface. Each is a deferred tool with a static risk:
 * `read` is allowed without asking, `write` and `external` ask, `destructive` always asks.
 */
export function nativeActions(bot: Bot, token: string): NativeAction[] {
  const run = (fn: () => Promise<unknown>, done: string): Promise<string> =>
    fn().then(
      () => done,
      (error) => `Telegram refused: ${mapTelegramError(error, token).message}`,
    )
  const text = (value: unknown): string => JSON.stringify(value, null, 1).slice(0, 4000)
  const act = (
    name: string,
    risk: NativeAction['risk'],
    summary: string,
    shape: z.ZodRawShape,
    exec: (input: Record<string, never>) => Promise<unknown>,
    done?: string,
  ): NativeAction => ({
    name,
    risk,
    summary,
    schema: z.object(shape),
    run: (input) =>
      done === undefined
        ? exec(input as Record<string, never>).then(
            (v) => text(v),
            (e) => `Telegram refused: ${mapTelegramError(e, token).message}`,
          )
        : run(() => exec(input as Record<string, never>), done),
  })
  const c = (i: Record<string, unknown>): number | string => chatArg(String(i.chat))
  return [
    act(
      'get_chat',
      'read',
      'Describe a chat: title, type, description, pinned message, permissions.',
      { chat },
      async (i) => {
        const r = await bot.api.getChat(c(i))
        return {
          id: r.id,
          type: r.type,
          title: 'title' in r ? r.title : undefined,
          username: 'username' in r ? r.username : undefined,
          description: 'description' in r ? r.description : undefined,
        }
      },
    ),
    act('get_member_count', 'read', 'Number of members of a chat.', { chat }, async (i) => ({
      members: await bot.api.getChatMemberCount(c(i)),
    })),
    act(
      'list_admins',
      'read',
      'Administrators of a chat (the Bot API cannot list all members).',
      { chat },
      async (i) =>
        (await bot.api.getChatAdministrators(c(i))).map((a) => ({
          id: a.user.id,
          name: a.user.first_name,
          username: a.user.username,
          status: a.status,
        })),
    ),
    act(
      'get_member',
      'read',
      'Status of one member of a chat (needs admin rights for others).',
      { chat, user: intId },
      async (i) => {
        const m = await bot.api.getChatMember(c(i), Number((i as Record<string, unknown>).user))
        return { id: m.user.id, name: m.user.first_name, status: m.status }
      },
    ),
    act(
      'send_poll',
      'external',
      'Post a poll in a chat.',
      {
        chat,
        topic: intId.optional().describe('Forum topic id'),
        question: z.string().min(1).max(300),
        options: z.array(z.string().min(1).max(100)).min(2).max(10),
        anonymous: z.boolean().default(true),
      },
      async (i) => {
        const r = i as Record<string, unknown>
        return bot.api.sendPoll(
          c(i),
          String(r.question),
          (r.options as string[]).map((t) => ({ text: t })),
          {
            is_anonymous: r.anonymous !== false,
            ...(r.topic === undefined ? {} : { message_thread_id: Number(r.topic) }),
          },
        )
      },
      'The poll was posted.',
    ),
    act(
      'pin_message',
      'write',
      'Pin a message (without notifying members).',
      { chat, message: intId },
      (i) =>
        bot.api.pinChatMessage(c(i), Number((i as Record<string, unknown>).message), {
          disable_notification: true,
        }),
      'The message was pinned.',
    ),
    act(
      'unpin_message',
      'write',
      'Unpin a message.',
      { chat, message: intId },
      (i) => bot.api.unpinChatMessage(c(i), Number((i as Record<string, unknown>).message)),
      'The message was unpinned.',
    ),
    act(
      'create_forum_topic',
      'write',
      'Create a topic in a forum group.',
      { chat, name: z.string().min(1).max(128) },
      (i) => bot.api.createForumTopic(c(i), String((i as Record<string, unknown>).name)),
      'The topic was created.',
    ),
    act(
      'edit_forum_topic',
      'write',
      'Rename a forum topic.',
      { chat, topic: intId, name: z.string().min(1).max(128) },
      (i) => {
        const r = i as Record<string, unknown>
        return bot.api.editForumTopic(c(i), Number(r.topic), { name: String(r.name) })
      },
      'The topic was renamed.',
    ),
    act(
      'close_forum_topic',
      'write',
      'Close a forum topic.',
      { chat, topic: intId },
      (i) => bot.api.closeForumTopic(c(i), Number((i as Record<string, unknown>).topic)),
      'The topic was closed.',
    ),
    act(
      'reopen_forum_topic',
      'write',
      'Reopen a closed forum topic.',
      { chat, topic: intId },
      (i) => bot.api.reopenForumTopic(c(i), Number((i as Record<string, unknown>).topic)),
      'The topic was reopened.',
    ),
    act(
      'delete_forum_topic',
      'destructive',
      'Delete a forum topic with all its messages.',
      { chat, topic: intId },
      (i) => bot.api.deleteForumTopic(c(i), Number((i as Record<string, unknown>).topic)),
      'The topic was deleted.',
    ),
    act(
      'set_chat_title',
      'write',
      'Change the title of a group or channel.',
      { chat, title: z.string().min(1).max(128) },
      (i) => bot.api.setChatTitle(c(i), String((i as Record<string, unknown>).title)),
      'The title was changed.',
    ),
    act(
      'create_invite_link',
      'external',
      'Create an invite link for a chat.',
      { chat, name: z.string().max(32).optional() },
      async (i) => {
        const r = i as Record<string, unknown>
        return bot.api.createChatInviteLink(
          c(i),
          r.name === undefined ? {} : { name: String(r.name) },
        )
      },
    ),
    act(
      'ban_member',
      'destructive',
      'Remove a member from a chat and ban them.',
      { chat, user: intId },
      (i) => bot.api.banChatMember(c(i), Number((i as Record<string, unknown>).user)),
      'The member was banned.',
    ),
    act(
      'unban_member',
      'write',
      'Lift the ban of a member (they may join again).',
      { chat, user: intId },
      (i) =>
        bot.api.unbanChatMember(c(i), Number((i as Record<string, unknown>).user), {
          only_if_banned: true,
        }),
      'The member was unbanned.',
    ),
    act(
      'restrict_member',
      'destructive',
      'Stop a member from sending messages.',
      { chat, user: intId },
      (i) =>
        bot.api.restrictChatMember(c(i), Number((i as Record<string, unknown>).user), {
          can_send_messages: false,
        }),
      'The member was restricted.',
    ),
    act(
      'leave_chat',
      'destructive',
      'Make the bot leave a chat.',
      { chat },
      (i) => bot.api.leaveChat(c(i)),
      'The bot left the chat.',
    ),
  ]
}
