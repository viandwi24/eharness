/**
 * The unified event stream (`domain/event-stream.ts`): a query over the two existing logs, with no
 * copy of the data. Channel events come from `ch_events` (the rows the gateway wrote for what the
 * platform said, not its own `gateway.*` activity), app events from `events` (the feed). Each page
 * is read from both in their own order and merged, newest first, by event time; the cursor keeps
 * the last id of each source, so a page never repeats or skips an event.
 *
 * Message text is never read: the logs do not hold it.
 */
import type { Database } from 'bun:sqlite'
import type { EventStreamPort } from '../../app/ports.ts'
import {
  APP_STREAM_TYPES,
  type AppStreamType,
  appEventId,
  appFields,
  appLink,
  CHANNEL_STREAM_TYPES,
  type ChannelStreamType,
  channelEventId,
  decodeCursor,
  encodeCursor,
  feedTypeOfStream,
  isAppType,
  isChannelType,
  parseEventId,
  type StreamActor,
  type StreamChat,
  type StreamEvent,
  type StreamPage,
  type StreamQuery,
  streamTypeOfFeed,
  summarizeApp,
  summarizeChannel,
} from '../../domain/event-stream.ts'
import type { ChannelGateway } from '../channels/gateway.ts'
import { likePattern } from '../channels/paging.ts'

interface ChRow {
  id: string
  connection_id: string
  type: string
  node_id: string | null
  actor_identity_id: string | null
  at: number
  payload: string
}

interface AppRow {
  seq: number
  type: string
  agent_id: string | null
  session_id: string | null
  payload: string
  created_at: number
}

export interface EventStreamOptions {
  sqlite: Database
  /** Late-bound: the gateway is built after the stream. */
  gateway: () => ChannelGateway | undefined
  /** Every connection with its label and kind. */
  connections: () => Promise<
    Array<{ id: string; label: string; platform: string; transport?: 'bot' | 'user' }>
  >
  /** The name of a program (an alarm or a task of a program run). */
  programName?: (programId: string) => string | undefined
}

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v !== '' ? v : v === undefined || v === null ? undefined : String(v)

export function createEventStream(options: EventStreamOptions): EventStreamPort & {
  /** A channel row of the log as a stream event (the engine builds events it just stored). */
  channelRow(id: string): Promise<StreamEvent | undefined>
  /** Is this session one a trigger started (its events are the agent's own, never a trigger's cause)? */
  isTriggerSession(sessionId: string): boolean
} {
  const { sqlite } = options
  let labels: Map<string, string> | undefined
  let labelsAt = 0
  const labelOf = async (connectionId: string): Promise<string> => {
    if (labels === undefined || Date.now() - labelsAt > 30_000 || !labels.has(connectionId)) {
      try {
        labels = new Map((await options.connections()).map((c) => [c.id, c.label]))
        labelsAt = Date.now()
      } catch {
        labels ??= new Map()
      }
    }
    return labels.get(connectionId) ?? connectionId
  }

  const isTriggerSession = (sessionId: string): boolean =>
    sqlite
      .query<{ n: number }, [string]>(
        "SELECT 1 AS n FROM trigger_fires WHERE json_extract(detail, '$.sessionId') = ? LIMIT 1",
      )
      .get(sessionId) !== null

  async function channelEvent(r: ChRow): Promise<StreamEvent | undefined> {
    if (!isChannelType(r.type)) return undefined
    const type: ChannelStreamType = r.type
    const gw = options.gateway()
    const p = JSON.parse(r.payload) as Record<string, unknown>
    const node = r.node_id === null ? undefined : gw?.nodes.get(r.node_id)
    let chat: StreamChat | undefined
    if (node !== undefined) {
      const parent =
        node.kind === 'thread' && node.parentId !== null ? gw?.nodes.get(node.parentId) : undefined
      const title =
        parent === undefined
          ? (node.title ?? node.nativeId)
          : `${parent.title ?? parent.nativeId} / ${node.title ?? node.nativeId}`
      chat = {
        nodeId: node.id,
        ...(parent === undefined ? {} : { roomId: parent.id }),
        nativeId: parent === undefined ? node.nativeId : parent.nativeId,
        title,
      }
    }
    // the person: the stored identity, else what the payload names
    const native = str(p.senderNativeId) ?? str(p.userId)
    const row =
      r.actor_identity_id !== null
        ? gw?.identities.get(r.actor_identity_id)
        : native === undefined
          ? undefined
          : gw?.identities.byNative(r.connection_id, native)
    let actor: StreamActor | undefined
    const id = row?.nativeId ?? native
    if (id !== undefined || row !== undefined) {
      const name = row?.displayName ?? str(p.name)
      const username = row?.username ?? str(p.username)
      let role: string | undefined
      if (id !== undefined && row?.isSelf !== true) {
        try {
          role = gw?.people.get(r.connection_id, id, r.node_id ?? undefined)?.role
        } catch {}
      }
      actor = {
        ...(id === undefined ? {} : { id }),
        ...(name === undefined || name === null ? {} : { name }),
        ...(username === undefined || username === null ? {} : { username }),
        ...(role === undefined ? {} : { role }),
        ...(row?.isSelf === true ? { self: true } : {}),
      }
    }
    const fields: Record<string, string> = {}
    const put = (k: string, v: unknown): void => {
      const t = str(v)
      if (t !== undefined) fields[k] = t.length > 300 ? t.slice(0, 300) : t
    }
    if (actor?.id !== undefined) put('user', actor.id)
    if (actor?.name !== undefined) put('name', actor.name)
    if (actor?.username !== undefined) put('username', actor.username)
    switch (type) {
      case 'message.created':
        put('messageNativeId', p.messageNativeId)
        put('attachments', p.attachments)
        if (p.replyToNativeId !== undefined) fields.reply = 'true'
        break
      case 'message.edited':
        put('messageNativeId', p.messageNativeId)
        break
      case 'message.deleted':
        fields.count = String(Array.isArray(p.messageNativeIds) ? p.messageNativeIds.length : 1)
        break
      case 'reaction.added':
      case 'reaction.removed':
        put('emoji', p.emoji)
        put('messageNativeId', p.messageNativeId)
        break
      case 'member.joined':
      case 'member.left':
      case 'member.updated':
        put('role', p.role)
        put('by', p.byName ?? p.byId)
        if (p.bySelf === true) fields.bySelf = 'true'
        break
      case 'member.join_requested':
        put('link', p.link)
        put('pending', p.pending)
        if (p.hasBio === true) fields.hasBio = 'true'
        break
      case 'member.join_request_resolved':
        put('resolution', p.resolution)
        fields.bySelf = p.bySelf === true ? 'true' : 'false'
        break
      case 'node.state_changed':
        put('state', p.state)
        put('reason', p.reason)
        break
      case 'node.migrated':
        put('from', p.from)
        break
      case 'action':
        put('name', p.name)
        put('messageNativeId', p.messageNativeId)
        break
      default:
        break
    }
    const agentCaused =
      type === 'message.created' ||
      type === 'message.edited' ||
      type === 'reaction.added' ||
      type === 'reaction.removed'
        ? actor?.self === true
        : type.startsWith('member.')
          ? p.bySelf === true
          : false
    return {
      id: channelEventId(r.id),
      at: r.at,
      source: 'channel',
      connectionId: r.connection_id,
      sourceLabel: await labelOf(r.connection_id),
      type,
      ...(chat === undefined ? {} : { chat }),
      ...(actor === undefined ? {} : { actor }),
      summary: summarizeChannel(type, { actor, chat: chat?.title, fields }),
      fields,
      link:
        chat === undefined
          ? `/channels/${encodeURIComponent(r.connection_id)}`
          : `/channels/${encodeURIComponent(r.connection_id)}/chats/${encodeURIComponent(chat.nodeId)}`,
      agentCaused,
    }
  }

  /** Every session a trigger started (one scan per page, not one per event). */
  const triggerSessions = (): Set<string> =>
    new Set(
      sqlite
        .query<{ s: string }, []>(
          "SELECT DISTINCT json_extract(detail, '$.sessionId') AS s FROM trigger_fires WHERE s IS NOT NULL",
        )
        .all()
        .map((r) => r.s),
    )

  function appEvent(r: AppRow, started?: Set<string>): StreamEvent | undefined {
    const type = streamTypeOfFeed(r.type)
    if (type === undefined) return undefined
    const payload = JSON.parse(r.payload) as Record<string, unknown>
    const fields = appFields(type, payload)
    // an alarm about a program names it
    if (
      type === 'alarm.raised' &&
      fields.program === undefined &&
      fields.subject?.startsWith('program:')
    ) {
      const name = options.programName?.(fields.subject.slice('program:'.length))
      if (name !== undefined) fields.program = name
    }
    // the run of a program: its session id names the program
    if (
      type === 'task.changed' &&
      fields.program === undefined &&
      r.session_id?.startsWith('program:')
    ) {
      const name = options.programName?.(r.session_id.split(':')[1] ?? '')
      if (name !== undefined) fields.program = name
    }
    return {
      id: appEventId(r.seq),
      at: r.created_at,
      source: 'app',
      sourceLabel: 'app',
      type,
      summary: summarizeApp(type, fields),
      fields,
      link: appLink(type, payload),
      // a run a trigger started: what it does is the agent's work, never a cause for a trigger
      agentCaused:
        r.session_id !== null &&
        (started === undefined ? isTriggerSession(r.session_id) : started.has(r.session_id)),
      ...(r.agent_id === null ? {} : { agentId: r.agent_id }),
      ...(r.session_id === null ? {} : { sessionId: r.session_id }),
    }
  }

  const typesIn = (
    q: StreamQuery,
    all: readonly string[],
    pick: (t: string) => boolean,
  ): string[] => (q.types === undefined || q.types.length === 0 ? [...all] : q.types.filter(pick))

  function channelRows(q: StreamQuery, after: string | null, limit: number): ChRow[] {
    const types = typesIn(q, CHANNEL_STREAM_TYPES, isChannelType)
    if (types.length === 0 || q.source === 'app') return []
    const where = [`e.type IN (${types.map(() => '?').join(',')})`]
    const args: Array<string | number> = [...types]
    if (q.connectionId !== undefined) {
      where.push('e.connection_id = ?')
      args.push(q.connectionId)
    }
    if (q.connectionIds !== undefined) {
      if (q.connectionIds.length === 0) return []
      where.push(`e.connection_id IN (${q.connectionIds.map(() => '?').join(',')})`)
      args.push(...q.connectionIds)
    }
    if (q.from !== undefined) {
      where.push('e.at >= ?')
      args.push(q.from)
    }
    if (q.to !== undefined) {
      where.push('e.at <= ?')
      args.push(q.to)
    }
    if (q.chat !== undefined && q.chat.trim() !== '') {
      const like = likePattern(q.chat.trim())
      where.push(
        `(e.node_id = ? OR e.node_id IN (SELECT id FROM ch_nodes n WHERE n.connection_id = e.connection_id
            AND (n.parent_id = ? OR n.title LIKE ? ESCAPE '\\' OR n.native_id = ?)))`,
      )
      args.push(q.chat.trim(), q.chat.trim(), like, q.chat.trim())
    }
    if (q.actor !== undefined && q.actor.trim() !== '') {
      const text = q.actor.trim().replace(/^@/, '')
      const like = likePattern(text)
      where.push(
        `(json_extract(e.payload, '$.senderNativeId') = ? OR json_extract(e.payload, '$.userId') = ?
          OR json_extract(e.payload, '$.name') LIKE ? ESCAPE '\\' OR json_extract(e.payload, '$.username') LIKE ? ESCAPE '\\'
          OR e.actor_identity_id IN (SELECT id FROM ch_identities i WHERE i.connection_id = e.connection_id
              AND (i.native_id = ? OR i.display_name LIKE ? ESCAPE '\\' OR i.username LIKE ? ESCAPE '\\')))`,
      )
      args.push(text, text, like, like, text, like, like)
    }
    if (after !== null) {
      where.push('e.id < ?')
      args.push(after)
    }
    return sqlite
      .query<ChRow, Array<string | number>>(
        `SELECT e.id, e.connection_id, e.type, e.node_id, e.actor_identity_id, e.at, e.payload FROM ch_events e
         WHERE ${where.join(' AND ')} ORDER BY e.id DESC LIMIT ?`,
      )
      .all(...args, limit)
  }

  function appRows(q: StreamQuery, after: number | null, limit: number): AppRow[] {
    const types = typesIn(q, APP_STREAM_TYPES, isAppType).filter(isAppType)
    // a channel filter (connection, chat, person) can never match an app event
    if (
      types.length === 0 ||
      q.source === 'channel' ||
      q.connectionId !== undefined ||
      (q.chat !== undefined && q.chat !== '') ||
      (q.actor !== undefined && q.actor !== '')
    )
      return []
    const feed = types.map((t) => feedTypeOfStream(t as AppStreamType))
    const where = [`type IN (${feed.map(() => '?').join(',')})`]
    const args: Array<string | number> = [...feed]
    if (q.from !== undefined) {
      where.push('created_at >= ?')
      args.push(q.from)
    }
    if (q.to !== undefined) {
      where.push('created_at <= ?')
      args.push(q.to)
    }
    if (after !== null) {
      where.push('seq < ?')
      args.push(after)
    }
    return sqlite
      .query<AppRow, Array<string | number>>(
        `SELECT seq, type, agent_id, session_id, payload, created_at FROM events
         WHERE ${where.join(' AND ')} ORDER BY seq DESC LIMIT ?`,
      )
      .all(...args, limit)
  }

  return {
    async list(q): Promise<StreamPage> {
      const cur = decodeCursor(q.cursor)
      const started = triggerSessions()
      const ch = channelRows(q, cur.ch, q.limit + 1)
      const ap = appRows(q, cur.app, q.limit + 1)
      // a two-pointer merge on the heads: each source is returned in its own order
      const items: StreamEvent[] = []
      let i = 0
      let j = 0
      let last: StreamCursor = { ch: cur.ch, app: cur.app }
      let more = false
      const take = async (): Promise<boolean> => {
        const a = ch[i]
        const b = ap[j]
        if (a === undefined && b === undefined) return false
        const useCh = b === undefined || (a !== undefined && a.at >= b.created_at)
        if (useCh && a !== undefined) {
          i++
          const e = await channelEvent(a)
          last = { ...last, ch: a.id }
          if (e !== undefined) items.push(e)
        } else if (b !== undefined) {
          j++
          const e = appEvent(b, started)
          last = { ...last, app: b.seq }
          if (e !== undefined) items.push(e)
        }
        return true
      }
      while (items.length < q.limit && (await take())) {}
      more = i < ch.length || j < ap.length
      return { items, ...(more ? { next: encodeCursor(last) } : {}) }
    },

    async get(id) {
      const parsed = parseEventId(id)
      if (parsed === undefined) return undefined
      if (parsed.source === 'channel') {
        const row = sqlite
          .query<ChRow, [string]>(
            'SELECT id, connection_id, type, node_id, actor_identity_id, at, payload FROM ch_events WHERE id = ?',
          )
          .get(parsed.id)
        return row === null ? undefined : channelEvent(row)
      }
      const row = sqlite
        .query<AppRow, [number]>(
          'SELECT seq, type, agent_id, session_id, payload, created_at FROM events WHERE seq = ?',
        )
        .get(parsed.seq)
      return row === null ? undefined : appEvent(row)
    },

    async sources() {
      return options.connections()
    },

    async channelRow(id) {
      return this.get(channelEventId(id))
    },

    isTriggerSession,
  }
}

interface StreamCursor {
  ch: string | null
  app: number | null
}
