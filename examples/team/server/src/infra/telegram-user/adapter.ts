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

import {
  createJoinRequestStore,
  type JoinRequestStore,
  type JoinResolution,
} from '../channels/join-requests.ts'
import { parseMentions, plainMentions } from '../channels/mentions.ts'
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
import { toTelegramHtml } from '../telegram/format.ts'
import { accountActions, DELETED_HINT } from './actions.ts'
import type { AdminLogQuery } from './adminlog.ts'
import type {
  TgChat,
  TgDelete,
  TgJoinRequestsUpdate,
  TgMemberUpdate,
  TgMessage,
  TgTopic,
  TgUser,
  TgUserClient,
} from './client.ts'
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
  // mention tokens are rendered as @handle or a mention by id (`renderMentions`)
  mentions: 'id',
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
  /** The admin log of a chat, read fresh and filtered, as text (the `admin_log` action). */
  adminLogRead?(chatId: string, query: AdminLogQuery): Promise<string>
  /** The live dialog list was read: record the chats (not chosen) so the Channels page lists them. */
  dialogsSeen?(list: TgChat[]): void
  /** Choose a chat for ingest (observe-only) and back-fill `days` (0 = none); a sentence for the model. */
  chooseChat?(chatId: string, days: number): Promise<string>
  /** Back-fill a chosen chat for `days`; a sentence for the model. */
  backfill?(chatId: string, days: number): Promise<string>
  /** A chat was joined or left by a platform action. */
  chatsChanged?(): void
  /** A chat was created by a platform action: the service chooses it (wake on mention). */
  chatCreated?(chat: TgChat): Promise<void>
  warn?(message: string): void
}

export interface UserAdapterOptions {
  connectionId: string
  client: TgUserClient
  me: TgUser
  chats: ChatStore
  counters: CounterStore
  settings: () => AccountSettings
  /** Where pending join requests are kept (default: memory). The app passes the durable store. */
  joinRequests?: JoinRequestStore
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
  /** The team timezone (times the platform actions show). Default UTC. */
  timezone?: () => string
  /** Reads a library file (a chat photo, album files). */
  readFile?: (path: string) => Promise<{ bytes: Uint8Array; mediaType: string } | undefined>
  /** Pause between spaced calls (tests). */
  sleep?: (ms: number) => Promise<void>
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

  const joinRequests = options.joinRequests ?? createJoinRequestStore(now)
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

  // --- members and join requests --------------------------------------------------------------
  // Telegram tells the administrators of a chat who joined, left or was promoted, and which join
  // requests are pending. Reactions of other people are not delivered to a user account.

  const identityOfTg = (u: TgUser): Identity => ({
    id: u.id,
    name: u.name,
    ...(u.username === undefined ? {} : { username: u.username }),
    ...(u.isBot ? { isBot: true, kind: 'bot' as const } : {}),
    ...(u.id === selfId ? { isSelf: true } : {}),
  })

  /** The chat as the node of an event: what the dialogs know, else what the id says. */
  const roomOf = (chat: { id: string; title?: string; kind?: TgChat['kind']; forum?: boolean }) => {
    const known = chats.get(connectionId, chat.id)
    return chatNode({
      id: chat.id,
      kind: known?.kind ?? chat.kind ?? kindOfChatId(chat.id),
      title: known?.title ?? (chat.title === '' ? undefined : chat.title),
      forum: known?.forum ?? chat.forum ?? false,
      admin: known?.admin ?? true,
    })
  }

  function onMember(u: TgMemberUpdate): void {
    if (!accepts({ chat: u.chat })) return
    const type =
      u.type === 'joined' || u.type === 'added'
        ? 'member.joined'
        : u.type === 'left' || u.type === 'kicked'
          ? 'member.left'
          : u.type === 'unkicked'
            ? undefined
            : 'member.updated'
    if (type === undefined) return
    const role =
      u.status === 'creator'
        ? ('owner' as const)
        : u.status === 'admin'
          ? ('admin' as const)
          : u.status === 'left' || u.status === 'banned'
            ? ('none' as const)
            : ('member' as const)
    if (!remember(`cm:${u.chat.id}:${u.user.id}:${u.type}:${u.at}`)) return
    inLane(u.chat.id, async () => {
      const room = roomOf(u.chat)
      await deliver({
        type,
        dedupeKey: `tgu:cm:${u.chat.id}:${u.user.id}:${u.type}:${u.at}`,
        at: u.at,
        node: { nativeId: room.nativeId, chain: [room] },
        actor: identityOfTg(u.user),
        ...(u.actor === undefined ? {} : { by: identityOfTg(u.actor) }),
        role,
      })
    })
  }

  function onJoinRequests(u: TgJoinRequestsUpdate): void {
    const known = chats.get(connectionId, u.chat.id)
    const title = known?.title ?? u.chat.title
    // every requester is saved (the tools list them); the ones that are new announce themselves
    const fresh: TgUser[] = []
    for (const user of u.users) {
      const isNew = joinRequests.note({
        chatId: u.chat.id,
        chatTitle: title,
        userId: user.id,
        name: user.name,
        ...(user.username === undefined ? {} : { username: user.username }),
        at: u.at,
      })
      if (isNew) fresh.push(user)
    }
    if (fresh.length === 0 || !accepts({ chat: u.chat })) return
    inLane(u.chat.id, async () => {
      const room = roomOf({ ...u.chat, title })
      for (const user of fresh) {
        await deliver({
          type: 'member.join_requested',
          dedupeKey: `tgu:jr:${u.chat.id}:${user.id}:${u.at}`,
          at: u.at,
          node: { nativeId: room.nativeId, chain: [room] },
          actor: identityOfTg(user),
          request: { pending: u.total },
        })
      }
    })
  }

  /** Requests answered by a tool: resolve the saved ones and tell the gateway. */
  function joinAnswered(a: {
    chatId: string
    resolution: JoinResolution
    users?: string[]
    link?: string
  }): void {
    const pending = joinRequests
      .list(a.chatId)
      .filter(
        (r) =>
          (a.users === undefined || a.users.includes(r.userId)) &&
          (a.link === undefined || r.link === a.link),
      )
    for (const r of pending) {
      joinRequests.resolve(r.chatId, r.userId, a.resolution, 'this account')
      inLane(a.chatId, async () => {
        const room = roomOf({ id: a.chatId, title: r.chatTitle })
        await deliver({
          type: 'member.join_request_resolved',
          dedupeKey: `tgu:jr-resolved:${r.chatId}:${r.userId}:${r.at}:${a.resolution}`,
          at: now(),
          node: { nativeId: room.nativeId, chain: [room] },
          actor: {
            id: r.userId,
            name: r.name,
            ...(r.username === undefined ? {} : { username: r.username }),
          },
          resolution: a.resolution,
          bySelf: true,
        })
      })
    }
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

  /** The account has a conversation with this person (the dialog list, read again once if it is not there). */
  async function hasConversation(chat: string): Promise<boolean> {
    if ((await dialogs()).some((d) => d.id === chat)) return true
    return (await dialogs(true)).some((d) => d.id === chat)
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
      if (!(await hasConversation(chat))) {
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

  /**
   * What the model wrote, as Telegram HTML: the same Markdown subset the bot transport renders
   * (bold, italic, code, links, lists), and the gateway's mention tokens as `@handle` when the person
   * has a username (Telegram pings and links it) or a `tg://user` link by id otherwise.
   */
  function renderForTelegram(text: string): { html: string; handles: string[] } {
    const handles: string[] = []
    let out = ''
    let at = 0
    for (const m of parseMentions(text)) {
      const handle = host?.usernameOf?.(m.id)
      if (handle === undefined || handle === '') continue
      out += `${text.slice(at, m.start)}@${handle}`
      handles.push(handle)
      at = m.end
    }
    return { html: toTelegramHtml(out + text.slice(at)), handles }
  }

  async function send(node: ChannelNode, message: OutboundMessage): Promise<SentMessage> {
    await guardSend(node)
    const chat = targetOf(node).chat
    try {
      const rendered = renderForTelegram(message.text)
      const sent =
        message.files !== undefined && message.files.length > 0
          ? await client.sendFiles(
              chat,
              message.files,
              plainMentions(message.text),
              sendOptions(node, message),
            )
          : await client.sendText(chat, rendered.html, {
              ...sendOptions(node, message),
              html: { handles: rendered.handles },
            })
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

  /** Park check and error mapping for a platform action (a flood wait parks the chat and is seen by the governor). */
  const callFor = async <T>(chatId: string | undefined, fn: () => Promise<T>): Promise<T> => {
    const parked = chatId === undefined ? undefined : parkedUntil(chatId)
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
      throw toChannelError(error, chatId)
    }
  }

  // the platform layer of the account (`actions.ts`): what MTProto can do beyond the generic tools
  const actions: NativeAction[] = accountActions({
    connectionId,
    client,
    chats,
    counters,
    settings: options.settings,
    selfId,
    dialogs,
    call: callFor,
    blocked: () => options.blocked?.(),
    learnTopics: (chat, list) => learnTopics(chat, list),
    timezone: () => options.timezone?.() ?? 'UTC',
    now,
    ...(options.readFile === undefined ? {} : { readFile: options.readFile }),
    ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
    joinRequests,
    joinAnswered: (a) => joinAnswered(a),
    hooks,
  })

  const adapter: TelegramUserAdapter = {
    platform: 'telegram-user',
    actsAs: 'user',
    connectionId,
    idFormats: USER_ID_FORMATS,
    self: () => self,
    actions,
    noResultHint: (nativeId) => {
      const c = chats.get(connectionId, splitNativeId(nativeId).chatId)
      return c?.admin && c.kind !== 'dm' ? DELETED_HINT : undefined
    },
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
          member: onMember,
          joinRequests: onJoinRequests,
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
      guarded(node, () => {
        const rendered = renderForTelegram(text)
        return client.editText(targetOf(node).chat, Number(nativeId), rendered.html, {
          handles: rendered.handles,
        })
      }),
    delete: (node, nativeId) =>
      guarded(node, () => client.deleteMessages(targetOf(node).chat, [Number(nativeId)])),
    pin: (node, nativeId, pinned) =>
      guarded(node, () => client.pin(targetOf(node).chat, Number(nativeId), pinned)),
    react: (node, nativeId, emoji) =>
      guarded(node, () => client.react(targetOf(node).chat, Number(nativeId), emoji)),
    async fetchHistory(node, o): Promise<HistoryEntry[]> {
      const { chat, topic } = targetOf(node)
      // a topic of a forum: only its messages; General (topic 0) is the chat's history without a topic
      const general = node.kind === 'thread' && topic === undefined
      const page = await guarded(node, () =>
        client.history(chat, {
          limit: Math.min(o.limit, 100),
          ...(o.before === undefined ? {} : { offsetId: Number(o.before) }),
          ...(topic === undefined ? {} : { topicId: topic }),
        }),
      )
      const mine = general ? page.filter((m) => m.topicId === undefined || m.topicId === 1) : page
      return mine.map(historyEntryOf).reverse()
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
    // the generic history tools ask for older messages when a window starts before the log
    async requestBackfill(node, days) {
      if (hooks.backfill === undefined) return 'Backfill is not available for this account.'
      return hooks.backfill(targetOf(node).chat, days)
    },
    async fetchAttachment(node, messageNativeId) {
      return guarded(node, () => client.download(targetOf(node).chat, Number(messageNativeId)))
    },
    async canDirectMessage(identityNativeId) {
      try {
        return await hasConversation(identityNativeId)
      } catch {
        // the dialog list could not be read: do not claim there is none
        return true
      }
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
