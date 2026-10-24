/**
 * The append-only event log of a connection (docs/plans/P41-team-channels.md, phase L5). It holds
 * what the platform said (`message.created`, `node.updated`, `member.joined`, ...) and what the
 * gateway did with it (`gateway.woke`, `gateway.dropped`, `gateway.reply_sent`, ...). Unique per
 * `(connection, dedupe key)`, so a replayed platform event is recognized; `node_id` is null while
 * an event cannot be placed (a deletion that names no chat) and is filled in when it can.
 *
 * Payloads are facts (ids, counts, reasons), never a message text: texts live only in the sealed
 * message store. Inbox counters and the Activity tab are views over this log.
 */
import type { Database } from 'bun:sqlite'
import { uuidv7 } from 'eharness'
import { likePattern, windowOf } from './paging.ts'

export const GATEWAY_PREFIX = 'gateway.'

/** The activity vocabulary (what the Activity tab filters on): `gateway.<type with _ for ->`. */
export const EVENT_TYPES = [
  'woke',
  'observed',
  'dropped',
  'reply-queued',
  'reply-sent',
  'reply-retried',
  'reply-failed',
  'approval-posted',
  'approval-answered',
  'breaker-opened',
  'needs-auth',
  /** A native action or a platform write the agent made (the API governor's audit). */
  'action',
  /** A platform read the agent made (history, members, chat info). */
  'read',
  /** The platform asked to slow down: the connection (or a chat) is parked. */
  'parked',
] as const
export type ChannelEventType = (typeof EVENT_TYPES)[number]

/** Which way an event goes: what the platform sent us (`in`), what we did to the platform (`out`), or neither (`system`). */
export type EventDirection = 'in' | 'out' | 'system'
const DIRECTION: Record<ChannelEventType, EventDirection> = {
  woke: 'in',
  observed: 'in',
  dropped: 'in',
  'approval-answered': 'in',
  'reply-queued': 'out',
  'reply-sent': 'out',
  'reply-retried': 'out',
  'reply-failed': 'out',
  'approval-posted': 'out',
  action: 'out',
  read: 'out',
  'breaker-opened': 'system',
  'needs-auth': 'system',
  parked: 'system',
}
export const directionOf = (type: ChannelEventType): EventDirection => DIRECTION[type]
const typesOf = (direction: 'in' | 'out'): ChannelEventType[] =>
  EVENT_TYPES.filter((t) => DIRECTION[t] === direction)

/** Why an incoming message was dropped (the `reason` of a `dropped` event). */
export const DROP_REASONS = [
  'unlinked-sender',
  'chat-not-allowed',
  'dm-disabled',
  'bot-sender',
  'loop-guard',
  'duplicate',
  'agent-unavailable',
  'not-authorized',
  'not-observed',
] as const
export type DropReason = (typeof DROP_REASONS)[number]

const gatewayType = (t: ChannelEventType): string => `${GATEWAY_PREFIX}${t.replace(/-/g, '_')}`
const activityType = (t: string): ChannelEventType | undefined => {
  if (!t.startsWith(GATEWAY_PREFIX)) return undefined
  const name = t.slice(GATEWAY_PREFIX.length).replace(/_/g, '-')
  return (EVENT_TYPES as readonly string[]).includes(name) ? (name as ChannelEventType) : undefined
}

/** One event as the Activity tab shows it. */
export interface ChannelEvent {
  id: string
  connectionId: string
  at: number
  type: ChannelEventType
  /** `in`: what the platform sent; `out`: what the agent did to it (replies, actions, reads); `system`. */
  direction?: EventDirection
  /** The name of the action or read (`pin_message`, `history`, ...) of an `action` or `read` event. */
  action?: string
  /** A drop reason code, a wake reason, or a short free text (never message text). */
  reason?: string
  /** The node the event is about (its internal id). */
  conversationId?: string
  peerId?: string
  peerName?: string
  /** Native id of the message the event is about. */
  platformId?: string
  /** Small facts (counts, outbox kind, attempt); never message text. */
  detail?: Record<string, string | number | boolean>
}

export type NewChannelEvent = Omit<ChannelEvent, 'id'>

export interface StoredEvent {
  id: string
  connectionId: string
  type: string
  nodeId: string | null
  actorIdentityId: string | null
  targetMessageNativeId: string | null
  targetMessageId: string | null
  at: number
  receivedAt: number
  dedupeKey: string
  streamOrder: string | null
  normalizerVersion: number
  payload: Record<string, unknown>
  /** The sealed platform payload, when the gateway keeps raw events. */
  raw: string | null
}

export interface NewEvent {
  connectionId: string
  type: string
  nodeId?: string | null
  actorIdentityId?: string | null
  targetMessageNativeId?: string | null
  targetMessageId?: string | null
  at: number
  receivedAt: number
  dedupeKey: string
  streamOrder?: string | null
  normalizerVersion?: number
  payload?: Record<string, unknown>
  raw?: string | null
}

interface EventDb {
  id: string
  connection_id: string
  type: string
  node_id: string | null
  actor_identity_id: string | null
  target_message_native_id: string | null
  target_message_id: string | null
  at: number
  received_at: number
  dedupe_key: string
  stream_order: string | null
  normalizer_version: number
  payload: string
  raw: string | null
}

const toStored = (r: EventDb): StoredEvent => ({
  id: r.id,
  connectionId: r.connection_id,
  type: r.type,
  nodeId: r.node_id,
  actorIdentityId: r.actor_identity_id,
  targetMessageNativeId: r.target_message_native_id,
  targetMessageId: r.target_message_id,
  at: r.at,
  receivedAt: r.received_at,
  dedupeKey: r.dedupe_key,
  streamOrder: r.stream_order,
  normalizerVersion: r.normalizer_version,
  payload: JSON.parse(r.payload) as Record<string, unknown>,
  raw: r.raw,
})

const toActivity = (r: EventDb): ChannelEvent | undefined => {
  const type = activityType(r.type)
  if (type === undefined) return undefined
  const p = JSON.parse(r.payload) as {
    reason?: string
    peerId?: string
    peerName?: string
    platformId?: string
    action?: string
    detail?: ChannelEvent['detail']
  }
  return {
    id: r.id,
    connectionId: r.connection_id,
    at: r.at,
    type,
    direction: directionOf(type),
    ...(p.action === undefined ? {} : { action: p.action }),
    ...(p.reason === undefined ? {} : { reason: p.reason }),
    ...(r.node_id === null ? {} : { conversationId: r.node_id }),
    ...(p.peerId === undefined ? {} : { peerId: p.peerId }),
    ...(p.peerName === undefined ? {} : { peerName: p.peerName }),
    ...(p.platformId === undefined ? {} : { platformId: p.platformId }),
    ...(p.detail === undefined ? {} : { detail: p.detail }),
  }
}

export interface EventQuery {
  type?: ChannelEventType | undefined
  direction?: 'in' | 'out' | undefined
  action?: string | undefined
  /** Node id. */
  conversationId?: string | undefined
  /** Page back from this event id (exclusive). */
  before?: string | undefined
  limit: number
}

export interface EventTableQuery {
  type?: ChannelEventType | undefined
  /** `in`: what the platform sent; `out`: what the agent did (replies, actions, reads). */
  direction?: 'in' | 'out' | undefined
  /** An action or read name, as the `action` of the event. */
  action?: string | undefined
  conversationId?: string | undefined
  /** The platform user id of the person the event is about. */
  peerId?: string | undefined
  /** Searches the reason, the name of the person and the title of the conversation. */
  q?: string | undefined
  order?: 'asc' | 'desc' | undefined
  page: number
  limit: number
}

/** The audit of platform actions across connections (`GET /audit/actions`): newest first, cursor paging. */
export interface AuditQuery {
  /** Only these connections (a scope the caller was granted, or a connector kind resolved to ids). */
  connectionIds?: readonly string[] | undefined
  connectionId?: string | undefined
  /** `action` (writes) or `read`; default both. */
  kind?: 'action' | 'read' | undefined
  /** The name of the tool or the sub-action. */
  action?: string | undefined
  /** A chat: its internal node id, or part of its title or of the target the call named. */
  chat?: string | undefined
  /** Part of the name of the person who asked (or `web owner`, `autonomous <origin>`). */
  requester?: string | undefined
  /** The id of the agent that made the call. */
  agentId?: string | undefined
  result?: 'ok' | 'error' | 'refused' | 'rate_limited' | undefined
  from?: number | undefined
  to?: number | undefined
  /** Page back from this event id (exclusive). */
  before?: string | undefined
  limit: number
}

export interface EventPage {
  items: ChannelEvent[]
  /** Pass as `before` for the next (older) page; undefined at the end. */
  next?: string
}

export interface EventStore {
  /** Append once per `(connection, dedupe key)`; `inserted: false` = a replay. */
  append(event: NewEvent): { event: StoredEvent; inserted: boolean }
  /** Record gateway activity (never throws on a duplicate: the key is unique per call). */
  record(event: NewChannelEvent): ChannelEvent
  /** Activity newest first. */
  list(connectionId: string, query: EventQuery): EventPage
  /** One page of activity, newest first by default, with the number of events that match. */
  table(connectionId: string, query: EventTableQuery): { items: ChannelEvent[]; total: number }
  /** The action and read names recorded so far (the Activity filter). */
  actions(connectionId: string): string[]
  /** Platform actions and reads of all connections, newest first (the Audit page, the audit tool). */
  audit(query: AuditQuery): EventPage
  /** Delete events older than `olderThan` (when set) and keep at most `keepLast` rows. */
  prune(options: { olderThan?: number; keepLast?: number }): number
  /** Events that name no node yet (oldest first). */
  unresolved(connectionId: string, limit?: number): StoredEvent[]
  resolve(id: string, nodeId: string): void
  /** `gateway.dropped` per node: for the inbox counters. */
  dropCounts(connectionId: string): Map<string, number>
  /** Nodes with gateway activity of the inbox kind (woke, observed, dropped). */
  clear(connectionId: string): void
  count(connectionId: string, type?: string): number
}

export function sqliteEventStore(sqlite: Database): EventStore {
  const insert = (e: NewEvent): { event: StoredEvent; inserted: boolean } => {
    const id = uuidv7()
    const res = sqlite
      .query(
        `INSERT INTO ch_events (id, connection_id, type, node_id, actor_identity_id, target_message_native_id,
           target_message_id, at, received_at, dedupe_key, stream_order, normalizer_version, payload, raw)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (connection_id, dedupe_key) DO NOTHING`,
      )
      .run(
        id,
        e.connectionId,
        e.type,
        e.nodeId ?? null,
        e.actorIdentityId ?? null,
        e.targetMessageNativeId ?? null,
        e.targetMessageId ?? null,
        e.at,
        e.receivedAt,
        e.dedupeKey,
        e.streamOrder ?? null,
        e.normalizerVersion ?? 1,
        JSON.stringify(e.payload ?? {}),
        e.raw ?? null,
      )
    const row = sqlite
      .query<EventDb, [string, string]>(
        'SELECT * FROM ch_events WHERE connection_id = ? AND dedupe_key = ?',
      )
      .get(e.connectionId, e.dedupeKey) as EventDb
    return { event: toStored(row), inserted: res.changes > 0 }
  }
  return {
    append: insert,
    record(event) {
      const id = uuidv7()
      const payload = {
        ...(event.reason === undefined ? {} : { reason: event.reason }),
        ...(event.peerId === undefined ? {} : { peerId: event.peerId }),
        ...(event.peerName === undefined ? {} : { peerName: event.peerName }),
        ...(event.platformId === undefined ? {} : { platformId: event.platformId }),
        ...(event.action === undefined ? {} : { action: event.action }),
        direction: directionOf(event.type),
        ...(event.detail === undefined ? {} : { detail: event.detail }),
      }
      sqlite
        .query(
          `INSERT INTO ch_events (id, connection_id, type, node_id, target_message_native_id, at, received_at, dedupe_key, payload)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          event.connectionId,
          gatewayType(event.type),
          event.conversationId ?? null,
          event.platformId ?? null,
          event.at,
          event.at,
          `gw:${id}`,
          JSON.stringify(payload),
        )
      return { ...event, id }
    },
    list(connectionId, query) {
      const where = ['connection_id = ?']
      const args: Array<string | number> = [connectionId]
      if (query.type !== undefined) {
        where.push('type = ?')
        args.push(gatewayType(query.type))
      } else if (query.direction !== undefined) {
        const types = typesOf(query.direction).map(gatewayType)
        where.push(`type IN (${types.map(() => '?').join(',')})`)
        args.push(...types)
      } else {
        where.push('type LIKE ?')
        args.push(`${GATEWAY_PREFIX}%`)
      }
      if (query.action !== undefined) {
        where.push("json_extract(payload, '$.action') = ?")
        args.push(query.action)
      }
      if (query.conversationId !== undefined) {
        where.push('node_id = ?')
        args.push(query.conversationId)
      }
      if (query.before !== undefined) {
        where.push('id < ?')
        args.push(query.before)
      }
      const rows = sqlite
        .query<EventDb, Array<string | number>>(
          `SELECT * FROM ch_events WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ?`,
        )
        .all(...args, query.limit + 1)
      const more = rows.length > query.limit
      const items = rows
        .slice(0, query.limit)
        .map(toActivity)
        .filter((e): e is ChannelEvent => e !== undefined)
      const last = rows.slice(0, query.limit).at(-1)
      return { items, ...(more && last !== undefined ? { next: last.id } : {}) }
    },
    table(connectionId, query) {
      const types = EVENT_TYPES.map(gatewayType)
      const where = ['e.connection_id = ?']
      const args: Array<string | number> = [connectionId]
      if (query.type !== undefined) {
        where.push('e.type = ?')
        args.push(gatewayType(query.type))
      } else {
        const wanted =
          query.direction === undefined ? types : typesOf(query.direction).map(gatewayType)
        where.push(`e.type IN (${wanted.map(() => '?').join(',')})`)
        args.push(...wanted)
      }
      if (query.action !== undefined) {
        where.push("json_extract(e.payload, '$.action') = ?")
        args.push(query.action)
      }
      if (query.conversationId !== undefined) {
        where.push('e.node_id = ?')
        args.push(query.conversationId)
      }
      if (query.peerId !== undefined) {
        where.push("json_extract(e.payload, '$.peerId') = ?")
        args.push(query.peerId)
      }
      if (query.q !== undefined && query.q.trim() !== '') {
        const like = likePattern(query.q.trim())
        where.push(
          `(json_extract(e.payload, '$.reason') LIKE ? ESCAPE '\\' OR json_extract(e.payload, '$.peerName') LIKE ? ESCAPE '\\'
             OR json_extract(e.payload, '$.action') LIKE ? ESCAPE '\\'
             OR e.node_id IN (SELECT id FROM ch_nodes WHERE connection_id = e.connection_id AND title LIKE ? ESCAPE '\\'))`,
        )
        args.push(like, like, like, like)
      }
      const from = `FROM ch_events e WHERE ${where.join(' AND ')}`
      const total =
        sqlite
          .query<{ n: number }, Array<string | number>>(`SELECT COUNT(*) AS n ${from}`)
          .get(...args)?.n ?? 0
      const dir = query.order === 'asc' ? 'ASC' : 'DESC'
      const rows = sqlite
        .query<EventDb, Array<string | number>>(
          `SELECT e.* ${from} ORDER BY e.id ${dir} LIMIT ? OFFSET ?`,
        )
        .all(...args, ...windowOf(query.page, query.limit))
      return {
        items: rows.map(toActivity).filter((e): e is ChannelEvent => e !== undefined),
        total,
      }
    },
    audit(query) {
      const types = (query.kind === undefined ? ['action', 'read'] : [query.kind]).map((t) =>
        gatewayType(t as ChannelEventType),
      )
      const where = [`e.type IN (${types.map(() => '?').join(',')})`]
      const args: Array<string | number> = [...types]
      if (query.connectionIds !== undefined) {
        if (query.connectionIds.length === 0) return { items: [] }
        where.push(`e.connection_id IN (${query.connectionIds.map(() => '?').join(',')})`)
        args.push(...query.connectionIds)
      }
      if (query.connectionId !== undefined) {
        where.push('e.connection_id = ?')
        args.push(query.connectionId)
      }
      if (query.action !== undefined) {
        where.push("json_extract(e.payload, '$.action') = ?")
        args.push(query.action)
      }
      if (query.result !== undefined) {
        where.push("json_extract(e.payload, '$.detail.result') = ?")
        args.push(query.result)
      }
      if (query.agentId !== undefined) {
        where.push("json_extract(e.payload, '$.detail.agent') = ?")
        args.push(query.agentId)
      }
      if (query.requester !== undefined && query.requester.trim() !== '') {
        where.push("json_extract(e.payload, '$.peerName') LIKE ? ESCAPE '\\'")
        args.push(likePattern(query.requester.trim()))
      }
      if (query.chat !== undefined && query.chat.trim() !== '') {
        const like = likePattern(query.chat.trim())
        where.push(
          `(e.node_id = ? OR json_extract(e.payload, '$.detail.targetChat') LIKE ? ESCAPE '\\'
             OR e.node_id IN (SELECT id FROM ch_nodes WHERE connection_id = e.connection_id AND title LIKE ? ESCAPE '\\'))`,
        )
        args.push(query.chat.trim(), like, like)
      }
      if (query.from !== undefined) {
        where.push('e.at >= ?')
        args.push(query.from)
      }
      if (query.to !== undefined) {
        where.push('e.at <= ?')
        args.push(query.to)
      }
      if (query.before !== undefined) {
        where.push('e.id < ?')
        args.push(query.before)
      }
      const rows = sqlite
        .query<EventDb, Array<string | number>>(
          `SELECT e.* FROM ch_events e WHERE ${where.join(' AND ')} ORDER BY e.id DESC LIMIT ?`,
        )
        .all(...args, query.limit + 1)
      const more = rows.length > query.limit
      const page = rows.slice(0, query.limit)
      const items = page.map(toActivity).filter((e): e is ChannelEvent => e !== undefined)
      const last = page.at(-1)
      return { items, ...(more && last !== undefined ? { next: last.id } : {}) }
    },
    actions(connectionId) {
      return sqlite
        .query<{ a: string }, [string]>(
          `SELECT DISTINCT json_extract(payload, '$.action') AS a FROM ch_events
             WHERE connection_id = ? AND type IN ('gateway.action', 'gateway.read') AND a IS NOT NULL ORDER BY a`,
        )
        .all(connectionId)
        .map((r) => r.a)
    },
    prune({ olderThan, keepLast }) {
      let removed = 0
      if (olderThan !== undefined) {
        removed += sqlite.query('DELETE FROM ch_events WHERE at < ?').run(olderThan).changes
      }
      if (keepLast !== undefined) {
        // the cap counts the activity of the gateway; platform events are bounded by age
        removed += sqlite
          .query(
            `DELETE FROM ch_events WHERE type LIKE 'gateway.%' AND id NOT IN
               (SELECT id FROM ch_events WHERE type LIKE 'gateway.%' ORDER BY id DESC LIMIT ?)`,
          )
          .run(keepLast).changes
      }
      return removed
    },
    unresolved(connectionId, limit = 100) {
      return sqlite
        .query<EventDb, [string, number]>(
          "SELECT * FROM ch_events WHERE connection_id = ? AND node_id IS NULL AND type NOT LIKE 'gateway.%' ORDER BY id LIMIT ?",
        )
        .all(connectionId, limit)
        .map(toStored)
    },
    resolve(id, nodeId) {
      sqlite.query('UPDATE ch_events SET node_id = ? WHERE id = ?').run(nodeId, id)
    },
    dropCounts(connectionId) {
      const out = new Map<string, number>()
      for (const r of sqlite
        .query<{ node_id: string; n: number }, [string, string]>(
          `SELECT node_id, COUNT(*) AS n FROM ch_events WHERE connection_id = ? AND type = ? AND node_id IS NOT NULL GROUP BY node_id`,
        )
        .all(connectionId, gatewayType('dropped'))) {
        out.set(r.node_id, r.n)
      }
      return out
    },
    clear(connectionId) {
      sqlite.query('DELETE FROM ch_events WHERE connection_id = ?').run(connectionId)
    },
    count(connectionId, type) {
      return (
        (type === undefined
          ? sqlite
              .query<{ n: number }, [string]>(
                'SELECT COUNT(*) AS n FROM ch_events WHERE connection_id = ?',
              )
              .get(connectionId)
          : sqlite
              .query<{ n: number }, [string, string]>(
                'SELECT COUNT(*) AS n FROM ch_events WHERE connection_id = ? AND type = ?',
              )
              .get(connectionId, type)
        )?.n ?? 0
      )
    },
  }
}
