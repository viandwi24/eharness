/**
 * Admin log polling (P41 L4). Telegram keeps the moderation log of a channel or supergroup for a
 * short time only (believed about 48 hours: verify with a real account), so for chats where the
 * account is an admin it is read every few hours and every event is stored (deletions with the
 * original text, edits, bans, promotions) into the channel log as event rows.
 */

import type { JobHooks } from './backfill.ts'
import type { TgAdminEvent, TgUserClient } from './client.ts'
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

export interface AdminLog {
  /** Read the log of every chat that is due (or all with `force`). */
  runDue(force?: boolean): Promise<void>
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

  async function readChat(chatId: string): Promise<void> {
    const chat = chats.get(connectionId, chatId)
    if (chat === undefined) return
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
      } else if (k.kind === 'auth-lost' || k.kind === 'duplicated' || k.kind === 'peer-flood') {
        hooks.onFatal({ kind: k.kind, text: k.text })
      } else {
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
      }
    }
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
