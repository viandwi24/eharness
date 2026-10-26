/**
 * The message store of the channels gateway (docs/plans/P41-team-channels.md, phase L5): messages
 * keyed by `(node, native id)` whose content is sealed with the channel vault, edits kept as
 * revisions, deletions as tombstones (the content stays for audit until the node's retention,
 * unless the node setting `redactOnDelete` is on), and reactions.
 */
import type { Database } from 'bun:sqlite'
import { uuidv7 } from 'eharness'
import type { SecretVault } from 'eharness/providers'
import { identityDtoOf } from './identities.ts'
import {
  type ContentPart,
  FILE_URL_PREFIX,
  type FileMedia,
  filesOfContent,
  type IdentityRow,
  type MessageContent,
  type MessageEntity,
  type StructuredContent,
  textOfContent,
} from './model.ts'
import type { Identity } from './types.ts'

/** A stored file of a message: what it is, never its bytes. */
export interface LogAttachment extends FileMedia {
  id: string
  kind?: string
  name?: string
  mediaType?: string
  size?: number
}

/** The stored form of an inbound attachment (drops `fetch` and absent fields). */
export const logAttachmentOf = (
  a: {
    id: string
    kind?: string
    name?: string | undefined
    mediaType?: string | undefined
    size?: number | undefined
  } & { [K in keyof FileMedia]?: FileMedia[K] | undefined },
): LogAttachment => {
  const out: LogAttachment = { id: a.id }
  if (a.kind !== undefined) out.kind = a.kind
  if (a.name !== undefined) out.name = a.name
  if (a.mediaType !== undefined) out.mediaType = a.mediaType
  if (a.size !== undefined) out.size = a.size
  return { ...out, ...mediaOf(a as FileMedia) }
}

const MEDIA_NAMES: Record<string, string> = {
  photo: 'photo',
  video: 'video',
  animation: 'GIF',
  video_note: 'video note',
  voice: 'voice message',
  audio: 'audio',
  document: 'file',
  sticker: 'sticker',
  image: 'image',
  file: 'file',
}

/** `[photo]`, `[3 photos]`, `[sticker 🚀]`, `[voice message, file]` — what a message carries, for lines the agent reads. */
export const attachmentsLabel = (list: readonly LogAttachment[]): string => {
  if (list.length === 0) return ''
  const counts = new Map<string, number>()
  for (const a of list) {
    const base = MEDIA_NAMES[a.media ?? a.kind ?? 'file'] ?? 'file'
    const name = a.sticker?.emoji === undefined ? base : `${base} ${a.sticker.emoji}`
    counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  return `[${[...counts].map(([name, n]) => (n === 1 ? name : `${n} ${name}s`)).join(', ')}]`
}

const MEDIA_KEYS = ['media', 'width', 'height', 'duration', 'sticker', 'ref'] as const

/** What a stored message says once opened. */
export interface LogMessage {
  /** Our id (uuidv7, sorts by creation). */
  id: string
  connectionId: string
  nodeId: string
  /** The platform's message id. */
  nativeId: string
  /** Platform time. */
  at: number
  /** The message was sent by this identity. */
  self: boolean
  sender?: Identity
  senderIdentityId?: string
  text: string
  attachments: LogAttachment[]
  entities?: MessageEntity[]
  replyTo?: { messageId: string; senderName?: string; text?: string }
  threadRoot?: string
  /** Origin of a forwarded message, as the adapter reported it. */
  forwardOf?: Record<string, unknown>
  /** Album id shared by messages sent together. */
  groupId?: string
  /** A place, contact, poll or dice. */
  structured?: StructuredContent
  kind: 'message' | 'service' | 'system'
  editedAt?: number
  deletedAt?: number
  /** The message was deleted and its content is still stored (audit). */
  deletedHasContent?: boolean
  /** Earlier texts of an edited message, oldest first. */
  edits?: Array<{ at: number; text: string }>
  /** What the gateway did with an incoming message (absent: sent by us, or stored before this was kept). */
  disposition?: 'woke' | 'observed'
  /** Local change counter (collectors). */
  rev: number
}

interface MessageDb {
  id: string
  connection_id: string
  node_id: string
  native_id: string
  sender_identity_id: string | null
  sent_at: number
  sort_key: string
  direction: string
  kind: string
  content: string | null
  content_version: number
  reply_to_native_id: string | null
  reply_to_message_id: string | null
  thread_root_native_id: string | null
  edited_at: number | null
  deleted_at: number | null
  deleted_by: string | null
  deleted_has_content: number
  send_txn_id: string | null
  disposition: string | null
  pending: number
  handled: number
  rev: number
  meta: string
}

export interface NewLogMessage {
  connectionId: string
  nodeId: string
  nativeId: string
  at: number
  /** `out` = sent by this identity. Default `in`. */
  direction?: 'in' | 'out'
  senderIdentityId?: string | undefined
  text: string
  attachments?: LogMessage['attachments']
  entities?: MessageEntity[] | undefined
  replyTo?: LogMessage['replyTo'] | undefined
  threadRoot?: string | undefined
  kind?: 'message' | 'service' | 'system'
  sortKey?: string | undefined
  sendTxnId?: string | undefined
  forwardOf?: Record<string, unknown> | undefined
  groupId?: string | undefined
  structured?: StructuredContent | undefined
}

/** A message the Pause all hold kept from waking the agent. */
export interface HeldWake {
  connectionId: string
  nodeId: string
  nativeId: string
  /** Platform time of the message (ms). */
  sentAt: number
  /** When it was held (ms). */
  heldAt: number
  /** What the wake policy decided ("mentioned", "reply to the agent", ...). */
  reason: string
}

export interface InsertResult {
  inserted: boolean
  /** The row existed and the gateway had finished acting on it. */
  handled: boolean
  id: string
}

export interface LogChange extends LogMessage {
  rev: number
}

export interface ChannelLog {
  /** Store a message once per (node, native id). `pending` = observed, for the next wake. */
  insert(
    message: NewLogMessage,
    options: { pending: boolean; handled?: boolean; disposition?: 'woke' | 'observed' },
  ): Promise<InsertResult>
  /** `handled = false` hands a row back (a wake that could not be queued must be retried). */
  markHandled(nodeId: string, nativeId: string, handled?: boolean): void
  /**
   * Pause all with the channel hold: remember that this message would have woken the agent (it
   * stays context for the log). Durable (inside `meta`), so a restart between pause and resume
   * loses nothing.
   */
  markHeld(nodeId: string, nativeId: string, held: { at: number; reason: string }): void
  /** Held wake messages not settled yet, oldest first (per node, in time order). */
  heldWakes(options?: { connectionId?: string }): HeldWake[]
  /** The held message was answered or dropped: it never comes back (and is not context twice). */
  settleHeld(nodeId: string, nativeId: string): void
  /** A message that was going to wake the agent becomes context for the next wake (observed, shown once). */
  demote(nodeId: string, nativeId: string): void
  find(nodeId: string, nativeId: string): Promise<LogMessage | undefined>
  byId(id: string): Promise<LogMessage | undefined>
  /** A message of the connection by native id, when exactly one node has it. */
  findAnywhere(connectionId: string, nativeId: string): Promise<LogMessage | undefined>
  /** The text of a message changed: the old content moves to a revision. False when the message is unknown. */
  recordEdit(
    nodeId: string,
    nativeId: string,
    next: { text: string; entities?: MessageEntity[] | undefined },
    at: number,
    editorIdentityId?: string,
  ): Promise<boolean>
  /** Tombstone messages. With `redact`, their content is dropped too. Returns how many changed. */
  recordDeleted(
    nodeId: string,
    nativeIds: string[],
    at: number,
    options?: { redact?: boolean; by?: string },
  ): number
  /** Newest `limit` messages, oldest first; `before` = a native id to page back from. */
  recent(nodeId: string, options: { limit: number; before?: string }): Promise<LogMessage[]>
  /**
   * One page for the inbox view: `limit` messages older than our id `before` (the newest when
   * absent), oldest first; `more` says whether older ones exist.
   */
  page(
    nodeId: string,
    options: { limit: number; before?: string | undefined },
  ): Promise<{ items: LogMessage[]; more: boolean }>
  /** The newest message of a node, if any. */
  last(nodeId: string): Promise<LogMessage | undefined>
  /** The newest message of these nodes that woke the agent (a person's), if any. */
  lastWoke(nodeIds: readonly string[]): Promise<LogMessage | undefined>
  /** How much of these nodes the log holds: the oldest and newest message time and the count (deleted ones not counted). */
  stats(nodeIds: readonly string[]): {
    firstAt: number | undefined
    lastAt: number | undefined
    count: number
  }
  /**
   * Messages of these nodes sent in `[from, to)`, oldest first by time. `after` is the `next` of
   * the previous page; `next` is undefined at the end. Deleted messages are left out; system
   * entries (a moderation log) are left out unless `includeSystem`.
   */
  range(
    nodeIds: readonly string[],
    options: {
      from: number
      to: number
      limit: number
      after?: string | undefined
      includeSystem?: boolean
    },
  ): Promise<{ items: LogMessage[]; next?: string }>
  /** Observed messages of these nodes not yet shown to a run, oldest first (the newest `limit`). */
  pending(nodeIds: readonly string[], limit: number): Promise<LogMessage[]>
  /** Messages of these nodes up to our id `upTo` are shown: not pending anymore. */
  clearPending(nodeIds: readonly string[], upTo: string): number
  /** Delete messages older than each node's retention; returns the number removed. */
  purge(now: number, retentionDaysOf: (nodeId: string) => number): number
  count(connectionId?: string): number
  /** Messages by disposition for the inbox: per node `woke` / `observed` counts. */
  dispositionCounts(connectionId: string): Map<string, { woke: number; observed: number }>
  /**
   * Rows changed (inserted, edited or deleted) after change counter `afterRev`, oldest change
   * first: the feed of collectors. `rev` of a row is the counter of its latest change.
   */
  changes(connectionId: string, afterRev: number, limit: number): Promise<LogChange[]>
  /** Find stored messages by native id (deletions arrive as ids only). */
  locate(
    connectionId: string,
    nativeIds: readonly string[],
  ): Array<{ nodeId: string; nativeId: string }>
  /** Is a message of this node one this connection sent? */
  isOwn(nodeId: string, nativeId: string): boolean
  setReaction(
    messageId: string,
    identityId: string,
    reaction: { emoji: string; added: boolean; at: number },
  ): void
  reactions(
    messageId: string,
  ): Array<{ identityId: string; emoji: string; at: number; removedAt?: number }>
  /** Drop every message of a connection with revisions and reactions. */
  clear(connectionId: string): void
}

export const contentOf = (m: {
  text: string
  attachments?: LogMessage['attachments']
  entities?: MessageEntity[] | undefined
  replyTo?: LogMessage['replyTo'] | undefined
  forwardOf?: Record<string, unknown> | undefined
  groupId?: string | undefined
  structured?: StructuredContent | undefined
}): MessageContent => {
  const parts: ContentPart[] = []
  if (m.text !== '') parts.push({ type: 'text', text: m.text })
  for (const a of m.attachments ?? []) {
    parts.push({
      type: 'file',
      mediaType: a.mediaType ?? 'application/octet-stream',
      ...(a.name === undefined ? {} : { filename: a.name }),
      url: `${FILE_URL_PREFIX}${a.id}`,
      providerMetadata: {
        channel: {
          id: a.id,
          ...(a.kind === undefined ? {} : { kind: a.kind }),
          ...(a.size === undefined ? {} : { size: a.size }),
          ...mediaOf(a),
        },
      },
    })
  }
  const reply =
    m.replyTo === undefined || (m.replyTo.senderName === undefined && m.replyTo.text === undefined)
      ? undefined
      : {
          ...(m.replyTo.senderName === undefined ? {} : { senderName: m.replyTo.senderName }),
          ...(m.replyTo.text === undefined ? {} : { text: m.replyTo.text }),
        }
  return {
    parts,
    ...(m.entities === undefined || m.entities.length === 0 ? {} : { entities: m.entities }),
    ...(reply === undefined ? {} : { reply }),
    ...(m.forwardOf === undefined ? {} : { forwardOf: m.forwardOf }),
    ...(m.groupId === undefined ? {} : { groupId: m.groupId }),
    ...(m.structured === undefined ? {} : { structured: m.structured }),
  }
}

const mediaOf = (a: FileMedia): FileMedia => {
  const out: FileMedia = {}
  for (const k of MEDIA_KEYS) if (a[k] !== undefined) (out as Record<string, unknown>)[k] = a[k]
  return out
}

export function sqliteChannelLog(sqlite: Database, vault: SecretVault): ChannelLog {
  const context = (id: string): string => `channel-message:${id}`
  const revisionContext = (id: string, version: number): string =>
    `channel-message-revision:${id}:${version}`
  const identityQ = sqlite.query<
    {
      native_id: string
      kind: string
      display_name: string | null
      username: string | null
      is_self: number
    },
    [string]
  >('SELECT native_id, kind, display_name, username, is_self FROM ch_identities WHERE id = ?')

  const senderOf = (
    id: string | null,
    cache: Map<string, Identity | undefined>,
  ): Identity | undefined => {
    if (id === null) return undefined
    if (cache.has(id)) return cache.get(id)
    const r = identityQ.get(id)
    const dto =
      r === null
        ? undefined
        : identityDtoOf({
            id,
            connectionId: '',
            nativeId: r.native_id,
            kind: r.kind as IdentityRow['kind'],
            personId: null,
            linkedAt: null,
            isSelf: r.is_self === 1,
            displayName: r.display_name,
            username: r.username,
            avatar: null,
            meta: {},
            firstSeenAt: 0,
            lastSeenAt: 0,
            dmFirstAt: null,
            dmLastAt: null,
            dmCount: 0,
            ignored: false,
          })
    cache.set(id, dto)
    return dto
  }

  const open = async (
    r: MessageDb,
    cache: Map<string, Identity | undefined> = new Map(),
  ): Promise<LogMessage> => {
    const content: MessageContent =
      r.content === null
        ? { parts: [] }
        : (JSON.parse(await vault.open(r.content, context(r.id))) as MessageContent)
    const revisions =
      r.content_version > 0
        ? await Promise.all(
            sqlite
              .query<{ version: number; content: string; edited_at: number }, [string]>(
                'SELECT version, content, edited_at FROM ch_message_revisions WHERE message_id = ? ORDER BY version',
              )
              .all(r.id)
              .map(async (rev) => ({
                at: rev.edited_at,
                text: textOfContent(
                  JSON.parse(
                    await vault.open(rev.content, revisionContext(r.id, rev.version)),
                  ) as MessageContent,
                ),
              })),
          )
        : []
    const sender = senderOf(r.sender_identity_id, cache)
    return {
      id: r.id,
      connectionId: r.connection_id,
      nodeId: r.node_id,
      nativeId: r.native_id,
      at: r.sent_at,
      self: r.direction === 'out',
      ...(sender === undefined ? {} : { sender }),
      ...(r.sender_identity_id === null ? {} : { senderIdentityId: r.sender_identity_id }),
      text: textOfContent(content),
      attachments: filesOfContent(content).map((f) => ({
        id: f.providerMetadata?.channel.id ?? f.url.replace(FILE_URL_PREFIX, ''),
        ...(f.providerMetadata?.channel.kind === undefined
          ? {}
          : { kind: f.providerMetadata.channel.kind }),
        ...(f.filename === undefined ? {} : { name: f.filename }),
        mediaType: f.mediaType,
        ...(f.providerMetadata?.channel.size === undefined
          ? {}
          : { size: f.providerMetadata.channel.size }),
        ...(f.providerMetadata === undefined ? {} : mediaOf(f.providerMetadata.channel)),
      })),
      ...(content.entities === undefined ? {} : { entities: content.entities }),
      ...(r.reply_to_native_id === null
        ? {}
        : {
            replyTo: {
              messageId: r.reply_to_native_id,
              ...(content.reply?.senderName === undefined
                ? {}
                : { senderName: content.reply.senderName }),
              ...(content.reply?.text === undefined ? {} : { text: content.reply.text }),
            },
          }),
      ...(r.thread_root_native_id === null ? {} : { threadRoot: r.thread_root_native_id }),
      ...(content.forwardOf === undefined ? {} : { forwardOf: content.forwardOf }),
      ...(content.groupId === undefined ? {} : { groupId: content.groupId }),
      ...(content.structured === undefined ? {} : { structured: content.structured }),
      kind: r.kind as LogMessage['kind'],
      ...(r.edited_at === null ? {} : { editedAt: r.edited_at }),
      ...(r.deleted_at === null ? {} : { deletedAt: r.deleted_at }),
      ...(r.deleted_at === null ? {} : { deletedHasContent: r.deleted_has_content === 1 }),
      ...(revisions.length === 0 ? {} : { edits: revisions }),
      ...(r.disposition === 'woke' || r.disposition === 'observed'
        ? { disposition: r.disposition }
        : {}),
      rev: r.rev,
    }
  }
  const openAll = (rows: MessageDb[]): Promise<LogMessage[]> => {
    const cache = new Map<string, Identity | undefined>()
    return Promise.all(rows.map((r) => open(r, cache)))
  }

  const byNative = sqlite.query<MessageDb, [string, string]>(
    'SELECT * FROM ch_messages WHERE node_id = ? AND native_id = ?',
  )
  const byIdQ = sqlite.query<MessageDb, [string]>('SELECT * FROM ch_messages WHERE id = ?')
  const nextRev = '(SELECT COALESCE(MAX(rev), 0) + 1 FROM ch_messages WHERE connection_id = ?)'

  return {
    async insert(message, options) {
      const id = uuidv7()
      const sealed = await vault.seal(JSON.stringify(contentOf(message)), context(id))
      const res = sqlite
        .query(
          `INSERT INTO ch_messages (id, connection_id, node_id, native_id, sender_identity_id, sent_at, sort_key,
             direction, kind, content, reply_to_native_id, thread_root_native_id, send_txn_id,
             disposition, pending, handled, rev)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${nextRev})
           ON CONFLICT DO NOTHING`,
        )
        .run(
          id,
          message.connectionId,
          message.nodeId,
          message.nativeId,
          message.senderIdentityId ?? null,
          message.at,
          message.sortKey ?? message.nativeId,
          message.direction ?? 'in',
          message.kind ?? 'message',
          sealed,
          message.replyTo?.messageId ?? null,
          message.threadRoot ?? null,
          message.sendTxnId ?? null,
          options.disposition ?? null,
          options.pending ? 1 : 0,
          options.handled === true ? 1 : 0,
          message.connectionId,
        )
      if (res.changes > 0) return { inserted: true, handled: options.handled === true, id }
      const row = byNative.get(message.nodeId, message.nativeId)
      return { inserted: false, handled: row?.handled === 1, id: row?.id ?? id }
    },
    demote(nodeId, nativeId) {
      sqlite
        .query(
          "UPDATE ch_messages SET pending = 1, disposition = 'observed', handled = 1 WHERE node_id = ? AND native_id = ?",
        )
        .run(nodeId, nativeId)
    },
    markHandled(nodeId, nativeId, handled = true) {
      sqlite
        .query('UPDATE ch_messages SET handled = ? WHERE node_id = ? AND native_id = ?')
        .run(handled ? 1 : 0, nodeId, nativeId)
    },
    markHeld(nodeId, nativeId, held) {
      sqlite
        .query(
          "UPDATE ch_messages SET meta = json_set(meta, '$.heldWake', json(?)) WHERE node_id = ? AND native_id = ?",
        )
        .run(JSON.stringify(held), nodeId, nativeId)
    },
    heldWakes(options) {
      const rows = sqlite
        .query<
          {
            connection_id: string
            node_id: string
            native_id: string
            sent_at: number
            held_at: number
            reason: string
          },
          [string | null, string | null]
        >(
          `SELECT connection_id, node_id, native_id, sent_at,
                  json_extract(meta, '$.heldWake.at') AS held_at,
                  json_extract(meta, '$.heldWake.reason') AS reason
             FROM ch_messages
            WHERE json_extract(meta, '$.heldWake') IS NOT NULL
              AND json_extract(meta, '$.heldDone') IS NULL
              AND direction = 'in' AND deleted_at IS NULL
              AND (? IS NULL OR connection_id = ?)
            ORDER BY node_id, sent_at, sort_key, id`,
        )
        .all(options?.connectionId ?? null, options?.connectionId ?? null)
      return rows.map((r) => ({
        connectionId: r.connection_id,
        nodeId: r.node_id,
        nativeId: r.native_id,
        sentAt: r.sent_at,
        heldAt: r.held_at,
        reason: r.reason ?? '',
      }))
    },
    settleHeld(nodeId, nativeId) {
      sqlite
        .query(
          "UPDATE ch_messages SET pending = 0, meta = json_set(meta, '$.heldDone', 1) WHERE node_id = ? AND native_id = ?",
        )
        .run(nodeId, nativeId)
    },
    async find(nodeId, nativeId) {
      const r = byNative.get(nodeId, nativeId)
      return r === null ? undefined : open(r)
    },
    async byId(id) {
      const r = byIdQ.get(id)
      return r === null ? undefined : open(r)
    },
    async findAnywhere(connectionId, nativeId) {
      const rows = sqlite
        .query<MessageDb, [string, string]>(
          'SELECT * FROM ch_messages WHERE connection_id = ? AND native_id = ? LIMIT 2',
        )
        .all(connectionId, nativeId)
      return rows.length === 1 ? open(rows[0] as MessageDb) : undefined
    },
    async recordEdit(nodeId, nativeId, next, at, editorIdentityId) {
      const r = byNative.get(nodeId, nativeId)
      if (r === null) return false
      const current = await open(r)
      if (current.text === next.text) return true
      const version = r.content_version
      const previous = r.content === null ? '' : await vault.open(r.content, context(r.id))
      const keepFiles =
        r.content === null ? [] : filesOfContent(JSON.parse(previous) as MessageContent)
      const nextContent: MessageContent = {
        parts: [
          ...(next.text === '' ? [] : [{ type: 'text' as const, text: next.text }]),
          ...keepFiles,
        ],
        ...(next.entities === undefined || next.entities.length === 0
          ? {}
          : { entities: next.entities }),
        ...(current.replyTo?.senderName === undefined && current.replyTo?.text === undefined
          ? {}
          : {
              reply: {
                ...(current.replyTo.senderName === undefined
                  ? {}
                  : { senderName: current.replyTo.senderName }),
                ...(current.replyTo.text === undefined ? {} : { text: current.replyTo.text }),
              },
            }),
      }
      const sealedNext = await vault.seal(JSON.stringify(nextContent), context(r.id))
      if (r.content !== null) {
        const sealedOld = await vault.seal(previous, revisionContext(r.id, version))
        sqlite
          .query(
            `INSERT OR REPLACE INTO ch_message_revisions (message_id, version, content, edited_at, editor_identity_id)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .run(r.id, version, sealedOld, at, editorIdentityId ?? null)
      }
      sqlite
        .query(
          `UPDATE ch_messages SET content = ?, content_version = ?, edited_at = ?, rev = ${nextRev} WHERE id = ?`,
        )
        .run(sealedNext, version + 1, at, r.connection_id, r.id)
      return true
    },
    recordDeleted(nodeId, nativeIds, at, options) {
      let n = 0
      for (const nativeId of nativeIds) {
        const row = byNative.get(nodeId, nativeId)
        if (row === null || row.deleted_at !== null) continue
        const redact = options?.redact === true
        n += sqlite
          .query(
            `UPDATE ch_messages SET deleted_at = ?, deleted_by = ?, deleted_has_content = ?,
               content = CASE WHEN ? = 1 THEN NULL ELSE content END, rev = ${nextRev} WHERE id = ?`,
          )
          .run(
            at,
            options?.by ?? null,
            !redact && row.content !== null ? 1 : 0,
            redact ? 1 : 0,
            row.connection_id,
            row.id,
          ).changes
        if (redact) {
          sqlite.query('DELETE FROM ch_message_revisions WHERE message_id = ?').run(row.id)
        }
      }
      return n
    },
    async recent(nodeId, options) {
      let before: string | undefined
      if (options.before !== undefined) {
        before = byNative.get(nodeId, options.before)?.id
        if (before === undefined) return []
      }
      const rows = sqlite
        .query<MessageDb, [string, string, number]>(
          'SELECT * FROM ch_messages WHERE node_id = ? AND id < ? ORDER BY id DESC LIMIT ?',
        )
        .all(nodeId, before ?? '￿', options.limit)
      return openAll(rows.reverse())
    },
    async page(nodeId, options) {
      const rows = sqlite
        .query<MessageDb, [string, string, number]>(
          'SELECT * FROM ch_messages WHERE node_id = ? AND id < ? ORDER BY id DESC LIMIT ?',
        )
        .all(nodeId, options.before ?? '￿', options.limit + 1)
      const more = rows.length > options.limit
      return { items: await openAll(rows.slice(0, options.limit).reverse()), more }
    },
    async last(nodeId) {
      const r = sqlite
        .query<MessageDb, [string]>(
          'SELECT * FROM ch_messages WHERE node_id = ? ORDER BY id DESC LIMIT 1',
        )
        .get(nodeId)
      return r === null ? undefined : open(r)
    },
    async lastWoke(nodeIds) {
      if (nodeIds.length === 0) return undefined
      const r = sqlite
        .query<MessageDb, string[]>(
          `SELECT * FROM ch_messages WHERE node_id IN (${nodeIds.map(() => '?').join(',')})
             AND disposition = 'woke' AND direction != 'out' ORDER BY id DESC LIMIT 1`,
        )
        .get(...nodeIds)
      return r === null ? undefined : open(r)
    },
    stats(nodeIds) {
      if (nodeIds.length === 0) return { firstAt: undefined, lastAt: undefined, count: 0 }
      const r = sqlite
        .query<{ first_at: number | null; last_at: number | null; n: number }, string[]>(
          `SELECT MIN(sent_at) AS first_at, MAX(sent_at) AS last_at, COUNT(*) AS n FROM ch_messages
             WHERE node_id IN (${nodeIds.map(() => '?').join(',')}) AND deleted_at IS NULL AND kind != 'system'`,
        )
        .get(...nodeIds)
      return {
        firstAt: r?.first_at ?? undefined,
        lastAt: r?.last_at ?? undefined,
        count: r?.n ?? 0,
      }
    },
    async range(nodeIds, options) {
      if (nodeIds.length === 0) return { items: [] }
      const [afterAt, afterId] =
        options.after === undefined
          ? [options.from - 1, '']
          : [
              Number(options.after.split(':')[0]),
              options.after.slice(options.after.indexOf(':') + 1),
            ]
      const marks = nodeIds.map(() => '?').join(',')
      const rows = sqlite
        .query<MessageDb, Array<string | number>>(
          `SELECT * FROM ch_messages WHERE node_id IN (${marks}) AND sent_at >= ? AND sent_at < ?
             AND deleted_at IS NULL${options.includeSystem === true ? '' : " AND kind != 'system'"}
             AND (sent_at > ? OR (sent_at = ? AND id > ?))
             ORDER BY sent_at, id LIMIT ?`,
        )
        .all(...nodeIds, options.from, options.to, afterAt, afterAt, afterId, options.limit + 1)
      const more = rows.length > options.limit
      const items = await openAll(rows.slice(0, options.limit))
      const lastRow = rows[options.limit - 1]
      return {
        items,
        ...(more && lastRow !== undefined ? { next: `${lastRow.sent_at}:${lastRow.id}` } : {}),
      }
    },
    async pending(nodeIds, limit) {
      if (nodeIds.length === 0) return []
      const rows = sqlite
        .query<MessageDb, Array<string | number>>(
          `SELECT * FROM ch_messages WHERE node_id IN (${nodeIds.map(() => '?').join(',')}) AND pending = 1
             ORDER BY id DESC LIMIT ?`,
        )
        .all(...nodeIds, limit)
      return openAll(rows.reverse())
    },
    clearPending(nodeIds, upTo) {
      if (nodeIds.length === 0) return 0
      return sqlite
        .query(
          `UPDATE ch_messages SET pending = 0 WHERE node_id IN (${nodeIds.map(() => '?').join(',')}) AND pending = 1 AND id <= ?`,
        )
        .run(...nodeIds, upTo).changes
    },
    purge(now, retentionDaysOf) {
      const nodes = sqlite
        .query<{ node_id: string }, []>('SELECT DISTINCT node_id FROM ch_messages')
        .all()
      let removed = 0
      for (const { node_id } of nodes) {
        const cutoff = now - retentionDaysOf(node_id) * 86_400_000
        const old = sqlite
          .query<{ id: string }, [string, number]>(
            'SELECT id FROM ch_messages WHERE node_id = ? AND sent_at < ?',
          )
          .all(node_id, cutoff)
        for (const { id } of old) {
          sqlite.query('DELETE FROM ch_message_revisions WHERE message_id = ?').run(id)
          sqlite.query('DELETE FROM ch_reactions WHERE message_id = ?').run(id)
        }
        removed += sqlite
          .query('DELETE FROM ch_messages WHERE node_id = ? AND sent_at < ?')
          .run(node_id, cutoff).changes
      }
      return removed
    },
    count(connectionId) {
      const r =
        connectionId === undefined
          ? sqlite.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM ch_messages').get()
          : sqlite
              .query<{ n: number }, [string]>(
                'SELECT COUNT(*) AS n FROM ch_messages WHERE connection_id = ?',
              )
              .get(connectionId)
      return r?.n ?? 0
    },
    dispositionCounts(connectionId) {
      const out = new Map<string, { woke: number; observed: number }>()
      for (const r of sqlite
        .query<{ node_id: string; disposition: string | null; n: number }, [string]>(
          `SELECT node_id, disposition, COUNT(*) AS n FROM ch_messages
             WHERE connection_id = ? AND direction = 'in' GROUP BY node_id, disposition`,
        )
        .all(connectionId)) {
        const cur = out.get(r.node_id) ?? { woke: 0, observed: 0 }
        if (r.disposition === 'woke') cur.woke += r.n
        else if (r.disposition === 'observed') cur.observed += r.n
        out.set(r.node_id, cur)
      }
      return out
    },
    async changes(connectionId, afterRev, limit) {
      const rows = sqlite
        .query<MessageDb, [string, number, number]>(
          'SELECT * FROM ch_messages WHERE connection_id = ? AND rev > ? ORDER BY rev ASC LIMIT ?',
        )
        .all(connectionId, afterRev, limit)
      return openAll(rows)
    },
    locate(connectionId, nativeIds) {
      const out: Array<{ nodeId: string; nativeId: string }> = []
      const q = sqlite.query<{ node_id: string; native_id: string }, [string, string]>(
        'SELECT node_id, native_id FROM ch_messages WHERE connection_id = ? AND native_id = ?',
      )
      for (const nativeId of nativeIds) {
        for (const r of q.all(connectionId, nativeId)) {
          out.push({ nodeId: r.node_id, nativeId: r.native_id })
        }
      }
      return out
    },
    isOwn(nodeId, nativeId) {
      return byNative.get(nodeId, nativeId)?.direction === 'out'
    },
    setReaction(messageId, identityId, reaction) {
      if (reaction.added) {
        sqlite
          .query(
            `INSERT INTO ch_reactions (message_id, identity_id, emoji_id, emoji, at, removed_at) VALUES (?, ?, ?, ?, ?, NULL)
             ON CONFLICT (message_id, identity_id, emoji_id) DO UPDATE SET removed_at = NULL, at = excluded.at`,
          )
          .run(messageId, identityId, reaction.emoji, reaction.emoji, reaction.at)
      } else {
        sqlite
          .query(
            'UPDATE ch_reactions SET removed_at = ? WHERE message_id = ? AND identity_id = ? AND emoji_id = ?',
          )
          .run(reaction.at, messageId, identityId, reaction.emoji)
      }
    },
    reactions(messageId) {
      return sqlite
        .query<
          { identity_id: string; emoji: string; at: number; removed_at: number | null },
          [string]
        >(
          'SELECT identity_id, emoji, at, removed_at FROM ch_reactions WHERE message_id = ? ORDER BY at',
        )
        .all(messageId)
        .map((r) => ({
          identityId: r.identity_id,
          emoji: r.emoji,
          at: r.at,
          ...(r.removed_at === null ? {} : { removedAt: r.removed_at }),
        }))
    },
    clear(connectionId) {
      const ids = sqlite
        .query<{ id: string }, [string]>('SELECT id FROM ch_messages WHERE connection_id = ?')
        .all(connectionId)
      for (const { id } of ids) {
        sqlite.query('DELETE FROM ch_message_revisions WHERE message_id = ?').run(id)
        sqlite.query('DELETE FROM ch_reactions WHERE message_id = ?').run(id)
      }
      sqlite.query('DELETE FROM ch_messages WHERE connection_id = ?').run(connectionId)
    },
  }
}
