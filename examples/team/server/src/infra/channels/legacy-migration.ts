/**
 * The data migration of phase L5 (docs/plans/P41-team-channels.md): the tables of L1-L4
 * (`channel_conversations`, `channel_messages`, `channel_inbox`, `channel_events`,
 * `channel_known_chats`, `channel_unlinked`, `channel_identities`, `tgu_chats`) become nodes,
 * links, access, settings, identities, sessions, messages and events.
 *
 * Two steps, both idempotent (unique keys, `INSERT OR IGNORE`, a marker in `ch_meta`):
 *
 *  1. {@link migrateLegacyStructure} (synchronous, one transaction): everything that is not
 *     sealed. A conversation of before L5 becomes a node whose `legacy_ref_id` is the old
 *     conversation id; a forum chat becomes a container room with a `General` thread (the old
 *     container-level conversation of a forum was its General topic) and one thread per topic. The
 *     per-group and per-topic overrides of the connection configuration become node settings (the
 *     `*` entry joins the connection defaults). Sessions keep their old key, so threads and
 *     approvals keep working; the `conversation_id` of the outbox and of approvals becomes a node id.
 *  2. {@link migrateLegacyMessages} (asynchronous: the bodies are sealed): every message is opened
 *     with the channel vault and written again as a message with UIMessage compatible content, its
 *     sender as an identity, edits as revisions. Message ids and change counters are kept, so
 *     collectors resume where they were.
 *
 * The old tables are left in place (read by nothing); a later migration drops them once the copy
 * is verified on real data. Native ids of migrated nodes follow the old conversation id
 * (`<chat>` and `<chat>/<topic>`), which is also what the Telegram adapters compose.
 */
import type { Database } from 'bun:sqlite'
import { uuidv7 } from 'eharness'
import type { SecretVault } from 'eharness/providers'
import { sqliteIdentityStore } from './identities.ts'
import { contentOf } from './messages.ts'
import { type NodeKind, type NodeTraits, traitsOf } from './model.ts'
import { sqliteNodeStore } from './nodes.ts'
import { ScopePolicySchema } from './policy.ts'

const MARKER_STRUCTURE = 'legacy_structure_migrated'
const MARKER_MESSAGES = 'legacy_messages_migrated'

export interface LegacyReport {
  skipped: boolean
  nodes: number
  settings: number
  sessions: number
  identities: number
  events: number
  messages: number
}

const empty = (skipped: boolean): LegacyReport => ({
  skipped,
  nodes: 0,
  settings: 0,
  sessions: 0,
  identities: 0,
  events: 0,
  messages: 0,
})

interface RefJson {
  id?: string
  container?: string
  topic?: string
  kind?: 'dm' | 'group' | 'channel'
  title?: string
}

interface ConvInfo {
  connectionId: string
  legacyId: string
  container: string
  topic: string | undefined
  kind: 'dm' | 'group' | 'channel' | undefined
  title: string | undefined
  firstAt: number | undefined
  lastAt: number | undefined
}

const marker = (sqlite: Database, key: string): string | undefined =>
  sqlite.query<{ value: string }, [string]>('SELECT value FROM ch_meta WHERE key = ?').get(key)
    ?.value

const setMarker = (sqlite: Database, key: string, value: string): void => {
  sqlite
    .query(
      `INSERT INTO ch_meta (key, value) VALUES (?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    )
    .run(key, value)
}

const splitLegacyId = (id: string): { container: string; topic?: string } => {
  const at = id.indexOf('/')
  return at < 0 ? { container: id } : { container: id.slice(0, at), topic: id.slice(at + 1) }
}

const safeJson = <T>(text: string | null | undefined, fallback: T): T => {
  if (text === null || text === undefined) return fallback
  try {
    return JSON.parse(text) as T
  } catch {
    return fallback
  }
}

const ROLE_OF_STATUS: Record<string, 'admin' | 'owner' | 'member' | 'none'> = {
  administrator: 'admin',
  creator: 'owner',
  member: 'member',
  restricted: 'member',
  left: 'none',
  kicked: 'none',
}

export function migrateLegacyStructure(sqlite: Database, now: number): LegacyReport {
  if (marker(sqlite, MARKER_STRUCTURE) !== undefined) return empty(true)
  const report = empty(false)
  const nodes = sqliteNodeStore(sqlite)
  const identities = sqliteIdentityStore(sqlite)

  const run = (): void => {
    // --- 1. what the old tables say about conversations ---------------------------------------
    const convs = new Map<string, ConvInfo>()
    const key = (c: string, id: string): string => `${c}\n${id}`
    const note = (
      connectionId: string,
      legacyId: string,
      patch: Partial<ConvInfo> & { ref?: RefJson },
    ): void => {
      const k = key(connectionId, legacyId)
      const cur = convs.get(k)
      const ref = patch.ref
      const split = splitLegacyId(legacyId)
      const next: ConvInfo = cur ?? {
        connectionId,
        legacyId,
        container: ref?.container ?? split.container,
        topic: ref?.container === undefined ? split.topic : ref.topic,
        kind: undefined,
        title: undefined,
        firstAt: undefined,
        lastAt: undefined,
      }
      if (ref?.kind !== undefined && next.kind === undefined) next.kind = ref.kind
      if (ref?.title !== undefined && next.title === undefined && ref.title !== '')
        next.title = ref.title
      if (patch.kind !== undefined && next.kind === undefined) next.kind = patch.kind
      if (patch.title !== undefined && next.title === undefined) next.title = patch.title
      if (patch.firstAt !== undefined)
        next.firstAt = Math.min(next.firstAt ?? patch.firstAt, patch.firstAt)
      if (patch.lastAt !== undefined) next.lastAt = Math.max(next.lastAt ?? 0, patch.lastAt)
      convs.set(k, next)
    }

    const conversations = sqlite
      .query<
        {
          connection_id: string
          conversation_id: string
          session_id: string
          agent_id: string
          ref: string
          label: string | null
          retention_days: number | null
          created_at: number
          generation: number
        },
        []
      >('SELECT * FROM channel_conversations')
      .all()
    for (const c of conversations) {
      note(c.connection_id, c.conversation_id, {
        ref: safeJson<RefJson>(c.ref, {}),
        firstAt: c.created_at,
      })
    }
    const inbox = sqlite
      .query<
        {
          connection_id: string
          conversation_id: string
          ref: string
          first_at: number
          last_at: number
        },
        []
      >('SELECT connection_id, conversation_id, ref, first_at, last_at FROM channel_inbox')
      .all()
    for (const i of inbox) {
      note(i.connection_id, i.conversation_id, {
        ref: safeJson<RefJson>(i.ref, {}),
        firstAt: i.first_at,
        lastAt: i.last_at,
      })
    }

    const known = sqlite
      .query<
        {
          connection_id: string
          chat_id: string
          kind: string
          title: string
          username: string | null
          forum: number
          topics: string
          bot_status: string | null
          can_post: number | null
          first_seen: number
          last_seen: number
        },
        []
      >('SELECT * FROM channel_known_chats')
      .all()
    const tgu = sqlite
      .query<
        {
          connection_id: string
          chat_id: string
          kind: string
          title: string
          username: string | null
          forum: number
          admin: number
          selected: number
          high_id: number | null
          first_live_id: number | null
          backfill_days: number | null
          backfill_state: string
          backfill_oldest_id: number | null
          backfill_oldest_at: number | null
          backfill_count: number
          backfill_error: string | null
          parked_until: number | null
          admin_log_enabled: number
          admin_log_last_id: string | null
          admin_log_last_at: number | null
          admin_log_count: number
          admin_log_error: string | null
          updated_at: number
        },
        []
      >('SELECT * FROM tgu_chats')
      .all()

    const configRows = sqlite
      .query<{ connection_id: string; config: string }, []>(
        'SELECT connection_id, config FROM channel_connections',
      )
      .all()
    type RawScope = Record<string, unknown> & { topics?: Record<string, Record<string, unknown>> }
    const rawConfigs = new Map<string, Record<string, unknown>>()
    for (const r of configRows) rawConfigs.set(r.connection_id, safeJson(r.config, {}))
    const groupsOf = (connectionId: string): Record<string, RawScope> =>
      (rawConfigs.get(connectionId)?.groups as Record<string, RawScope> | undefined) ?? {}

    // forum chats and their topics
    const forum = new Set<string>()
    const topicNames = new Map<string, string>()
    const chatInfo = new Map<
      string,
      { kind: 'dm' | 'group' | 'channel'; title: string; at: number }
    >()
    for (const k of known) {
      const ck = key(k.connection_id, k.chat_id)
      if (k.forum === 1) forum.add(ck)
      chatInfo.set(ck, {
        kind: k.kind as 'dm' | 'group' | 'channel',
        title: k.title,
        at: k.first_seen,
      })
      for (const [t, name] of Object.entries(safeJson<Record<string, string>>(k.topics, {}))) {
        topicNames.set(key(k.connection_id, `${k.chat_id}/${t}`), name)
        note(k.connection_id, `${k.chat_id}/${t}`, { firstAt: k.first_seen })
      }
      note(k.connection_id, k.chat_id, {
        kind: k.kind as 'dm' | 'group' | 'channel',
        title: k.title,
        firstAt: k.first_seen,
        lastAt: k.last_seen,
      })
    }
    for (const t of tgu) {
      const ck = key(t.connection_id, t.chat_id)
      if (t.forum === 1) forum.add(ck)
      if (!chatInfo.has(ck))
        chatInfo.set(ck, {
          kind: t.kind as 'dm' | 'group' | 'channel',
          title: t.title,
          at: t.updated_at,
        })
      note(t.connection_id, t.chat_id, {
        kind: t.kind as 'dm' | 'group' | 'channel',
        title: t.title,
        firstAt: t.updated_at,
      })
    }
    for (const [connectionId] of rawConfigs) {
      for (const [container, g] of Object.entries(groupsOf(connectionId))) {
        if (container === '*') continue
        note(connectionId, container, {})
        for (const t of Object.keys(g.topics ?? {})) note(connectionId, `${container}/${t}`, {})
      }
    }
    // anything else that names a conversation (messages, events, outbox, approvals)
    for (const [table, column] of [
      ['channel_messages', 'conversation_id'],
      ['channel_events', 'conversation_id'],
      ['channel_outbox', 'conversation_id'],
      ['channel_approvals', 'conversation_id'],
    ] as const) {
      const rows = sqlite
        .query<{ connection_id: string; id: string }, []>(
          `SELECT DISTINCT connection_id, ${column} AS id FROM ${table} WHERE ${column} IS NOT NULL`,
        )
        .all()
      // (a row that already names a node, after an earlier run, is not an old conversation)
      for (const r of rows) if (nodes.get(r.id) === undefined) note(r.connection_id, r.id, {})
    }
    for (const c of convs.values()) {
      if (c.topic !== undefined) forum.add(key(c.connectionId, c.container))
    }

    // --- 2. nodes -----------------------------------------------------------------------------
    const legacyToNode = new Map<string, string>()
    const nodeOfLegacy = (connectionId: string, legacyId: string): string | undefined =>
      legacyToNode.get(key(connectionId, legacyId))

    const containers = new Map<string, { connectionId: string; container: string }>()
    for (const c of convs.values())
      containers.set(key(c.connectionId, c.container), {
        connectionId: c.connectionId,
        container: c.container,
      })
    const roomOf = new Map<string, string>()
    for (const { connectionId, container } of containers.values()) {
      const ck = key(connectionId, container)
      const isForum = forum.has(ck)
      const own = convs.get(key(connectionId, container))
      const info = chatInfo.get(ck)
      const kind = own?.kind ?? info?.kind ?? 'group'
      const title =
        own?.title ??
        info?.title ??
        [...convs.values()].find(
          (x) =>
            x.connectionId === connectionId && x.container === container && x.title !== undefined,
        )?.title
      const nodeKind: NodeKind = kind === 'dm' ? 'direct' : 'room'
      const traits: Partial<NodeTraits> =
        kind === 'dm'
          ? { multiUser: false, threading: 'none' }
          : {
              multiUser: kind === 'group',
              broadcast: kind === 'channel',
              threading: isForum ? 'node' : 'relation',
              ...(isForum ? { container: true, postable: false } : {}),
            }
      const existing = nodes.byNative(connectionId, container)
      const created =
        existing === undefined
          ? nodes.apply(
              connectionId,
              {
                nativeId: container,
                kind: nodeKind,
                traits,
                ...(title === undefined ? {} : { title }),
              },
              undefined,
              { now: own?.firstAt ?? info?.at ?? now },
            )
          : undefined
      const node = existing ?? (created?.node as NonNullable<typeof created>['node'])
      if (existing === undefined) report.nodes++
      roomOf.set(ck, node.id)
      if (!isForum && node.legacyRefId === null) {
        sqlite.query('UPDATE ch_nodes SET legacy_ref_id = ? WHERE id = ?').run(container, node.id)
        legacyToNode.set(key(connectionId, container), node.id)
      } else if (!isForum) legacyToNode.set(key(connectionId, container), node.id)
      if (isForum) {
        // the container-level conversation of a forum was its General topic
        const generalNative = `${container}/0`
        let general = nodes.byNative(connectionId, generalNative)
        if (general === undefined) {
          general = nodes.apply(
            connectionId,
            {
              nativeId: generalNative,
              kind: 'thread',
              title: 'General',
              traits: { multiUser: true, threading: 'relation' },
            },
            node,
            { now: own?.firstAt ?? now },
          )?.node
          report.nodes++
        }
        if (general !== undefined) {
          sqlite
            .query('UPDATE ch_nodes SET legacy_ref_id = ? WHERE id = ? AND legacy_ref_id IS NULL')
            .run(container, general.id)
          legacyToNode.set(key(connectionId, container), general.id)
        }
      }
    }
    for (const c of convs.values()) {
      if (c.topic === undefined) continue
      const room = nodes.get(roomOf.get(key(c.connectionId, c.container)) as string)
      if (room === undefined) continue
      const native = `${c.container}/${c.topic}`
      let node = nodes.byNative(c.connectionId, native)
      if (node === undefined) {
        node = nodes.apply(
          c.connectionId,
          {
            nativeId: native,
            kind: 'thread',
            title: topicNames.get(key(c.connectionId, c.legacyId)) ?? `Topic ${c.topic}`,
            traits: { multiUser: true, threading: 'relation' },
          },
          room,
          { now: c.firstAt ?? now },
        )?.node
        report.nodes++
      }
      if (node !== undefined) {
        sqlite
          .query('UPDATE ch_nodes SET legacy_ref_id = ? WHERE id = ? AND legacy_ref_id IS NULL')
          .run(c.legacyId, node.id)
        legacyToNode.set(key(c.connectionId, c.legacyId), node.id)
      }
    }
    // activity times
    for (const c of convs.values()) {
      const id = nodeOfLegacy(c.connectionId, c.legacyId)
      if (id === undefined || c.lastAt === undefined) continue
      sqlite
        .query('UPDATE ch_nodes SET last_event_at = MAX(last_event_at, ?) WHERE id = ?')
        .run(c.lastAt, id)
    }

    // --- 3. access (bot membership, account jobs) ---------------------------------------------
    for (const k of known) {
      const id = roomOf.get(key(k.connection_id, k.chat_id))
      if (id === undefined) continue
      const role = k.bot_status === null ? undefined : ROLE_OF_STATUS[k.bot_status]
      nodes.setAccess(
        id,
        k.connection_id,
        {
          ...(role === undefined ? {} : { member: role }),
          ...(k.can_post === null ? {} : { canPost: k.can_post === 1 }),
        },
        now,
      )
      if (role === 'none') {
        nodes.apply(
          k.connection_id,
          { nativeId: k.chat_id, state: 'left', stateReason: k.bot_status ?? 'left' },
          undefined,
          { now, existingOnly: true },
        )
      }
    }
    for (const t of tgu) {
      const id = roomOf.get(key(t.connection_id, t.chat_id))
      if (id === undefined) continue
      nodes.setAccess(id, t.connection_id, { member: t.admin === 1 ? 'admin' : 'member' }, now)
      const history: Record<string, unknown> = {
        ...(t.backfill_days === null ? {} : { days: t.backfill_days }),
        state: t.backfill_state,
        ...(t.backfill_oldest_id === null ? {} : { oldestNativeId: String(t.backfill_oldest_id) }),
        ...(t.backfill_oldest_at === null ? {} : { oldestAt: t.backfill_oldest_at }),
        count: t.backfill_count,
        ...(t.backfill_error === null ? {} : { error: t.backfill_error }),
        ...(t.parked_until === null ? {} : { parkedUntil: t.parked_until }),
        ...(t.high_id === null ? {} : { highNativeId: String(t.high_id) }),
        ...(t.first_live_id === null ? {} : { firstLiveNativeId: String(t.first_live_id) }),
      }
      nodes.patchHistory(id, t.connection_id, history, now)
      nodes.patchExtra(
        id,
        t.connection_id,
        {
          adminLog: {
            enabled: t.admin_log_enabled === 1,
            ...(t.admin_log_last_id === null ? {} : { lastId: t.admin_log_last_id }),
            ...(t.admin_log_last_at === null ? {} : { lastAt: t.admin_log_last_at }),
            count: t.admin_log_count,
            ...(t.admin_log_error === null ? {} : { error: t.admin_log_error }),
          },
        },
        now,
      )
      if (t.username !== null) {
        const node = nodes.get(id)
        if (node !== undefined && node.meta.username === undefined)
          nodes.apply(
            t.connection_id,
            { nativeId: node.nativeId, meta: { username: t.username } },
            undefined,
            {
              now,
              existingOnly: true,
            },
          )
      }
    }

    // --- 4. settings: group and topic overrides become inherited settings ----------------------
    const policyKeys = Object.keys(ScopePolicySchema.shape) as Array<
      keyof typeof ScopePolicySchema.shape
    >
    const settingsOf = (raw: Record<string, unknown>): Record<string, unknown> => {
      const out: Record<string, unknown> = {}
      for (const k of policyKeys) {
        if (k === 'enabled') continue
        const v = raw[k]
        if (v !== undefined && ScopePolicySchema.shape[k].safeParse(v).success) out[k] = v
      }
      return out
    }
    const setOnce = (nodeId: string, values: Record<string, unknown>): void => {
      const have = nodes.settings(nodeId)
      const next: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(values)) if (have[k] === undefined) next[k] = v
      if (Object.keys(next).length === 0) return
      nodes.setSettings(nodeId, next)
      report.settings += Object.keys(next).length
    }
    for (const [connectionId, raw] of rawConfigs) {
      const groups = groupsOf(connectionId)
      const star = groups['*']
      for (const [container, g] of Object.entries(groups)) {
        if (container === '*') continue
        const roomId = roomOf.get(key(connectionId, container))
        if (roomId === undefined) continue
        setOnce(roomId, { ...settingsOf(g), enabled: g.enabled !== false })
        for (const [t, tp] of Object.entries(g.topics ?? {})) {
          const topicId = nodeOfLegacy(connectionId, `${container}/${t}`)
          if (topicId === undefined) continue
          setOnce(topicId, {
            ...settingsOf(tp),
            ...(tp.enabled === false ? { enabled: false } : {}),
          })
        }
      }
      // the `*` entry of an open policy joins the connection defaults, and the groups leave the config
      const defaults = (raw.defaults as Record<string, unknown> | undefined) ?? {}
      const nextConfig = { ...raw }
      delete nextConfig.groups
      if (star !== undefined) {
        nextConfig.defaults = { ...defaults, ...settingsOf(star) }
      }
      if (raw.groups !== undefined) {
        sqlite
          .query('UPDATE channel_connections SET config = ? WHERE connection_id = ?')
          .run(JSON.stringify(nextConfig), connectionId)
      }
    }
    // a chosen account chat is in the allowlist, observe-only unless something says otherwise
    for (const t of tgu) {
      if (t.selected !== 1) continue
      const id = roomOf.get(key(t.connection_id, t.chat_id))
      if (id === undefined) continue
      setOnce(id, { enabled: true, wake: 'never' })
    }
    for (const c of conversations) {
      if (c.retention_days === null) continue
      const id = nodeOfLegacy(c.connection_id, c.conversation_id)
      if (id !== undefined) setOnce(id, { retentionDays: c.retention_days })
    }

    // --- 5. identities ------------------------------------------------------------------------
    for (const l of sqlite
      .query<
        {
          connection_id: string
          peer_id: string
          member_id: string
          name: string | null
          linked_at: number
        },
        []
      >('SELECT * FROM channel_identities')
      .all()) {
      identities.upsert(
        l.connection_id,
        { id: l.peer_id, ...(l.name === null ? {} : { name: l.name }) },
        { now: l.linked_at },
      )
      sqlite
        .query(
          `UPDATE ch_identities SET person_id = ?, linked_at = ?, display_name = COALESCE(display_name, ?)
             WHERE connection_id = ? AND native_id = ? AND person_id IS NULL`,
        )
        .run(l.member_id, l.linked_at, l.name, l.connection_id, l.peer_id)
      report.identities++
    }
    for (const u of sqlite
      .query<
        {
          connection_id: string
          peer_id: string
          name: string | null
          username: string | null
          first_seen: number
          last_seen: number
          message_count: number
          ignored: number
        },
        []
      >('SELECT * FROM channel_unlinked')
      .all()) {
      identities.upsert(
        u.connection_id,
        {
          id: u.peer_id,
          ...(u.name === null ? {} : { name: u.name }),
          ...(u.username === null ? {} : { username: u.username }),
        },
        { now: u.first_seen },
      )
      sqlite
        .query(
          `UPDATE ch_identities SET dm_first_at = COALESCE(dm_first_at, ?), dm_last_at = MAX(COALESCE(dm_last_at, 0), ?),
             dm_count = MAX(dm_count, ?), ignored = ?, last_seen_at = MAX(last_seen_at, ?)
             WHERE connection_id = ? AND native_id = ? AND person_id IS NULL`,
        )
        .run(
          u.first_seen,
          u.last_seen,
          u.message_count,
          u.ignored,
          u.last_seen,
          u.connection_id,
          u.peer_id,
        )
      report.identities++
    }
    // a direct chat belongs to the person it is with
    for (const n of sqlite
      .query<{ id: string; connection_id: string; native_id: string }, []>(
        "SELECT id, connection_id, native_id FROM ch_nodes WHERE kind = 'direct'",
      )
      .all()) {
      const who = identities.byNative(n.connection_id, n.native_id)
      if (who !== undefined) identities.setMembership(n.id, who.id, {})
    }

    // --- 6. sessions keep their old key --------------------------------------------------------
    for (const c of conversations) {
      const id = nodeOfLegacy(c.connection_id, c.conversation_id)
      if (id === undefined) continue
      const res = sqlite
        .query(
          `INSERT OR IGNORE INTO ch_node_sessions (connection_id, node_id, session_id, agent_id, label, created_at, generation, last_node_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(c.connection_id, id, c.session_id, c.agent_id, c.label, c.created_at, c.generation, id)
      report.sessions += res.changes
    }

    // --- 7. activity events --------------------------------------------------------------------
    for (const e of sqlite
      .query<
        {
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
        },
        []
      >('SELECT * FROM channel_events')
      .all()) {
      const nodeId =
        e.conversation_id === null
          ? null
          : (nodeOfLegacy(e.connection_id, e.conversation_id) ?? null)
      const payload = {
        ...(e.reason === null ? {} : { reason: e.reason }),
        ...(e.peer_id === null ? {} : { peerId: e.peer_id }),
        ...(e.peer_name === null ? {} : { peerName: e.peer_name }),
        ...(e.platform_id === null ? {} : { platformId: e.platform_id }),
        ...(e.detail === null ? {} : { detail: safeJson(e.detail, {}) }),
      }
      const res = sqlite
        .query(
          `INSERT OR IGNORE INTO ch_events (id, connection_id, type, node_id, target_message_native_id, at, received_at, dedupe_key, payload)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          e.id,
          e.connection_id,
          `gateway.${e.type.replace(/-/g, '_')}`,
          nodeId,
          e.platform_id,
          e.at,
          e.at,
          `legacy:${e.id}`,
          JSON.stringify(payload),
        )
      report.events += res.changes
    }

    // --- 8. the outbox and the approvals point at nodes ---------------------------------------
    for (const c of convs.values()) {
      const id = nodeOfLegacy(c.connectionId, c.legacyId)
      if (id === undefined) continue
      for (const table of ['channel_outbox', 'channel_approvals']) {
        sqlite
          .query(
            `UPDATE ${table} SET conversation_id = ? WHERE connection_id = ? AND conversation_id = ?`,
          )
          .run(id, c.connectionId, c.legacyId)
      }
    }
    setMarker(sqlite, MARKER_STRUCTURE, JSON.stringify({ at: now, ...report }))
    // the message step needs the mapping again on a later boot
  }
  sqlite.transaction(run)()
  return report
}

interface LegacyBody {
  sender?: { id: string; name?: string; username?: string; isBot?: boolean; isSelf?: boolean }
  text: string
  attachments?: Array<{
    id: string
    kind?: string
    name?: string
    mediaType?: string
    size?: number
  }>
  replyTo?: { messageId: string; senderName?: string; text?: string }
  edits?: Array<{ at: number; text: string }>
}

interface LegacyMessage {
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

/** Open every old message and store it again in the new shape (idempotent: done ids are skipped). */
export async function migrateLegacyMessages(
  sqlite: Database,
  vault: SecretVault,
  options: { batch?: number; now?: () => number } = {},
): Promise<LegacyReport> {
  const now = options.now ?? Date.now
  const report = empty(false)
  const total =
    sqlite.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM channel_messages').get()?.n ?? 0
  if (total === 0 || marker(sqlite, MARKER_MESSAGES) !== undefined) {
    if (marker(sqlite, MARKER_MESSAGES) === undefined)
      setMarker(sqlite, MARKER_MESSAGES, JSON.stringify({ at: now(), legacy: 0, migrated: 0 }))
    return { ...report, skipped: true }
  }
  const nodes = sqliteNodeStore(sqlite)
  const identities = sqliteIdentityStore(sqlite)
  const batch = options.batch ?? 200
  const done = sqlite.query<{ id: string }, [string]>('SELECT id FROM ch_messages WHERE id = ?')
  const insert = sqlite.query(
    `INSERT OR IGNORE INTO ch_messages (id, connection_id, node_id, native_id, sender_identity_id, sent_at, sort_key,
       direction, kind, content, content_version, reply_to_native_id, edited_at, deleted_at, deleted_has_content,
       disposition, pending, handled, rev)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'message', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const fallbackNode = (connectionId: string, legacyId: string): string => {
    const existing = nodes.byLegacy(connectionId, legacyId)
    if (existing !== undefined) return existing.id
    const split = splitLegacyId(legacyId)
    const made = nodes.apply(
      connectionId,
      { nativeId: legacyId, kind: 'room', title: split.container, traits: { multiUser: true } },
      undefined,
      { now: now() },
    )?.node as NonNullable<ReturnType<typeof nodes.byNative>>
    sqlite.query('UPDATE ch_nodes SET legacy_ref_id = ? WHERE id = ?').run(legacyId, made.id)
    return made.id
  }

  let after = ''
  for (;;) {
    const rows = sqlite
      .query<LegacyMessage, [string, number]>(
        'SELECT * FROM channel_messages WHERE id > ? ORDER BY id LIMIT ?',
      )
      .all(after, batch)
    if (rows.length === 0) break
    after = (rows.at(-1) as LegacyMessage).id
    for (const r of rows) {
      if (done.get(r.id) !== null) continue
      let body: LegacyBody
      try {
        body = JSON.parse(await vault.open(r.body, `channel-message:${r.id}`)) as LegacyBody
      } catch {
        // a body the current key cannot open stays in the old table; the count below shows it
        continue
      }
      const nodeId = fallbackNode(r.connection_id, r.conversation_id)
      const sender =
        body.sender === undefined
          ? undefined
          : identities.upsert(r.connection_id, body.sender, {
              now: r.at,
              isSelf: body.sender.isSelf === true || r.self === 1,
            })
      const edits = body.edits ?? []
      const content = contentOf({
        text: body.text,
        attachments: body.attachments ?? [],
        replyTo: body.replyTo,
      })
      const sealed = await vault.seal(JSON.stringify(content), `channel-message:${r.id}`)
      const revisions: Array<{ version: number; sealed: string; at: number }> = []
      for (const [i, e] of edits.entries()) {
        revisions.push({
          version: i,
          at: e.at,
          sealed: await vault.seal(
            JSON.stringify(contentOf({ text: e.text })),
            `channel-message-revision:${r.id}:${i}`,
          ),
        })
      }
      sqlite.transaction(() => {
        insert.run(
          r.id,
          r.connection_id,
          nodeId,
          r.platform_id,
          sender?.id ?? null,
          r.at,
          r.platform_id,
          r.self === 1 ? 'out' : 'in',
          sealed,
          edits.length,
          body.replyTo?.messageId ?? null,
          r.edited_at,
          r.deleted_at,
          r.deleted_at === null ? 0 : 1,
          r.disposition,
          r.pending,
          r.handled,
          r.rev,
        )
        for (const rev of revisions) {
          sqlite
            .query(
              `INSERT OR IGNORE INTO ch_message_revisions (message_id, version, content, edited_at) VALUES (?, ?, ?, ?)`,
            )
            .run(r.id, rev.version, rev.sealed, rev.at)
        }
      })()
      report.messages++
    }
  }
  const have =
    sqlite
      .query<{ n: number }, []>(
        'SELECT COUNT(*) AS n FROM ch_messages WHERE id IN (SELECT id FROM channel_messages)',
      )
      .get()?.n ?? 0
  // only a complete copy is marked: a body that could not be opened is tried again next boot
  if (have === total) {
    setMarker(sqlite, MARKER_MESSAGES, JSON.stringify({ at: now(), legacy: total, migrated: have }))
  }
  void uuidv7
  void traitsOf
  return report
}
