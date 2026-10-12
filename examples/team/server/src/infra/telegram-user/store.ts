/** SQLite state of the Telegram user transport: chats and their jobs, the session lease, daily counters, account settings. */
import type { Database } from 'bun:sqlite'
import { z } from 'zod'
import type { TgChat, TgChatKind } from './client.ts'

export type BackfillState = 'idle' | 'queued' | 'running' | 'parked' | 'done' | 'error'

export interface UserChat {
  connectionId: string
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

interface Row {
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
}

const u = <T>(v: T | null): T | undefined => (v === null ? undefined : v)

const toChat = (r: Row): UserChat => ({
  connectionId: r.connection_id,
  chatId: r.chat_id,
  kind: r.kind as TgChatKind,
  title: r.title,
  username: u(r.username),
  forum: r.forum === 1,
  admin: r.admin === 1,
  selected: r.selected === 1,
  highId: u(r.high_id),
  firstLiveId: u(r.first_live_id),
  backfillDays: u(r.backfill_days),
  backfillState: r.backfill_state as BackfillState,
  backfillOldestId: u(r.backfill_oldest_id),
  backfillOldestAt: u(r.backfill_oldest_at),
  backfillCount: r.backfill_count,
  backfillError: u(r.backfill_error),
  parkedUntil: u(r.parked_until),
  adminLogEnabled: r.admin_log_enabled === 1,
  adminLogLastId: u(r.admin_log_last_id),
  adminLogLastAt: u(r.admin_log_last_at),
  adminLogCount: r.admin_log_count,
  adminLogError: u(r.admin_log_error),
  updatedAt: r.updated_at,
})

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

export function sqliteChatStore(sqlite: Database): ChatStore {
  const get = sqlite.query<Row, [string, string]>(
    'SELECT * FROM tgu_chats WHERE connection_id = ? AND chat_id = ?',
  )
  const touch = (connectionId: string, chatId: string, set: string, args: unknown[]): void => {
    sqlite
      .query(`UPDATE tgu_chats SET ${set} WHERE connection_id = ? AND chat_id = ?`)
      .run(...(args as never[]), connectionId, chatId)
  }
  return {
    upsertDialog(connectionId, chat, now) {
      sqlite
        .query(
          `INSERT INTO tgu_chats (connection_id, chat_id, kind, title, username, forum, admin, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (connection_id, chat_id) DO UPDATE SET kind = excluded.kind, title = excluded.title,
             username = excluded.username, forum = excluded.forum, admin = excluded.admin, updated_at = excluded.updated_at`,
        )
        .run(
          connectionId,
          chat.id,
          chat.kind,
          chat.title,
          chat.username ?? null,
          chat.forum ? 1 : 0,
          chat.admin ? 1 : 0,
          now,
        )
    },
    get(connectionId, chatId) {
      const r = get.get(connectionId, chatId)
      return r === null ? undefined : toChat(r)
    },
    list(connectionId) {
      return sqlite
        .query<Row, [string]>(
          'SELECT * FROM tgu_chats WHERE connection_id = ? ORDER BY selected DESC, title COLLATE NOCASE',
        )
        .all(connectionId)
        .map(toChat)
    },
    selected(connectionId) {
      return sqlite
        .query<Row, [string]>(
          'SELECT * FROM tgu_chats WHERE connection_id = ? AND selected = 1 ORDER BY title COLLATE NOCASE',
        )
        .all(connectionId)
        .map(toChat)
    },
    isSelected(connectionId, chatId) {
      return get.get(connectionId, chatId)?.selected === 1
    },
    setSelected(connectionId, chatId, selected, now) {
      touch(connectionId, chatId, 'selected = ?, updated_at = ?', [selected ? 1 : 0, now])
    },
    noteMessage(connectionId, chatId, id, live) {
      sqlite
        .query(
          `UPDATE tgu_chats SET high_id = MAX(COALESCE(high_id, 0), ?),
             first_live_id = CASE WHEN ? = 1 THEN MIN(COALESCE(first_live_id, ?), ?) ELSE first_live_id END
           WHERE connection_id = ? AND chat_id = ?`,
        )
        .run(id, live ? 1 : 0, id, id, connectionId, chatId)
    },
    setBackfillDays(connectionId, chatId, days, now) {
      const chat = get.get(connectionId, chatId)
      if (chat === null) return
      if (days === null) {
        touch(
          connectionId,
          chatId,
          "backfill_days = NULL, backfill_state = 'idle', backfill_error = NULL, updated_at = ?",
          [now],
        )
        return
      }
      // a bigger window after a finished run walks further down from where it stopped
      touch(
        connectionId,
        chatId,
        "backfill_days = ?, backfill_state = 'queued', backfill_error = NULL, updated_at = ?",
        [days, now],
      )
    },
    patchBackfill(connectionId, chatId, patch, now) {
      const sets: string[] = ['updated_at = ?']
      const args: unknown[] = [now]
      if (patch.state !== undefined) {
        sets.push('backfill_state = ?')
        args.push(patch.state)
      }
      if (patch.oldestId !== undefined) {
        sets.push('backfill_oldest_id = ?')
        args.push(patch.oldestId)
      }
      if (patch.oldestAt !== undefined) {
        sets.push('backfill_oldest_at = ?')
        args.push(patch.oldestAt)
      }
      if (patch.addCount !== undefined) {
        sets.push('backfill_count = backfill_count + ?')
        args.push(patch.addCount)
      }
      if (patch.error !== undefined) {
        sets.push('backfill_error = ?')
        args.push(patch.error)
      }
      if (patch.parkedUntil !== undefined) {
        sets.push('parked_until = ?')
        args.push(patch.parkedUntil)
      }
      touch(connectionId, chatId, sets.join(', '), args)
    },
    setAdminLog(connectionId, chatId, enabled, now) {
      touch(connectionId, chatId, 'admin_log_enabled = ?, admin_log_error = NULL, updated_at = ?', [
        enabled ? 1 : 0,
        now,
      ])
    },
    patchAdminLog(connectionId, chatId, patch, now) {
      const sets: string[] = ['updated_at = ?']
      const args: unknown[] = [now]
      if (patch.lastId !== undefined) {
        sets.push('admin_log_last_id = ?')
        args.push(patch.lastId)
      }
      if (patch.lastAt !== undefined) {
        sets.push('admin_log_last_at = ?')
        args.push(patch.lastAt)
      }
      if (patch.addCount !== undefined) {
        sets.push('admin_log_count = admin_log_count + ?')
        args.push(patch.addCount)
      }
      if (patch.error !== undefined) {
        sets.push('admin_log_error = ?')
        args.push(patch.error)
      }
      touch(connectionId, chatId, sets.join(', '), args)
    },
    setParked(connectionId, chatId, until, now) {
      touch(connectionId, chatId, 'parked_until = ?, updated_at = ?', [until, now])
    },
    recover(connectionId, now) {
      sqlite
        .query(
          "UPDATE tgu_chats SET backfill_state = 'queued', updated_at = ? WHERE connection_id = ? AND backfill_state IN ('running', 'parked')",
        )
        .run(now, connectionId)
    },
    remove(connectionId) {
      sqlite.query('DELETE FROM tgu_chats WHERE connection_id = ?').run(connectionId)
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

export type CounterKey = 'dm' | 'all'

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
