/**
 * Admin log polling (P41 L4). Telegram keeps the moderation log of a channel or supergroup for a
 * short time only (believed about 48 hours: verify with a real account), so for chats where the
 * account is an admin it is read every few hours and every event is stored (deletions with the
 * original text, edits, bans, promotions) into the channel log as event rows.
 */

import type { Database } from 'bun:sqlite'
import type { JobHooks } from './backfill.ts'
import type { TgAdminEvent, TgUserClient } from './client.ts'
import { ADMIN_EVENT_PREFIX } from './collector.ts'
import { classifyError, describeError } from './errors.ts'
import type { ChatStore } from './store.ts'

export interface AdminLogOptions {
  connectionId: string
  client: TgUserClient
  chats: ChatStore
  /** Store one event; false when it was already stored. */
  record(chatId: string, event: TgAdminEvent): Promise<boolean>
  allowed(chatId: string): boolean
  everyMs: () => number
  hooks: JobHooks
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  random?: () => number
  pageSize?: number
  maxPages?: number
}

/** How a read of one chat ended. */
export interface AdminLogPoll {
  /** `ok`, or why nothing was read (`parked`, `off`, `not-admin`, `not-chosen`, `error`). */
  status: 'ok' | 'parked' | 'off' | 'not-admin' | 'not-chosen' | 'error'
  /** A sentence for a person when `status` is not `ok`. */
  text?: string
  parkedUntil?: number
}

/** What `admin_log` asks for (all optional but the limit). */
export interface AdminLogQuery {
  limit: number
  /** `delete`, `edit`, `ban`, `unban`, `restrict`, `promote`, `demote`, `join`, `leave`, `invite`, `pin`. */
  kind?: string
  /** Text inside the event line (a deleted message's words, a name). */
  query?: string
  /** Epoch ms bounds of the event time. */
  from?: number
  to?: number
  /** A user id (the admin who acted, or the person acted on), or part of a name. */
  user?: string
}

export const ADMIN_EVENT_KINDS = [
  'delete',
  'edit',
  'ban',
  'unban',
  'restrict',
  'promote',
  'demote',
  'join',
  'leave',
  'invite',
  'pin',
  'other',
] as const

/** The stored admin events of a chat (its room path), newest first, matching the filters. */
export function storedAdminEvents(
  sqlite: Database,
  connectionId: string,
  roomPath: string,
  q: AdminLogQuery,
): Array<{ content: string | null; sent_at: number }> {
  const where = [
    'm.connection_id = ?',
    "m.kind = 'system'",
    'm.native_id LIKE ?',
    '(n.path = ? OR n.path LIKE ?)',
  ]
  const args: Array<string | number> = [
    connectionId,
    `${ADMIN_EVENT_PREFIX}%`,
    roomPath,
    `${roomPath}/%`,
  ]
  if (q.kind !== undefined) {
    where.push("json_extract(m.meta, '$.adminEvent.kind') = ?")
    args.push(q.kind)
  }
  if (q.query !== undefined && q.query.trim() !== '') {
    where.push("m.content LIKE ? ESCAPE '\\'")
    args.push(`%${q.query.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`)
  }
  if (q.from !== undefined) {
    where.push('m.sent_at >= ?')
    args.push(q.from)
  }
  if (q.to !== undefined) {
    where.push('m.sent_at <= ?')
    args.push(q.to)
  }
  if (q.user !== undefined && q.user.trim() !== '') {
    const u = q.user.trim().replace(/^@/, '')
    where.push(
      "(json_extract(m.meta, '$.adminEvent.actorId') = ? OR json_extract(m.meta, '$.adminEvent.targetId') = ? OR json_extract(m.meta, '$.adminEvent.actorName') LIKE ? OR json_extract(m.meta, '$.adminEvent.targetName') LIKE ?)",
    )
    args.push(u, u, `%${u}%`, `%${u}%`)
  }
  return sqlite
    .query<{ content: string | null; sent_at: number }, Array<string | number>>(
      `SELECT m.content, m.sent_at FROM ch_messages m JOIN ch_nodes n ON n.id = m.node_id
         WHERE ${where.join(' AND ')} ORDER BY m.sent_at DESC, m.id DESC LIMIT ${Math.max(1, Math.min(100, q.limit))}`,
    )
    .all(...args)
}

export interface AdminLog {
  /** Read the log of every chat that is due (or all with `force`). */
  runDue(force?: boolean): Promise<void>
  /** Read the log of one chat now (not waiting for the interval); a flood park is respected. */
  pollChat(chatId: string): Promise<AdminLogPoll>
  start(tickMs?: number): void
  stop(): Promise<void>
}

const big = (id: string): bigint => {
  try {
    return BigInt(id)
  } catch {
    return 0n
  }
}

/** One line a person or a model can read. */
export function eventText(e: TgAdminEvent): string {
  const actor = e.actor === undefined ? 'someone' : e.actor.name
  const target = e.target === undefined ? '' : ` ${e.target.name}`
  switch (e.kind) {
    case 'delete':
      return `[admin log] ${actor} deleted message ${e.messageId ?? '?'}${e.text === undefined ? '' : `: "${e.text}"`}`
    case 'edit':
      return `[admin log] ${actor} edited message ${e.messageId ?? '?'}${e.previousText === undefined ? '' : ` (was: "${e.previousText}")`}${e.text === undefined ? '' : ` (now: "${e.text}")`}`
    default:
      return `[admin log] ${actor} ${e.kind}${target}${e.detail === undefined ? '' : `: ${e.detail}`}`
  }
}

export function createAdminLog(options: AdminLogOptions): AdminLog {
  const { connectionId, client, chats, hooks } = options
  const now = options.now ?? (() => Date.now())
  const random = options.random ?? Math.random
  const sleep = options.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)))
  const pageSize = options.pageSize ?? 100
  const maxPages = options.maxPages ?? 5
  const warn = hooks.warn ?? ((m) => console.warn(`team: ${m}`))
  let stopped = false
  let timer: ReturnType<typeof setInterval> | undefined
  let running: Promise<void> | undefined

  async function readChat(chatId: string): Promise<AdminLogPoll> {
    const chat = chats.get(connectionId, chatId)
    if (chat === undefined) return { status: 'not-chosen', text: 'That chat is not known.' }
    const lastId = chat.adminLogLastId
    let newest = lastId
    let maxId: string | undefined
    let added = 0
    try {
      for (let page = 0; page < maxPages; page++) {
        const events = await client.adminLog(chatId, {
          ...(lastId === undefined ? {} : { minId: lastId }),
          ...(maxId === undefined ? {} : { maxId }),
          limit: pageSize,
        })
        if (events.length === 0) break
        // oldest first, so a crash in the middle never skips an older event
        for (const e of [...events].sort((a, b) => (big(a.id) < big(b.id) ? -1 : 1))) {
          if (await options.record(chatId, e)) added++
          if (newest === undefined || big(e.id) > big(newest)) newest = e.id
        }
        if (events.length < pageSize) break
        maxId = events.reduce(
          (m, e) => (big(e.id) < big(m) ? e.id : m),
          (events[0] as TgAdminEvent).id,
        )
        await sleep(1000 + Math.floor(random() * 2000))
      }
      chats.patchAdminLog(
        connectionId,
        chatId,
        {
          lastAt: now(),
          ...(newest === undefined ? {} : { lastId: newest }),
          addCount: added,
          error: null,
        },
        now(),
      )
      return { status: 'ok' }
    } catch (error) {
      const k = classifyError(error)
      if (k.kind === 'flood') {
        const until = now() + k.seconds * 1000 + 1000 + Math.floor(random() * 4000)
        chats.setParked(connectionId, chatId, until, now())
        hooks.onPark(chatId, until, k.text)
        chats.patchAdminLog(
          connectionId,
          chatId,
          { addCount: added, error: describeError(k) },
          now(),
        )
        return { status: 'parked', parkedUntil: until, text: describeError(k) }
      }
      if (k.kind === 'auth-lost' || k.kind === 'duplicated' || k.kind === 'peer-flood') {
        hooks.onFatal({ kind: k.kind, text: k.text })
        return { status: 'error', text: describeError(k) }
      }
      {
        // not an admin (any more), a private channel, ...: show it, try again next round
        const text =
          k.kind === 'invalid' && k.text.startsWith('CHAT_ADMIN_REQUIRED')
            ? 'The account is not an admin of this chat (or lacks the right to see the admin log).'
            : describeError(k)
        chats.patchAdminLog(
          connectionId,
          chatId,
          { lastAt: now(), addCount: added, error: text },
          now(),
        )
        return {
          status:
            k.kind === 'invalid' && k.text.startsWith('CHAT_ADMIN_REQUIRED')
              ? 'not-admin'
              : 'error',
          text,
        }
      }
    }
  }

  async function pollChat(chatId: string): Promise<AdminLogPoll> {
    const c = chats.get(connectionId, chatId)
    if (c === undefined || c.kind === 'dm' || !options.allowed(chatId)) {
      return { status: 'not-chosen', text: 'That chat is not chosen for ingest.' }
    }
    if (!c.admin) {
      return {
        status: 'not-admin',
        text: 'The account is not an admin of this chat: Telegram only shows the admin log to admins.',
      }
    }
    if (!c.adminLogEnabled) {
      return { status: 'off', text: 'Reading the admin log is turned off for this chat.' }
    }
    if (c.parkedUntil !== undefined && c.parkedUntil > now()) {
      return {
        status: 'parked',
        parkedUntil: c.parkedUntil,
        text: 'This chat is paused by a Telegram flood wait.',
      }
    }
    return readChat(chatId)
  }

  async function runDue(force = false): Promise<void> {
    if (running !== undefined) return running
    running = (async () => {
      const every = options.everyMs()
      for (const c of chats.selected(connectionId)) {
        if (stopped) return
        if (!c.adminLogEnabled || !c.admin || c.kind === 'dm') continue
        if (!options.allowed(c.chatId)) continue
        if (c.parkedUntil !== undefined && c.parkedUntil > now()) continue
        if (!force && c.adminLogLastAt !== undefined && now() - c.adminLogLastAt < every) continue
        await readChat(c.chatId)
      }
    })().finally(() => {
      running = undefined
    })
    return running
  }

  return {
    runDue,
    pollChat,
    start(tickMs = 60_000) {
      if (timer !== undefined) return
      const tick = (): void => {
        void runDue().catch((e) =>
          warn(`telegram-user: admin log of ${connectionId}: ${String(e)}`),
        )
      }
      timer = setInterval(tick, tickMs)
      ;(timer as { unref?: () => void }).unref?.()
      tick()
    },
    async stop() {
      stopped = true
      if (timer !== undefined) clearInterval(timer)
      timer = undefined
      await running?.catch(() => undefined)
    },
  }
}
