/**
 * The per-connection API governor. Every call that reaches a chat platform passes here: outbox
 * sends, native actions, platform reads, the history and admin-log jobs of a user account. It owns
 *
 *  - **token buckets** per call class (`read`, `edit`, `admin`) and one over the whole connection
 *    (`global`, sends are charged to it too). A user account is stricter than a bot; both are
 *    overridden by the connection's `rate.governor`.
 *  - **the park state**, shared by everything: a rate limit (HTTP 429 `retry_after`, FLOOD_WAIT_X)
 *    on ANY call parks the whole connection, or only one chat when the error says it is chat
 *    scoped. The outbox reads the same state (`outbound.ts` has no park state of its own).
 *  - **the flood storm**: several rate limits within a window ask the owner of the breaker (the
 *    outbox) to open it.
 *  - **the audit**: one record per governed call (what, where, who asked, result, duration); ids
 *    and targets only, never a message body or a secret.
 *
 * A call during a park or with an empty bucket waits up to `parkWaitMs`; beyond that it fails with
 * a {@link GovernorLimited} ("rate limited, retry in N s") that the model can read. Background
 * jobs (`patient`) wait for as long as it takes, up to a cap.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import type { GovernorOverrides } from './policy.ts'
import {
  type ChannelAdapter,
  ChannelError,
  type ChannelNode,
  type NativeAction,
  type OutboundMessage,
} from './types.ts'

export type CallClass = 'send' | 'edit' | 'read' | 'admin'

export interface BucketLimit {
  burst: number
  perMinute: number
}

export interface GovernorLimits {
  read: BucketLimit
  edit: BucketLimit
  admin: BucketLimit
  global: BucketLimit
  parkWaitMs: number
  floodStorm: { count: number; windowMs: number }
}

/** A bot may do what the platform allows a bot. */
export const BOT_GOVERNOR: GovernorLimits = {
  read: { burst: 10, perMinute: 120 },
  edit: { burst: 10, perMinute: 60 },
  admin: { burst: 5, perMinute: 30 },
  global: { burst: 30, perMinute: 600 },
  parkWaitMs: 5000,
  floodStorm: { count: 5, windowMs: 3_600_000 },
}

/** A user account that talks like a robot gets limited: stricter on every class. */
export const USER_GOVERNOR: GovernorLimits = {
  read: { burst: 5, perMinute: 30 },
  edit: { burst: 3, perMinute: 15 },
  admin: { burst: 2, perMinute: 6 },
  global: { burst: 8, perMinute: 45 },
  parkWaitMs: 10_000,
  floodStorm: { count: 3, windowMs: 3_600_000 },
}

export function governorLimitsOf(
  actsAs: 'bot' | 'user' | undefined,
  overrides?: GovernorOverrides,
): GovernorLimits {
  const base = actsAs === 'user' ? USER_GOVERNOR : BOT_GOVERNOR
  const o = overrides ?? {}
  const bucket = (b: BucketLimit, p: Partial<BucketLimit> | undefined): BucketLimit => ({
    burst: p?.burst ?? b.burst,
    perMinute: p?.perMinute ?? b.perMinute,
  })
  return {
    read: bucket(base.read, o.read),
    edit: bucket(base.edit, o.edit),
    admin: bucket(base.admin, o.admin),
    global: bucket(base.global, o.global),
    parkWaitMs: o.parkWaitMs ?? base.parkWaitMs,
    floodStorm: {
      count: o.floodStorm?.count ?? base.floodStorm.count,
      windowMs: o.floodStorm?.windowMs ?? base.floodStorm.windowMs,
    },
  }
}

/** The governor refused or delayed a call beyond what it may wait; `retryAfterMs` says when to try again. */
export class GovernorLimited extends ChannelError {
  readonly local = true
  constructor(message: string, retryAfterMs: number, scope: 'connection' | 'chat' = 'connection') {
    super('rate_limit', message, retryAfterMs, scope)
    this.name = 'GovernorLimited'
  }
}

/** Who a governed call is for (set by the channels plugin around a tool call). */
export interface CallContext {
  sessionId?: string
  agentId?: string
  /** `chat`, `web`, `routine`, `program`, ... */
  origin?: string
  /** The person whose request it is (team member or platform name). */
  requester?: string
  memberId?: string
}

export type AuditResult = 'ok' | 'error' | 'rate_limited'

export interface AuditRecord {
  connectionId: string
  at: number
  kind: 'action' | 'read'
  action: string
  /** Internal id of the node the call is about. */
  nodeId?: string
  args: Record<string, string | number | boolean>
  context?: CallContext
  result: AuditResult
  durationMs: number
  /** A short reason for `error` and `rate_limited`; never message text. */
  note?: string
}

export interface CallMeta {
  connectionId: string
  cls: CallClass
  action: string
  nodeId?: string
  /** Chat scope of a park (`connection\nnode`), as the outbox keys it. */
  chatKey?: string
  args?: Record<string, unknown>
  /** Record an audit row (default true). */
  audit?: boolean
  /** Charge the buckets but never wait for them (a send: the outbox waits; internal lookups). */
  noWait?: boolean
  /** A background job: wait for as long as it takes (capped), never fail with "rate limited". */
  patient?: boolean
  /** The `read` or `action` of the audit row (default: by class). */
  kind?: 'action' | 'read'
  /** Recognize a rate limit in an error the governor does not know (a raw client's flood wait). */
  classify?: (error: unknown) => { retryAfterMs: number; scope?: 'connection' | 'chat' } | undefined
}

export interface GovernorState {
  /** The whole connection is parked until this moment. */
  parkedUntil?: number
  parkedReason?: string
  chats: Array<{ chatKey: string; until: number }>
  /** Rate limits seen within the storm window. */
  floods: number
  /** Tokens left per class (rounded down). */
  buckets: Record<'read' | 'edit' | 'admin' | 'global', number>
  limits: GovernorLimits
}

export interface GovernorOptions {
  limitsOf: (connectionId: string) => GovernorLimits
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  audit?: (record: AuditRecord) => void
  /** A park started (for the activity log). */
  onPark?: (event: {
    connectionId: string
    until: number
    scope: 'connection' | 'chat'
    reason: string
    ms: number
  }) => void
  /** Rate limits piled up within the window: open the breaker. */
  onStorm?: (event: { connectionId: string; reason: string }) => void
}

export interface Governor {
  /** Park the connection (or one chat) for `ms`; counts toward the flood storm. */
  park(
    connectionId: string,
    ms: number,
    options?: { chatKey?: string; reason?: string; error?: unknown },
  ): void
  /** Park state from an error, when it is a rate limit the governor has not seen yet. */
  noteError(connectionId: string, error: unknown, chatKey?: string): void
  /** Milliseconds to wait before a call to the connection (and chat) may go out. */
  parkedFor(connectionId: string, chatKey?: string): number
  /** Run a governed call: wait for park and buckets, run, audit, park on a rate limit. */
  call<T>(meta: CallMeta, op: () => Promise<T>): Promise<T>
  /** Charge the global bucket for a call that waits elsewhere (an outbox send). */
  charge(connectionId: string, cls?: CallClass): void
  state(connectionId: string): GovernorState
  /** One readable sentence about the current limits and park, for the model. */
  describe(connectionId: string): string
  /** Run `fn` with the person and session the calls inside it are for. */
  within<T>(context: CallContext, fn: () => T): T
  context(): CallContext | undefined
  /** Clear parks and counters (a person fixed the problem). */
  reset(connectionId: string): void
}

interface Bucket {
  tokens: number
  at: number
}

const PATIENT_CAP_MS = 30 * 60_000
const seconds = (ms: number): number => Math.max(1, Math.ceil(ms / 1000))

const NO_BODY_KEYS =
  /^(chat|chat_id|chatId|user|user_id|userId|message|message_id|messageId|messageIds|ids|topic|topic_id|thread|limit|before|after|count|status|connection|days|attachment|attachmentId|emoji|until|duration|query)$/i
const SAFE_VALUE = /^[-@\w.:+]{1,64}$/

/** Ids, targets and counters only: a value with spaces (a message, a title) never gets through. */
export function auditArgs(input: unknown): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {}
  if (input === null || typeof input !== 'object') return out
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (!NO_BODY_KEYS.test(key)) continue
    if (typeof value === 'number' || typeof value === 'boolean') out[key] = value
    else if (typeof value === 'string' && SAFE_VALUE.test(value)) out[key] = value
  }
  return out
}

const store = new AsyncLocalStorage<{ context?: CallContext; failed?: string }>()

/**
 * Called by a native action that answers a failure as text (so the model reads it): the governed
 * call is then audited as an error instead of ok. No-op outside a governed call.
 */
export function reportFailure(text: string): void {
  const s = store.getStore()
  if (s !== undefined) s.failed = text.slice(0, 160)
}

export function createGovernor(options: GovernorOptions): Governor {
  const now = options.now ?? Date.now
  const sleep =
    options.sleep ?? ((ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms)))
  const buckets = new Map<string, Bucket>()
  const parkedUntil = new Map<string, { until: number; reason: string }>()
  const chatParked = new Map<string, number>()
  const floods = new Map<string, number[]>()
  const seen = new WeakSet<object>()

  const bucketOf = (connectionId: string, cls: 'read' | 'edit' | 'admin' | 'global'): Bucket => {
    const key = `${connectionId}\n${cls}`
    let b = buckets.get(key)
    if (b === undefined) {
      b = { tokens: options.limitsOf(connectionId)[cls].burst, at: now() }
      buckets.set(key, b)
    }
    return b
  }
  const refill = (b: Bucket, limit: BucketLimit): void => {
    const t = now()
    b.tokens = Math.min(limit.burst, b.tokens + ((t - b.at) * limit.perMinute) / 60_000)
    b.at = t
  }
  /**
   * Milliseconds until a token is in the bucket (0 = now). A patient background job also leaves
   * `reserve` tokens behind, so a tool call is never starved by a backfill.
   */
  const waitOf = (
    connectionId: string,
    cls: 'read' | 'edit' | 'admin' | 'global',
    patient = false,
  ): number => {
    const limit = options.limitsOf(connectionId)[cls]
    const b = bucketOf(connectionId, cls)
    refill(b, limit)
    const need = 1 + (patient ? Math.min(2, limit.burst - 1) : 0)
    if (b.tokens >= need) return 0
    return Math.ceil(((need - b.tokens) * 60_000) / limit.perMinute)
  }
  const take = (connectionId: string, cls: 'read' | 'edit' | 'admin' | 'global'): void => {
    const b = bucketOf(connectionId, cls)
    refill(b, options.limitsOf(connectionId)[cls])
    b.tokens -= 1
  }
  const classBucket = (cls: CallClass): 'read' | 'edit' | 'admin' | undefined =>
    cls === 'send' ? undefined : cls

  const parkedFor = (connectionId: string, chatKey?: string): number => {
    const t = now()
    return Math.max(
      0,
      (parkedUntil.get(connectionId)?.until ?? 0) - t,
      chatKey === undefined ? 0 : (chatParked.get(chatKey) ?? 0) - t,
    )
  }

  const park: Governor['park'] = (connectionId, ms, opts = {}) => {
    if (opts.error !== null && typeof opts.error === 'object') {
      if (seen.has(opts.error)) return
      seen.add(opts.error)
    }
    const wait = Math.max(1, Math.ceil(ms))
    const until = now() + wait
    const reason = opts.reason ?? 'rate limited by the platform'
    if (opts.chatKey === undefined) {
      const current = parkedUntil.get(connectionId)
      if (current === undefined || current.until < until)
        parkedUntil.set(connectionId, { until, reason })
    } else {
      chatParked.set(opts.chatKey, Math.max(chatParked.get(opts.chatKey) ?? 0, until))
    }
    options.onPark?.({
      connectionId,
      until,
      scope: opts.chatKey === undefined ? 'connection' : 'chat',
      reason,
      ms: wait,
    })
    // the storm: rate limits piling up within the window
    const limits = options.limitsOf(connectionId)
    const list = (floods.get(connectionId) ?? []).filter(
      (x) => x > now() - limits.floodStorm.windowMs,
    )
    list.push(now())
    floods.set(connectionId, list)
    if (list.length >= limits.floodStorm.count) {
      floods.set(connectionId, [])
      options.onStorm?.({
        connectionId,
        reason: `${list.length} rate limits within ${Math.max(1, Math.round(limits.floodStorm.windowMs / 60_000))} minutes`,
      })
    }
  }

  const rateLimitOf = (
    error: unknown,
    classify: CallMeta['classify'],
  ): { retryAfterMs: number; scope: 'connection' | 'chat'; local: boolean } | undefined => {
    if (error instanceof GovernorLimited) return undefined
    if (error instanceof ChannelError) {
      return error.kind === 'rate_limit'
        ? {
            retryAfterMs: Math.max(error.retryAfterMs ?? 1000, 1),
            scope: error.scope,
            local: false,
          }
        : undefined
    }
    const c = classify?.(error)
    return c === undefined
      ? undefined
      : { retryAfterMs: c.retryAfterMs, scope: c.scope ?? 'connection', local: false }
  }

  const audit = (
    meta: CallMeta,
    context: CallContext | undefined,
    result: AuditResult,
    startedAt: number,
    note?: string,
  ): void => {
    if (meta.audit === false || options.audit === undefined) return
    try {
      options.audit({
        connectionId: meta.connectionId,
        at: startedAt,
        kind: meta.kind ?? (meta.cls === 'read' ? 'read' : 'action'),
        action: meta.action,
        ...(meta.nodeId === undefined ? {} : { nodeId: meta.nodeId }),
        args: auditArgs(meta.args),
        ...(context === undefined ? {} : { context }),
        result,
        durationMs: Math.max(0, now() - startedAt),
        ...(note === undefined ? {} : { note: note.slice(0, 160) }),
      })
    } catch {
      // an audit failure never breaks the call it describes
    }
  }

  return {
    park,
    noteError(connectionId, error, chatKey) {
      const rl = rateLimitOf(error, undefined)
      if (rl === undefined) return
      park(connectionId, rl.retryAfterMs, {
        ...(rl.scope === 'chat' && chatKey !== undefined ? { chatKey } : {}),
        reason: error instanceof Error ? error.message : String(error),
        error,
      })
    },
    parkedFor,
    charge(connectionId, cls = 'send') {
      take(connectionId, 'global')
      const own = classBucket(cls)
      if (own !== undefined) take(connectionId, own)
    },
    async call(meta, op) {
      const startedAt = now()
      const limits = options.limitsOf(meta.connectionId)
      const context = store.getStore()?.context
      const bound = meta.patient === true ? PATIENT_CAP_MS : limits.parkWaitMs
      const own = classBucket(meta.cls)
      let waited = 0
      for (;;) {
        // a send (the outbox waited already) and the gateway's own lookups are charged, never held
        if (meta.noWait === true) break
        const parked = parkedFor(meta.connectionId, meta.chatKey)
        const need = Math.max(
          parked,
          waitOf(meta.connectionId, 'global', meta.patient === true),
          own === undefined ? 0 : waitOf(meta.connectionId, own, meta.patient === true),
        )
        if (need <= 0) break
        if (waited + need > bound) {
          const chatOnly = parkedFor(meta.connectionId) <= 0
          const limited = new GovernorLimited(
            `rate limited, retry in ${seconds(need)} s (${
              parked > 0
                ? (parkedUntil.get(meta.connectionId)?.reason ?? 'the platform asked to slow down')
                : `too many ${meta.cls === 'read' ? 'reads' : meta.cls === 'send' ? 'sends' : `${meta.cls} calls`} for this connection`
            })`,
            need,
            chatOnly && parked > 0 ? 'chat' : 'connection',
          )
          audit(meta, context, 'rate_limited', startedAt, limited.message)
          throw limited
        }
        await sleep(Math.ceil(need))
        waited += need
      }
      take(meta.connectionId, 'global')
      if (own !== undefined) take(meta.connectionId, own)
      const slot: { context?: CallContext; failed?: string } =
        context === undefined ? {} : { context }
      try {
        const result = await store.run(slot, op)
        audit(meta, context, slot.failed === undefined ? 'ok' : 'error', startedAt, slot.failed)
        return result
      } catch (error) {
        const rl = rateLimitOf(error, meta.classify)
        if (rl !== undefined) {
          park(meta.connectionId, rl.retryAfterMs, {
            ...(rl.scope === 'chat' && meta.chatKey !== undefined ? { chatKey: meta.chatKey } : {}),
            reason: error instanceof Error ? error.message : String(error),
            error,
          })
          audit(meta, context, 'rate_limited', startedAt, `retry in ${seconds(rl.retryAfterMs)} s`)
        } else {
          audit(
            meta,
            context,
            error instanceof GovernorLimited ? 'rate_limited' : 'error',
            startedAt,
            error instanceof Error ? error.message : String(error),
          )
        }
        throw error
      }
    },
    state(connectionId) {
      const limits = options.limitsOf(connectionId)
      const t = now()
      const left = (cls: 'read' | 'edit' | 'admin' | 'global'): number => {
        const b = bucketOf(connectionId, cls)
        refill(b, limits[cls])
        return Math.max(0, Math.floor(b.tokens))
      }
      const p = parkedUntil.get(connectionId)
      return {
        ...(p !== undefined && p.until > t ? { parkedUntil: p.until, parkedReason: p.reason } : {}),
        chats: [...chatParked.entries()]
          .filter(([k, until]) => k.startsWith(`${connectionId}\n`) && until > t)
          .map(([chatKey, until]) => ({ chatKey, until })),
        floods: (floods.get(connectionId) ?? []).filter((x) => x > t - limits.floodStorm.windowMs)
          .length,
        buckets: {
          read: left('read'),
          edit: left('edit'),
          admin: left('admin'),
          global: left('global'),
        },
        limits,
      }
    },
    describe(connectionId) {
      const s = this.state(connectionId)
      const t = now()
      const parts: string[] = []
      if (s.parkedUntil !== undefined) {
        parts.push(
          `API calls are parked for ${seconds(s.parkedUntil - t)} more seconds (the platform asked to slow down)`,
        )
      }
      if (s.chats.length > 0) {
        parts.push(
          `${s.chats.length} chat${s.chats.length === 1 ? ' is' : 's are'} parked by a per-chat flood wait (up to ${seconds(Math.max(...s.chats.map((c) => c.until)) - t)} s)`,
        )
      }
      const l = s.limits
      parts.push(
        `API limits: reads ${l.read.perMinute}/min, edits/deletes/pins ${l.edit.perMinute}/min, moderation ${l.admin.perMinute}/min, all calls ${l.global.perMinute}/min; a call that would wait over ${seconds(l.parkWaitMs)} s answers "rate limited" instead`,
      )
      if (s.floods > 0)
        parts.push(`${s.floods} rate limit${s.floods === 1 ? '' : 's'} seen recently`)
      return `${parts.join('. ')}.`
    },
    within(context, fn) {
      return store.run({ context }, fn)
    },
    context: () => store.getStore()?.context,
    reset(connectionId) {
      parkedUntil.delete(connectionId)
      floods.delete(connectionId)
      for (const key of [...chatParked.keys()])
        if (key.startsWith(`${connectionId}\n`)) chatParked.delete(key)
      for (const key of [...buckets.keys()])
        if (key.startsWith(`${connectionId}\n`)) buckets.delete(key)
    },
  }
}

// --- the adapter wrapper -----------------------------------------------------------------------

const CLASS_OF_RISK: Record<NativeAction['risk'], CallClass> = {
  read: 'read',
  write: 'edit',
  external: 'send',
  destructive: 'admin',
}

export interface GovernAdapterOptions {
  governor: Governor
  /** Internal node id of a native chat id (for the audit row of a native action). */
  nodeIdOf?: (connectionId: string, nativeId: string) => string | undefined
}

const chatKeyOf = (connectionId: string, node: ChannelNode): string => `${connectionId}\n${node.id}`

/** The text the model reads when a native action is held back, or the platform asked to slow down. */
const limitedText = (error: ChannelError): string =>
  error instanceof GovernorLimited
    ? `ERROR: ${error.message}.`
    : `ERROR: rate limited, retry in ${seconds(error.retryAfterMs ?? 1000)} s (${error.message}).`

/**
 * An adapter whose every platform call goes through the governor. Sends only report and charge
 * (the outbox waits and audits them); calls the gateway makes for itself, outside a tool call, are
 * governed but not audited (the Activity log shows what the agent did), and its lookups never wait.
 */
export function governAdapter<A extends ChannelAdapter>(
  adapter: A,
  options: GovernAdapterOptions,
): A {
  const { governor } = options
  const id = adapter.connectionId
  const run = <T>(meta: Omit<CallMeta, 'connectionId'>, op: () => Promise<T>): Promise<T> =>
    governor.call({ connectionId: id, ...meta }, op)
  /** A lookup the gateway makes for itself: no waiting and no audit unless a tool asked for it. */
  const lookup = <T>(
    action: string,
    args: unknown,
    op: () => Promise<T>,
    node?: ChannelNode,
  ): Promise<T> => {
    const asked = governor.context() !== undefined
    return run(
      {
        cls: 'read',
        action,
        args: args as Record<string, unknown>,
        ...(node === undefined ? {} : { nodeId: node.id, chatKey: chatKeyOf(id, node) }),
        audit: asked,
        noWait: !asked,
      },
      op,
    )
  }
  /** A call on a node: audited when a tool asked for it (the agent's own doing), not when the gateway did it (an ack, a card update). */
  const onNode = <T>(
    cls: 'read' | 'edit',
    action: string,
    node: ChannelNode,
    args: Record<string, unknown>,
    op: () => Promise<T>,
  ): Promise<T> =>
    run(
      {
        cls,
        action,
        nodeId: node.id,
        chatKey: chatKeyOf(id, node),
        args,
        audit: governor.context() !== undefined,
      },
      op,
    )
  const nodeRead = <T>(
    action: string,
    node: ChannelNode,
    args: Record<string, unknown>,
    op: () => Promise<T>,
  ): Promise<T> => onNode('read', action, node, args, op)
  const nodeWrite = <T>(
    action: string,
    node: ChannelNode,
    args: Record<string, unknown>,
    op: () => Promise<T>,
  ): Promise<T> => onNode('edit', action, node, args, op)

  const governedActions = adapter.actions?.map(
    (a): NativeAction =>
      a.local === true
        ? a
        : {
            ...a,
            run: async (input) => {
              const chat = typeof input.chat === 'string' ? input.chat : undefined
              const nodeId = chat === undefined ? undefined : options.nodeIdOf?.(id, chat)
              try {
                return await run(
                  {
                    cls: CLASS_OF_RISK[a.risk],
                    action: a.name,
                    args: input,
                    kind: a.risk === 'read' ? 'read' : 'action',
                    ...(nodeId === undefined ? {} : { nodeId }),
                  },
                  () => a.run(input),
                )
              } catch (error) {
                // held back (or the platform asked to slow down): the model reads why
                if (error instanceof ChannelError && error.kind === 'rate_limit')
                  return limitedText(error)
                throw error
              }
            },
          },
  )

  return new Proxy(adapter, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target) as unknown
      if (prop === 'actions') return governedActions
      if (typeof value !== 'function') return value
      const fn = value as (...args: unknown[]) => unknown
      switch (prop) {
        case 'send':
          return async (node: ChannelNode, message: OutboundMessage) => {
            // the outbox waits for the park and its windows; the call is charged and a rate limit parks
            return run(
              {
                cls: 'send',
                action: 'send',
                nodeId: node.id,
                chatKey: chatKeyOf(id, node),
                audit: false,
                noWait: true,
              },
              () => fn.call(target, node, message) as Promise<unknown>,
            )
          }
        case 'edit':
          return (node: ChannelNode, nativeId: string, text: string) =>
            nodeWrite(
              'edit',
              node,
              { message: nativeId },
              () => fn.call(target, node, nativeId, text) as Promise<unknown>,
            )
        case 'delete':
          return (node: ChannelNode, nativeId: string) =>
            nodeWrite(
              'delete',
              node,
              { message: nativeId },
              () => fn.call(target, node, nativeId) as Promise<unknown>,
            )
        case 'pin':
          return (node: ChannelNode, nativeId: string, pinned: boolean) =>
            nodeWrite(
              pinned ? 'pin' : 'unpin',
              node,
              { message: nativeId },
              () => fn.call(target, node, nativeId, pinned) as Promise<unknown>,
            )
        case 'react':
          return (node: ChannelNode, nativeId: string, emoji: string) =>
            nodeWrite(
              'react',
              node,
              { message: nativeId },
              () => fn.call(target, node, nativeId, emoji) as Promise<unknown>,
            )
        case 'fetchHistory':
          return (node: ChannelNode, o: { limit: number; before?: string }) =>
            nodeRead('history', node, o, () => fn.call(target, node, o) as Promise<unknown>)
        case 'listMembers':
          return (node: ChannelNode, o: { limit: number }) =>
            nodeRead('members', node, o, () => fn.call(target, node, o) as Promise<unknown>)
        case 'fetchAttachment':
          return (node: ChannelNode, messageNativeId: string, attachmentId: string) =>
            nodeRead(
              'download',
              node,
              { message: messageNativeId, attachment: attachmentId },
              () => fn.call(target, node, messageNativeId, attachmentId) as Promise<unknown>,
            )
        case 'getNodeInfo':
          return (nativeId: string) =>
            lookup(
              'node_info',
              { chat: nativeId },
              () => fn.call(target, nativeId) as Promise<unknown>,
            )
        case 'getIdentityInfo':
          return (nativeId: string, scope?: string) =>
            lookup(
              'identity_info',
              { user: nativeId },
              () => fn.call(target, nativeId, scope) as Promise<unknown>,
            )
        case 'listNodes':
          return (parent?: ChannelNode) =>
            lookup('list_nodes', {}, () => fn.call(target, parent) as Promise<unknown>, parent)
        case 'resolveIdentifier':
          return (query: string) =>
            lookup('resolve_identifier', {}, () => fn.call(target, query) as Promise<unknown>)
        default:
          return (...args: unknown[]) => fn.apply(target, args)
      }
    },
  })
}
