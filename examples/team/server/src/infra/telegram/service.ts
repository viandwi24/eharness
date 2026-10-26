/**
 * Telegram channels: the runtime that starts and stops one bot transport per connected, bound
 * connection, and the admin service behind the Channels page (`ChannelsPort`).
 *
 * A connection of the "Telegram bot" connector (`connector.ts`) is polled when it is connected,
 * enabled and bound to an agent (a gateway config exists). The runtime follows the connector
 * connections (a change bumps `connectors.rev()`) and the explicit calls of the admin service.
 * A rejected token (401) marks the connection `needs-auth` and raises a bell; other failures show
 * as `error` with a message and are retried.
 */
import type { Database } from 'bun:sqlite'
import type { ConnectionRecord } from 'eharness/connectors'
import type { ChannelsPort } from '../../app/ports.ts'
import type { AgentDef } from '../../domain/agents.ts'
import type {
  ChannelBindInput,
  ChannelConnectionView,
  ChannelPolicyInput,
  ChannelRuntimeState,
} from '../../domain/channels.ts'
import { conflict, invalid, notFound } from '../../domain/errors.ts'
import type { ChannelGateway } from '../channels/index.ts'
import { sqliteJoinRequestStore } from '../channels/join-requests.ts'
import {
  countChats,
  listNodeViews,
  nodeView,
  pageNodeViews,
  writePolicy,
} from '../channels/node-views.ts'
import { type ConnectionConfig, NO_OWNER, type ScopePolicy } from '../channels/policy.ts'
import {
  createTelegramAdapter,
  type TelegramAdapter,
  type TelegramBotInfo,
  type TelegramFailure,
  TelegramSetupError,
} from './adapter.ts'
import { privacyGuidance, TELEGRAM_CONNECTOR_ID } from './connector.ts'

export interface TelegramChannelsOptions {
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
  }
  agents: { get(id: string): AgentDef | undefined }
  notify?(n: { key: string; title: string; body: string; agentId: string | null }): void
  /** The bot token was rejected: an alarm for the owner (P54). */
  onNeedsAuth?(connectionId: string, label: string, message: string): void
  /** A background step failed (logged here too): a `system` alarm (P54). */
  problem?(step: string, error: unknown): void
  apiRoot?: string
  fetch?: typeof fetch
  /** Long-poll timeout (seconds, default 30). */
  pollTimeoutSec?: number
  /** How often the runtime looks for connection changes (ms, default 1000; 0 = only on explicit calls). */
  syncPollMs?: number
  /** Delay before a failed start is tried again (ms, default 30 000; 0 = never). */
  retryMs?: number
  warn?(message: string): void
  now?(): number
}

export interface TelegramChannels extends ChannelsPort {
  /** Follow the connector connections (initial pass, then on every change). */
  start(): void
  /** One pass now: start what should run, stop what should not. */
  sync(): Promise<void>
  stop(): Promise<void>
}

interface RuntimeEntry {
  state: ChannelRuntimeState
  message?: string
  since: number
  adapter?: TelegramAdapter
  bot?: TelegramBotInfo
  webhookUrl?: string
  /** The token the running adapter was started with (a changed token restarts it). */
  token?: string
  retry?: ReturnType<typeof setTimeout>
}

export function createTelegramChannels(options: TelegramChannelsOptions): TelegramChannels {
  const { gateway } = options
  const now = options.now ?? (() => Date.now())
  const warn = options.warn ?? ((m) => console.warn(`team: ${m}`))
  const report = (step: string, error: unknown): void => {
    warn(`telegram: ${step} failed: ${String(error)}`)
    try {
      options.problem?.(`telegram:${step}`, error)
    } catch {
      // the alarm is the last resort: if it cannot be raised the warning above is all there is
    }
  }
  const entries = new Map<string, RuntimeEntry>()
  let stopped = false
  let lastRev = -1
  let poller: ReturnType<typeof setInterval> | undefined
  let chain: Promise<void> = Promise.resolve()

  const entryOf = (id: string): RuntimeEntry => {
    let e = entries.get(id)
    if (e === undefined) {
      e = { state: 'stopped', since: now() }
      entries.set(id, e)
    }
    return e
  }
  const setState = (e: RuntimeEntry, state: ChannelRuntimeState, message?: string): void => {
    if (e.state !== state) e.since = now()
    e.state = state
    if (message === undefined) delete e.message
    else e.message = message
  }
  const tokenOf = (record: ConnectionRecord): string | undefined => {
    const t = (record.settings as { token?: unknown }).token
    return typeof t === 'string' && t.trim() !== '' ? t.trim() : undefined
  }
  const listRecords = (): Promise<ConnectionRecord[]> =>
    options.connectors.stores.connections.list({ definitionId: TELEGRAM_CONNECTOR_ID })
  const recordOf = async (id: string): Promise<ConnectionRecord> => {
    const r = await options.connectors.stores.connections.get(id)
    if (r === undefined || r.definitionId !== TELEGRAM_CONNECTOR_ID) {
      throw notFound('channel connection', id)
    }
    return r
  }

  // --- runtime ---------------------------------------------------------------------------------

  async function halt(id: string): Promise<void> {
    const e = entries.get(id)
    if (e?.retry !== undefined) clearTimeout(e.retry)
    if (e !== undefined) delete e.retry
    if (e?.adapter !== undefined) {
      delete e.adapter
      // teardown: the transport is being dropped anyway; nothing to alarm about
      let timer: ReturnType<typeof setTimeout> | undefined
      await Promise.race([
        gateway.unregister(id).catch(() => undefined),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 5_000)
        }),
      ])
      clearTimeout(timer)
    }
  }

  async function authFailed(id: string, record: ConnectionRecord | undefined): Promise<void> {
    const e = entryOf(id)
    const message =
      'Telegram rejected the bot token (it may have been revoked). Enter a new token to reconnect.'
    await halt(id)
    setState(e, 'needs-auth', message)
    await options.connectors
      .markNeedsAuth(id, message)
      .catch((error) => report('mark-needs-auth', error))
    options.onNeedsAuth?.(id, record?.label ?? id, message)
    gateway.activity.record({ connectionId: id, type: 'needs-auth', reason: 'token-rejected' })
    options.notify?.({
      key: `channel-auth:${id}`,
      title: `Telegram bot ${record?.label ?? id} needs a new token`,
      body: message,
      agentId: gateway.config(id)?.agentId ?? null,
    })
  }

  function scheduleRetry(id: string): void {
    const ms = options.retryMs ?? 30_000
    const e = entryOf(id)
    if (ms <= 0 || stopped) return
    if (e.retry !== undefined) clearTimeout(e.retry)
    e.retry = setTimeout(() => {
      delete e.retry
      void sync().catch((error) => report('sync', error))
    }, ms)
    ;(e.retry as { unref?: () => void }).unref?.()
  }

  async function failed(id: string, failure: TelegramFailure): Promise<void> {
    const record = await options.connectors.stores.connections.get(id)
    if (failure.kind === 'auth') return authFailed(id, record)
    const e = entryOf(id)
    await halt(id)
    setState(
      e,
      'error',
      failure.kind === 'conflict'
        ? 'Another process is polling this bot (or a webhook was set). Only one poller can read a bot at a time.'
        : failure.message,
    )
    scheduleRetry(id)
  }

  async function startOne(
    record: ConnectionRecord,
    token: string,
    onWebhook: 'refuse' | 'delete' = 'refuse',
  ): Promise<void> {
    const id = record.id
    const e = entryOf(id)
    setState(e, 'starting')
    const adapter = createTelegramAdapter({
      connectionId: id,
      token,
      ...(options.apiRoot === undefined ? {} : { apiRoot: options.apiRoot }),
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.pollTimeoutSec === undefined ? {} : { pollTimeoutSec: options.pollTimeoutSec }),
      onWebhook,
      // pending join requests survive a restart (`ch_join_requests`)
      joinRequests: sqliteJoinRequestStore(options.sqlite, id),
      hooks: {
        onFailure: (failure) =>
          void failed(id, failure).catch((error) => report('failure-handler', error)),
        warn,
      },
    })
    e.adapter = adapter
    e.token = token
    try {
      // a Telegram that never answers (no network, a blocked host, a dead API root) must not leave
      // the connection "starting" for ever: give up after a while and retry later
      let timer: ReturnType<typeof setTimeout> | undefined
      await Promise.race([
        gateway.register(adapter),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(START_TIMEOUT_TEXT)), START_TIMEOUT_MS)
        }),
      ]).finally(() => clearTimeout(timer))
      const info = adapter.info()
      if (info !== undefined) e.bot = info
      delete e.webhookUrl
      setState(e, 'running')
    } catch (error) {
      await halt(id)
      if (error instanceof TelegramSetupError && error.code === 'webhook-set') {
        if (error.webhookUrl !== undefined) e.webhookUrl = error.webhookUrl
        setState(e, 'webhook', error.message)
        return
      }
      const kind = (error as { kind?: string }).kind
      if (kind === 'fatal') return authFailed(id, record)
      setState(e, 'error', error instanceof Error ? error.message : String(error))
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
      const token = tokenOf(record)
      const bound = gateway.config(id) !== undefined
      if (!record.enabled) {
        await halt(id)
        setState(e, 'disabled')
        continue
      }
      if (record.status === 'needs-auth' || token === undefined) {
        await halt(id)
        setState(e, 'needs-auth', record.statusMessage ?? 'Enter the bot token to connect.')
        continue
      }
      // no owning agent: the bot still runs and records (observe-only); allowed agents use its tools
      if (!bound) gateway.configure({ connectionId: id, agentId: NO_OWNER, replyToUnknown: false })
      if (e.adapter !== undefined && e.token === token) continue
      if (e.adapter !== undefined) await halt(id)
      // a pending retry (error, webhook) is handled here too: a sync is always a fresh try
      if (e.state === 'webhook' && e.token === token && e.webhookUrl !== undefined) {
        // the admin has to decide (delete the webhook): do not retry on every sync
        continue
      }
      await startOne(record, token)
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

  const peek = (id: string): RuntimeEntry | undefined => entries.get(id)

  // --- views -----------------------------------------------------------------------------------

  async function viewOf(record: ConnectionRecord): Promise<ChannelConnectionView> {
    const id = record.id
    const e = peek(id) ?? { state: 'stopped' as const, since: now() }
    const config = gateway.config(id)
    const counts = gateway.outbox.counts(id)
    const bot = e.bot ?? e.adapter?.info()
    const breaker = gateway.outbound.breaker(id)
    return {
      id,
      platform: 'telegram',
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
      ...(bot === undefined
        ? {}
        : {
            bot: {
              id: bot.id,
              username: bot.username,
              name: bot.name,
              canReadAllGroupMessages: bot.canReadAllGroupMessages,
              guidance: privacyGuidance(bot.canReadAllGroupMessages),
            },
          }),
      ...(e.webhookUrl === undefined ? {} : { webhookUrl: e.webhookUrl }),
      binding:
        config === undefined || config.agentId === NO_OWNER
          ? null
          : {
              agentId: config.agentId,
              groupPolicy: config.groupPolicy,
              dm: config.dm,
              allowBots: config.allowBots,
              replyToUnknown: config.replyToUnknown,
              replyMissed: config.replyMissed,
              missedWindowMinutes: config.missedWindowMinutes,
              admins: config.admins,
              historyLimit: config.historyLimit,
              defaults: defaultsView(config),
            },
      counts: {
        chats: countChats(gateway, id),
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

  // --- admin -----------------------------------------------------------------------------------

  const requireConfig = (id: string): ConnectionConfig => {
    const c = gateway.config(id)
    if (c === undefined) throw conflict('Bind this connection to an agent first.', 'NOT_BOUND')
    return c
  }

  const checkAgent = (agentId: string): void => {
    const a = options.agents.get(agentId)
    if (a === undefined || a.archivedAt !== null) throw invalid(`unknown agent: ${agentId}`)
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

  const port: TelegramChannels = {
    start() {
      stopped = false
      void sync().catch((e) => warn(`telegram: sync failed: ${String(e)}`))
      const every = options.syncPollMs ?? 1000
      if (every > 0) {
        poller = setInterval(() => {
          if (options.connectors.rev() !== lastRev) {
            void sync().catch((e) => warn(`telegram: sync failed: ${String(e)}`))
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
    async connections() {
      if (options.connectors.rev() !== lastRev) await settle(sync())
      const records = await listRecords()
      return Promise.all(records.map(viewOf))
    },
    async connection(id) {
      if (options.connectors.rev() !== lastRev) await settle(sync())
      return viewOf(await recordOf(id))
    },
    async bind(id, input: ChannelBindInput) {
      const record = await recordOf(id)
      checkAgent(input.agentId)
      const existing = gateway.config(id)
      gateway.configure({
        ...(existing ?? {}),
        connectionId: id,
        agentId: input.agentId,
        ...(input.groupPolicy === undefined ? {} : { groupPolicy: input.groupPolicy }),
        ...(input.dm === undefined ? {} : { dm: input.dm }),
        ...(input.allowBots === undefined ? {} : { allowBots: input.allowBots }),
        ...(input.replyToUnknown === undefined ? {} : { replyToUnknown: input.replyToUnknown }),
        ...(input.replyMissed === undefined ? {} : { replyMissed: input.replyMissed }),
        ...(input.missedWindowMinutes === undefined
          ? {}
          : { missedWindowMinutes: input.missedWindowMinutes }),
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
      // removing the owner keeps the connection running, observe-only, with its chats and people
      const record = await recordOf(id)
      const existing = gateway.config(id)
      if (existing !== undefined)
        gateway.configure({ ...existing, agentId: NO_OWNER, replyToUnknown: false })
      await sync()
      return viewOf(record)
    },
    async chats(id) {
      await recordOf(id)
      return listNodeViews(gateway, id)
    },
    async chatsTable(id, query) {
      await recordOf(id)
      return pageNodeViews(gateway, id, query)
    },
    async chat(id, nodeId) {
      await recordOf(id)
      const node = gateway.nodes.get(nodeId)
      if (node === undefined || node.connectionId !== id || node.kind === 'direct')
        throw notFound('chat', nodeId)
      return nodeView(gateway, node) as NonNullable<ReturnType<typeof nodeView>>
    },
    async setChatPolicy(id, nodeId, input) {
      await recordOf(id)
      requireConfig(id)
      const node = gateway.nodes.get(nodeId)
      if (node === undefined || node.connectionId !== id || node.kind === 'direct')
        throw notFound('chat', nodeId)
      writePolicy(gateway, node, input, checkAgent)
      return nodeView(gateway, node) as NonNullable<ReturnType<typeof nodeView>>
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
    async deleteWebhook(id) {
      const record = await recordOf(id)
      const token = tokenOf(record)
      if (token === undefined) throw conflict('The connection has no token.', 'NO_TOKEN')
      requireConfig(id)
      await halt(id)
      chain = chain.catch(() => undefined).then(() => startOne(record, token, 'delete'))
      await chain
      return viewOf(record)
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
      return viewOf(record)
    },
  }
  return port
}

/** A `ChannelsPort` that delegates to a service built later (the service needs the app deps). */
export function lazyChannelsPort(get: () => ChannelsPort | undefined): ChannelsPort {
  return new Proxy({} as ChannelsPort, {
    get: (_t, name) => {
      const target = get()
      if (target === undefined) throw new Error('channels are not ready yet')
      return (target as unknown as Record<string | symbol, unknown>)[name]
    },
  })
}

/** A view waits at most 2 seconds for a sync: a slow start shows as "starting", never as a hang. */
async function settle(p: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([
    p.catch(() => undefined),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, 2_000)
    }),
  ])
  clearTimeout(timer)
}

/** How long starting a bot may wait for Telegram before it counts as failed (then retried). */
const START_TIMEOUT_MS = 20_000
const START_TIMEOUT_TEXT =
  'Telegram did not answer within 20 seconds (no network, Telegram blocked, or a wrong API address). Trying again shortly.'
