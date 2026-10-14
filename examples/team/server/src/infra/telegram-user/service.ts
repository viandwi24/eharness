/**
 * Telegram user accounts (P41 L4): the runtime that keeps one live MTProto client per connected,
 * bound "Telegram account" connection, and the admin service behind the Channels page.
 *
 * - **One live client per session.** A DB lease (`tgu_leases`) is taken before a client starts and
 *   renewed while it runs; a second process finds it taken and does not start (`lease` state):
 *   Telegram kills a session used from two places (AUTH_KEY_DUPLICATED).
 * - **Session lost** (AUTH_KEY_UNREGISTERED, SESSION_REVOKED, USER_DEACTIVATED, AUTH_KEY_DUPLICATED):
 *   the connection is marked `needs-auth`, a bell rings, every job of the connection stops.
 * - Chats are chosen explicitly (`selected`); a chosen chat starts observe-only (`wake: never`).
 * - Backfill, gap fill, admin log and the collector live in their own modules; this file wires them.
 */
import type { Database } from 'bun:sqlite'
import type { ConnectionCredentials, ConnectionRecord } from 'eharness/connectors'
import type { ChannelAccountsPort, ChannelsPort } from '../../app/ports.ts'
import type { AgentDef } from '../../domain/agents.ts'
import type {
  ChannelAccountChatState,
  ChannelAccountView,
  ChannelBindInput,
  ChannelConnectionView,
  ChannelLimitsInput,
  ChannelNodeView,
  ChannelPolicyInput,
  ChannelRuntimeState,
} from '../../domain/channels.ts'
import type { Collector } from '../../domain/collectors.ts'
import { conflict, invalid, notFound } from '../../domain/errors.ts'
import type { ChannelGateway } from '../channels/index.ts'
import { listNodeViews, nodeView, pageNodeViews, writePolicy } from '../channels/node-views.ts'
import { type ConnectionConfig, RateLimitsSchema, type ScopePolicy } from '../channels/policy.ts'
import { createTelegramUserAdapter, type TelegramUserAdapter, type UserFatal } from './adapter.ts'
import { type AdminLog, createAdminLog, eventText } from './adminlog.ts'
import { type Backfill, createBackfill } from './backfill.ts'
import type { TgAdminEvent, TgClientFactory, TgMessage, TgUserClient } from './client.ts'
import { ADMIN_EVENT_PREFIX, collectorId, telegramUserCollector } from './collector.ts'
import {
  SESSION_FORMAT,
  TELEGRAM_USER_CONNECTOR_ID,
  type TelegramApp,
  type UserConnectionSettings,
} from './connector.ts'
import { classifyError, describeError } from './errors.ts'
import { governJobClient } from './governed-client.ts'
import { chainOfMessage, normalizeMessage } from './normalize.ts'
import {
  type AccountSettings,
  AccountSettingsSchema,
  type ChatStore,
  nodeChatStore,
  sqliteCounterStore,
  sqliteLeaseStore,
  sqliteSettingsStore,
  type UserChat,
} from './store.ts'

/** Stricter than the bot: a user account that talks like a robot gets limited. */
export const USER_RATE_DEFAULTS = {
  chatMinIntervalMs: 3000,
  groupMax: 10,
  groupWindowMs: 60_000,
  connectionMax: 15,
  connectionWindowMs: 60_000,
  maxWaitMs: 300_000,
  breakerCooldownMs: 900_000,
} as const

/** The send limits a new account starts with (the account card shows "default N" beside each value). */
export function accountLimitDefaults(): ChannelAccountView['limits'] {
  const s = AccountSettingsSchema.parse({})
  return {
    dmDailyMax: s.dmDailyMax,
    dailyMax: s.dailyMax,
    adminLogEveryMs: s.adminLogEveryMs,
    chatMinIntervalMs: USER_RATE_DEFAULTS.chatMinIntervalMs,
    groupMax: USER_RATE_DEFAULTS.groupMax,
    groupWindowMs: USER_RATE_DEFAULTS.groupWindowMs,
    connectionMax: USER_RATE_DEFAULTS.connectionMax,
    connectionWindowMs: USER_RATE_DEFAULTS.connectionWindowMs,
  }
}

export interface TelegramUserOptions {
  sqlite: Database
  gateway: ChannelGateway
  connectors: {
    stores: {
      connections: {
        list(q?: { definitionId?: string }): Promise<ConnectionRecord[]>
        get(id: string): Promise<ConnectionRecord | undefined>
      }
    }
    rev(): number
    markNeedsAuth(connectionId: string, message?: string): Promise<void>
    credentialsOf(connectionId: string): Promise<ConnectionCredentials | undefined>
    telegramApp(): Promise<TelegramApp | undefined>
  }
  agents: { get(id: string): AgentDef | undefined }
  clientFactory: TgClientFactory
  /** This process (the lease owner). */
  instanceId: string
  /** Registers the big-data source of an account's observe-only chats. */
  collectors?: { add(c: Collector): void; remove(id: string): void }
  notify?(n: { key: string; title: string; body: string; agentId: string | null }): void
  /** Lease lifetime (ms, default 60 000); renewed every third of it. */
  leaseTtlMs?: number
  syncPollMs?: number
  retryMs?: number
  /** Backfill and admin log timing (tests shorten and stub it). */
  jobs?: {
    sleep?: (ms: number) => Promise<void>
    random?: () => number
    pageDelayMs?: { min: number; max: number }
    /** 0 = no background loop (tests call the jobs through the admin methods). */
    backfillEveryMs?: number
    adminLogTickMs?: number
    gapWindowMs?: number
  }
  warn?(message: string): void
  now?(): number
}

export interface TelegramUserChannels extends ChannelsPort, ChannelAccountsPort {
  start(): void
  sync(): Promise<void>
  stop(): Promise<void>
  /** Is this connection a user account (routing of the composite port). */
  owns(id: string): Promise<boolean>
  chatsStore: ChatStore
  /** Run the backfill and gap fill now until nothing is runnable (tests, "run now"). */
  runJobs(id: string): Promise<void>
}

interface Entry {
  state: ChannelRuntimeState
  message?: string
  since: number
  client?: TgUserClient
  adapter?: TelegramUserAdapter
  backfill?: Backfill
  adminLog?: AdminLog
  leaseTimer?: ReturnType<typeof setInterval>
  /** Fingerprint of the session the running client uses (a changed session restarts it). */
  fingerprint?: string
  retry?: ReturnType<typeof setTimeout>
  me?: { id: string; username?: string; phone?: string }
  blocked?: string
  lastFloodAt?: number
  pausedUntil?: number
  collectorId?: string
}

const fingerprintOf = async (session: string): Promise<string> => {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(session))
  return Array.from(new Uint8Array(d).slice(0, 8), (b) => b.toString(16).padStart(2, '0')).join('')
}

const maskPhone = (phone: string | undefined): string | undefined => {
  if (phone === undefined) return undefined
  const digits = phone.replace(/\D/g, '')
  if (digits.length < 6) return '••••'
  return `+${digits.slice(0, 2)}${'•'.repeat(Math.max(2, digits.length - 6))}${digits.slice(-4)}`
}

export function createTelegramUserChannels(options: TelegramUserOptions): TelegramUserChannels {
  const { gateway, sqlite } = options
  const now = options.now ?? (() => Date.now())
  const warn = options.warn ?? ((m) => console.warn(`team: ${m}`))
  const chats = nodeChatStore({
    sqlite,
    nodes: gateway.nodes,
    allowed: (node) => gateway.settings.resolve(node.id)?.allowed === true,
  })
  const leases = sqliteLeaseStore(sqlite)
  const counters = sqliteCounterStore(sqlite)
  const settings = sqliteSettingsStore(sqlite)
  const leaseTtl = options.leaseTtlMs ?? 60_000
  const entries = new Map<string, Entry>()
  let stopped = false
  let lastRev = -1
  let poller: ReturnType<typeof setInterval> | undefined
  let chain: Promise<void> = Promise.resolve()

  const entryOf = (id: string): Entry => {
    let e = entries.get(id)
    if (e === undefined) {
      e = { state: 'stopped', since: now() }
      entries.set(id, e)
    }
    return e
  }
  const setState = (e: Entry, state: ChannelRuntimeState, message?: string): void => {
    if (e.state !== state) e.since = now()
    e.state = state
    if (message === undefined) delete e.message
    else e.message = message
  }
  const listRecords = (): Promise<ConnectionRecord[]> =>
    options.connectors.stores.connections.list({ definitionId: TELEGRAM_USER_CONNECTOR_ID })
  const recordOf = async (id: string): Promise<ConnectionRecord> => {
    const r = await options.connectors.stores.connections.get(id)
    if (r === undefined || r.definitionId !== TELEGRAM_USER_CONNECTOR_ID) {
      throw notFound('Telegram account', id)
    }
    return r
  }
  const notify = (id: string, key: string, title: string, body: string): void => {
    options.notify?.({ key, title, body, agentId: gateway.config(id)?.agentId ?? null })
  }

  const allowedChat = (id: string, chatId: string): boolean => chats.isSelected(id, chatId)

  // --- storing history and admin events (no wake, ever) -----------------------------------------

  const noFetch = (): (() => Promise<{ bytes: Uint8Array }>) => async () => {
    throw new Error('attachments of history are not downloaded')
  }

  async function ingestHistory(id: string, m: TgMessage): Promise<boolean> {
    const selfId = entries.get(id)?.me?.id ?? ''
    return gateway.ingest(id, normalizeMessage(m, { selfId, fetch: noFetch }))
  }

  async function recordAdminEvent(id: string, chatId: string, ev: TgAdminEvent): Promise<boolean> {
    const known = chats.get(id, chatId)
    const chain = chainOfMessage({
      chat: {
        id: chatId,
        kind: known?.kind ?? 'group',
        title: known?.title ?? chatId,
        forum: false,
        ...(known?.username === undefined ? {} : { username: known.username }),
      },
      id: 0,
      at: ev.at,
      text: '',
      outgoing: false,
      mention: false,
      mentionsOthers: false,
      attachments: [],
      service: false,
    })
    const inserted = await gateway.ingest(id, {
      type: 'message.created',
      dedupeKey: `tgu:admin:${chatId}:${ev.id}`,
      at: ev.at,
      node: { nativeId: chatId, chain },
      message: {
        nativeId: `${ADMIN_EVENT_PREFIX}${ev.id}`,
        sender:
          ev.actor === undefined
            ? { id: 'unknown', name: 'Unknown' }
            : { id: ev.actor.id, name: ev.actor.name },
        text: eventText(ev),
        attachments: [],
        kind: 'system',
      },
      signals: { mentionedSelf: false, replyToSelf: false },
    })
    if (inserted && ev.kind === 'delete' && ev.messageId !== undefined) {
      // the message is gone: mark the one we may have stored (the event text keeps what it said)
      const room = gateway.nodes.byNative(id, chatId)
      for (const f of gateway.log.locate(id, [String(ev.messageId)])) {
        const n = gateway.nodes.get(f.nodeId)
        if (n === undefined || room === undefined || !n.path.startsWith(room.path)) continue
        gateway.log.recordDeleted(f.nodeId, [f.nativeId], ev.at, {
          redact: gateway.settings.resolve(f.nodeId)?.redactOnDelete === true,
        })
      }
    }
    return inserted
  }

  // --- runtime ----------------------------------------------------------------------------------

  async function halt(id: string): Promise<void> {
    const e = entries.get(id)
    if (e === undefined) return
    if (e.retry !== undefined) clearTimeout(e.retry)
    delete e.retry
    if (e.leaseTimer !== undefined) clearInterval(e.leaseTimer)
    delete e.leaseTimer
    await e.backfill?.stop().catch(() => undefined)
    await e.adminLog?.stop().catch(() => undefined)
    delete e.backfill
    delete e.adminLog
    if (e.adapter !== undefined || e.client !== undefined) {
      // a start that failed before the adapter existed still owns an open client: close it, or the
      // next attempt would run two clients on one session (AUTH_KEY_DUPLICATED)
      const orphan = e.adapter === undefined ? e.client : undefined
      delete e.adapter
      delete e.client
      await orphan?.stop().catch(() => undefined)
      await gateway.unregister(id).catch(() => undefined)
      leases.release(id, options.instanceId)
    }
    if (e.collectorId !== undefined) {
      options.collectors?.remove(e.collectorId)
      delete e.collectorId
    }
    delete e.fingerprint
  }

  async function authFailed(
    id: string,
    fatal: UserFatal | { kind: 'auth-lost'; text: string },
  ): Promise<void> {
    const e = entryOf(id)
    const message = describeError(
      fatal.kind === 'duplicated'
        ? { kind: 'duplicated', text: fatal.text }
        : { kind: 'auth-lost', text: fatal.text },
    )
    const record = await options.connectors.stores.connections.get(id)
    await halt(id)
    setState(e, 'needs-auth', message)
    await options.connectors.markNeedsAuth(id, message).catch(() => undefined)
    gateway.activity.record({ connectionId: id, type: 'needs-auth', reason: fatal.kind })
    notify(
      id,
      `channel-auth:${id}`,
      `Telegram account ${record?.label ?? id} needs a new sign-in`,
      message,
    )
  }

  function onFatal(id: string, fatal: UserFatal): void {
    const e = entryOf(id)
    switch (fatal.kind) {
      case 'auth-lost':
      case 'duplicated':
        void authFailed(id, fatal).catch(() => undefined)
        return
      case 'peer-flood':
      case 'flood-storm': {
        const message =
          fatal.kind === 'peer-flood'
            ? 'Telegram flagged this account for sending too many messages to people (PEER_FLOOD). Sending is paused until you reset it. Check the account in the Telegram app and consider appealing at recover@telegram.org.'
            : `Telegram keeps rate limiting this account (${fatal.text}). Sending is paused until you reset it.`
        e.blocked = message
        notify(
          id,
          `channel-flood:${id}:${new Date(now()).toISOString().slice(0, 13)}`,
          `Telegram account ${id} stopped sending`,
          message,
        )
        return
      }
      default:
        warn(`telegram-user: ${id}: ${fatal.text}`)
    }
  }

  function scheduleRetry(id: string): void {
    const ms = options.retryMs ?? 30_000
    const e = entryOf(id)
    if (ms <= 0 || stopped) return
    if (e.retry !== undefined) clearTimeout(e.retry)
    e.retry = setTimeout(() => {
      delete e.retry
      void sync().catch(() => undefined)
    }, ms)
    ;(e.retry as { unref?: () => void }).unref?.()
  }

  async function startOne(record: ConnectionRecord, session: string): Promise<void> {
    const id = record.id
    const e = entryOf(id)
    setState(e, 'starting')
    const app = await options.connectors.telegramApp()
    if (app === undefined) {
      setState(e, 'error', 'The Telegram api_id and api_hash are not configured for the workspace.')
      return
    }
    if (!leases.acquire(id, options.instanceId, leaseTtl, now())) {
      const held = leases.holder(id, now())
      setState(
        e,
        'lease',
        `Another process runs this account${held === undefined ? '' : ` (its claim lasts until ${new Date(held.expiresAt).toISOString()})`}. Only one process may hold a Telegram session; it is not started here.`,
      )
      scheduleRetry(id)
      return
    }
    const client = options.clientFactory({ apiId: app.apiId, apiHash: app.apiHash, session })
    e.client = client
    try {
      const me = await client.getMe()
      e.me = {
        id: me.id,
        ...(me.username === undefined ? {} : { username: me.username }),
        ...(me.phone === undefined ? {} : { phone: me.phone }),
      }
      // the chats chosen while connecting; later changes are made on the Channels page
      const saved = (record.settings as UserConnectionSettings).chats ?? []
      for (const c of saved) {
        const had = chats.get(id, c.id)
        chats.upsertDialog(
          id,
          {
            id: c.id,
            kind: c.kind as 'group' | 'channel',
            title: c.title,
            forum: c.forum,
            admin: c.admin,
          },
          now(),
        )
        // a chat chosen while connecting is in the allowlist, observe-only
        if (had === undefined) chats.setSelected(id, c.id, true, now())
      }
      chats.recover(id, now())
      const adapter = createTelegramUserAdapter({
        connectionId: id,
        client,
        // topic titles are background reads: through the governor, like the backfill
        topicClient: governJobClient(client, gateway.governor, id),
        // times the platform actions show: the team clock
        timezone: () => gateway.timezone(),
        me,
        chats,
        counters,
        settings: () => settings.get(id),
        blocked: () => e.blocked,
        ...(options.now === undefined ? {} : { now: options.now }),
        ...(options.jobs?.random === undefined ? {} : { random: options.jobs.random }),
        hooks: {
          onFatal: (f) => onFatal(id, f),
          onFlood: (info) => {
            e.lastFloodAt = now()
            warn(`telegram-user: ${id} flood wait ${info.seconds}s (${info.text})`)
          },
          adminLogText: (chatId, limit) => adminLogText(id, chatId, limit),
          // agent tools of the account (`list_dialogs`, `choose_chat`, `backfill`): the same
          // effect as the Channels page, chosen chats stay observe-only
          dialogsSeen: (list) => {
            for (const d of list) if (d.kind !== 'dm') chats.upsertDialog(id, d, now())
          },
          chatsChanged: () => {
            void adapter
              .dialogs(true)
              .then((list) => {
                for (const d of list) if (d.kind !== 'dm') chats.upsertDialog(id, d, now())
              })
              .catch(() => undefined)
          },
          chooseChat: async (chatId, days) => {
            const d = (await adapter.dialogs(true)).find((x) => x.id === chatId)
            if (d === undefined) {
              return `ERROR: ${chatId} is not a group or channel of this account. list_dialogs shows the ones it is in; a chat joined seconds ago may need a moment.`
            }
            if (d.kind === 'dm') {
              return 'ERROR: that is a person, not a group or channel. People reach the agent through linking on the Channels page.'
            }
            chats.upsertDialog(id, d, now())
            const was = chats.isSelected(id, chatId)
            if (!was) chats.setSelected(id, chatId, true, now())
            if (days > 0) chats.setBackfillDays(id, chatId, days, now())
            void e.backfill?.runUntilIdle().catch(() => undefined)
            return `${was ? 'Already chosen' : 'Chosen'}: "${d.title}" (${chatId}), observe-only (stored and readable; no wake, no posting on its own).${days > 0 ? ` Reading its history back ${days} day(s) in the background through the rate-limit queue: it fills in over minutes, check with channel_read or chat_history.` : ' No history is read: only messages from now on.'}`
          },
          backfill: async (chatId, days) => {
            if (!chats.isSelected(id, chatId)) {
              return `ERROR: ${chatId} is not chosen for ingest. Choose it first with choose_chat (with backfill_days).`
            }
            chats.setBackfillDays(id, chatId, days, now())
            void e.backfill?.runUntilIdle().catch(() => undefined)
            return `Reading the history of ${chats.get(id, chatId)?.title ?? chatId} back ${days} day(s) in the background through the rate-limit queue. It fills in over minutes; check with channel_read or chat_history.`
          },
          warn,
        },
      })
      e.adapter = adapter
      e.fingerprint = await fingerprintOf(session)
      await gateway.register(adapter)
      const jobHooks = {
        onFatal: (f: UserFatal) => onFatal(id, f),
        onPark: (chatId: string, until: number, text: string) => {
          adapter.parkChat(chatId, until)
          e.lastFloodAt = now()
          warn(
            `telegram-user: ${id} chat ${chatId} parked until ${new Date(until).toISOString()} (${text})`,
          )
        },
        onStorm: (until: number, text: string) => {
          e.pausedUntil = until
          notify(
            id,
            `channel-flood:${id}:${new Date(now()).toISOString().slice(0, 13)}`,
            `Telegram account ${record.label} is being rate limited`,
            `${text}. Background history jobs are paused until ${new Date(until).toISOString()}.`,
          )
        },
        warn,
      }
      const j = options.jobs ?? {}
      // the jobs read through the connection's API governor (shared park state with sends and tools)
      const jobClient = governJobClient(client, gateway.governor, id)
      e.backfill = createBackfill({
        connectionId: id,
        client: jobClient,
        chats,
        ingest: (m) => ingestHistory(id, m),
        allowed: (chatId) => allowedChat(id, chatId),
        hooks: jobHooks,
        ...(options.now === undefined ? {} : { now: options.now }),
        ...(j.sleep === undefined ? {} : { sleep: j.sleep }),
        ...(j.random === undefined ? {} : { random: j.random }),
        ...(j.pageDelayMs === undefined ? {} : { pageDelayMs: j.pageDelayMs }),
        ...(j.gapWindowMs === undefined ? {} : { gapWindowMs: j.gapWindowMs }),
      })
      e.adminLog = createAdminLog({
        connectionId: id,
        client: jobClient,
        chats,
        record: (chatId, ev) => recordAdminEvent(id, chatId, ev),
        allowed: (chatId) => allowedChat(id, chatId),
        everyMs: () => settings.get(id).adminLogEveryMs,
        hooks: jobHooks,
        ...(options.now === undefined ? {} : { now: options.now }),
        ...(j.sleep === undefined ? {} : { sleep: j.sleep }),
        ...(j.random === undefined ? {} : { random: j.random }),
      })
      e.backfill.queueGapFill()
      // chats joined while the server was down are listed on the Channels page (not chosen); this
      // also fills mtcute's peer cache, which lives in memory only
      void adapter
        .dialogs(true)
        .then((list) => {
          for (const d of list) if (d.kind !== 'dm') chats.upsertDialog(id, d, now())
        })
        .catch((error) => warn(`telegram-user: dialogs of ${id} not read: ${String(error)}`))
      if (j.backfillEveryMs !== 0) e.backfill.start(j.backfillEveryMs)
      if (j.adminLogTickMs !== 0) e.adminLog.start(j.adminLogTickMs)
      e.leaseTimer = setInterval(
        () => {
          if (!leases.acquire(id, options.instanceId, leaseTtl, now())) {
            void halt(id).then(() => {
              setState(
                e,
                'lease',
                'The session lease was taken by another process: this one stopped.',
              )
            })
          }
        },
        Math.max(1000, Math.floor(leaseTtl / 3)),
      )
      ;(e.leaseTimer as { unref?: () => void }).unref?.()
      if (options.collectors !== undefined) {
        const source = telegramUserCollector({
          connectionId: id,
          log: gateway.log,
          nodes: gateway.nodes,
          scopeOf: (nodeId) => gateway.settings.resolve(nodeId),
        })
        options.collectors.add(source)
        e.collectorId = source.id
      }
      setState(e, 'running')
    } catch (error) {
      const k = classifyError(error)
      await halt(id)
      if (k.kind === 'auth-lost' || k.kind === 'duplicated') {
        await authFailed(id, { kind: k.kind, text: k.text })
        return
      }
      setState(e, 'error', describeError(k))
      scheduleRetry(id)
    }
  }

  async function doSync(): Promise<void> {
    if (stopped) return
    lastRev = options.connectors.rev()
    const records = await listRecords()
    const seen = new Set<string>()
    for (const record of records) {
      const id = record.id
      seen.add(id)
      const e = entryOf(id)
      const creds = await options.connectors.credentialsOf(id)
      const session = creds?.session?.format === SESSION_FORMAT ? creds.session.data : undefined
      if (!record.enabled) {
        await halt(id)
        setState(e, 'disabled')
        continue
      }
      if (record.status === 'needs-auth' || session === undefined) {
        await halt(id)
        setState(e, 'needs-auth', record.statusMessage ?? 'Sign in again to connect this account.')
        continue
      }
      if (gateway.config(id) === undefined) {
        await halt(id)
        setState(e, 'unbound')
        continue
      }
      const fp = await fingerprintOf(session)
      if (e.adapter !== undefined && e.fingerprint === fp) continue
      if (e.adapter !== undefined) await halt(id)
      await startOne(record, session)
    }
    for (const id of [...entries.keys()]) {
      if (seen.has(id)) continue
      await halt(id)
      entries.delete(id)
    }
  }

  function sync(): Promise<void> {
    chain = chain.catch(() => undefined).then(doSync)
    return chain
  }

  // --- views ------------------------------------------------------------------------------------

  const accountState = (c: UserChat): ChannelAccountChatState => ({
    selected: c.selected,
    admin: c.admin,
    backfill: {
      days: c.backfillDays ?? null,
      state: c.backfillState,
      ...(c.backfillOldestAt === undefined ? {} : { oldestAt: c.backfillOldestAt }),
      count: c.backfillCount,
      ...(c.backfillError === undefined ? {} : { error: c.backfillError }),
      ...(c.parkedUntil !== undefined && c.parkedUntil > now()
        ? { parkedUntil: c.parkedUntil }
        : {}),
    },
    adminLog: {
      enabled: c.adminLogEnabled,
      ...(c.adminLogLastAt === undefined ? {} : { lastAt: c.adminLogLastAt }),
      count: c.adminLogCount,
      ...(c.adminLogError === undefined ? {} : { error: c.adminLogError }),
    },
  })

  /** The node view of a chat of the account, with its jobs. */
  function chatView(chat: UserChat): ChannelNodeView {
    const node = gateway.nodes.get(chat.nodeId)
    return nodeView(gateway, node as NonNullable<typeof node>, {
      account: accountState(chat),
    }) as ChannelNodeView
  }

  function adminLogText(id: string, chatId: string, limit: number): string {
    const room = gateway.nodes.byNative(id, chatId)
    if (room === undefined) return ''
    const rows = sqlite
      .query<{ n: number }, [string, string, string]>(
        `SELECT COUNT(*) AS n FROM ch_messages m JOIN ch_nodes n ON n.id = m.node_id
           WHERE m.connection_id = ? AND m.kind = 'system' AND (n.path = ? OR n.path LIKE ?)`,
      )
      .get(id, room.path, `${room.path}/%`)
    if ((rows?.n ?? 0) === 0) return ''
    void limit
    return `${rows?.n} admin log events are stored for this chat; read them with channel_read on conversation ${chatId} (rows start with "[admin log]").`
  }

  async function viewOf(record: ConnectionRecord): Promise<ChannelConnectionView> {
    const id = record.id
    const e = entries.get(id) ?? { state: 'stopped' as const, since: now() }
    const config = gateway.config(id)
    const counts = gateway.outbox.counts(id)
    const breaker = gateway.outbound.breaker(id)
    const s = settings.get(id)
    const rate = config?.rate ?? RateLimitsSchema.parse(USER_RATE_DEFAULTS)
    const stats = e.adapter?.stats() ?? { events: 0, lastEventAt: undefined, unresolvedDeletes: 0 }
    const list = chats.list(id)
    const saved = record.settings as UserConnectionSettings
    const warnings = [
      'Ban risk: Telegram may limit or ban accounts that an API client drives. Use a dedicated account with two-step verification, keep the limits low, and read the terms of the API before use.',
    ]
    if (e.blocked !== undefined) warnings.push(e.blocked)
    const retention = config?.defaults.retentionDays ?? 30
    for (const c of list) {
      if (
        c.backfillDays !== undefined &&
        c.backfillDays > (gateway.settings.resolve(c.nodeId)?.retentionDays ?? retention)
      ) {
        warnings.push(
          `The history window of "${c.title}" (${c.backfillDays} days) is longer than its retention: older messages are purged.`,
        )
      }
    }
    const account: ChannelAccountView = {
      ...((e.me?.id ?? saved.accountId) === undefined
        ? {}
        : { accountId: (e.me?.id ?? saved.accountId) as string }),
      ...((e.me?.username ?? saved.username) === undefined
        ? {}
        : { username: (e.me?.username ?? saved.username) as string }),
      ...(maskPhone(e.me?.phone ?? saved.phone) === undefined
        ? {}
        : { phone: maskPhone(e.me?.phone ?? saved.phone) as string }),
      limits: {
        dmDailyMax: s.dmDailyMax,
        dailyMax: s.dailyMax,
        adminLogEveryMs: s.adminLogEveryMs,
        chatMinIntervalMs: rate.chatMinIntervalMs,
        groupMax: rate.groupMax,
        groupWindowMs: rate.groupWindowMs,
        connectionMax: rate.connectionMax,
        connectionWindowMs: rate.connectionWindowMs,
      },
      limitDefaults: accountLimitDefaults(),
      today: { dm: counters.get(id, 'dm', now()), all: counters.get(id, 'all', now()) },
      floods: {
        ...(e.lastFloodAt === undefined ? {} : { lastAt: e.lastFloodAt }),
        parkedChats: list.filter((c) => c.parkedUntil !== undefined && c.parkedUntil > now())
          .length,
      },
      ...(e.backfill?.pausedUntil() === undefined
        ? {}
        : { pausedUntil: e.backfill.pausedUntil() as number }),
      source: collectorId(id),
      events: {
        live: stats.events,
        ...(stats.lastEventAt === undefined ? {} : { lastEventAt: stats.lastEventAt }),
        unresolvedDeletes: stats.unresolvedDeletes,
      },
      warnings,
    }
    return {
      id,
      platform: 'telegram',
      transport: 'user',
      label: record.label,
      ...(record.accountLabel === undefined ? {} : { accountLabel: record.accountLabel }),
      connectionStatus: record.status,
      ...(record.statusMessage === undefined ? {} : { statusMessage: record.statusMessage }),
      enabled: record.enabled,
      runtime: {
        state: e.state,
        ...(e.message === undefined ? {} : { message: e.message }),
        since: e.since,
      },
      account,
      binding:
        config === undefined
          ? null
          : {
              agentId: config.agentId,
              groupPolicy: config.groupPolicy,
              dm: config.dm,
              allowBots: config.allowBots,
              replyToUnknown: config.replyToUnknown,
              admins: config.admins,
              historyLimit: config.historyLimit,
              defaults: defaultsView(config),
            },
      counts: {
        chats: list.filter((c) => c.selected).length,
        linked: gateway.pairing.members(id).length,
        unlinked: gateway.unlinked.list(id).length,
        outboxPending: counts.pending + counts.sending,
        outboxFailed: counts.failed,
        outboxHeld: counts.held,
      },
      ...(breaker === undefined || !breaker.open ? {} : { breaker }),
    }
  }

  const defaultsView = (config: ConnectionConfig) => ({
    ...(config.defaults.wake === undefined ? {} : { wake: config.defaults.wake }),
    ...(config.defaults.delivery === undefined ? {} : { delivery: config.defaults.delivery }),
    ...(config.defaults.retentionDays === undefined
      ? {}
      : { retentionDays: config.defaults.retentionDays }),
    ...(config.defaults.observe === undefined ? {} : { observe: config.defaults.observe }),
    ...(config.defaults.sessionScope === undefined
      ? {}
      : { sessionScope: config.defaults.sessionScope }),
    ...(config.defaults.redactOnDelete === undefined
      ? {}
      : { redactOnDelete: config.defaults.redactOnDelete }),
  })

  // --- admin ------------------------------------------------------------------------------------

  const requireConfig = (id: string): ConnectionConfig => {
    const c = gateway.config(id)
    if (c === undefined) throw conflict('Bind this connection to an agent first.', 'NOT_BOUND')
    return c
  }
  const checkAgent = (agentId: string): void => {
    const a = options.agents.get(agentId)
    if (a === undefined || a.archivedAt !== null) throw invalid(`unknown agent: ${agentId}`)
  }
  /** The chat of a node id of this connection. */
  const chatOf = (id: string, nodeId: string): UserChat => {
    const node = gateway.nodes.get(nodeId)
    const c =
      node === undefined || node.connectionId !== id ? undefined : chats.get(id, node.nativeId)
    if (c === undefined) throw notFound('chat', nodeId)
    return c
  }
  const applyScope = (target: ScopePolicy, input: ChannelPolicyInput): ScopePolicy => {
    const next: Record<string, unknown> = { ...target }
    for (const key of [
      'enabled',
      'agentId',
      'wake',
      'delivery',
      'retentionDays',
      'observe',
      'sessionScope',
      'redactOnDelete',
    ] as const) {
      const value = input[key]
      if (value === undefined) continue
      if (value === null) delete next[key]
      else next[key] = value
    }
    if (typeof input.agentId === 'string') checkAgent(input.agentId)
    return next as ScopePolicy
  }

  const port: TelegramUserChannels = {
    chatsStore: chats,
    start() {
      stopped = false
      void sync().catch((e) => warn(`telegram-user: sync failed: ${String(e)}`))
      const every = options.syncPollMs ?? 1000
      if (every > 0) {
        poller = setInterval(() => {
          if (options.connectors.rev() !== lastRev) {
            void sync().catch((e) => warn(`telegram-user: sync failed: ${String(e)}`))
          }
        }, every)
        ;(poller as { unref?: () => void }).unref?.()
      }
    },
    sync,
    async stop() {
      stopped = true
      if (poller !== undefined) clearInterval(poller)
      await chain.catch(() => undefined)
      for (const id of [...entries.keys()]) await halt(id)
    },
    async owns(id) {
      const r = await options.connectors.stores.connections.get(id)
      return r?.definitionId === TELEGRAM_USER_CONNECTOR_ID
    },
    async runJobs(id) {
      await recordOf(id)
      await entries.get(id)?.backfill?.runUntilIdle()
    },
    async connections() {
      if (options.connectors.rev() !== lastRev) await sync()
      return Promise.all((await listRecords()).map(viewOf))
    },
    async connection(id) {
      if (options.connectors.rev() !== lastRev) await sync()
      return viewOf(await recordOf(id))
    },
    async bind(id, input: ChannelBindInput) {
      const record = await recordOf(id)
      checkAgent(input.agentId)
      if (input.groupPolicy === 'open') {
        throw invalid(
          'A user account only ingests the chats you choose: the open policy is not available.',
        )
      }
      const existing = gateway.config(id)
      gateway.configure({
        ...(existing ?? { rate: { ...USER_RATE_DEFAULTS } }),
        connectionId: id,
        agentId: input.agentId,
        groupPolicy: 'allowlist',
        ...(input.dm === undefined ? {} : { dm: input.dm }),
        ...(input.allowBots === undefined ? {} : { allowBots: input.allowBots }),
        ...(input.replyToUnknown === undefined ? {} : { replyToUnknown: input.replyToUnknown }),
        ...(input.admins === undefined ? {} : { admins: input.admins }),
        ...(input.historyLimit === undefined ? {} : { historyLimit: input.historyLimit }),
        ...(input.defaults === undefined
          ? {}
          : { defaults: applyScope(existing?.defaults ?? {}, input.defaults) }),
      })
      await sync()
      return viewOf(record)
    },
    async unbind(id) {
      const record = await recordOf(id)
      gateway.removeConnection(id)
      await sync()
      return viewOf(record)
    },
    async chats(id) {
      await recordOf(id)
      return listNodeViews(gateway, id, {
        account: (node) => {
          const c = node.kind === 'room' ? chats.get(id, node.nativeId) : undefined
          return c === undefined ? undefined : accountState(c)
        },
      })
    },
    async chatsTable(id, query) {
      await recordOf(id)
      return pageNodeViews(gateway, id, query, {
        account: (node) => {
          const c = node.kind === 'room' ? chats.get(id, node.nativeId) : undefined
          return c === undefined ? undefined : accountState(c)
        },
      })
    },
    async chat(id, nodeId) {
      await recordOf(id)
      const node = gateway.nodes.get(nodeId)
      if (node === undefined || node.connectionId !== id || node.kind === 'direct')
        throw notFound('chat', nodeId)
      const chat = node.kind === 'room' ? chats.get(id, node.nativeId) : undefined
      return nodeView(
        gateway,
        node,
        chat === undefined ? {} : { account: accountState(chat) },
      ) as ChannelNodeView
    },
    async setChatPolicy(id, nodeId, input) {
      await recordOf(id)
      requireConfig(id)
      const node = gateway.nodes.get(nodeId)
      if (node === undefined || node.connectionId !== id || node.kind === 'direct')
        throw notFound('chat', nodeId)
      writePolicy(gateway, node, input, checkAgent)
      const chat = node.kind === 'room' ? chats.get(id, node.nativeId) : undefined
      return nodeView(
        gateway,
        node,
        chat === undefined ? {} : { account: accountState(chat) },
      ) as ChannelNodeView
    },
    async links(id) {
      await recordOf(id)
      return gateway.pairing.members(id).map((l) => ({
        peerId: l.peerId,
        memberId: l.memberId,
        ...(l.name === null ? {} : { name: l.name }),
        linkedAt: l.linkedAt,
      }))
    },
    async revokeLink(id, peerId) {
      await recordOf(id)
      if (!gateway.pairing.unlink(id, peerId)) throw notFound('linked account', peerId)
    },
    async deleteWebhook() {
      throw conflict('A user account has no webhook.', 'NOT_A_BOT')
    },
    async restart(id) {
      const record = await recordOf(id)
      await halt(id)
      setState(entryOf(id), 'stopped')
      await sync()
      return viewOf(record)
    },
    async resetBreaker(id) {
      const record = await recordOf(id)
      gateway.outbound.reset(id)
      const e = entries.get(id)
      if (e !== undefined) {
        delete e.blocked
        delete e.pausedUntil
      }
      return viewOf(record)
    },
    async refreshChats(id) {
      await recordOf(id)
      const e = entries.get(id)
      if (e?.adapter === undefined || e.state !== 'running') {
        throw conflict(
          'The account is not running: bind it to an agent and wait until it is running.',
          'NOT_RUNNING',
        )
      }
      try {
        for (const d of await e.adapter.dialogs(true)) {
          // people are not chats to ingest: they reach the agent through linking
          if (d.kind !== 'dm') chats.upsertDialog(id, d, now())
        }
      } catch (error) {
        throw conflict(error instanceof Error ? error.message : String(error), 'TELEGRAM_ERROR')
      }
      return this.chats(id)
    },
    async selectChat(id, nodeId, selected) {
      await recordOf(id)
      requireConfig(id)
      const chat = chatOf(id, nodeId)
      chats.setSelected(id, chat.chatId, selected, now())
      if (!selected) {
        chats.setBackfillDays(id, chat.chatId, null, now())
        chats.setAdminLog(id, chat.chatId, false, now())
      }
      return chatView(chatOf(id, nodeId))
    },
    async setBackfill(id, nodeId, days) {
      await recordOf(id)
      const chat = chatOf(id, nodeId)
      if (!chat.selected) throw conflict('Choose the chat for ingest first.', 'NOT_SELECTED')
      if (days !== null && (!Number.isInteger(days) || days < 1 || days > 3650)) {
        throw invalid('days must be a whole number from 1 to 3650 (or null for no backfill)')
      }
      chats.setBackfillDays(id, chat.chatId, days, now())
      void entries
        .get(id)
        ?.backfill?.runUntilIdle()
        .catch(() => undefined)
      return chatView(chatOf(id, nodeId))
    },
    async setAdminLog(id, nodeId, enabled) {
      await recordOf(id)
      const chat = chatOf(id, nodeId)
      if (enabled && !chat.admin) {
        throw conflict(
          'The account is not an admin of this chat: Telegram only shows the admin log to admins.',
          'NOT_ADMIN',
        )
      }
      if (enabled && !chat.selected)
        throw conflict('Choose the chat for ingest first.', 'NOT_SELECTED')
      chats.setAdminLog(id, chat.chatId, enabled, now())
      return chatView(chatOf(id, nodeId))
    },
    async runAdminLog(id, force) {
      const record = await recordOf(id)
      await entries.get(id)?.adminLog?.runDue(force)
      return viewOf(record)
    },
    async setLimits(id, input: ChannelLimitsInput) {
      const record = await recordOf(id)
      const patch: Partial<AccountSettings> = {}
      if (input.dmDailyMax !== undefined) patch.dmDailyMax = input.dmDailyMax
      if (input.dailyMax !== undefined) patch.dailyMax = input.dailyMax
      if (input.adminLogEveryMs !== undefined) patch.adminLogEveryMs = input.adminLogEveryMs
      try {
        settings.set(id, patch, now())
      } catch {
        throw invalid('a limit is out of range')
      }
      const rateKeys = [
        'chatMinIntervalMs',
        'groupMax',
        'groupWindowMs',
        'connectionMax',
        'connectionWindowMs',
      ] as const
      const rate: Record<string, number> = {}
      for (const k of rateKeys) if (input[k] !== undefined) rate[k] = input[k] as number
      if (Object.keys(rate).length > 0) {
        const config = requireConfig(id)
        const merged = RateLimitsSchema.safeParse({ ...config.rate, ...rate })
        if (!merged.success) throw invalid('a rate limit is out of range')
        gateway.configure({ ...config, rate: merged.data })
      }
      return viewOf(record)
    },
  }
  return port
}

/** One `ChannelsPort` over the bot and the user transports: each connection goes to the service that owns it. */
export function compositeChannelsPort(
  bot: ChannelsPort,
  user: Pick<TelegramUserChannels, 'owns'> & ChannelsPort,
): ChannelsPort {
  const pick = async (id: string): Promise<ChannelsPort> => ((await user.owns(id)) ? user : bot)
  return {
    connections: async () => [...(await bot.connections()), ...(await user.connections())],
    connection: async (id) => (await pick(id)).connection(id),
    bind: async (id, input) => (await pick(id)).bind(id, input),
    unbind: async (id) => (await pick(id)).unbind(id),
    chats: async (id) => (await pick(id)).chats(id),
    chatsTable: async (id, query) => (await pick(id)).chatsTable(id, query),
    chat: async (id, nodeId) => (await pick(id)).chat(id, nodeId),
    setChatPolicy: async (id, nodeId, input) => (await pick(id)).setChatPolicy(id, nodeId, input),
    links: async (id) => (await pick(id)).links(id),
    revokeLink: async (id, peerId) => (await pick(id)).revokeLink(id, peerId),
    deleteWebhook: async (id) => (await pick(id)).deleteWebhook(id),
    restart: async (id) => (await pick(id)).restart(id),
    resetBreaker: async (id) => (await pick(id)).resetBreaker(id),
  }
}

/** The account port, delegating to a service built later. */
export function lazyAccountsPort(get: () => ChannelAccountsPort | undefined): ChannelAccountsPort {
  return new Proxy({} as ChannelAccountsPort, {
    get: (_t, name) => {
      const target = get()
      if (target === undefined) throw new Error('channels are not ready yet')
      return (target as unknown as Record<string | symbol, unknown>)[name]
    },
  })
}
