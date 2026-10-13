/**
 * SQLite state of the Telegram user transport (P41 L4, on nodes since L5): the chats of the account
 * and their jobs (stored as node access: `history` for backfill, `extra.adminLog` for the admin
 * log), the session lease, daily counters and account settings.
 *
 * A chat is a room node of the connection. "Chosen for ingest" is the allowlist of the node
 * (`enabled`, inherited like any setting); a chosen chat starts observe-only (`wake: never`).
 */
import type { Database } from 'bun:sqlite'
import { z } from 'zod'
import type { NodeRow } from '../channels/model.ts'
import type { NodeStore } from '../channels/nodes.ts'
import type { TgChat, TgChatKind } from './client.ts'
import { chatNode } from './normalize.ts'

export type BackfillState = 'idle' | 'queued' | 'running' | 'parked' | 'done' | 'error'

export interface UserChat {
  connectionId: string
  /** The node id. */
  nodeId: string
  /** The marked chat id (the native id of the node). */
  chatId: string
  kind: TgChatKind
  title: string
  username: string | undefined
  forum: boolean
  admin: boolean
  selected: boolean
  highId: number | undefined
  firstLiveId: number | undefined
  backfillDays: number | undefined
  backfillState: BackfillState
  backfillOldestId: number | undefined
  backfillOldestAt: number | undefined
  backfillCount: number
  backfillError: string | undefined
  parkedUntil: number | undefined
  adminLogEnabled: boolean
  adminLogLastId: string | undefined
  adminLogLastAt: number | undefined
  adminLogCount: number
  adminLogError: string | undefined
  updatedAt: number
}

export interface BackfillPatch {
  state?: BackfillState
  oldestId?: number | null
  oldestAt?: number | null
  addCount?: number
  error?: string | null
  parkedUntil?: number | null
}

export interface AdminLogPatch {
  lastId?: string | null
  lastAt?: number | null
  addCount?: number
  error?: string | null
}

export interface ChatStore {
  /** Record what the dialogs list said about a chat (title, kind, admin); keeps selection and job state. */
  upsertDialog(connectionId: string, chat: TgChat, now: number): void
  get(connectionId: string, chatId: string): UserChat | undefined
  list(connectionId: string): UserChat[]
  selected(connectionId: string): UserChat[]
  isSelected(connectionId: string, chatId: string): boolean
  /** Choose (observe-only) or stop ingesting a chat; stopping clears what the node sets itself and its jobs. */
  setSelected(connectionId: string, chatId: string, selected: boolean, now: number): void
  /** A message was stored: raise `highId`; `live` also lowers `firstLiveId`. */
  noteMessage(connectionId: string, chatId: string, id: number, live: boolean): void
  setBackfillDays(connectionId: string, chatId: string, days: number | null, now: number): void
  patchBackfill(connectionId: string, chatId: string, patch: BackfillPatch, now: number): void
  setAdminLog(connectionId: string, chatId: string, enabled: boolean, now: number): void
  patchAdminLog(connectionId: string, chatId: string, patch: AdminLogPatch, now: number): void
  setParked(connectionId: string, chatId: string, until: number | null, now: number): void
  /** Jobs left `running` by a crash go back to `queued`. */
  recover(connectionId: string, now: number): void
  remove(connectionId: string): void
}

const POLICY_KEYS = [
  'enabled',
  'agentId',
  'wake',
  'delivery',
  'retentionDays',
  'observe',
  'sessionScope',
  'redactOnDelete',
]

interface AdminLogState {
  enabled?: boolean
  lastId?: string
  lastAt?: number
  count?: number
  error?: string
}

const num = (v: string | undefined): number | undefined => {
  if (v === undefined) return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

export function nodeChatStore(deps: {
  sqlite: Database
  nodes: NodeStore
  /** Does the node pass the allowlist (the chosen chats)? */
  allowed: (node: NodeRow) => boolean
}): ChatStore {
  const { sqlite, nodes } = deps
  const nodeOf = (connectionId: string, chatId: string): NodeRow | undefined => {
    const n = nodes.byNative(connectionId, chatId)
    return n !== undefined && n.kind !== 'thread' && n.kind !== 'direct' ? n : undefined
  }
  const toChat = (n: NodeRow): UserChat => {
    const access = nodes.access(n.id)
    const h = access?.history ?? {}
    const log = (access?.extra.adminLog ?? {}) as AdminLogState
    return {
      connectionId: n.connectionId,
      nodeId: n.id,
      chatId: n.nativeId,
      kind: n.traits.broadcast ? 'channel' : 'group',
      title: n.title ?? n.nativeId,
      username: typeof n.meta.username === 'string' ? n.meta.username : undefined,
      forum: n.traits.container,
      admin: access?.member === 'admin' || access?.member === 'owner',
      selected: deps.allowed(n),
      highId: num(h.highNativeId),
      firstLiveId: num(h.firstLiveNativeId),
      backfillDays: h.days,
      backfillState: (h.state ?? 'idle') as BackfillState,
      backfillOldestId: num(h.oldestNativeId),
      backfillOldestAt: h.oldestAt,
      backfillCount: h.count ?? 0,
      backfillError: h.error,
      parkedUntil: h.parkedUntil,
      adminLogEnabled: log.enabled === true,
      adminLogLastId: log.lastId,
      adminLogLastAt: log.lastAt,
      adminLogCount: log.count ?? 0,
      adminLogError: log.error,
      updatedAt: access?.updatedAt ?? n.lastEventAt,
    }
  }
  const access = (n: NodeRow) => nodes.access(n.id)
  const patchLog = (n: NodeRow, patch: Record<string, unknown>, now: number): void => {
    const cur = (access(n)?.extra.adminLog ?? {}) as AdminLogState
    const next: Record<string, unknown> = { ...cur }
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue
      if (v === null) delete next[k]
      else next[k] = v
    }
    nodes.patchExtra(n.id, n.connectionId, { adminLog: next }, now)
  }
  return {
    upsertDialog(connectionId, chat, now) {
      nodes.apply(connectionId, { ...chatNode(chat) }, undefined, { now })
    },
    get(connectionId, chatId) {
      const n = nodeOf(connectionId, chatId)
      return n === undefined ? undefined : toChat(n)
    },
    list(connectionId) {
      return nodes
        .list(connectionId, { kind: 'room' })
        .map(toChat)
        .sort((a, b) => Number(b.selected) - Number(a.selected) || a.title.localeCompare(b.title))
    },
    selected(connectionId) {
      return nodes
        .list(connectionId, { kind: 'room' })
        .filter((n) => deps.allowed(n))
        .map(toChat)
        .sort((a, b) => a.title.localeCompare(b.title))
    },
    isSelected(connectionId, chatId) {
      const n = nodeOf(connectionId, chatId)
      return n !== undefined && deps.allowed(n)
    },
    setSelected(connectionId, chatId, selected, now) {
      const n = nodeOf(connectionId, chatId)
      if (n === undefined) return
      if (selected) {
        const own = nodes.settings(n.id)
        nodes.setSettings(n.id, {
          ...(own.enabled === undefined ? { enabled: true } : {}),
          ...(own.wake === undefined ? { wake: 'never' } : {}),
        })
      } else {
        nodes.setSettings(n.id, Object.fromEntries(POLICY_KEYS.map((k) => [k, null])))
      }
      void now
    },
    noteMessage(connectionId, chatId, id, live) {
      const n = nodeOf(connectionId, chatId)
      if (n === undefined) return
      const h = access(n)?.history ?? {}
      const high = Math.max(num(h.highNativeId) ?? 0, id)
      const first = live ? Math.min(num(h.firstLiveNativeId) ?? id, id) : num(h.firstLiveNativeId)
      nodes.patchHistory(
        n.id,
        connectionId,
        {
          highNativeId: String(high),
          ...(first === undefined ? {} : { firstLiveNativeId: String(first) }),
        },
        Date.now(),
      )
    },
    setBackfillDays(connectionId, chatId, days, now) {
      const n = nodeOf(connectionId, chatId)
      if (n === undefined) return
      if (days === null) {
        nodes.patchHistory(n.id, connectionId, { days: null, state: 'idle', error: null }, now)
        return
      }
      // a bigger window after a finished run walks further down from where it stopped
      nodes.patchHistory(n.id, connectionId, { days, state: 'queued', error: null }, now)
    },
    patchBackfill(connectionId, chatId, patch, now) {
      const n = nodeOf(connectionId, chatId)
      if (n === undefined) return
      const h = access(n)?.history ?? {}
      nodes.patchHistory(
        n.id,
        connectionId,
        {
          ...(patch.state === undefined ? {} : { state: patch.state }),
          ...(patch.oldestId === undefined
            ? {}
            : { oldestNativeId: patch.oldestId === null ? null : String(patch.oldestId) }),
          ...(patch.oldestAt === undefined ? {} : { oldestAt: patch.oldestAt }),
          ...(patch.addCount === undefined ? {} : { count: (h.count ?? 0) + patch.addCount }),
          ...(patch.error === undefined ? {} : { error: patch.error }),
          ...(patch.parkedUntil === undefined ? {} : { parkedUntil: patch.parkedUntil }),
        },
        now,
      )
    },
    setAdminLog(connectionId, chatId, enabled, now) {
      const n = nodeOf(connectionId, chatId)
      if (n !== undefined) patchLog(n, { enabled, error: null }, now)
    },
    patchAdminLog(connectionId, chatId, patch, now) {
      const n = nodeOf(connectionId, chatId)
      if (n === undefined) return
      const cur = (access(n)?.extra.adminLog ?? {}) as AdminLogState
      patchLog(
        n,
        {
          ...(patch.lastId === undefined ? {} : { lastId: patch.lastId }),
          ...(patch.lastAt === undefined ? {} : { lastAt: patch.lastAt }),
          ...(patch.addCount === undefined ? {} : { count: (cur.count ?? 0) + patch.addCount }),
          ...(patch.error === undefined ? {} : { error: patch.error }),
        },
        now,
      )
    },
    setParked(connectionId, chatId, until, now) {
      const n = nodeOf(connectionId, chatId)
      if (n !== undefined) nodes.patchHistory(n.id, connectionId, { parkedUntil: until }, now)
    },
    recover(connectionId, now) {
      for (const n of nodes.list(connectionId, { kind: 'room' })) {
        const state = access(n)?.history.state
        if (state === 'running' || state === 'parked') {
          nodes.patchHistory(n.id, connectionId, { state: 'queued' }, now)
        }
      }
    },
    remove(connectionId) {
      sqlite.query('DELETE FROM tgu_counters WHERE connection_id = ?').run(connectionId)
      sqlite.query('DELETE FROM tgu_settings WHERE connection_id = ?').run(connectionId)
      sqlite.query('DELETE FROM tgu_leases WHERE connection_id = ?').run(connectionId)
    },
  }
}

// --- the lease -----------------------------------------------------------------------------------

export interface LeaseStore {
  /** Claim (or renew) the session for `owner`. False when another owner holds an unexpired claim. */
  acquire(connectionId: string, owner: string, ttlMs: number, now: number): boolean
  /** The current holder, when the claim has not lapsed. */
  holder(connectionId: string, now: number): { owner: string; expiresAt: number } | undefined
  release(connectionId: string, owner: string): void
}

export function sqliteLeaseStore(sqlite: Database): LeaseStore {
  return {
    acquire(connectionId, owner, ttlMs, now) {
      // one statement: insert, or take over our own / a lapsed claim; a live claim of another owner wins
      const res = sqlite
        .query(
          `INSERT INTO tgu_leases (connection_id, owner, expires_at) VALUES (?, ?, ?)
           ON CONFLICT (connection_id) DO UPDATE SET owner = excluded.owner, expires_at = excluded.expires_at
             WHERE tgu_leases.owner = excluded.owner OR tgu_leases.expires_at <= ?`,
        )
        .run(connectionId, owner, now + ttlMs, now)
      return res.changes > 0
    },
    holder(connectionId, now) {
      const r = sqlite
        .query<{ owner: string; expires_at: number }, [string]>(
          'SELECT owner, expires_at FROM tgu_leases WHERE connection_id = ?',
        )
        .get(connectionId)
      return r === null || r.expires_at <= now
        ? undefined
        : { owner: r.owner, expiresAt: r.expires_at }
    },
    release(connectionId, owner) {
      sqlite
        .query('DELETE FROM tgu_leases WHERE connection_id = ? AND owner = ?')
        .run(connectionId, owner)
    },
  }
}

// --- counters ------------------------------------------------------------------------------------

/** Daily counters: direct messages, all posts, joins and username lookups (platform actions). */
export type CounterKey = 'dm' | 'all' | 'join' | 'resolve'

export interface CounterStore {
  get(connectionId: string, key: CounterKey, now: number): number
  add(connectionId: string, key: CounterKey, now: number, n?: number): void
}

const dayOf = (now: number): string => new Date(now).toISOString().slice(0, 10)

export function sqliteCounterStore(sqlite: Database): CounterStore {
  return {
    get(connectionId, key, now) {
      return (
        sqlite
          .query<{ n: number }, [string, string, string]>(
            'SELECT n FROM tgu_counters WHERE connection_id = ? AND day = ? AND key = ?',
          )
          .get(connectionId, dayOf(now), key)?.n ?? 0
      )
    },
    add(connectionId, key, now, n = 1) {
      sqlite
        .query(
          `INSERT INTO tgu_counters (connection_id, day, key, n) VALUES (?, ?, ?, ?)
           ON CONFLICT (connection_id, day, key) DO UPDATE SET n = n + excluded.n`,
        )
        .run(connectionId, dayOf(now), key, n)
      // old days are of no use
      sqlite
        .query('DELETE FROM tgu_counters WHERE connection_id = ? AND day < ?')
        .run(connectionId, dayOf(now - 3 * 86_400_000))
    },
  }
}

// --- account settings ----------------------------------------------------------------------------

export const AccountSettingsSchema = z.object({
  /** Messages to people (DMs) per UTC day. */
  dmDailyMax: z.number().int().min(0).max(1000).default(30),
  /** Every message the account sends per UTC day. */
  dailyMax: z.number().int().min(0).max(5000).default(300),
  /** How often the admin log of a chat is read (ms; Telegram keeps it only for a short time). */
  adminLogEveryMs: z
    .number()
    .int()
    .min(60_000)
    .default(4 * 3_600_000),
})
export type AccountSettings = z.infer<typeof AccountSettingsSchema>

export interface SettingsStore {
  get(connectionId: string): AccountSettings
  set(connectionId: string, patch: Partial<AccountSettings>, now: number): AccountSettings
}

export function sqliteSettingsStore(sqlite: Database): SettingsStore {
  const read = (connectionId: string): AccountSettings => {
    const r = sqlite
      .query<{ config: string }, [string]>(
        'SELECT config FROM tgu_settings WHERE connection_id = ?',
      )
      .get(connectionId)
    const parsed = AccountSettingsSchema.safeParse(r === null ? {} : JSON.parse(r.config))
    return parsed.success ? parsed.data : AccountSettingsSchema.parse({})
  }
  return {
    get: read,
    set(connectionId, patch, now) {
      const next = AccountSettingsSchema.parse({ ...read(connectionId), ...patch })
      sqlite
        .query(
          `INSERT INTO tgu_settings (connection_id, config, updated_at) VALUES (?, ?, ?)
           ON CONFLICT (connection_id) DO UPDATE SET config = excluded.config, updated_at = excluded.updated_at`,
        )
        .run(connectionId, JSON.stringify(next), now)
      return next
    },
  }
}
