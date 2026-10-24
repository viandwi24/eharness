/**
 * Join requests that wait for an answer (a chat whose invite link or public entry needs approval).
 * Platform neutral: a bot (`chat_join_request` update) and a user account (pending-requests update)
 * note them, the tools `join_requests` / `list_join_requests` read them, an answer resolves them.
 *
 * The durable store keeps them in `ch_join_requests` (one row per connection, chat and person: the
 * latest request), so a restart loses nothing. `bio` is the applicant's own profile text as the
 * platform showed it with the request; it is never copied into the event log.
 */
import type { Database } from 'bun:sqlite'

export interface JoinRequest {
  chatId: string
  chatTitle: string
  userId: string
  name: string
  username?: string
  bio?: string
  /** The invite link the person used, when there was one. */
  link?: string
  /** Epoch ms of the request. */
  at: number
}

export type JoinResolution = 'approved' | 'declined'

export interface JoinRequestStore {
  /** Keep a request as pending; `true` when it is new (it was not already pending). */
  note(request: JoinRequest): boolean
  /** The pending requests, oldest first; with `chatId` only that chat. */
  list(chatId?: string): JoinRequest[]
  /** One pending request. */
  get(chatId: string, userId: string): JoinRequest | undefined
  /** Mark a pending request answered; undefined when none was pending. */
  resolve(
    chatId: string,
    userId: string,
    resolution: JoinResolution,
    by?: string,
  ): JoinRequest | undefined
}

/** Pending requests older than this are dropped from the list (the platform answers them by itself or they are stale). */
export const PENDING_TTL_MS = 7 * 86_400_000
const MAX_PENDING = 500

/** Memory only: for tests and adapters built without a database. */
export function createJoinRequestStore(now: () => number = Date.now): JoinRequestStore {
  const map = new Map<string, JoinRequest>()
  const key = (c: string, u: string): string => `${c}\n${u}`
  const prune = (): void => {
    for (const [k, v] of map) if (now() - v.at > PENDING_TTL_MS) map.delete(k)
    while (map.size > MAX_PENDING) {
      const first = map.keys().next().value
      if (first === undefined) break
      map.delete(first)
    }
  }
  return {
    note(r) {
      const fresh = !map.has(key(r.chatId, r.userId))
      map.delete(key(r.chatId, r.userId))
      map.set(key(r.chatId, r.userId), r)
      prune()
      return fresh
    },
    list(chatId) {
      prune()
      return [...map.values()].filter((r) => chatId === undefined || r.chatId === chatId)
    },
    get: (c, u) => map.get(key(c, u)),
    resolve(c, u) {
      const r = map.get(key(c, u))
      map.delete(key(c, u))
      return r
    },
  }
}

interface Row {
  chat_id: string
  chat_title: string
  user_id: string
  name: string
  username: string | null
  bio: string | null
  link: string | null
  requested_at: number
}

const toRequest = (r: Row): JoinRequest => ({
  chatId: r.chat_id,
  chatTitle: r.chat_title,
  userId: r.user_id,
  name: r.name,
  ...(r.username === null ? {} : { username: r.username }),
  ...(r.bio === null || r.bio === '' ? {} : { bio: r.bio }),
  ...(r.link === null ? {} : { link: r.link }),
  at: r.requested_at,
})

/** The pending requests of one connection in `ch_join_requests`. */
export function sqliteJoinRequestStore(
  sqlite: Database,
  connectionId: string,
  now: () => number = Date.now,
): JoinRequestStore {
  const prune = (): void => {
    sqlite
      .query(
        "UPDATE ch_join_requests SET status = 'expired', resolved_at = ? WHERE connection_id = ? AND status = 'pending' AND requested_at < ?",
      )
      .run(now(), connectionId, now() - PENDING_TTL_MS)
  }
  const get = (chatId: string, userId: string): JoinRequest | undefined => {
    const row = sqlite
      .query<Row, [string, string, string]>(
        "SELECT * FROM ch_join_requests WHERE connection_id = ? AND chat_id = ? AND user_id = ? AND status = 'pending'",
      )
      .get(connectionId, chatId, userId)
    return row === null ? undefined : toRequest(row)
  }
  return {
    note(r) {
      const fresh = get(r.chatId, r.userId) === undefined
      sqlite
        .query(
          `INSERT INTO ch_join_requests (connection_id, chat_id, user_id, chat_title, name, username, bio, link, requested_at, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
           ON CONFLICT (connection_id, chat_id, user_id) DO UPDATE SET
             chat_title = excluded.chat_title, name = excluded.name, username = excluded.username,
             bio = COALESCE(excluded.bio, bio), link = COALESCE(excluded.link, link),
             requested_at = excluded.requested_at, status = 'pending', resolved_at = NULL, resolved_by = NULL`,
        )
        .run(
          connectionId,
          r.chatId,
          r.userId,
          r.chatTitle,
          r.name,
          r.username ?? null,
          r.bio ?? null,
          r.link ?? null,
          r.at,
        )
      // keep the table small: the oldest pending ones beyond the cap are expired
      sqlite
        .query(
          `UPDATE ch_join_requests SET status = 'expired', resolved_at = ?
           WHERE connection_id = ? AND status = 'pending' AND rowid NOT IN
             (SELECT rowid FROM ch_join_requests WHERE connection_id = ? AND status = 'pending'
              ORDER BY requested_at DESC LIMIT ?)`,
        )
        .run(now(), connectionId, connectionId, MAX_PENDING)
      return fresh
    },
    list(chatId) {
      prune()
      const rows =
        chatId === undefined
          ? sqlite
              .query<Row, [string]>(
                "SELECT * FROM ch_join_requests WHERE connection_id = ? AND status = 'pending' ORDER BY requested_at",
              )
              .all(connectionId)
          : sqlite
              .query<Row, [string, string]>(
                "SELECT * FROM ch_join_requests WHERE connection_id = ? AND chat_id = ? AND status = 'pending' ORDER BY requested_at",
              )
              .all(connectionId, chatId)
      return rows.map(toRequest)
    },
    get,
    resolve(chatId, userId, resolution, by) {
      const found = get(chatId, userId)
      if (found === undefined) return undefined
      sqlite
        .query(
          "UPDATE ch_join_requests SET status = ?, resolved_at = ?, resolved_by = ? WHERE connection_id = ? AND chat_id = ? AND user_id = ? AND status = 'pending'",
        )
        .run(resolution, now(), by ?? null, connectionId, chatId, userId)
      return found
    },
  }
}
