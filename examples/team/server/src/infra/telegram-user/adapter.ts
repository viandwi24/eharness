/**
 * The Telegram user-account adapter (P41 L4): the channels contract over a {@link TgUserClient}.
 *
 * Inbound: updates of the chosen chats (and DMs, which the gateway filters by pairing) become
 * normalized events, in order per chat, deduped by (chat, message id, edit date). Deletions
 * arrive as ids: a channel deletion names the chat, a common-box deletion is resolved through
 * our own log (ambiguous ids are dropped, never guessed).
 *
 * Outbound is deliberately more careful than the bot: no DM to somebody the account has no
 * dialog with, daily caps (DMs and everything), a parked chat after FLOOD_WAIT (only that chat
 * waits), a circuit breaker on PEER_FLOOD or a storm of floods. It never marks anything as read,
 * never types, never touches presence.
 */
import { z } from 'zod'
import {
  type ChannelAdapter,
  type ChannelCapabilities,
  ChannelError,
  type ConversationKind,
  type ConversationRef,
  type EventSink,
  type HistoryEntry,
  type Identity,
  type InboundAttachment,
  type InboundEvent,
  type NativeAction,
  type OutboundMessage,
  type SentMessage,
} from '../channels/types.ts'
import type { TgChat, TgDelete, TgMessage, TgUser, TgUserClient } from './client.ts'
import { classifyError, describeError, type TgErrorKind } from './errors.ts'
import {
  historyEntryOf,
  kindOfChatId,
  normalizeEdit,
  normalizeMessage,
  refOf,
  splitConversationId,
} from './normalize.ts'
import type { AccountSettings, ChatStore, CounterStore } from './store.ts'

export const USER_CAPABILITIES: ChannelCapabilities = {
  maxTextLength: 4096,
  maxCaptionLength: 1024,
  // chunked downloads have no Telegram cap; this is our own ceiling for what a model turn loads
  maxDownloadBytes: 25 * 1024 * 1024,
  topics: true,
  reactions: true,
  edit: true,
  delete: true,
  pin: true,
  // the account never types: presence games are off the table
  typing: false,
  quote: true,
  history: true,
  historyMode: 'rest',
  members: true,
  membersScope: 'partial',
  upload: true,
  deletions: 'ids',
  adminLog: true,
  listChats: true,
}

/** Why the adapter wants the whole session stopped. */
export type UserFatal =
  | { kind: 'auth-lost'; text: string }
  | { kind: 'duplicated'; text: string }
  | { kind: 'peer-flood'; text: string }
  | { kind: 'flood-storm'; text: string }
  | { kind: 'updates'; text: string }

export interface UserAdapterHooks {
  /** The account cannot continue (auth lost, duplicated, flagged): the service marks the connection and stops. */
  onFatal(fatal: UserFatal): void
  /** A flood wait happened (for the Channels page). */
  onFlood?(info: { chatId: string | undefined; seconds: number; until: number; text: string }): void
  /** The admin log of a chat, as text (the `admin_log` action). */
  adminLogText?(chatId: string, limit: number): string
  warn?(message: string): void
}

export interface UserAdapterOptions {
  connectionId: string
  client: TgUserClient
  me: TgUser
  chats: ChatStore
  counters: CounterStore
  settings: () => AccountSettings
  /** Find logged messages by id (`ChannelLog.locate`). */
  locate: (
    ids: string[],
    container?: string,
  ) => Array<{ conversationId: string; platformId: string }>
  hooks: UserAdapterHooks
  /** Was message `messageId` of the chat sent by this account (our log knows)? Telegram does not say who a reply points at. */
  /** A reason to refuse every send (the account was flagged: PEER_FLOOD, a flood storm); undefined = fine. */
  blocked?: () => string | undefined
  isOwn?: (chatId: string, messageId: string) => boolean
  now?: () => number
  random?: () => number
  /** Flood waits that trip the breaker (default 3 within 1 hour). */
  floodBreaker?: { count: number; windowMs: number }
  /** How long the dialog list is trusted before a DM target is checked again (ms, default 60 000). */
  dialogsTtlMs?: number
}

export interface TelegramUserAdapter extends ChannelAdapter {
  /** The dialogs of the account (cached for a short time). */
  dialogs(refresh?: boolean): Promise<TgChat[]>
  /** The chat's jobs and sends resume at `until` (a flood wait). */
  parkChat(chatId: string, until: number): void
  parkedUntil(chatId: string): number | undefined
  /** Live events seen since start (for status). */
  stats(): { events: number; lastEventAt: number | undefined; unresolvedDeletes: number }
}

const DEDUPE_MAX = 5000

export function createTelegramUserAdapter(options: UserAdapterOptions): TelegramUserAdapter {
  const { connectionId, client, chats, counters, hooks } = options
  const now = options.now ?? (() => Date.now())
  const random = options.random ?? Math.random
  const floodBreaker = options.floodBreaker ?? { count: 3, windowMs: 3_600_000 }
  const dialogsTtl = options.dialogsTtlMs ?? 60_000
  const warn = hooks.warn ?? ((m) => console.warn(`team: ${m}`))
  const selfId = options.me.id
  const self: Identity = {
    id: selfId,
    name: options.me.name,
    ...(options.me.username === undefined ? {} : { username: options.me.username }),
    isSelf: true,
  }

  let sink: EventSink | undefined
  let stopped = false
  let events = 0
  let lastEventAt: number | undefined
  let unresolvedDeletes = 0
  const seen = new Set<string>()
  const sentIds = new Set<string>()
  const lanes = new Map<string, Promise<unknown>>()
  const parks = new Map<string, number>()
  const floods: number[] = []
  let dialogCache: { at: number; list: TgChat[] } | undefined

  const remember = (key: string): boolean => {
    if (seen.has(key)) return false
    seen.add(key)
    if (seen.size > DEDUPE_MAX) {
      const oldest = seen.values().next().value
      if (oldest !== undefined) seen.delete(oldest)
    }
    return true
  }

  /** Run `fn` after everything queued for the same chat (updates of one chat stay in order). */
  const inLane = (chatId: string, fn: () => Promise<void>): void => {
    const prev = lanes.get(chatId) ?? Promise.resolve()
    const next = prev.then(fn).catch((error) => {
      if (!stopped) warn(`telegram-user: an event of ${connectionId} failed: ${String(error)}`)
    })
    lanes.set(chatId, next)
    void next.then(() => {
      if (lanes.get(chatId) === next) lanes.delete(chatId)
    })
  }

  const fetchOf =
    (m: TgMessage, attachmentId: string): InboundAttachment['fetch'] =>
    async () => {
      void attachmentId
      try {
        return await client.download(m.chat.id, m.id)
      } catch (error) {
        throw toChannelError(error, m.chat.id)
      }
    }
  const nopts = { connectionId, selfId, fetch: fetchOf }

  /** DMs are always accepted here (the gateway only lets paired people through); other chats must be chosen. */
  const accepts = (m: { chat: { id: string; kind: string } }): boolean =>
    m.chat.kind === 'dm' || chats.isSelected(connectionId, m.chat.id)

  const deliver = (event: InboundEvent): Promise<void> => {
    events++
    lastEventAt = now()
    return sink === undefined ? Promise.resolve() : sink(event)
  }

  /** A reply to one of our own messages is the strongest implicit wake: fill in who it points at. */
  const withReplyOwner = (m: TgMessage): TgMessage => {
    const r = m.replyTo
    if (r === undefined || r.senderId !== undefined) return m
    const own =
      sentIds.has(`${m.chat.id}:${r.id}`) || options.isOwn?.(m.chat.id, String(r.id)) === true
    return own ? { ...m, replyTo: { ...r, senderId: selfId, senderName: self.name ?? 'me' } } : m
  }

  function onMessage(raw: TgMessage): void {
    const m = withReplyOwner(raw)
    if (m.service || !accepts(m)) return
    if (!remember(`m:${m.chat.id}:${m.id}`)) return
    inLane(m.chat.id, async () => {
      if (m.chat.kind !== 'dm') chats.noteMessage(connectionId, m.chat.id, m.id, true)
      await deliver(normalizeMessage(m, nopts))
    })
  }

  function onEdit(m: TgMessage): void {
    if (m.service || !accepts(m)) return
    if (!remember(`e:${m.chat.id}:${m.id}:${m.editedAt ?? 0}`)) return
    inLane(m.chat.id, async () => {
      await deliver(normalizeEdit(m, nopts))
    })
  }

  function conversationRefOf(conversationId: string): ConversationRef {
    const { chatId, topicId } = splitConversationId(conversationId)
    const known = chats.get(connectionId, chatId)
    return refOf(
      connectionId,
      { id: chatId, kind: known?.kind ?? kindOfChatId(chatId), title: known?.title },
      topicId,
    )
  }

  function onDelete(d: TgDelete): void {
    const ids = d.ids.map(String)
    if (ids.length === 0) return
    const chatId = d.chatId
    if (chatId !== undefined && !chats.isSelected(connectionId, chatId)) return
    const run = async (): Promise<void> => {
      const found = options.locate(ids, chatId)
      // the common box (no chat id) holds persons and basic groups: channel ids are another space
      const usable =
        chatId === undefined ? found.filter((f) => !f.conversationId.startsWith('-100')) : found
      const byId = new Map<string, Set<string>>()
      for (const f of usable) {
        const set = byId.get(f.platformId) ?? new Set<string>()
        set.add(f.conversationId)
        byId.set(f.platformId, set)
      }
      const perConversation = new Map<string, string[]>()
      for (const id of ids) {
        const where = byId.get(id)
        if (where === undefined) continue
        if (where.size > 1) {
          // the same id in two conversations of the common box: do not guess
          unresolvedDeletes++
          continue
        }
        const conv = [...where][0] as string
        const list = perConversation.get(conv) ?? []
        list.push(id)
        perConversation.set(conv, list)
      }
      for (const [conv, messageIds] of perConversation) {
        await deliver({
          type: 'delete',
          conversation: conversationRefOf(conv),
          at: now(),
          messageIds,
        })
      }
    }
    inLane(chatId ?? '*', run)
  }

  // --- errors ----------------------------------------------------------------------------------

  const jitterMs = (): number => 1000 + Math.floor(random() * 4000)

  function parkChat(chatId: string, until: number): void {
    parks.set(chatId, until)
    if (chats.get(connectionId, chatId) !== undefined)
      chats.setParked(connectionId, chatId, until, now())
  }
  function parkedUntil(chatId: string): number | undefined {
    const t = Math.max(parks.get(chatId) ?? 0, chats.get(connectionId, chatId)?.parkedUntil ?? 0)
    return t > now() ? t : undefined
  }

  /** Map a client error to a ChannelError, parking the chat on a flood and tripping on the bad ones. */
  function toChannelError(error: unknown, chatId?: string): ChannelError {
    if (error instanceof ChannelError) return error
    const k: TgErrorKind = classifyError(error)
    switch (k.kind) {
      case 'flood': {
        const ms = k.seconds * 1000 + jitterMs()
        const until = now() + ms
        if (chatId !== undefined) parkChat(chatId, until)
        hooks.onFlood?.({ chatId, seconds: k.seconds, until, text: k.text })
        floods.push(now())
        while (floods.length > 0 && (floods[0] as number) < now() - floodBreaker.windowMs)
          floods.shift()
        if (floods.length >= floodBreaker.count) {
          const text = `${floods.length} flood waits within ${Math.round(floodBreaker.windowMs / 60_000)} minutes`
          hooks.onFatal({ kind: 'flood-storm', text })
          return new ChannelError(
            'fatal',
            `Telegram keeps rate limiting this account (${text}); sending is paused.`,
          )
        }
        return new ChannelError(
          'rate_limit',
          describeError(k),
          ms,
          chatId === undefined ? 'connection' : 'chat',
        )
      }
      case 'peer-flood':
        hooks.onFatal({ kind: 'peer-flood', text: k.text })
        return new ChannelError('fatal', describeError(k))
      case 'auth-lost':
      case 'duplicated':
        hooks.onFatal({ kind: k.kind, text: k.text })
        return new ChannelError('fatal', describeError(k))
      case 'invalid':
      case 'phone-invalid':
      case 'app-invalid':
      case 'code-invalid':
      case 'code-expired':
      case 'password-invalid':
      case 'password-needed':
        return new ChannelError('invalid', describeError(k))
      default:
        return new ChannelError('transient', describeError(k))
    }
  }

  // --- outbound --------------------------------------------------------------------------------

  async function dialogs(refresh = false): Promise<TgChat[]> {
    if (!refresh && dialogCache !== undefined && now() - dialogCache.at < dialogsTtl) {
      return dialogCache.list
    }
    try {
      const list = await client.listChats()
      dialogCache = { at: now(), list }
      return list
    } catch (error) {
      throw toChannelError(error)
    }
  }

  async function guardSend(ref: ConversationRef): Promise<void> {
    const blocked = options.blocked?.()
    if (blocked !== undefined) throw new ChannelError('fatal', blocked)
    const parked = parkedUntil(ref.container)
    if (parked !== undefined) {
      throw new ChannelError(
        'rate_limit',
        `this chat is paused by a Telegram flood wait until ${new Date(parked).toISOString()}`,
        parked - now(),
        'chat',
      )
    }
    const s = options.settings()
    if (counters.get(connectionId, 'all', now()) >= s.dailyMax) {
      throw new ChannelError(
        'invalid',
        `the account reached its daily limit of ${s.dailyMax} messages (it resets at 00:00 UTC); raise it on the Channels page only if you are sure`,
      )
    }
    if (ref.kind === 'dm') {
      let known = (await dialogs()).some((d) => d.id === ref.container)
      if (!known) known = (await dialogs(true)).some((d) => d.id === ref.container)
      if (!known) {
        throw new ChannelError(
          'invalid',
          'this account has no conversation with that person, and it never starts one (no cold messages): ask them to write to the account first',
        )
      }
      if (counters.get(connectionId, 'dm', now()) >= s.dmDailyMax) {
        throw new ChannelError(
          'invalid',
          `the account reached its daily limit of ${s.dmDailyMax} direct messages (it resets at 00:00 UTC)`,
        )
      }
    }
  }

  const sendOptions = (ref: ConversationRef, message: OutboundMessage) => ({
    ...(message.replyTo === undefined ? {} : { replyTo: Number(message.replyTo) }),
    ...(ref.topic === undefined ? {} : { topicId: Number(ref.topic) }),
    ...(message.silent === true ? { silent: true } : {}),
    ...(message.key === undefined ? {} : { key: message.key }),
  })

  async function send(ref: ConversationRef, message: OutboundMessage): Promise<SentMessage> {
    await guardSend(ref)
    try {
      const sent =
        message.files !== undefined && message.files.length > 0
          ? await client.sendFiles(
              ref.container,
              message.files,
              message.text,
              sendOptions(ref, message),
            )
          : await client.sendText(ref.container, message.text, sendOptions(ref, message))
      sentIds.add(`${ref.container}:${sent.id}`)
      if (sentIds.size > DEDUPE_MAX) {
        const oldest = sentIds.values().next().value
        if (oldest !== undefined) sentIds.delete(oldest)
      }
      counters.add(connectionId, 'all', now())
      if (ref.kind === 'dm') counters.add(connectionId, 'dm', now())
      return { messageId: String(sent.id) }
    } catch (error) {
      throw toChannelError(error, ref.container)
    }
  }

  const guarded = async <T>(ref: ConversationRef, fn: () => Promise<T>): Promise<T> => {
    const parked = parkedUntil(ref.container)
    if (parked !== undefined) {
      throw new ChannelError(
        'rate_limit',
        'this chat is paused by a Telegram flood wait',
        parked - now(),
        'chat',
      )
    }
    try {
      return await fn()
    } catch (error) {
      throw toChannelError(error, ref.container)
    }
  }

  const actions: NativeAction[] = [
    {
      name: 'list_chats',
      risk: 'read',
      summary:
        'List the chats this account has chosen for ingest (and whether it is an admin there).',
      schema: z.object({}),
      run: async () => {
        const list = chats.selected(connectionId)
        if (list.length === 0) return 'No chats are chosen for this account yet.'
        return list
          .map(
            (c) =>
              `${c.chatId}  ${c.title} (${c.kind}${c.admin ? ', admin' : ''}${c.forum ? ', forum' : ''})`,
          )
          .join('\n')
      },
    },
    {
      name: 'admin_log',
      risk: 'read',
      summary:
        'Moderation events stored for a chat the account administers (deletions with their text, edits, bans, promotions). Telegram keeps them only briefly: this is what we stored.',
      schema: z.object({
        chat: z.string().min(1).describe('The chat id, as `list_chats` shows it.'),
        limit: z.number().int().min(1).max(100).default(30),
      }),
      run: async (input) => {
        const text = hooks.adminLogText?.(String(input.chat), Number(input.limit ?? 30))
        return text === undefined || text === ''
          ? 'No admin log events are stored for that chat.'
          : text
      },
    },
  ]

  const adapter: TelegramUserAdapter = {
    platform: 'telegram-user',
    connectionId,
    capabilities: USER_CAPABILITIES,
    self: () => self,
    actions,
    async start(s) {
      sink = s
      stopped = false
      await client.startUpdates(
        {
          message: onMessage,
          edit: onEdit,
          delete: onDelete,
          error: (error) => {
            const k = classifyError(error)
            if (k.kind === 'auth-lost' || k.kind === 'duplicated') {
              hooks.onFatal({ kind: k.kind, text: k.text })
            } else if (!stopped) {
              warn(`telegram-user: updates of ${connectionId}: ${k.text.slice(0, 160)}`)
            }
          },
        },
        { catchUp: true },
      )
    },
    async stop() {
      stopped = true
      sink = undefined
      await client.stop().catch(() => undefined)
    },
    send,
    edit: (ref, messageId, text) =>
      guarded(ref, () => client.editText(ref.container, Number(messageId), text)),
    delete: (ref, messageId) =>
      guarded(ref, () => client.deleteMessages(ref.container, [Number(messageId)])),
    pin: (ref, messageId, pinned) =>
      guarded(ref, () => client.pin(ref.container, Number(messageId), pinned)),
    react: (ref, messageId, emoji) =>
      guarded(ref, () => client.react(ref.container, Number(messageId), emoji)),
    async fetchHistory(ref, o): Promise<HistoryEntry[]> {
      const page = await guarded(ref, () =>
        client.history(ref.container, {
          limit: Math.min(o.limit, 100),
          ...(o.before === undefined ? {} : { offsetId: Number(o.before) }),
        }),
      )
      return page.map(historyEntryOf).reverse()
    },
    async members(ref, o) {
      // partial on purpose: a bounded look at who is there, never a sweep of a big group
      const list = await guarded(ref, () => client.members(ref.container, Math.min(o.limit, 100)))
      return list.map((u) => ({
        id: u.id,
        name: u.name,
        ...(u.username === undefined ? {} : { username: u.username }),
        ...(u.isBot ? { isBot: true } : {}),
      }))
    },
    async fetchAttachment(ref, messageId) {
      return guarded(ref, () => client.download(ref.container, Number(messageId)))
    },
    conversationRef(input) {
      const kind: ConversationKind = input.kind ?? kindOfChatId(input.container)
      return refOf(
        connectionId,
        {
          id: input.container,
          kind,
          title: chats.get(connectionId, input.container)?.title,
        },
        input.topic,
      )
    },
    dialogs,
    parkChat,
    parkedUntil,
    stats: () => ({ events, lastEventAt, unresolvedDeletes }),
  }
  return adapter
}
