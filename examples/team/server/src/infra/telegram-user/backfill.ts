/**
 * Backfill and gap fill of a Telegram user account (P41 L4).
 *
 * - **Backfill**: per chat with a window of N days, newest first, 100 messages a page with a
 *   1 to 3 s pause, one chat at a time per account. The cursor (lowest id reached) is persisted
 *   after every page, so a restart resumes where it stopped. It starts below the first live id,
 *   so the live stream and the backfill never overlap; both write idempotently (the log keeps
 *   one row per message id).
 * - **Gap fill**: after the client was down, messages of the chosen chats newer than the highest
 *   id stored are read once (newest first, bounded). They are stored, never answered.
 * - A FLOOD_WAIT parks that chat (resume at now + X + jitter) and the other chats continue. A
 *   storm of floods pauses the whole job runner and raises an alert.
 *
 * It only ever reads history. It never marks anything as read.
 */

import type { UserFatal } from './adapter.ts'
import type { TgMessage, TgUserClient } from './client.ts'
import { classifyError, describeError } from './errors.ts'
import type { ChatStore } from './store.ts'

export interface JobHooks {
  onFatal(fatal: UserFatal): void
  /** A flood wait parked a chat (also tells the adapter, which refuses sends meanwhile). */
  onPark(chatId: string, until: number, text: string): void
  /** Too many floods: the whole runner is paused until `until`. */
  onStorm(until: number, text: string): void
  warn?(message: string): void
}

export interface BackfillOptions {
  connectionId: string
  client: TgUserClient
  chats: ChatStore
  /** Store one history message; false when it was already stored or not wanted. Never wakes an agent. */
  ingest(message: TgMessage): Promise<boolean>
  /** Is the chat in the gateway allowlist (a chat that is not is never read). */
  allowed(chatId: string): boolean
  hooks: JobHooks
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  random?: () => number
  pageSize?: number
  /** Pause between two pages (ms; default 1000 to 3000). */
  pageDelayMs?: { min: number; max: number }
  /** Longest the gap fill looks back (ms, default 7 days). */
  gapWindowMs?: number
  /** Most pages of one gap fill (default 20). */
  gapMaxPages?: number
  /** Floods within the window that pause the runner (default 3 in 1 hour; pause 1 hour). */
  stormAfter?: { count: number; windowMs: number; pauseMs: number }
}

export interface Backfill {
  /** Queue the gap fill of every chosen chat (once per start). */
  queueGapFill(): void
  /** Process jobs until nothing is runnable now (tests, and what the loop calls). */
  runUntilIdle(): Promise<void>
  /** Start the background loop. */
  start(everyMs?: number): void
  stop(): Promise<void>
  /** The runner is paused by a flood storm until this time. */
  pausedUntil(): number | undefined
}

const DAY = 86_400_000

export function createBackfill(options: BackfillOptions): Backfill {
  const { connectionId, client, chats, hooks } = options
  const now = options.now ?? (() => Date.now())
  const sleep = options.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)))
  const random = options.random ?? Math.random
  const pageSize = options.pageSize ?? 100
  const delay = options.pageDelayMs ?? { min: 1000, max: 3000 }
  const gapWindow = options.gapWindowMs ?? 7 * DAY
  const gapMaxPages = options.gapMaxPages ?? 20
  const storm = options.stormAfter ?? { count: 3, windowMs: 3_600_000, pauseMs: 3_600_000 }
  const warn = hooks.warn ?? ((m) => console.warn(`team: ${m}`))

  const gaps = new Set<string>()
  const floods: number[] = []
  let paused = 0
  let stopped = false
  let timer: ReturnType<typeof setInterval> | undefined
  let running: Promise<void> | undefined

  const pause = (): number => delay.min + Math.floor(random() * Math.max(0, delay.max - delay.min))

  /** Park a chat after a flood; returns true when this was the storm that pauses the runner. */
  function flooded(chatId: string, seconds: number, text: string): void {
    const until = now() + seconds * 1000 + 1000 + Math.floor(random() * 4000)
    chats.setParked(connectionId, chatId, until, now())
    hooks.onPark(chatId, until, text)
    floods.push(now())
    while (floods.length > 0 && (floods[0] as number) < now() - storm.windowMs) floods.shift()
    if (floods.length >= storm.count) {
      paused = now() + storm.pauseMs
      floods.length = 0
      hooks.onStorm(
        paused,
        `${storm.count} flood waits within ${Math.round(storm.windowMs / 60_000)} minutes`,
      )
    }
  }

  /** Handle an error of a job on `chatId`; returns what the chat's job state becomes. */
  function failed(chatId: string, error: unknown): { state: 'parked' | 'error'; message: string } {
    const k = classifyError(error)
    switch (k.kind) {
      case 'flood':
        flooded(chatId, k.seconds, k.text)
        return { state: 'parked', message: describeError(k) }
      case 'auth-lost':
      case 'duplicated':
      case 'peer-flood':
        hooks.onFatal({ kind: k.kind, text: k.text })
        return { state: 'error', message: describeError(k) }
      case 'invalid':
        return { state: 'error', message: describeError(k) }
      default: {
        // a glitch: look again in a few minutes
        chats.setParked(connectionId, chatId, now() + 300_000, now())
        return { state: 'parked', message: describeError(k) }
      }
    }
  }

  const parked = (chatId: string): boolean => {
    const t = chats.get(connectionId, chatId)?.parkedUntil
    return t !== undefined && t > now()
  }

  /** One page of the window backfill of `chatId`. Returns true when more remain. */
  async function backfillPage(chatId: string): Promise<boolean> {
    const chat = chats.get(connectionId, chatId)
    if (chat === undefined || chat.backfillDays === undefined) return false
    const cutoff = now() - chat.backfillDays * DAY
    const offsetId = chat.backfillOldestId ?? chat.firstLiveId
    chats.patchBackfill(connectionId, chatId, { state: 'running', error: null }, now())
    let page: TgMessage[]
    try {
      page = await client.history(chatId, {
        limit: pageSize,
        ...(offsetId === undefined ? {} : { offsetId }),
      })
    } catch (error) {
      const f = failed(chatId, error)
      chats.patchBackfill(connectionId, chatId, { state: f.state, error: f.message }, now())
      return false
    }
    let added = 0
    let reached = false
    let oldest: TgMessage | undefined
    for (const m of page) {
      if (m.at < cutoff) {
        reached = true
        break
      }
      oldest = m
      if (m.service) continue
      if (await options.ingest(m)) added++
      chats.noteMessage(connectionId, chatId, m.id, false)
    }
    const last = page.at(-1)
    const done = page.length === 0 || reached || page.length < pageSize
    chats.patchBackfill(
      connectionId,
      chatId,
      {
        state: done ? 'done' : 'running',
        ...(oldest === undefined ? {} : { oldestId: oldest.id, oldestAt: oldest.at }),
        // an empty tail still moves the cursor so a restart does not repeat the page
        ...(oldest === undefined && last !== undefined ? { oldestId: last.id } : {}),
        addCount: added,
      },
      now(),
    )
    return !done
  }

  /** The gap fill of one chat: newest first until the highest id we already had. */
  async function gapFill(chatId: string): Promise<void> {
    const chat = chats.get(connectionId, chatId)
    const high = chat?.highId
    if (chat === undefined || high === undefined) return
    const cutoff = now() - gapWindow
    let offsetId: number | undefined
    for (let page = 0; page < gapMaxPages; page++) {
      let list: TgMessage[]
      try {
        list = await client.history(chatId, {
          limit: pageSize,
          ...(offsetId === undefined ? {} : { offsetId }),
        })
      } catch (error) {
        failed(chatId, error)
        gaps.add(chatId) // try again when the park ends
        return
      }
      let stop = list.length < pageSize
      for (const m of list) {
        if (m.id <= high || m.at < cutoff) {
          stop = true
          break
        }
        if (m.service) continue
        await options.ingest(m)
        chats.noteMessage(connectionId, chatId, m.id, false)
      }
      if (stop) return
      offsetId = list.at(-1)?.id
      await sleep(pause())
    }
  }

  async function runUntilIdle(): Promise<void> {
    if (running !== undefined) return running
    running = (async () => {
      for (;;) {
        if (stopped || paused > now()) return
        let worked = false
        for (const chatId of [...gaps]) {
          if (!chats.isSelected(connectionId, chatId) || !options.allowed(chatId)) {
            gaps.delete(chatId)
            continue
          }
          if (parked(chatId)) continue
          gaps.delete(chatId)
          await gapFill(chatId)
          worked = true
          if (stopped) return
          await sleep(pause())
        }
        const next = chats
          .selected(connectionId)
          .find(
            (c) =>
              c.backfillDays !== undefined &&
              (c.backfillState === 'queued' ||
                c.backfillState === 'running' ||
                c.backfillState === 'parked') &&
              !parked(c.chatId) &&
              options.allowed(c.chatId),
          )
        if (next !== undefined) {
          const more = await backfillPage(next.chatId)
          worked = true
          if (more) await sleep(pause())
        }
        if (!worked) return
      }
    })().finally(() => {
      running = undefined
    })
    return running
  }

  return {
    queueGapFill() {
      for (const c of chats.selected(connectionId)) if (c.highId !== undefined) gaps.add(c.chatId)
    },
    runUntilIdle,
    start(everyMs = 30_000) {
      if (timer !== undefined) return
      const tick = (): void => {
        void runUntilIdle().catch((e) =>
          warn(`telegram-user: backfill of ${connectionId}: ${String(e)}`),
        )
      }
      timer = setInterval(tick, everyMs)
      ;(timer as { unref?: () => void }).unref?.()
      tick()
    },
    async stop() {
      stopped = true
      if (timer !== undefined) clearInterval(timer)
      timer = undefined
      await running?.catch(() => undefined)
    },
    pausedUntil: () => (paused > now() ? paused : undefined),
  }
}
