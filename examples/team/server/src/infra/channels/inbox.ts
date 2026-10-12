/**
 * Metadata stores of the channels inbox (docs/plans/P41-team-channels.md, "linking without links"):
 * people who wrote and are not linked yet, one row per conversation seen (with counters), and the
 * activity events of a connection. None of them holds a message text: texts live only in the
 * sealed channel log.
 */
import type { Database } from 'bun:sqlite'
import { uuidv7 } from 'eharness'
import type { ConversationRef, Identity } from './types.ts'

// --- activity events ---------------------------------------------------------------------------

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
] as const
export type ChannelEventType = (typeof EVENT_TYPES)[number]

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
] as const
export type DropReason = (typeof DROP_REASONS)[number]

export interface ChannelEvent {
  id: string
  connectionId: string
  at: number
  type: ChannelEventType
  /** A drop reason code, a wake reason, or a short free text (never message text). */
  reason?: string
  conversationId?: string
  peerId?: string
  peerName?: string
  /** Platform id of the message the event is about. */
  platformId?: string
  /** Small facts (counts, outbox kind, attempt); never message text. */
  detail?: Record<string, string | number | boolean>
}

export type NewChannelEvent = Omit<ChannelEvent, 'id'>

interface EventDb {
  id: string
  connection_id: string
  at: number
  type: string
  reason: string | null
  conversation_id: string | null
  peer_id: string | null
  peer_name: string | null
  platform_id: string | null
  detail: string | null
}

const toEvent = (r: EventDb): ChannelEvent => ({
  id: r.id,
  connectionId: r.connection_id,
  at: r.at,
  type: r.type as ChannelEventType,
  ...(r.reason === null ? {} : { reason: r.reason }),
  ...(r.conversation_id === null ? {} : { conversationId: r.conversation_id }),
  ...(r.peer_id === null ? {} : { peerId: r.peer_id }),
  ...(r.peer_name === null ? {} : { peerName: r.peer_name }),
  ...(r.platform_id === null ? {} : { platformId: r.platform_id }),
  ...(r.detail === null ? {} : { detail: JSON.parse(r.detail) as ChannelEvent['detail'] }),
})

export interface EventQuery {
  type?: ChannelEventType | undefined
  conversationId?: string | undefined
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
  record(event: NewChannelEvent): ChannelEvent
  /** Newest first. */
  list(connectionId: string, query: EventQuery): EventPage
  /** Delete events older than `olderThan` (when set) and keep at most `keepLast` rows. */
  prune(options: { olderThan?: number; keepLast?: number }): number
  /** Delete every event of a connection. */
  clear(connectionId: string): void
}

export function sqliteEventStore(sqlite: Database): EventStore {
  return {
    record(event) {
      const id = uuidv7()
      sqlite
        .query(
          `INSERT INTO channel_events (id, connection_id, at, type, reason, conversation_id, peer_id, peer_name, platform_id, detail)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          event.connectionId,
          event.at,
          event.type,
          event.reason ?? null,
          event.conversationId ?? null,
          event.peerId ?? null,
          event.peerName ?? null,
          event.platformId ?? null,
          event.detail === undefined ? null : JSON.stringify(event.detail),
        )
      return { ...event, id }
    },
    list(connectionId, query) {
      const where = ['connection_id = ?']
      const args: Array<string | number> = [connectionId]
      if (query.type !== undefined) {
        where.push('type = ?')
        args.push(query.type)
      }
      if (query.conversationId !== undefined) {
        where.push('conversation_id = ?')
        args.push(query.conversationId)
      }
      if (query.before !== undefined) {
        where.push('id < ?')
        args.push(query.before)
      }
      const rows = sqlite
        .query<EventDb, Array<string | number>>(
          `SELECT * FROM channel_events WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ?`,
        )
        .all(...args, query.limit + 1)
      const more = rows.length > query.limit
      const items = rows.slice(0, query.limit).map(toEvent)
      const last = items.at(-1)
      return { items, ...(more && last !== undefined ? { next: last.id } : {}) }
    },
    prune({ olderThan, keepLast }) {
      let removed = 0
      if (olderThan !== undefined) {
        removed += sqlite.query('DELETE FROM channel_events WHERE at < ?').run(olderThan).changes
      }
      if (keepLast !== undefined) {
        removed += sqlite
          .query(
            'DELETE FROM channel_events WHERE id NOT IN (SELECT id FROM channel_events ORDER BY id DESC LIMIT ?)',
          )
          .run(keepLast).changes
      }
      return removed
    },
    clear(connectionId) {
      sqlite.query('DELETE FROM channel_events WHERE connection_id = ?').run(connectionId)
    },
  }
}

// --- conversations seen (inbox list) -----------------------------------------------------------

export type InboxOutcome = 'woke' | 'observed' | 'dropped'

export interface InboxRow {
  connectionId: string
  conversationId: string
  ref: ConversationRef
  woke: number
  observed: number
  dropped: number
  firstAt: number
  lastAt: number
}

interface InboxDb {
  connection_id: string
  conversation_id: string
  ref: string
  woke: number
  observed: number
  dropped: number
  first_at: number
  last_at: number
}

const toInbox = (r: InboxDb): InboxRow => ({
  connectionId: r.connection_id,
  conversationId: r.conversation_id,
  ref: JSON.parse(r.ref) as ConversationRef,
  woke: r.woke,
  observed: r.observed,
  dropped: r.dropped,
  firstAt: r.first_at,
  lastAt: r.last_at,
})

export interface InboxPage {
  items: InboxRow[]
  next?: string
}

export interface InboxStore {
  /** Count one message of a conversation (creates the row, keeps the newest reference). */
  touch(ref: ConversationRef, outcome: InboxOutcome, at: number): void
  get(connectionId: string, conversationId: string): InboxRow | undefined
  /** Most recently active first. `cursor` is the `next` of the previous page. */
  list(connectionId: string, options: { limit: number; cursor?: string | undefined }): InboxPage
  clear(connectionId: string): void
  /**
   * Fill inbox rows from the channel log for conversations that have none yet (idempotent: existing
   * rows are never touched). Counts come from message dispositions; older messages without one
   * count as woke when the agent answered later in the conversation, otherwise as nothing.
   * Observed-only and dropped messages of the past are unknown (0). Reads metadata only.
   */
  backfill(connectionId: string): number
}

const CURSOR_SEP = '|'

export function sqliteInboxStore(sqlite: Database): InboxStore {
  return {
    touch(ref, outcome, at) {
      const col = outcome
      sqlite
        .query(
          `INSERT INTO channel_inbox (connection_id, conversation_id, ref, ${col}, first_at, last_at)
           VALUES (?, ?, ?, 1, ?, ?)
           ON CONFLICT (connection_id, conversation_id) DO UPDATE SET
             ref = excluded.ref, ${col} = ${col} + 1, last_at = MAX(last_at, excluded.last_at)`,
        )
        .run(ref.connectionId, ref.id, JSON.stringify(ref), at, at)
    },
    get(connectionId, conversationId) {
      const r = sqlite
        .query<InboxDb, [string, string]>(
          'SELECT * FROM channel_inbox WHERE connection_id = ? AND conversation_id = ?',
        )
        .get(connectionId, conversationId)
      return r === null ? undefined : toInbox(r)
    },
    list(connectionId, options) {
      let rows: InboxDb[]
      if (options.cursor === undefined) {
        rows = sqlite
          .query<InboxDb, [string, number]>(
            `SELECT * FROM channel_inbox WHERE connection_id = ?
               ORDER BY last_at DESC, conversation_id DESC LIMIT ?`,
          )
          .all(connectionId, options.limit + 1)
      } else {
        const at = options.cursor.indexOf(CURSOR_SEP)
        const lastAt = Number(options.cursor.slice(0, at))
        const id = options.cursor.slice(at + 1)
        rows = sqlite
          .query<InboxDb, [string, number, number, string, number]>(
            `SELECT * FROM channel_inbox WHERE connection_id = ?
               AND (last_at < ? OR (last_at = ? AND conversation_id < ?))
               ORDER BY last_at DESC, conversation_id DESC LIMIT ?`,
          )
          .all(connectionId, lastAt, lastAt, id, options.limit + 1)
      }
      const more = rows.length > options.limit
      const items = rows.slice(0, options.limit).map(toInbox)
      const last = items.at(-1)
      return {
        items,
        ...(more && last !== undefined
          ? { next: `${last.lastAt}${CURSOR_SEP}${last.conversationId}` }
          : {}),
      }
    },
    clear(connectionId) {
      sqlite.query('DELETE FROM channel_inbox WHERE connection_id = ?').run(connectionId)
    },
    backfill(connectionId) {
      const missing = sqlite
        .query<{ conversation_id: string; ref: string; created_at: number }, [string, string]>(
          `SELECT conversation_id, ref, created_at FROM channel_conversations
             WHERE connection_id = ? AND conversation_id NOT IN
               (SELECT conversation_id FROM channel_inbox WHERE connection_id = ?)`,
        )
        .all(connectionId, connectionId)
      let added = 0
      for (const c of missing) {
        const rows = sqlite
          .query<{ at: number; self: number; disposition: string | null }, [string, string]>(
            'SELECT at, self, disposition FROM channel_messages WHERE connection_id = ? AND conversation_id = ? ORDER BY at',
          )
          .all(connectionId, c.conversation_id)
        if (rows.length === 0) continue
        let woke = 0
        let observed = 0
        rows.forEach((m, i) => {
          if (m.self === 1) return
          if (m.disposition === 'woke') woke++
          else if (m.disposition === 'observed') observed++
          else if (rows.slice(i + 1).some((x) => x.self === 1)) woke++
        })
        const first = Math.min(c.created_at, rows[0]?.at ?? c.created_at)
        const last = rows.at(-1)?.at ?? first
        added += sqlite
          .query(
            `INSERT OR IGNORE INTO channel_inbox (connection_id, conversation_id, ref, woke, observed, dropped, first_at, last_at)
             VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
          )
          .run(connectionId, c.conversation_id, c.ref, woke, observed, first, last).changes
      }
      return added
    },
  }
}

// --- people who are not linked yet -------------------------------------------------------------

export interface UnlinkedSender {
  connectionId: string
  peerId: string
  name: string | null
  username: string | null
  firstSeen: number
  lastSeen: number
  messageCount: number
  ignored: boolean
}

interface UnlinkedDb {
  connection_id: string
  peer_id: string
  name: string | null
  username: string | null
  first_seen: number
  last_seen: number
  message_count: number
  ignored: number
}

const toUnlinked = (r: UnlinkedDb): UnlinkedSender => ({
  connectionId: r.connection_id,
  peerId: r.peer_id,
  name: r.name,
  username: r.username,
  firstSeen: r.first_seen,
  lastSeen: r.last_seen,
  messageCount: r.message_count,
  ignored: r.ignored === 1,
})

export interface UnlinkedStore {
  /** A message arrived from this person: record who (never what). */
  seen(connectionId: string, sender: Identity, at: number): UnlinkedSender
  get(connectionId: string, peerId: string): UnlinkedSender | undefined
  /** Newest activity first; ignored people only with `includeIgnored`. */
  list(connectionId: string, options?: { includeIgnored?: boolean }): UnlinkedSender[]
  setIgnored(connectionId: string, peerId: string, ignored: boolean): boolean
  remove(connectionId: string, peerId: string): void
  clear(connectionId: string): void
}

export function sqliteUnlinkedStore(sqlite: Database): UnlinkedStore {
  const get = sqlite.query<UnlinkedDb, [string, string]>(
    'SELECT * FROM channel_unlinked WHERE connection_id = ? AND peer_id = ?',
  )
  return {
    seen(connectionId, sender, at) {
      sqlite
        .query(
          `INSERT INTO channel_unlinked (connection_id, peer_id, name, username, first_seen, last_seen, message_count, ignored)
           VALUES (?, ?, ?, ?, ?, ?, 1, 0)
           ON CONFLICT (connection_id, peer_id) DO UPDATE SET
             name = COALESCE(excluded.name, name), username = COALESCE(excluded.username, username),
             last_seen = MAX(last_seen, excluded.last_seen), message_count = message_count + 1`,
        )
        .run(connectionId, sender.id, sender.name ?? null, sender.username ?? null, at, at)
      return toUnlinked(get.get(connectionId, sender.id) as UnlinkedDb)
    },
    get(connectionId, peerId) {
      const r = get.get(connectionId, peerId)
      return r === null ? undefined : toUnlinked(r)
    },
    list(connectionId, options) {
      return sqlite
        .query<UnlinkedDb, [string]>(
          `SELECT * FROM channel_unlinked WHERE connection_id = ?${options?.includeIgnored === true ? '' : ' AND ignored = 0'}
             ORDER BY last_seen DESC, peer_id`,
        )
        .all(connectionId)
        .map(toUnlinked)
    },
    setIgnored(connectionId, peerId, ignored) {
      return (
        sqlite
          .query('UPDATE channel_unlinked SET ignored = ? WHERE connection_id = ? AND peer_id = ?')
          .run(ignored ? 1 : 0, connectionId, peerId).changes > 0
      )
    },
    remove(connectionId, peerId) {
      sqlite
        .query('DELETE FROM channel_unlinked WHERE connection_id = ? AND peer_id = ?')
        .run(connectionId, peerId)
    },
    clear(connectionId) {
      sqlite.query('DELETE FROM channel_unlinked WHERE connection_id = ?').run(connectionId)
    },
  }
}
