/**
 * SQLite stores of the node tree (docs/plans/P41-team-channels.md, phase L5): nodes with a
 * materialized path, their links, the per-connection access and the settings that inherit down the
 * tree. Plain SQL on the shared connection. Nothing here names a platform.
 */
import type { Database } from 'bun:sqlite'
import { uuidv7 } from 'eharness'
import type { z } from 'zod'
import type { ChannelChatsQuery } from '../../domain/channels.ts'
import {
  type MemberRole,
  type NodeAccessRow,
  type NodeHistory,
  type NodeKind,
  type NodeLinkRel,
  type NodeRow,
  type NodeState,
  type NodeTraits,
  traitsOf,
} from './model.ts'
import { likePattern, orderBy, windowOf } from './paging.ts'
import type { ChannelNode, NodeInfo } from './types.ts'

interface NodeDb {
  id: string
  connection_id: string
  native_id: string
  parent_id: string | null
  path: string
  kind: string
  traits: string
  platform_type: string
  origin_message_native_id: string | null
  title: string | null
  state: string
  state_reason: string | null
  meta: string
  meta_version: number
  legacy_ref_id: string | null
  first_seen_at: number
  last_event_at: number
}

const toNode = (r: NodeDb): NodeRow => ({
  id: r.id,
  connectionId: r.connection_id,
  nativeId: r.native_id,
  parentId: r.parent_id,
  path: r.path,
  kind: r.kind as NodeKind,
  traits: traitsOf(JSON.parse(r.traits) as Partial<NodeTraits>),
  platformType: r.platform_type,
  originMessageNativeId: r.origin_message_native_id,
  title: r.title,
  state: r.state as NodeState,
  stateReason: r.state_reason,
  meta: JSON.parse(r.meta) as Record<string, unknown>,
  metaVersion: r.meta_version,
  legacyRefId: r.legacy_ref_id,
  firstSeenAt: r.first_seen_at,
  lastEventAt: r.last_event_at,
})

/** The adapter-facing view of a stored node. */
export function channelNodeOf(row: NodeRow, parent?: NodeRow): ChannelNode {
  return {
    id: row.id,
    connectionId: row.connectionId,
    nativeId: row.nativeId,
    kind: row.kind,
    traits: row.traits,
    platformType: row.platformType,
    title: row.title ?? undefined,
    parentNativeId: parent?.nativeId,
    meta: row.meta,
  }
}

export interface ApplyOptions {
  now: number
  /** The adapter's schema for `meta`; an invalid merge keeps the old meta. */
  metaSchema?: { schema: z.ZodType; version: number } | undefined
  onWarn?: ((message: string) => void) | undefined
  /** Do not create the node when it does not exist yet. */
  existingOnly?: boolean
}

export interface ApplyResult {
  node: NodeRow
  created: boolean
  changed: boolean
}

export interface NodeFilter {
  kind?: NodeKind
  /** Only direct children of this node (`null` = roots). */
  parentId?: string | null
  /** Subtree (including the node) of this node. */
  under?: string
  state?: NodeState
}

export interface NodeStore {
  get(id: string): NodeRow | undefined
  byNative(connectionId: string, nativeId: string): NodeRow | undefined
  byLegacy(connectionId: string, legacyId: string): NodeRow | undefined
  list(connectionId: string, filter?: NodeFilter): NodeRow[]
  children(id: string): NodeRow[]
  /** Root first, the node last. */
  chain(node: NodeRow): NodeRow[]
  /** The node and everything below it. */
  subtree(node: NodeRow): NodeRow[]
  /** Create or patch one node (patch semantics); `parent` places a new node (or moves an old one). */
  apply(
    connectionId: string,
    info: NodeInfo,
    parent: NodeRow | undefined,
    options: ApplyOptions,
  ): ApplyResult | undefined
  /**
   * Create or patch a chain given leaf first; parents are created before their children. Returns
   * the leaf and every node touched (root first).
   */
  upsertChain(
    connectionId: string,
    chain: readonly NodeInfo[],
    options: ApplyOptions,
  ): { leaf: NodeRow; touched: ApplyResult[] } | undefined
  touch(id: string, at: number): void
  /**
   * The nodes of the inbox: postable places that have messages or gateway activity, most recently
   * active first. `cursor` is the `next` of the previous page.
   */
  inbox(
    connectionId: string,
    options: { limit: number; cursor?: string | undefined },
  ): { items: NodeRow[]; next?: string }
  /**
   * One page of the chats and topics of a connection (people are not listed), filtered, sorted and
   * counted in SQL. `allowedByDefault` is what a node without an `enabled` setting anywhere above
   * it gets (the connection's group policy is `open`).
   */
  table(
    connectionId: string,
    query: ChannelChatsQuery,
    options: { allowedByDefault: boolean },
  ): { items: NodeRow[]; total: number }
  /**
   * One page of the inbox (the nodes with messages or gateway activity), most recently active
   * first by default; `kind` filters, `q` searches the title and the title of the forum above.
   */
  inboxTable(
    connectionId: string,
    query: {
      q?: string | undefined
      sort?: string | undefined
      order?: 'asc' | 'desc' | undefined
      kind?: 'dm' | 'group' | 'channel' | 'topic' | undefined
      page: number
      limit: number
    },
  ): { items: NodeRow[]; total: number }
  /** Is there any message or gateway activity for the node (the inbox lists it)? */
  hasActivity(nodeId: string): boolean
  /** Every agent id a node setting of the connection names. */
  agentIds(connectionId: string): Set<string>
  link(from: string, to: string, rel: NodeLinkRel, meta?: Record<string, unknown>): void
  links(nodeId: string): Array<{
    fromNodeId: string
    toNodeId: string
    rel: NodeLinkRel
    meta: Record<string, unknown>
  }>
  access(nodeId: string): NodeAccessRow | undefined
  setAccess(
    nodeId: string,
    connectionId: string,
    patch: {
      member?: MemberRole
      canPost?: boolean | null
      canRead?: boolean | null
      muted?: boolean
      lastReadNativeId?: string | null
      /** The connection's own administrator rights in the node (stored in `extra.rights`). */
      rights?: Record<string, boolean>
    },
    now: number,
  ): NodeAccessRow
  /** Merge into `history` (a `null` value deletes the key). */
  patchHistory(
    nodeId: string,
    connectionId: string,
    patch: { [K in keyof NodeHistory]?: NodeHistory[K] | null },
    now: number,
  ): NodeAccessRow
  /** Merge into the adapter-private `extra` (a `null` value deletes the key). */
  patchExtra(
    nodeId: string,
    connectionId: string,
    patch: Record<string, unknown>,
    now: number,
  ): NodeAccessRow
  settings(nodeId: string): Record<string, unknown>
  /** Set keys (a `null` value removes the key: inherit again). */
  setSettings(nodeId: string, patch: Record<string, unknown>): void
  /** Settings of several nodes at once (ancestors of a node, one query). */
  settingsOf(nodeIds: readonly string[]): Map<string, Record<string, unknown>>
  /** Remove every node of a connection with its links, access and settings (messages are not touched). */
  clear(connectionId: string): void
  count(connectionId: string): number
}

interface AccessDb {
  node_id: string
  connection_id: string
  member: string
  can_post: number | null
  can_read: number | null
  muted: number
  last_read_native_id: string | null
  history: string
  extra: string
  updated_at: number
}

const toAccess = (r: AccessDb): NodeAccessRow => ({
  nodeId: r.node_id,
  connectionId: r.connection_id,
  member: r.member as MemberRole,
  canPost: r.can_post === null ? null : r.can_post === 1,
  canRead: r.can_read === null ? null : r.can_read === 1,
  muted: r.muted === 1,
  lastReadNativeId: r.last_read_native_id,
  history: JSON.parse(r.history) as NodeHistory,
  extra: JSON.parse(r.extra) as Record<string, unknown>,
  updatedAt: r.updated_at,
})

const mergeKeys = (
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> => {
  const out = { ...base }
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue
    if (v === null) delete out[k]
    else out[k] = v
  }
  return out
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

export function sqliteNodeStore(sqlite: Database): NodeStore {
  const byId = sqlite.query<NodeDb, [string]>('SELECT * FROM ch_nodes WHERE id = ?')
  const byNativeQ = sqlite.query<NodeDb, [string, string]>(
    'SELECT * FROM ch_nodes WHERE connection_id = ? AND native_id = ?',
  )
  const get = (id: string): NodeRow | undefined => {
    const r = byId.get(id)
    return r === null ? undefined : toNode(r)
  }
  const byNative = (connectionId: string, nativeId: string): NodeRow | undefined => {
    const r = byNativeQ.get(connectionId, nativeId)
    return r === null ? undefined : toNode(r)
  }

  const reparent = (node: NodeRow, parent: NodeRow | undefined): void => {
    const oldPath = node.path
    const newPath = `${parent?.path ?? ''}/${node.id}`
    if (oldPath === newPath) return
    sqlite
      .query(
        `UPDATE ch_nodes SET path = ? || substr(path, ?) WHERE connection_id = ? AND (path = ? OR path LIKE ? ESCAPE '\\')`,
      )
      .run(
        newPath,
        oldPath.length + 1,
        node.connectionId,
        oldPath,
        `${oldPath.replace(/[\\%_]/g, '\\$&')}/%`,
      )
    sqlite.query('UPDATE ch_nodes SET parent_id = ? WHERE id = ?').run(parent?.id ?? null, node.id)
  }

  const apply: NodeStore['apply'] = (connectionId, info, parent, options) => {
    const existing = byNative(connectionId, info.nativeId)
    const validMeta = (
      base: Record<string, unknown>,
      patch: Record<string, unknown> | undefined,
    ): { meta: Record<string, unknown>; version: number | undefined } => {
      if (patch === undefined) return { meta: base, version: undefined }
      const merged = mergeKeys(base, patch)
      const schema = options.metaSchema
      if (schema === undefined) return { meta: merged, version: undefined }
      const parsed = schema.schema.safeParse(merged)
      if (!parsed.success) {
        options.onWarn?.(
          `channels: node meta of ${info.nativeId} does not match the adapter's schema; kept the old one`,
        )
        return { meta: base, version: undefined }
      }
      return { meta: parsed.data as Record<string, unknown>, version: schema.version }
    }
    if (existing === undefined) {
      if (options.existingOnly === true) return undefined
      const id = uuidv7()
      const kind = info.kind ?? 'room'
      const traits = traitsOf({
        multiUser: kind !== 'direct',
        ...(info.traits ?? {}),
      })
      const { meta, version } = validMeta({}, info.meta)
      const path = `${parent?.path ?? ''}/${id}`
      sqlite
        .query(
          `INSERT INTO ch_nodes (id, connection_id, native_id, parent_id, path, kind, traits, platform_type,
             origin_message_native_id, title, state, state_reason, meta, meta_version, legacy_ref_id, first_seen_at, last_event_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
        )
        .run(
          id,
          connectionId,
          info.nativeId,
          parent?.id ?? null,
          path,
          kind,
          JSON.stringify(traits),
          info.platformType ?? '',
          info.originMessageNativeId ?? null,
          info.title ?? null,
          info.state ?? 'active',
          info.stateReason ?? null,
          JSON.stringify(meta),
          version ?? 0,
          options.now,
          options.now,
        )
      const node = get(id) as NodeRow
      if (info.access !== undefined) {
        port.setAccess(id, connectionId, info.access, options.now)
      }
      return { node, created: true, changed: true }
    }
    // patch: undefined = unchanged, null = cleared
    let changed = false
    const sets: string[] = []
    const args: Array<string | number | null> = []
    const set = (column: string, value: string | number | null, differs: boolean): void => {
      if (!differs) return
      sets.push(`${column} = ?`)
      args.push(value)
      changed = true
    }
    if (info.kind !== undefined) set('kind', info.kind, info.kind !== existing.kind)
    if (info.traits !== undefined) {
      const next = traitsOf({ ...existing.traits, ...info.traits })
      set('traits', JSON.stringify(next), !same(next, existing.traits))
    }
    if (info.platformType !== undefined)
      set('platform_type', info.platformType, info.platformType !== existing.platformType)
    if (info.title !== undefined) set('title', info.title, info.title !== existing.title)
    if (info.state !== undefined) set('state', info.state, info.state !== existing.state)
    if (info.stateReason !== undefined)
      set('state_reason', info.stateReason, info.stateReason !== existing.stateReason)
    if (info.originMessageNativeId !== undefined) {
      set(
        'origin_message_native_id',
        info.originMessageNativeId,
        info.originMessageNativeId !== existing.originMessageNativeId,
      )
    }
    if (info.meta !== undefined) {
      const { meta, version } = validMeta(existing.meta, info.meta)
      if (!same(meta, existing.meta)) {
        set('meta', JSON.stringify(meta), true)
        if (version !== undefined) set('meta_version', version, version !== existing.metaVersion)
      }
    }
    if (sets.length > 0) {
      sqlite
        .query(`UPDATE ch_nodes SET ${sets.join(', ')} WHERE id = ?`)
        .run(...(args as never[]), existing.id)
    }
    // a node first seen through its children (a placeholder) learns its parent later
    if (parent !== undefined && existing.parentId !== parent.id && existing.id !== parent.id) {
      reparent(existing, parent)
      changed = true
    }
    if (info.access !== undefined)
      port.setAccess(existing.id, connectionId, info.access, options.now)
    return { node: get(existing.id) as NodeRow, created: false, changed }
  }

  const upsertChain: NodeStore['upsertChain'] = (connectionId, chain, options) => {
    if (chain.length === 0) return undefined
    const touched: ApplyResult[] = []
    let parent: NodeRow | undefined
    // root first
    for (let i = chain.length - 1; i >= 0; i--) {
      const info = chain[i] as NodeInfo
      // the platform may name a parent the chain does not carry: use it when it is known
      let p = parent
      if (p === undefined && info.parent !== undefined && info.parent !== null) {
        p = byNative(connectionId, info.parent)
      }
      const r = apply(connectionId, info, p, options)
      if (r === undefined) return undefined
      touched.push(r)
      parent = r.node
    }
    const leaf = (touched.at(-1) as ApplyResult).node
    return { leaf, touched }
  }

  const accessQ = sqlite.query<AccessDb, [string]>('SELECT * FROM ch_node_access WHERE node_id = ?')
  const ensureAccess = (nodeId: string, connectionId: string, now: number): AccessDb => {
    sqlite
      .query(
        'INSERT OR IGNORE INTO ch_node_access (node_id, connection_id, updated_at) VALUES (?, ?, ?)',
      )
      .run(nodeId, connectionId, now)
    return accessQ.get(nodeId) as AccessDb
  }

  const port: NodeStore = {
    get,
    byNative,
    byLegacy(connectionId, legacyId) {
      const r = sqlite
        .query<NodeDb, [string, string]>(
          'SELECT * FROM ch_nodes WHERE connection_id = ? AND legacy_ref_id = ?',
        )
        .get(connectionId, legacyId)
      return r === null ? undefined : toNode(r)
    },
    list(connectionId, filter) {
      const where = ['connection_id = ?']
      const args: Array<string | number> = [connectionId]
      if (filter?.kind !== undefined) {
        where.push('kind = ?')
        args.push(filter.kind)
      }
      if (filter?.parentId !== undefined) {
        if (filter.parentId === null) where.push('parent_id IS NULL')
        else {
          where.push('parent_id = ?')
          args.push(filter.parentId)
        }
      }
      if (filter?.state !== undefined) {
        where.push('state = ?')
        args.push(filter.state)
      }
      if (filter?.under !== undefined) {
        const base = get(filter.under)
        if (base === undefined) return []
        where.push(`(path = ? OR path LIKE ? ESCAPE '\\')`)
        args.push(base.path, `${base.path.replace(/[\\%_]/g, '\\$&')}/%`)
      }
      return sqlite
        .query<NodeDb, Array<string | number>>(
          `SELECT * FROM ch_nodes WHERE ${where.join(' AND ')} ORDER BY first_seen_at, id`,
        )
        .all(...args)
        .map(toNode)
    },
    children(id) {
      return sqlite
        .query<NodeDb, [string]>(
          'SELECT * FROM ch_nodes WHERE parent_id = ? ORDER BY first_seen_at, id',
        )
        .all(id)
        .map(toNode)
    },
    chain(node) {
      const ids = node.path.split('/').filter((s) => s !== '')
      const out: NodeRow[] = []
      for (const id of ids) {
        if (id === node.id) out.push(node)
        else {
          const row = get(id)
          if (row !== undefined) out.push(row)
        }
      }
      return out.length === 0 ? [node] : out
    },
    subtree(node) {
      return port.list(node.connectionId, { under: node.id })
    },
    apply,
    upsertChain,
    touch(id, at) {
      sqlite
        .query('UPDATE ch_nodes SET last_event_at = MAX(last_event_at, ?) WHERE id = ?')
        .run(at, id)
    },
    inbox(connectionId, options) {
      const base = `SELECT n.* FROM ch_nodes n WHERE n.connection_id = ?
        AND json_extract(n.traits, '$.postable') = 1
        AND (EXISTS (SELECT 1 FROM ch_messages m WHERE m.node_id = n.id)
          OR EXISTS (SELECT 1 FROM ch_events e WHERE e.connection_id = n.connection_id AND e.node_id = n.id
               AND e.type IN ('gateway.woke', 'gateway.observed', 'gateway.dropped')))`
      let rows: NodeDb[]
      if (options.cursor === undefined) {
        rows = sqlite
          .query<NodeDb, [string, number]>(
            `${base} ORDER BY n.last_event_at DESC, n.id DESC LIMIT ?`,
          )
          .all(connectionId, options.limit + 1)
      } else {
        const at = options.cursor.indexOf('|')
        const lastAt = Number(options.cursor.slice(0, at))
        const id = options.cursor.slice(at + 1)
        rows = sqlite
          .query<NodeDb, [string, number, number, string, number]>(
            `${base} AND (n.last_event_at < ? OR (n.last_event_at = ? AND n.id < ?))
               ORDER BY n.last_event_at DESC, n.id DESC LIMIT ?`,
          )
          .all(connectionId, lastAt, lastAt, id, options.limit + 1)
      }
      const more = rows.length > options.limit
      const items = rows.slice(0, options.limit).map(toNode)
      const last = items.at(-1)
      return {
        items,
        ...(more && last !== undefined ? { next: `${last.lastEventAt}|${last.id}` } : {}),
      }
    },
    table(connectionId, q, options) {
      // the `enabled` setting in force: the nearest one on the path to the root, else the default
      const allowedSql = `(COALESCE((SELECT s.value FROM ch_node_settings s JOIN ch_nodes an ON an.id = s.node_id
          WHERE s.key = 'enabled' AND an.connection_id = n.connection_id
            AND (n.path = an.path OR n.path LIKE an.path || '/%')
          ORDER BY length(an.path) DESC LIMIT 1), '${options.allowedByDefault ? 'true' : 'false'}') = 'true')`
      const where = ['n.connection_id = ?', "n.kind != 'direct'", "n.state != 'deleted'"]
      const args: Array<string | number> = [connectionId]
      const level = q.level ?? 'chat'
      if (level === 'chat') where.push("n.kind != 'thread'")
      else if (level === 'topic') where.push("n.kind = 'thread'")
      if (q.parentId !== undefined) {
        where.push('n.parent_id = ?')
        args.push(q.parentId)
      }
      if (q.kind !== undefined)
        where.push(
          `COALESCE(json_extract(n.traits, '$.broadcast'), 0) = ${q.kind === 'channel' ? 1 : 0}`,
        )
      if (q.state !== undefined) {
        where.push('n.state = ?')
        args.push(q.state)
      }
      if (q.allowed !== undefined) where.push(`${allowedSql} = ${q.allowed ? 1 : 0}`)
      if (q.admin !== undefined)
        where.push(`COALESCE(a.member IN ('admin', 'owner'), 0) = ${q.admin ? 1 : 0}`)
      if (q.history !== undefined)
        where.push(`(json_extract(a.history, '$.days') IS NOT NULL) = ${q.history ? 1 : 0}`)
      if (q.adminLog !== undefined)
        where.push(
          `COALESCE(json_extract(a.extra, '$.adminLog.enabled'), 1) = ${q.adminLog ? 1 : 0}`,
        )
      if (q.q !== undefined && q.q.trim() !== '') {
        const like = likePattern(q.q.trim())
        where.push(
          `(n.title LIKE ? ESCAPE '\\' OR n.native_id LIKE ? ESCAPE '\\' OR json_extract(n.meta, '$.username') LIKE ? ESCAPE '\\')`,
        )
        args.push(like, like, like)
      }
      const from = `FROM ch_nodes n LEFT JOIN ch_node_access a ON a.node_id = n.id WHERE ${where.join(' AND ')}`
      const order = orderBy(
        {
          title: { expr: 'COALESCE(n.title, n.native_id) COLLATE NOCASE', defaultOrder: 'asc' },
          lastSeen: { expr: 'n.last_event_at', defaultOrder: 'desc' },
          firstSeen: { expr: 'n.first_seen_at', defaultOrder: 'desc' },
          state: { expr: 'n.state', defaultOrder: 'asc' },
          kind: {
            expr: "COALESCE(json_extract(n.traits, '$.broadcast'), 0)",
            defaultOrder: 'asc',
          },
          allowed: { expr: allowedSql, defaultOrder: 'desc' },
          messages: {
            expr: "COALESCE(json_extract(a.history, '$.count'), 0)",
            defaultOrder: 'desc',
          },
          backfill: {
            expr: "COALESCE(json_extract(a.history, '$.state'), '')",
            defaultOrder: 'asc',
          },
        },
        q.sort,
        q.order,
        'lastSeen',
        'n.id',
      )
      const total =
        sqlite
          .query<{ n: number }, Array<string | number>>(`SELECT COUNT(*) AS n ${from}`)
          .get(...args)?.n ?? 0
      const rows = sqlite
        .query<NodeDb, Array<string | number>>(`SELECT n.* ${from} ${order} LIMIT ? OFFSET ?`)
        .all(...args, ...windowOf(q.page, q.limit))
      return { items: rows.map(toNode), total }
    },
    inboxTable(connectionId, q) {
      const where = [
        'n.connection_id = ?',
        "json_extract(n.traits, '$.postable') = 1",
        `(EXISTS (SELECT 1 FROM ch_messages m WHERE m.node_id = n.id)
          OR EXISTS (SELECT 1 FROM ch_events e WHERE e.connection_id = n.connection_id AND e.node_id = n.id
               AND e.type IN ('gateway.woke', 'gateway.observed', 'gateway.dropped')))`,
      ]
      const args: Array<string | number> = [connectionId]
      if (q.kind === 'dm') where.push("n.kind = 'direct'")
      else if (q.kind === 'topic') where.push("n.kind = 'thread'")
      else if (q.kind !== undefined)
        where.push(
          `n.kind NOT IN ('direct', 'thread') AND COALESCE(json_extract(n.traits, '$.broadcast'), 0) = ${q.kind === 'channel' ? 1 : 0}`,
        )
      if (q.q !== undefined && q.q.trim() !== '') {
        const like = likePattern(q.q.trim())
        where.push(
          `(n.title LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM ch_nodes pn WHERE pn.id = n.parent_id AND pn.title LIKE ? ESCAPE '\\'))`,
        )
        args.push(like, like)
      }
      const from = `FROM ch_nodes n WHERE ${where.join(' AND ')}`
      const order = orderBy(
        {
          lastAt: { expr: 'n.last_event_at', defaultOrder: 'desc' },
          firstAt: { expr: 'n.first_seen_at', defaultOrder: 'desc' },
          title: { expr: 'COALESCE(n.title, n.native_id) COLLATE NOCASE', defaultOrder: 'asc' },
        },
        q.sort,
        q.order,
        'lastAt',
        'n.id',
      )
      const total =
        sqlite
          .query<{ n: number }, Array<string | number>>(`SELECT COUNT(*) AS n ${from}`)
          .get(...args)?.n ?? 0
      const rows = sqlite
        .query<NodeDb, Array<string | number>>(`SELECT n.* ${from} ${order} LIMIT ? OFFSET ?`)
        .all(...args, ...windowOf(q.page, q.limit))
      return { items: rows.map(toNode), total }
    },
    hasActivity(nodeId) {
      return (
        sqlite
          .query<{ n: number }, [string, string]>(
            `SELECT (EXISTS (SELECT 1 FROM ch_messages WHERE node_id = ?)
               OR EXISTS (SELECT 1 FROM ch_events WHERE node_id = ? AND type LIKE 'gateway.%')) AS n`,
          )
          .get(nodeId, nodeId)?.n === 1
      )
    },
    agentIds(connectionId) {
      const out = new Set<string>()
      for (const r of sqlite
        .query<{ value: string }, [string]>(
          `SELECT DISTINCT s.value AS value FROM ch_node_settings s JOIN ch_nodes n ON n.id = s.node_id
             WHERE n.connection_id = ? AND s.key = 'agentId'`,
        )
        .all(connectionId)) {
        const v = JSON.parse(r.value)
        if (typeof v === 'string') out.add(v)
      }
      return out
    },
    link(from, to, rel, meta = {}) {
      sqlite
        .query(
          `INSERT INTO ch_node_links (from_node_id, to_node_id, rel, meta) VALUES (?, ?, ?, ?)
           ON CONFLICT (from_node_id, to_node_id, rel) DO UPDATE SET meta = excluded.meta`,
        )
        .run(from, to, rel, JSON.stringify(meta))
    },
    links(nodeId) {
      return sqlite
        .query<
          { from_node_id: string; to_node_id: string; rel: string; meta: string },
          [string, string]
        >('SELECT * FROM ch_node_links WHERE from_node_id = ? OR to_node_id = ?')
        .all(nodeId, nodeId)
        .map((r) => ({
          fromNodeId: r.from_node_id,
          toNodeId: r.to_node_id,
          rel: r.rel as NodeLinkRel,
          meta: JSON.parse(r.meta) as Record<string, unknown>,
        }))
    },
    access(nodeId) {
      const r = accessQ.get(nodeId)
      return r === null ? undefined : toAccess(r)
    },
    setAccess(nodeId, connectionId, patch, now) {
      const cur = ensureAccess(nodeId, connectionId, now)
      const sets: string[] = ['updated_at = ?']
      const args: Array<string | number | null> = [now]
      if (patch.member !== undefined) {
        sets.push('member = ?')
        args.push(patch.member)
      }
      if (patch.canPost !== undefined) {
        sets.push('can_post = ?')
        args.push(patch.canPost === null ? null : patch.canPost ? 1 : 0)
      }
      if (patch.canRead !== undefined) {
        sets.push('can_read = ?')
        args.push(patch.canRead === null ? null : patch.canRead ? 1 : 0)
      }
      if (patch.muted !== undefined) {
        sets.push('muted = ?')
        args.push(patch.muted ? 1 : 0)
      }
      if (patch.lastReadNativeId !== undefined) {
        sets.push('last_read_native_id = ?')
        args.push(patch.lastReadNativeId)
      }
      if (patch.rights !== undefined) {
        sets.push('extra = ?')
        args.push(
          JSON.stringify({
            ...(JSON.parse(cur.extra) as Record<string, unknown>),
            rights: patch.rights,
          }),
        )
      }
      sqlite
        .query(`UPDATE ch_node_access SET ${sets.join(', ')} WHERE node_id = ?`)
        .run(...(args as never[]), nodeId)
      return toAccess(accessQ.get(nodeId) as AccessDb)
    },
    patchHistory(nodeId, connectionId, patch, now) {
      const cur = ensureAccess(nodeId, connectionId, now)
      const next = mergeKeys(JSON.parse(cur.history) as Record<string, unknown>, patch)
      sqlite
        .query('UPDATE ch_node_access SET history = ?, updated_at = ? WHERE node_id = ?')
        .run(JSON.stringify(next), now, nodeId)
      return toAccess(accessQ.get(nodeId) as AccessDb)
    },
    patchExtra(nodeId, connectionId, patch, now) {
      const cur = ensureAccess(nodeId, connectionId, now)
      const next = mergeKeys(JSON.parse(cur.extra) as Record<string, unknown>, patch)
      sqlite
        .query('UPDATE ch_node_access SET extra = ?, updated_at = ? WHERE node_id = ?')
        .run(JSON.stringify(next), now, nodeId)
      return toAccess(accessQ.get(nodeId) as AccessDb)
    },
    settings(nodeId) {
      const out: Record<string, unknown> = {}
      for (const r of sqlite
        .query<{ key: string; value: string }, [string]>(
          'SELECT key, value FROM ch_node_settings WHERE node_id = ?',
        )
        .all(nodeId)) {
        out[r.key] = JSON.parse(r.value)
      }
      return out
    },
    setSettings(nodeId, patch) {
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) continue
        if (value === null) {
          sqlite
            .query('DELETE FROM ch_node_settings WHERE node_id = ? AND key = ?')
            .run(nodeId, key)
        } else {
          sqlite
            .query(
              `INSERT INTO ch_node_settings (node_id, key, value) VALUES (?, ?, ?)
               ON CONFLICT (node_id, key) DO UPDATE SET value = excluded.value`,
            )
            .run(nodeId, key, JSON.stringify(value))
        }
      }
    },
    settingsOf(nodeIds) {
      const out = new Map<string, Record<string, unknown>>()
      if (nodeIds.length === 0) return out
      const rows = sqlite
        .query<{ node_id: string; key: string; value: string }, string[]>(
          `SELECT node_id, key, value FROM ch_node_settings WHERE node_id IN (${nodeIds.map(() => '?').join(',')})`,
        )
        .all(...nodeIds)
      for (const r of rows) {
        const rec = out.get(r.node_id) ?? {}
        rec[r.key] = JSON.parse(r.value)
        out.set(r.node_id, rec)
      }
      return out
    },
    clear(connectionId) {
      const ids = sqlite
        .query<{ id: string }, [string]>('SELECT id FROM ch_nodes WHERE connection_id = ?')
        .all(connectionId)
        .map((r) => r.id)
      for (const id of ids) {
        sqlite.query('DELETE FROM ch_node_settings WHERE node_id = ?').run(id)
        sqlite.query('DELETE FROM ch_node_access WHERE node_id = ?').run(id)
        sqlite
          .query('DELETE FROM ch_node_links WHERE from_node_id = ? OR to_node_id = ?')
          .run(id, id)
      }
      sqlite.query('DELETE FROM ch_nodes WHERE connection_id = ?').run(connectionId)
    },
    count(connectionId) {
      return (
        sqlite
          .query<{ n: number }, [string]>(
            'SELECT COUNT(*) AS n FROM ch_nodes WHERE connection_id = ?',
          )
          .get(connectionId)?.n ?? 0
      )
    },
  }
  return port
}
