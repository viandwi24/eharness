/**
 * SQLite stores of the channels gateway (plain SQL on the shared connection): connection
 * configuration, conversations, the encrypted channel log, identities (the pairing token table stays for old databases, unused).
 */
import type { Database } from 'bun:sqlite'
import { uuidv7 } from 'eharness'
import type { SecretVault } from 'eharness/providers'
import { type ConnectionConfig, ConnectionConfigSchema, DEFAULT_RETENTION_DAYS } from './policy.ts'
import type { ConversationRef, Identity } from './types.ts'

// --- connection configuration ------------------------------------------------------------------

export interface ConfigStore {
  list(): ConnectionConfig[]
  get(connectionId: string): ConnectionConfig | undefined
  put(config: ConnectionConfig, now: number): void
  remove(connectionId: string): void
}

export function sqliteConfigStore(sqlite: Database): ConfigStore {
  return {
    list() {
      const rows = sqlite
        .query<{ config: string }, []>(
          'SELECT config FROM channel_connections ORDER BY connection_id',
        )
        .all()
      const out: ConnectionConfig[] = []
      for (const row of rows) {
        const parsed = ConnectionConfigSchema.safeParse(JSON.parse(row.config))
        if (parsed.success) out.push(parsed.data)
      }
      return out
    },
    get(connectionId) {
      const row = sqlite
        .query<{ config: string }, [string]>(
          'SELECT config FROM channel_connections WHERE connection_id = ?',
        )
        .get(connectionId)
      if (row === null) return undefined
      const parsed = ConnectionConfigSchema.safeParse(JSON.parse(row.config))
      return parsed.success ? parsed.data : undefined
    },
    put(config, now) {
      sqlite
        .query(
          `INSERT INTO channel_connections (connection_id, config, updated_at) VALUES (?, ?, ?)
           ON CONFLICT (connection_id) DO UPDATE SET config = excluded.config, updated_at = excluded.updated_at`,
        )
        .run(config.connectionId, JSON.stringify(config), now)
    },
    remove(connectionId) {
      sqlite.query('DELETE FROM channel_connections WHERE connection_id = ?').run(connectionId)
    },
  }
}

// --- conversations -----------------------------------------------------------------------------

export interface ConversationRow {
  connectionId: string
  conversationId: string
  sessionId: string
  agentId: string
  ref: ConversationRef
  label: string | null
  retentionDays: number | null
  createdAt: number
  /** 0 for the first agent; bumped when the agent of the conversation changes. */
  generation: number
}

interface ConversationDb {
  connection_id: string
  conversation_id: string
  session_id: string
  agent_id: string
  ref: string
  label: string | null
  retention_days: number | null
  created_at: number
  generation: number
}

const toConversation = (r: ConversationDb): ConversationRow => ({
  connectionId: r.connection_id,
  conversationId: r.conversation_id,
  sessionId: r.session_id,
  agentId: r.agent_id,
  ref: JSON.parse(r.ref) as ConversationRef,
  label: r.label,
  retentionDays: r.retention_days,
  createdAt: r.created_at,
  generation: r.generation,
})

export interface ConversationStore {
  get(connectionId: string, conversationId: string): ConversationRow | undefined
  bySession(sessionId: string): ConversationRow | undefined
  list(connectionId?: string): ConversationRow[]
  /** Create the row when missing; an existing row keeps its session and agent. */
  ensure(row: Omit<ConversationRow, 'createdAt' | 'generation'>, now: number): ConversationRow
  /** The agent of the conversation changed: it moves to a new session (and generation). */
  rebind(
    connectionId: string,
    conversationId: string,
    to: { agentId: string; sessionId: string; generation: number },
  ): ConversationRow | undefined
  setRetention(connectionId: string, conversationId: string, days: number | null): void
}

export function sqliteConversationStore(sqlite: Database): ConversationStore {
  const get = sqlite.query<ConversationDb, [string, string]>(
    'SELECT * FROM channel_conversations WHERE connection_id = ? AND conversation_id = ?',
  )
  return {
    get(connectionId, conversationId) {
      const r = get.get(connectionId, conversationId)
      return r === null ? undefined : toConversation(r)
    },
    bySession(sessionId) {
      const r = sqlite
        .query<ConversationDb, [string]>('SELECT * FROM channel_conversations WHERE session_id = ?')
        .get(sessionId)
      return r === null ? undefined : toConversation(r)
    },
    list(connectionId) {
      const rows =
        connectionId === undefined
          ? sqlite
              .query<ConversationDb, []>(
                'SELECT * FROM channel_conversations ORDER BY created_at, conversation_id',
              )
              .all()
          : sqlite
              .query<ConversationDb, [string]>(
                'SELECT * FROM channel_conversations WHERE connection_id = ? ORDER BY created_at, conversation_id',
              )
              .all(connectionId)
      return rows.map(toConversation)
    },
    ensure(row, now) {
      sqlite
        .query(
          `INSERT INTO channel_conversations (connection_id, conversation_id, session_id, agent_id, ref, label, retention_days, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (connection_id, conversation_id) DO UPDATE SET ref = excluded.ref,
             label = COALESCE(excluded.label, label)`,
        )
        .run(
          row.connectionId,
          row.conversationId,
          row.sessionId,
          row.agentId,
          JSON.stringify(row.ref),
          row.label,
          row.retentionDays,
          now,
        )
      return toConversation(get.get(row.connectionId, row.conversationId) as ConversationDb)
    },
    rebind(connectionId, conversationId, to) {
      sqlite
        .query(
          'UPDATE channel_conversations SET agent_id = ?, session_id = ?, generation = ? WHERE connection_id = ? AND conversation_id = ?',
        )
        .run(to.agentId, to.sessionId, to.generation, connectionId, conversationId)
      const r = get.get(connectionId, conversationId)
      return r === null ? undefined : toConversation(r)
    },
    setRetention(connectionId, conversationId, days) {
      sqlite
        .query(
          'UPDATE channel_conversations SET retention_days = ? WHERE connection_id = ? AND conversation_id = ?',
        )
        .run(days, connectionId, conversationId)
    },
  }
}

// --- the channel log ---------------------------------------------------------------------------

/** What a log row says once opened (the sealed body). */
export interface LogMessage {
  /** Our id (uuidv7, sorts by creation). */
  id: string
  connectionId: string
  conversationId: string
  /** The platform's message id. */
  platformId: string
  at: number
  /** The message was sent by this identity. */
  self: boolean
  sender?: Identity
  text: string
  attachments: Array<{
    id: string
    kind?: string
    name?: string
    mediaType?: string
    size?: number
  }>
  replyTo?: { messageId: string; senderName?: string; text?: string }
  editedAt?: number
  deletedAt?: number
  /** Earlier texts of an edited message, oldest first. */
  edits?: Array<{ at: number; text: string }>
  /** What the gateway did with an incoming message (absent: sent by us, or stored before this was kept). */
  disposition?: 'woke' | 'observed'
}

interface Body {
  sender?: Identity
  text: string
  attachments: LogMessage['attachments']
  replyTo?: LogMessage['replyTo']
  edits?: LogMessage['edits']
}

interface MessageDb {
  id: string
  connection_id: string
  conversation_id: string
  platform_id: string
  at: number
  self: number
  pending: number
  handled: number
  edited_at: number | null
  deleted_at: number | null
  rev: number
  disposition: string | null
  body: string
}

export interface NewLogMessage {
  connectionId: string
  conversationId: string
  platformId: string
  at: number
  self?: boolean
  sender?: Identity | undefined
  text: string
  attachments?: LogMessage['attachments']
  replyTo?: LogMessage['replyTo'] | undefined
}

export interface InsertResult {
  inserted: boolean
  /** The row existed and the gateway had finished acting on it. */
  handled: boolean
  id: string
}

export interface ChannelLog {
  /** Store a message once per (connection, conversation, platform id). `pending` = observed, for the next wake. */
  insert(
    message: NewLogMessage,
    options: { pending: boolean; handled?: boolean; disposition?: 'woke' | 'observed' },
  ): Promise<InsertResult>
  markHandled(connectionId: string, conversationId: string, platformId: string): void
  find(
    connectionId: string,
    conversationId: string,
    platformId: string,
  ): Promise<LogMessage | undefined>
  /** The text of a message changed: the old text moves to `edits`. False when the message is unknown. */
  recordEdit(
    connectionId: string,
    conversationId: string,
    platformId: string,
    text: string,
    at: number,
  ): Promise<boolean>
  recordDeleted(
    connectionId: string,
    conversationId: string,
    platformIds: string[],
    at: number,
  ): number
  /** Newest `limit` messages, oldest first; `before` = a platform id to page back from. */
  recent(
    connectionId: string,
    conversationId: string,
    options: { limit: number; before?: string },
  ): Promise<LogMessage[]>
  /**
   * One page for the inbox view: `limit` messages older than our id `before` (the newest when
   * absent), oldest first; `more` says whether older ones exist.
   */
  page(
    connectionId: string,
    conversationId: string,
    options: { limit: number; before?: string | undefined },
  ): Promise<{ items: LogMessage[]; more: boolean }>
  /** The newest message of a conversation, if any. */
  last(connectionId: string, conversationId: string): Promise<LogMessage | undefined>
  /** Observed messages not yet shown to a run, oldest first (the newest `limit`). */
  pending(connectionId: string, conversationId: string, limit: number): Promise<LogMessage[]>
  /** Messages up to our id `upTo` are shown: not pending anymore. */
  clearPending(connectionId: string, conversationId: string, upTo: string): number
  /** Delete rows older than each conversation's retention; returns the number removed. */
  purge(now: number, defaultDays?: number): number
  count(connectionId?: string): number
  /**
   * Rows changed (inserted, edited or deleted) after change counter `afterRev`, oldest change
   * first: the feed of collectors. `rev` of a row is the counter of its latest change.
   */
  changes(connectionId: string, afterRev: number, limit: number): Promise<LogChange[]>
  /**
   * Find logged messages by platform id (deletions arrive as ids only). With `container`, only
   * conversations of that chat (`<container>` or `<container>/<topic>`).
   */
  locate(
    connectionId: string,
    platformIds: readonly string[],
    container?: string,
  ): Array<{ conversationId: string; platformId: string }>
}

export interface LogChange extends LogMessage {
  rev: number
}

export function sqliteChannelLog(sqlite: Database, vault: SecretVault): ChannelLog {
  const bodyOf = (m: NewLogMessage): Body => ({
    ...(m.sender === undefined ? {} : { sender: m.sender }),
    text: m.text,
    attachments: m.attachments ?? [],
    ...(m.replyTo === undefined ? {} : { replyTo: m.replyTo }),
  })
  const context = (id: string): string => `channel-message:${id}`
  const open = async (r: MessageDb): Promise<LogMessage> => {
    const body = JSON.parse(await vault.open(r.body, context(r.id))) as Body
    return {
      id: r.id,
      connectionId: r.connection_id,
      conversationId: r.conversation_id,
      platformId: r.platform_id,
      at: r.at,
      self: r.self === 1,
      ...(body.sender === undefined ? {} : { sender: body.sender }),
      text: body.text,
      attachments: body.attachments,
      ...(body.replyTo === undefined ? {} : { replyTo: body.replyTo }),
      ...(r.edited_at === null ? {} : { editedAt: r.edited_at }),
      ...(r.deleted_at === null ? {} : { deletedAt: r.deleted_at }),
      ...(body.edits === undefined ? {} : { edits: body.edits }),
      ...(r.disposition === 'woke' || r.disposition === 'observed'
        ? { disposition: r.disposition }
        : {}),
    }
  }
  const byPlatform = sqlite.query<MessageDb, [string, string, string]>(
    'SELECT * FROM channel_messages WHERE connection_id = ? AND conversation_id = ? AND platform_id = ?',
  )
  return {
    async insert(message, options) {
      const id = uuidv7()
      const sealed = await vault.seal(JSON.stringify(bodyOf(message)), context(id))
      const res = sqlite
        .query(
          `INSERT INTO channel_messages (id, connection_id, conversation_id, platform_id, at, self, pending, handled, rev, disposition, body)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(rev), 0) + 1 FROM channel_messages WHERE connection_id = ?), ?, ?)
           ON CONFLICT (connection_id, conversation_id, platform_id) DO NOTHING`,
        )
        .run(
          id,
          message.connectionId,
          message.conversationId,
          message.platformId,
          message.at,
          message.self === true ? 1 : 0,
          options.pending ? 1 : 0,
          options.handled === true ? 1 : 0,
          message.connectionId,
          options.disposition ?? null,
          sealed,
        )
      if (res.changes > 0) return { inserted: true, handled: options.handled === true, id }
      const row = byPlatform.get(message.connectionId, message.conversationId, message.platformId)
      return { inserted: false, handled: row?.handled === 1, id: row?.id ?? id }
    },
    markHandled(connectionId, conversationId, platformId) {
      sqlite
        .query(
          'UPDATE channel_messages SET handled = 1 WHERE connection_id = ? AND conversation_id = ? AND platform_id = ?',
        )
        .run(connectionId, conversationId, platformId)
    },
    async find(connectionId, conversationId, platformId) {
      const r = byPlatform.get(connectionId, conversationId, platformId)
      return r === null ? undefined : open(r)
    },
    async recordEdit(connectionId, conversationId, platformId, text, at) {
      const r = byPlatform.get(connectionId, conversationId, platformId)
      if (r === null) return false
      const current = await open(r)
      if (current.text === text) return true
      const body: Body = {
        ...(current.sender === undefined ? {} : { sender: current.sender }),
        text,
        attachments: current.attachments,
        ...(current.replyTo === undefined ? {} : { replyTo: current.replyTo }),
        edits: [...(current.edits ?? []), { at, text: current.text }],
      }
      const sealed = await vault.seal(JSON.stringify(body), context(r.id))
      sqlite
        .query(
          `UPDATE channel_messages SET body = ?, edited_at = ?,
             rev = (SELECT COALESCE(MAX(rev), 0) + 1 FROM channel_messages WHERE connection_id = ?) WHERE id = ?`,
        )
        .run(sealed, at, connectionId, r.id)
      return true
    },
    recordDeleted(connectionId, conversationId, platformIds, at) {
      let n = 0
      for (const platformId of platformIds) {
        n += sqlite
          .query(
            `UPDATE channel_messages SET deleted_at = ?,
               rev = (SELECT COALESCE(MAX(rev), 0) + 1 FROM channel_messages WHERE connection_id = ?)
               WHERE connection_id = ? AND conversation_id = ? AND platform_id = ? AND deleted_at IS NULL`,
          )
          .run(at, connectionId, connectionId, conversationId, platformId).changes
      }
      return n
    },
    async recent(connectionId, conversationId, options) {
      let before: string | undefined
      if (options.before !== undefined) {
        before = byPlatform.get(connectionId, conversationId, options.before)?.id
        if (before === undefined) return []
      }
      const rows = sqlite
        .query<MessageDb, [string, string, string, number]>(
          `SELECT * FROM channel_messages WHERE connection_id = ? AND conversation_id = ?
             AND id < ? ORDER BY id DESC LIMIT ?`,
        )
        .all(connectionId, conversationId, before ?? '￿', options.limit)
      return Promise.all(rows.reverse().map(open))
    },
    async page(connectionId, conversationId, options) {
      const rows = sqlite
        .query<MessageDb, [string, string, string, number]>(
          `SELECT * FROM channel_messages WHERE connection_id = ? AND conversation_id = ?
             AND id < ? ORDER BY id DESC LIMIT ?`,
        )
        .all(connectionId, conversationId, options.before ?? '￿', options.limit + 1)
      const more = rows.length > options.limit
      const items = await Promise.all(rows.slice(0, options.limit).reverse().map(open))
      return { items, more }
    },
    async last(connectionId, conversationId) {
      const r = sqlite
        .query<MessageDb, [string, string]>(
          `SELECT * FROM channel_messages WHERE connection_id = ? AND conversation_id = ?
             ORDER BY id DESC LIMIT 1`,
        )
        .get(connectionId, conversationId)
      return r === null ? undefined : open(r)
    },
    async pending(connectionId, conversationId, limit) {
      const rows = sqlite
        .query<MessageDb, [string, string, number]>(
          `SELECT * FROM channel_messages WHERE connection_id = ? AND conversation_id = ? AND pending = 1
             ORDER BY id DESC LIMIT ?`,
        )
        .all(connectionId, conversationId, limit)
      return Promise.all(rows.reverse().map(open))
    },
    clearPending(connectionId, conversationId, upTo) {
      return sqlite
        .query(
          'UPDATE channel_messages SET pending = 0 WHERE connection_id = ? AND conversation_id = ? AND pending = 1 AND id <= ?',
        )
        .run(connectionId, conversationId, upTo).changes
    },
    purge(now, defaultDays = DEFAULT_RETENTION_DAYS) {
      // per conversation: its own retention, else the default (a conversation without a row too)
      const rows = sqlite
        .query<{ connection_id: string; conversation_id: string; days: number | null }, []>(
          `SELECT m.connection_id, m.conversation_id, c.retention_days AS days
             FROM (SELECT DISTINCT connection_id, conversation_id FROM channel_messages) m
             LEFT JOIN channel_conversations c
               ON c.connection_id = m.connection_id AND c.conversation_id = m.conversation_id`,
        )
        .all()
      let removed = 0
      const del = sqlite.query(
        'DELETE FROM channel_messages WHERE connection_id = ? AND conversation_id = ? AND at < ?',
      )
      for (const r of rows) {
        const days = r.days ?? defaultDays
        removed += del.run(r.connection_id, r.conversation_id, now - days * 86_400_000).changes
      }
      return removed
    },
    async changes(connectionId, afterRev, limit) {
      const rows = sqlite
        .query<MessageDb, [string, number, number]>(
          'SELECT * FROM channel_messages WHERE connection_id = ? AND rev > ? ORDER BY rev ASC LIMIT ?',
        )
        .all(connectionId, afterRev, limit)
      return Promise.all(rows.map(async (r) => ({ ...(await open(r)), rev: r.rev })))
    },
    locate(connectionId, platformIds, container) {
      const out: Array<{ conversationId: string; platformId: string }> = []
      const q = sqlite.query<{ conversation_id: string; platform_id: string }, [string, string]>(
        'SELECT conversation_id, platform_id FROM channel_messages WHERE connection_id = ? AND platform_id = ?',
      )
      for (const platformId of platformIds) {
        for (const r of q.all(connectionId, platformId)) {
          if (
            container !== undefined &&
            r.conversation_id !== container &&
            !r.conversation_id.startsWith(`${container}/`)
          ) {
            continue
          }
          out.push({ conversationId: r.conversation_id, platformId: r.platform_id })
        }
      }
      return out
    },
    count(connectionId) {
      const r =
        connectionId === undefined
          ? sqlite.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM channel_messages').get()
          : sqlite
              .query<{ n: number }, [string]>(
                'SELECT COUNT(*) AS n FROM channel_messages WHERE connection_id = ?',
              )
              .get(connectionId)
      return r?.n ?? 0
    },
  }
}

// --- identities (linked accounts) --------------------------------------------------------------

export interface PeerLink {
  connectionId: string
  peerId: string
  memberId: string
  name: string | null
  linkedAt: number
}

export interface PairingStore {
  /** Link a platform account to a team member (replaces an earlier link of the same account). */
  link(input: {
    connectionId: string
    peerId: string
    memberId: string
    name: string | undefined
    now: number
  }): PeerLink
  memberOf(connectionId: string, peerId: string): PeerLink | undefined
  /** The platform account of a member (the newest link), to DM them. */
  peerOf(connectionId: string, memberId: string): PeerLink | undefined
  unlink(connectionId: string, peerId: string): boolean
  list(connectionId: string): PeerLink[]
}

interface LinkDb {
  connection_id: string
  peer_id: string
  member_id: string
  name: string | null
  linked_at: number
}
const toLink = (r: LinkDb): PeerLink => ({
  connectionId: r.connection_id,
  peerId: r.peer_id,
  memberId: r.member_id,
  name: r.name,
  linkedAt: r.linked_at,
})

export function sqlitePairingStore(sqlite: Database): PairingStore {
  const link = sqlite.query<LinkDb, [string, string]>(
    'SELECT * FROM channel_identities WHERE connection_id = ? AND peer_id = ?',
  )
  return {
    link({ connectionId, peerId, memberId, name, now }) {
      sqlite
        .query(
          `INSERT INTO channel_identities (connection_id, peer_id, member_id, name, linked_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (connection_id, peer_id) DO UPDATE SET member_id = excluded.member_id, name = excluded.name, linked_at = excluded.linked_at`,
        )
        .run(connectionId, peerId, memberId, name ?? null, now)
      return toLink(link.get(connectionId, peerId) as LinkDb)
    },
    memberOf(connectionId, peerId) {
      const r = link.get(connectionId, peerId)
      return r === null ? undefined : toLink(r)
    },
    peerOf(connectionId, memberId) {
      const r = sqlite
        .query<LinkDb, [string, string]>(
          'SELECT * FROM channel_identities WHERE connection_id = ? AND member_id = ? ORDER BY linked_at DESC LIMIT 1',
        )
        .get(connectionId, memberId)
      return r === null ? undefined : toLink(r)
    },
    unlink(connectionId, peerId) {
      return (
        sqlite
          .query('DELETE FROM channel_identities WHERE connection_id = ? AND peer_id = ?')
          .run(connectionId, peerId).changes > 0
      )
    },
    list(connectionId) {
      return sqlite
        .query<LinkDb, [string]>(
          'SELECT * FROM channel_identities WHERE connection_id = ? ORDER BY linked_at',
        )
        .all(connectionId)
        .map(toLink)
    },
  }
}
