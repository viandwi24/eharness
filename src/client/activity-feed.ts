/**
 * `createActivityFeed`: one fetch-based SSE reader of `GET /activity/stream` with reconnect and
 * `Last-Event-ID`, a polling fallback (`GET /activity`) while the stream is down, an idle
 * watchdog, `/health` pings that catch a restarted server (new boot id), and dedupe by `seq`.
 * The state is a {@link Store}: the feed starts with the first subscriber and stops one second
 * after the last one left (or use `start()` / `stop()`).
 *
 * @see docs/specs/27-client.md#4-activity-feed
 */
import type { ActivityPage, ActivityRecord } from '../activity/index.ts'
import { type Clock, sleepOf, systemClock } from './clock.ts'
import type { HarnessClient } from './http-client.ts'
import { BACKOFF_MS, backoffDelay, createLiveness, GRACE_MS, KEEP_ALIVE_MS } from './liveness.ts'
import { createSseParser } from './sse.ts'
import { createStore, type Store } from './store.ts'

/** Connection status of the feed. */
export type FeedStatus = 'idle' | 'connecting' | 'live' | 'polling' | 'stopped'

/** Why state should be refetched. */
export type ResyncReason = 'connect' | 'resync-event' | 'boot-changed' | 'poll-gap'

/** The observable state of an {@link ActivityFeed}. */
export interface ActivityFeedState {
  status: FeedStatus
  /** Highest `seq` delivered, or `null` before the first event. */
  lastSeq: number | null
  /** Boot id of the server, when known. */
  boot: string | null
}

/** Options of {@link createActivityFeed}. */
export interface ActivityFeedOptions {
  client: HarnessClient
  /** Called for every new record (deduped by `seq`). */
  onEvent?: (record: ActivityRecord) => void
  /** State should be refetched: the stream (re)connected, or events were missed. */
  onResync?: (reason: ResyncReason) => void
  /** The boot id of the server became known; `restarted` when it changed. */
  onBoot?: (id: string, restarted: boolean) => void
  /** A listener threw. Default: ignored (a listener must not drop the connection). */
  onError?: (error: unknown) => void
  /** Start after this `seq` (e.g. persisted across reloads). */
  initialAfter?: number
  /** True while a chat or task runs: the feed then pings `/health` about every 5 s. */
  isBusy?: () => boolean
  /** Reconnect delays in ms (jittered, the last one repeats). Default 250 ms up to 5 s. */
  backoff?: readonly number[]
  /**
   * No bytes (not even the keep-alive comment, every 15 s) for this long: the connection is dead
   * without an error: drop it and reconnect. Default 20 s.
   */
  idleMs?: number
  /** Period of the health tick (ms). 0 disables it. Default 1000. */
  tickMs?: number
  clock?: Partial<Clock>
}

/** A running (or stopped) activity feed. */
export interface ActivityFeed extends Store<ActivityFeedState> {
  /** Start now (idempotent). Without it the feed starts with the first subscriber. */
  start(): void
  stop(): void
  /** Ping `/health` now (tab focus, network back): a failure or a new boot id reconnects at once. */
  check(): Promise<void>
  /** Add a listener for records; returns the remove function. */
  subscribeEvents(fn: (record: ActivityRecord) => void): () => void
  /** Add a listener for resyncs; returns the remove function. */
  subscribeResync(fn: (reason: ResyncReason) => void): () => void
}

const POLL_LIMIT = 200

/** Parse the `data` of an activity frame. */
export function parseActivityEvent(data: string): ActivityRecord | undefined {
  try {
    const e = JSON.parse(data) as Partial<ActivityRecord>
    if (e && typeof e.seq === 'number' && typeof e.type === 'string') {
      return { agentId: null, sessionId: null, payload: {}, createdAt: 0, ...e } as ActivityRecord
    }
  } catch {
    // ignore malformed frames
  }
  return undefined
}

/** Create the feed of one server. */
export function createActivityFeed(options: ActivityFeedOptions): ActivityFeed {
  const { client } = options
  const clock: Clock = { ...systemClock, ...options.clock }
  const sleep = sleepOf(clock)
  const steps = options.backoff?.length ? options.backoff : BACKOFF_MS
  const liveness = createLiveness()
  const eventListeners = new Set<(record: ActivityRecord) => void>()
  const resyncListeners = new Set<(reason: ResyncReason) => void>()

  let ctrl: AbortController | undefined
  let tick: unknown
  let kick: (() => void) | undefined // drop the current stream and reconnect now
  let wake: (() => void) | undefined // cut a backoff sleep short
  let kicked = false
  let pinging = false
  let nextReason: ResyncReason = 'connect'
  let explicit = false
  let auto = false
  let lastSeq: number | null = options.initialAfter ?? null

  const store = createStore<ActivityFeedState>(
    { status: 'idle', lastSeq, boot: null },
    {
      timers: clock,
      onActive: () => {
        if (ctrl !== undefined && !ctrl.signal.aborted) return
        auto = true
        begin()
      },
      onIdle: () => {
        if (auto && !explicit) end()
      },
    },
  )

  const setState = (changes: Partial<ActivityFeedState>): void => {
    const next = { ...store.get(), ...changes }
    const prev = store.get()
    if (next.status === prev.status && next.lastSeq === prev.lastSeq && next.boot === prev.boot) {
      return
    }
    store.set(next)
  }
  const report = (error: unknown): void => options.onError?.(error)
  const resync = (reason: ResyncReason): void => {
    try {
      options.onResync?.(reason)
    } catch (e) {
      report(e)
    }
    for (const fn of resyncListeners) {
      try {
        fn(reason)
      } catch (e) {
        report(e)
      }
    }
  }
  const deliver = (record: ActivityRecord): void => {
    if (lastSeq !== null && record.seq <= lastSeq) return // replay overlap
    lastSeq = record.seq
    setState({ lastSeq })
    try {
      options.onEvent?.(record)
    } catch (e) {
      report(e)
    }
    for (const fn of eventListeners) {
      try {
        fn(record)
      } catch (e) {
        report(e)
      }
    }
  }
  const noteBoot = (id: string): 'first' | 'same' | 'changed' => {
    const check = liveness.noteBoot(id)
    if (check !== 'same') {
      setState({ boot: id })
      try {
        options.onBoot?.(id, check === 'changed')
      } catch (e) {
        report(e)
      }
    }
    return check
  }
  const setStatus = (status: FeedStatus): void => setState({ status })

  async function readStream(signal: AbortSignal, arm: () => void): Promise<void> {
    const headers: Record<string, string> = { accept: 'text/event-stream' }
    const query = lastSeq === null ? undefined : { after: lastSeq }
    if (lastSeq !== null) headers['last-event-id'] = String(lastSeq)
    const response = await client.request(client.url('/activity/stream', query), {
      headers,
      signal,
    })
    if (!response.ok || !response.body) throw new Error(`activity stream ${response.status}`)
    arm()
    liveness.opened(clock.now())
    setStatus('live')
    const reason = nextReason
    nextReason = 'connect'
    resync(reason)
    const parser = createSseParser((m) => {
      if (m.event === 'boot') {
        try {
          const id = (JSON.parse(m.data) as { boot?: unknown }).boot
          if (typeof id === 'string') noteBoot(id) // the connect resync above ran against this server
        } catch {
          // malformed hint
        }
        return
      }
      if (m.event === 'resync') {
        // the cursor is outside what the server holds: refetch state, continue from its mark
        try {
          const seq = (JSON.parse(m.data) as { seq?: unknown }).seq
          if (typeof seq === 'number') {
            lastSeq = seq
            setState({ lastSeq })
          }
        } catch {
          // malformed hint
        }
        resync('resync-event')
        return
      }
      const record = parseActivityEvent(m.data)
      if (record !== undefined) deliver(record)
    })
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        arm()
        liveness.byte(clock.now())
        parser.push(decoder.decode(value, { stream: true }))
      }
    } finally {
      reader.releaseLock?.()
    }
  }

  async function stream(signal: AbortSignal): Promise<void> {
    // a silent connection is dropped by the watchdog below
    const inner = new AbortController()
    const onOuterAbort = (): void => inner.abort()
    signal.addEventListener('abort', onOuterAbort, { once: true })
    const idleMs = options.idleMs ?? KEEP_ALIVE_MS + GRACE_MS
    kick = () => inner.abort()
    let idle: unknown
    const arm = (): void => {
      if (idle !== undefined) clock.clearTimeout(idle)
      if (idleMs > 0) idle = clock.setTimeout(() => inner.abort(), idleMs)
    }
    arm()
    try {
      await readStream(inner.signal, arm)
    } finally {
      if (idle !== undefined) clock.clearTimeout(idle)
      kick = undefined
      liveness.closed()
      signal.removeEventListener('abort', onOuterAbort)
    }
  }

  async function pollPage(signal: AbortSignal, after: number): Promise<ActivityPage> {
    return await client.activity.page({ after, limit: POLL_LIMIT }, { signal })
  }

  async function poll(signal: AbortSignal): Promise<void> {
    if (lastSeq === null) {
      // first contact: page to the head without delivering (history is not news)
      let cursor = 0
      for (;;) {
        const page = await pollPage(signal, cursor)
        cursor = page.lastSeq
        if (page.events.length < POLL_LIMIT) break
      }
      lastSeq = cursor
      setState({ lastSeq })
      resync('connect')
      return
    }
    for (;;) {
      const page = await pollPage(signal, lastSeq)
      // events between our cursor and the retention mark are gone: refetch state
      if (page.resync) resync('poll-gap')
      for (const record of page.events) deliver(record)
      if (page.events.length < POLL_LIMIT) break
    }
  }

  async function run(signal: AbortSignal): Promise<void> {
    let failures = 0
    const pause = (ms: number): Promise<void> => {
      const w = new Promise<void>((r) => {
        wake = r
      })
      return Promise.race([sleep(ms, signal), w]).finally(() => {
        wake = undefined
      })
    }
    while (!signal.aborted) {
      setStatus(failures === 0 ? 'connecting' : store.get().status)
      try {
        await stream(signal)
        failures = 0 // clean close: reconnect right away (after a short pause)
        if (kicked) {
          kicked = false
          continue
        }
        await pause(backoffDelay(1, steps, clock.random))
        continue
      } catch {
        if (signal.aborted) break
        if (kicked) {
          // dropped on purpose (new boot, failed ping, stale): reconnect without waiting
          kicked = false
          failures = 0
          continue
        }
      }
      failures++
      setStatus('polling')
      try {
        await poll(signal)
      } catch {
        // still down; keep going
      }
      await pause(backoffDelay(failures, steps, clock.random))
    }
  }

  const reconnectNow = (reason: ResyncReason): void => {
    nextReason = reason
    if (kick) {
      kicked = true
      kick()
    } else wake?.() // already down: do not wait out the backoff
  }

  async function check(): Promise<void> {
    const active = ctrl
    if (pinging || active === undefined || active.signal.aborted) return
    pinging = true
    liveness.pinged(clock.now())
    const timeout = new AbortController()
    const timer = clock.setTimeout(() => timeout.abort(), 4000)
    try {
      const health = await client.health({ signal: timeout.signal })
      if (active.signal.aborted) return
      if (typeof health.boot === 'string' && noteBoot(health.boot) === 'changed') {
        return reconnectNow('boot-changed')
      }
      // it answers but the stream is stale or down
      if (liveness.health(clock.now()) !== 'connected') reconnectNow('connect')
    } catch {
      // up on paper, dead in fact
      if (!active.signal.aborted && store.get().status === 'live') reconnectNow('connect')
    } finally {
      clock.clearTimeout(timer)
      pinging = false
    }
  }

  function begin(): void {
    if (ctrl !== undefined && !ctrl.signal.aborted) return
    ctrl = new AbortController()
    void run(ctrl.signal)
    const every = options.tickMs ?? 1000
    if (every > 0) {
      tick = clock.setInterval(() => {
        if (liveness.shouldPing(clock.now(), options.isBusy?.() ?? false)) void check()
      }, every)
    }
  }

  function end(): void {
    if (tick !== undefined) clock.clearInterval(tick)
    tick = undefined
    ctrl?.abort()
    setStatus('stopped')
  }

  return {
    subscribe: store.subscribe,
    get: store.get,
    start() {
      explicit = true
      begin()
    },
    stop() {
      explicit = false
      auto = false
      end()
    },
    check,
    subscribeEvents(fn) {
      eventListeners.add(fn)
      return () => eventListeners.delete(fn)
    },
    subscribeResync(fn) {
      resyncListeners.add(fn)
      return () => resyncListeners.delete(fn)
    },
  }
}
