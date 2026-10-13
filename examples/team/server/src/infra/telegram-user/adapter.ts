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
  type AdapterHost,
  type ChannelAdapter,
  type ChannelCapabilities,
  ChannelError,
  type ChannelNode,
  type EventSink,
  type HistoryEntry,
  type Identity,
  type InboundAttachment,
  type NativeAction,
  type NodeInfo,
  type OutboundMessage,
  type RemoteEvent,
  type SentMessage,
} from '../channels/types.ts'
import type { TgChat, TgDelete, TgMessage, TgTopic, TgUser, TgUserClient } from './client.ts'
import { classifyError, describeError, type TgErrorKind } from './errors.ts'
import {
  chatNode,
  historyEntryOf,
  kindOfChatId,
  nativeIdOf,
  normalizeEdit,
  normalizeMessage,
  splitNativeId,
  topicNode,
} from './normalize.ts'
import type { AccountSettings, ChatStore, CounterStore } from './store.ts'

/** The documented native id formats (see `normalize.ts`). */
export const USER_ID_FORMATS =
  'chat `<marked chat id>` (a person is the positive id, a basic group `-<id>`, a channel or supergroup `-100<id>`); forum topic `<chat>/<topic id>` (General is `/0`); message `<message id>`; person `<user id>`'

export const USER_CAPABILITIES: ChannelCapabilities = {
  maxTextLength: 4096,
  maxCaptionLength: 1024,
  // chunked downloads have no Telegram cap; this is our own ceiling for what a model turn loads
  maxDownloadBytes: 25 * 1024 * 1024,
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
  hooks: UserAdapterHooks
  /** A reason to refuse every send (the account was flagged: PEER_FLOOD, a flood storm); undefined = fine. */
  blocked?: () => string | undefined
  now?: () => number
  random?: () => number
  /** Flood waits that trip the breaker (default 3 within 1 hour). */
  floodBreaker?: { count: number; windowMs: number }
  /** How long the dialog list is trusted before a DM target is checked again (ms, default 60 000). */
  dialogsTtlMs?: number
  /**
   * The client topic titles are read with (`governJobClient`: the connection's API governor, so a
   * flood wait parks it like any read). Default `client`.
   */
  topicClient?: TgUserClient
  /** How long a topic title is trusted before it is read again (ms, default 6 hours). */
  topicTtlMs?: number
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
  let host: AdapterHost | undefined
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
  const topicClient = options.topicClient ?? client
  const topicTtl = options.topicTtlMs ?? 6 * 3_600_000
  /** Forum topic titles per chat: `<chat>` -> topic id -> title and when it was read. */
  const topicTitles = new Map<string, Map<number, { title: string; at: number }>>()
  /** Topic reads in flight or failed lately (`<chat>/<topic>` or `<chat>/*` -> when), so a busy topic asks once. */
  const topicAsked = new Map<string, number>()

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
  const nopts = { selfId, fetch: fetchOf }

  /** DMs are always accepted here (the gateway only lets linked people through); other chats must be chosen. */
  const accepts = (m: { chat: { id: string; kind: string } }): boolean =>
    m.chat.kind === 'dm' ||
    (host?.isAllowed(m.chat.id) ?? chats.isSelected(connectionId, m.chat.id))

  const deliver = (event: RemoteEvent): Promise<void> => {
    events++
    lastEventAt = now()
    return sink === undefined ? Promise.resolve() : sink(event)
  }

  /** A reply to one of our own messages is the strongest implicit wake: fill in who it points at. */
  const withReplyOwner = (m: TgMessage): TgMessage => {
    const r = m.replyTo
    if (r === undefined || r.senderId !== undefined) return m
    const own =
      sentIds.has(`${m.chat.id}:${r.id}`) ||
      host?.isOwn(
        m.chat.forum && m.topicId !== undefined ? nativeIdOf(m.chat.id, m.topicId) : m.chat.id,
        String(r.id),
      ) === true ||
      host?.isOwn(nativeIdOf(m.chat.id, 0), String(r.id)) === true
    return own ? { ...m, replyTo: { ...r, senderId: selfId, senderName: self.name ?? 'me' } } : m
  }

  // --- forum topic titles ----------------------------------------------------------------------
  // MTProto updates carry only the topic id; the title is read from the forum (`forumTopics`) and
  // given to the gateway as `node.updated`, so chats, tools and the agent see "Clipping", not `/19480`.

  const knownTopic = (chatId: string, topicId: number): string | undefined =>
    topicTitles.get(chatId)?.get(topicId)?.title

  /** Record titles; a new or renamed one goes to the gateway (in the chat's lane, after its messages). */
  function learnTopics(
    chat: { id: string; kind: TgChat['kind']; title: string; forum: boolean },
    list: TgTopic[],
  ): void {
    const at = now()
    const known = topicTitles.get(chat.id) ?? new Map<number, { title: string; at: number }>()
    topicTitles.set(chat.id, known)
    for (const t of list) {
      if (t.id === 0 || t.title.trim() === '') continue
      const before = known.get(t.id)
      known.set(t.id, { title: t.title, at })
      if (before?.title === t.title) continue
      const topic = topicNode(chat.id, t.id, t.title)
      inLane(chat.id, () =>
        deliver({
          type: 'node.updated',
          dedupeKey: `tgu:topic:${topic.nativeId}:${t.title}`,
          at,
          node: { nativeId: topic.nativeId, chain: [topic, chatNode({ ...chat })] },
        }),
      )
    }
  }

  /** Read the titles of a forum chat (`ids`, else all of it) unless that was asked lately. Never throws. */
  async function readTopics(
    chat: { id: string; kind: TgChat['kind']; title: string; forum: boolean },
    ids?: number[],
  ): Promise<void> {
    if (topicClient.forumTopics === undefined || stopped) return
    const key = ids === undefined ? `${chat.id}/*` : `${chat.id}/${ids.join(',')}`
    const asked = topicAsked.get(key)
    // one read per topic per 10 minutes, success or not: a busy chat never floods the API
    if (asked !== undefined && now() - asked < 600_000) return
    topicAsked.set(key, now())
    try {
      learnTopics(chat, await topicClient.forumTopics(chat.id, ids === undefined ? {} : { ids }))
    } catch (error) {
      if (!stopped) warn(`telegram-user: topic titles of ${chat.id} not read: ${String(error)}`)
    }
  }

  /** The cached title of a message's topic; an unknown or old one is read in the background. */
  function withTopicTitle(m: TgMessage): TgMessage {
    if (!m.chat.forum || m.topicId === undefined || m.topicId === 0) return m
    const cached = topicTitles.get(m.chat.id)?.get(m.topicId)
    if (cached === undefined || now() - cached.at > topicTtl) void readTopics(m.chat, [m.topicId])
    return cached === undefined ? m : { ...m, topicTitle: cached.title }
  }

  function onMessage(raw: TgMessage): void {
    const m = withReplyOwner(raw)
    if (m.service || !accepts(m)) return
    if (!remember(`m:${m.chat.id}:${m.id}`)) return
    const titled = withTopicTitle(m)
    inLane(m.chat.id, async () => {
      if (m.chat.kind !== 'dm') chats.noteMessage(connectionId, m.chat.id, m.id, true)
      await deliver(normalizeMessage(titled, nopts))
    })
  }

  function onEdit(m: TgMessage): void {
    if (m.service || !accepts(m)) return
    if (!remember(`e:${m.chat.id}:${m.id}:${m.editedAt ?? 0}`)) return
    const titled = withTopicTitle(m)
    inLane(m.chat.id, async () => {
      await deliver(normalizeEdit(titled, nopts))
    })
  }

  function onDelete(d: TgDelete): void {
    const ids = d.ids.map(String)
    if (ids.length === 0) return
    const chatId = d.chatId
    const stamp = now()
    if (
      chatId !== undefined &&
      !(host?.isAllowed(chatId) ?? chats.isSelected(connectionId, chatId))
    )
      return
    const run = async (): Promise<void> => {
      const found = host?.locate(ids, chatId) ?? []
      // the common box (no chat id) holds persons and basic groups: channel ids are another space
      const usable =
        chatId === undefined
          ? found.filter((f) => !splitNativeId(f.nodeNativeId).chatId.startsWith('-100'))
          : found
      const byId = new Map<string, Set<string>>()
      for (const f of usable) {
        const set = byId.get(f.messageNativeId) ?? new Set<string>()
        set.add(f.nodeNativeId)
        byId.set(f.messageNativeId, set)
      }
      const perNode = new Map<string, string[]>()
      const unplaced: string[] = []
      for (const id of ids) {
        const where = byId.get(id)
        if (where === undefined) continue
        if (where.size > 1) {
          // the same id in two conversations of the common box: do not guess
          unresolvedDeletes++
          unplaced.push(id)
          continue
        }
        const node = [...where][0] as string
        perNode.set(node, [...(perNode.get(node) ?? []), id])
      }
      for (const [nodeNative, messageNativeIds] of perNode) {
        const { chatId: chat, topicId } = splitNativeId(nodeNative)
        const known = chats.get(connectionId, chat)
        const room = chatNode({
          id: chat,
          kind: known?.kind ?? kindOfChatId(chat),
          title: known?.title,
          forum: known?.forum,
        })
        await deliver({
          type: 'message.deleted',
          dedupeKey: `tgu:d:${nodeNative}:${messageNativeIds.join(',')}:${stamp}`,
          at: now(),
          node: {
            nativeId: nodeNative,
            chain:
              topicId === undefined
                ? [room]
                : [{ nativeId: nodeNative, kind: 'thread', parent: chat }, room],
          },
          messageNativeIds,
        })
      }
      if (unplaced.length > 0) {
        // the gateway records what it cannot place and tries again when it learns more
        await deliver({
          type: 'message.deleted',
          dedupeKey: `tgu:d:?:${unplaced.join(',')}:${stamp}`,
          at: now(),
          node: null,
          messageNativeIds: unplaced,
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

  /** The chat and topic a node stands for. */
  const targetOf = (node: ChannelNode): { chat: string; topic: number | undefined } => {
    const metaChat = node.meta.chatId
    const chat =
      typeof metaChat === 'string'
        ? metaChat
        : node.kind === 'thread'
          ? (node.parentNativeId ?? splitNativeId(node.nativeId).chatId)
          : node.nativeId
    if (node.kind !== 'thread') return { chat, topic: undefined }
    const topic = Number(
      typeof node.meta.topicId === 'number'
        ? node.meta.topicId
        : splitNativeId(node.nativeId).topicId,
    )
    return { chat, topic: Number.isFinite(topic) && topic !== 0 ? topic : undefined }
  }

  async function guardSend(node: ChannelNode): Promise<void> {
    const chat = targetOf(node).chat
    const blocked = options.blocked?.()
    if (blocked !== undefined) throw new ChannelError('fatal', blocked)
    const parked = parkedUntil(chat)
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
    if (node.kind === 'direct') {
      let known = (await dialogs()).some((d) => d.id === chat)
      if (!known) known = (await dialogs(true)).some((d) => d.id === chat)
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

  const sendOptions = (node: ChannelNode, message: OutboundMessage) => ({
    ...(message.replyTo === undefined ? {} : { replyTo: Number(message.replyTo) }),
    ...(targetOf(node).topic === undefined ? {} : { topicId: targetOf(node).topic as number }),
    ...(message.silent === true ? { silent: true } : {}),
    ...(message.sendTxnId === undefined ? {} : { key: message.sendTxnId }),
  })

  async function send(node: ChannelNode, message: OutboundMessage): Promise<SentMessage> {
    await guardSend(node)
    const chat = targetOf(node).chat
    try {
      const sent =
        message.files !== undefined && message.files.length > 0
          ? await client.sendFiles(chat, message.files, message.text, sendOptions(node, message))
          : await client.sendText(chat, message.text, sendOptions(node, message))
      sentIds.add(`${chat}:${sent.id}`)
      if (sentIds.size > DEDUPE_MAX) {
        const oldest = sentIds.values().next().value
        if (oldest !== undefined) sentIds.delete(oldest)
      }
      counters.add(connectionId, 'all', now())
      if (node.kind === 'direct') counters.add(connectionId, 'dm', now())
      return { nativeId: String(sent.id) }
    } catch (error) {
      throw toChannelError(error, chat)
    }
  }

  const guarded = async <T>(node: ChannelNode, fn: () => Promise<T>): Promise<T> => {
    const chat = targetOf(node).chat
    const parked = parkedUntil(chat)
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
      throw toChannelError(error, chat)
    }
  }

  const actions: NativeAction[] = [
    {
      name: 'list_chats',
      risk: 'read',
      local: true,
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
      local: true,
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
    actsAs: 'user',
    connectionId,
    idFormats: USER_ID_FORMATS,
    self: () => self,
    actions,
    getCapabilities: () => USER_CAPABILITIES,
    async getNodeInfo(nativeId) {
      if (splitNativeId(nativeId).topicId !== undefined) return undefined
      const d = (await dialogs()).find((x) => x.id === nativeId)
      return d === undefined ? undefined : chatNode(d)
    },
    async getIdentityInfo() {
      return undefined
    },
    async start(s, h) {
      sink = s
      host = h
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
      // titles of the topics of every chosen forum, once per start (topics seen before this
      // version have none), one chat after the other through the governor
      void (async () => {
        for (const c of chats.selected(connectionId)) {
          if (stopped) return
          if (!c.forum) continue
          await readTopics({ id: c.chatId, kind: c.kind, title: c.title, forum: true })
        }
      })()
    },
    async stop() {
      stopped = true
      sink = undefined
      await client.stop().catch(() => undefined)
    },
    send,
    edit: (node, nativeId, text) =>
      guarded(node, () => client.editText(targetOf(node).chat, Number(nativeId), text)),
    delete: (node, nativeId) =>
      guarded(node, () => client.deleteMessages(targetOf(node).chat, [Number(nativeId)])),
    pin: (node, nativeId, pinned) =>
      guarded(node, () => client.pin(targetOf(node).chat, Number(nativeId), pinned)),
    react: (node, nativeId, emoji) =>
      guarded(node, () => client.react(targetOf(node).chat, Number(nativeId), emoji)),
    async fetchHistory(node, o): Promise<HistoryEntry[]> {
      const page = await guarded(node, () =>
        client.history(targetOf(node).chat, {
          limit: Math.min(o.limit, 100),
          ...(o.before === undefined ? {} : { offsetId: Number(o.before) }),
        }),
      )
      return page.map(historyEntryOf).reverse()
    },
    async listMembers(node, o) {
      // partial on purpose: a bounded look at who is there, never a sweep of a big group
      const list = await guarded(node, () =>
        client.members(targetOf(node).chat, Math.min(o.limit, 100)),
      )
      return {
        scope: 'partial' as const,
        members: list.map((u) => ({
          id: u.id,
          name: u.name,
          ...(u.username === undefined ? {} : { username: u.username }),
          ...(u.isBot ? { isBot: true } : {}),
        })),
      }
    },
    async listNodes(parent?: ChannelNode): Promise<NodeInfo[]> {
      // the topics of a forum chat, with their titles
      if (
        parent !== undefined &&
        parent.kind !== 'thread' &&
        topicClient.forumTopics !== undefined
      ) {
        const chat = targetOf(parent).chat
        const d = (await dialogs()).find((x) => x.id === chat)
        if (d?.forum === true) {
          const list = await topicClient.forumTopics(chat, { limit: 100 })
          learnTopics(d, list)
          return list.map((t) => topicNode(chat, t.id, t.title))
        }
      }
      return (await dialogs(true)).map((d) => chatNode(d))
    },
    async fetchAttachment(node, messageNativeId) {
      return guarded(node, () => client.download(targetOf(node).chat, Number(messageNativeId)))
    },
    openDirect: (identityNativeId) => ({
      nativeId: identityNativeId,
      kind: 'direct',
      platformType: 'telegram-user:private',
      traits: { multiUser: false, threading: 'none' },
      meta: { chatId: identityNativeId },
    }),
    childNativeId: (parent, key) => nativeIdOf(parent.nativeId, key),
    dialogs,
    parkChat,
    parkedUntil,
    stats: () => ({ events, lastEventAt, unresolvedDeletes }),
  }
  return adapter
}
