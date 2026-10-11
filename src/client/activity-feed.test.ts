import { describe, expect, test } from 'bun:test'
import type { ActivityRecord } from '../activity/index.ts'
import {
  type ActivityFeed,
  createActivityFeed,
  type FeedStatus,
  type ResyncReason,
} from './activity-feed.ts'
import type { Clock } from './clock.ts'
import { createHarnessClient } from './http-client.ts'

const ev = (seq: number, type = 'message-saved'): ActivityRecord => ({
  seq,
  type,
  agentId: 'a',
  sessionId: null,
  payload: {},
  createdAt: 1,
})
const frame = (e: ActivityRecord): string =>
  `id: ${e.seq}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`
const sse = (text: string): Response => {
  const enc = new TextEncoder()
  return new Response(
    new ReadableStream({
      start(c) {
        c.enqueue(enc.encode(text))
        c.close()
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  )
}
const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status })

interface Call {
  url: string
  headers: Record<string, string>
}

/** A fake clock whose sleeps resolve at once; `onSleep` can stop the feed. */
const quick = (onSleep?: () => void): Partial<Clock> => ({
  sleep: async () => {
    await Promise.resolve()
    onSleep?.()
  },
})

/** Run until the feed is stopped (by `stopAfter` calls), sleeps resolved immediately. */
async function drive(
  handler: (url: string, n: number) => Response | Promise<Response>,
  stopAfter: number,
) {
  const calls: Call[] = []
  const events: ActivityRecord[] = []
  const status: FeedStatus[] = []
  const reasons: ResyncReason[] = []
  let feed!: ActivityFeed
  const client = createHarnessClient({
    baseUrl: '/api/',
    headers: { authorization: 'Bearer tok' },
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), headers: Object.fromEntries(new Headers(init?.headers)) })
      return handler(String(input), calls.length)
    }) as typeof fetch,
  })
  feed = createActivityFeed({
    client,
    onEvent: (e) => events.push(e),
    onResync: (r) => reasons.push(r),
    clock: quick(() => {
      if (calls.length >= stopAfter) feed.stop()
    }),
  })
  feed.subscribe((s) => {
    if (status.at(-1) !== s.status) status.push(s.status)
  })
  feed.start()
  for (let i = 0; i < 200 && status.at(-1) !== 'stopped'; i++)
    await new Promise((r) => setTimeout(r, 1))
  return { calls, events, status, reasons, feed }
}

describe('activity feed', () => {
  test('streams with headers, resumes with Last-Event-ID after the stream ends, dedups replays', async () => {
    const r = await drive(
      (_url, n) => (n === 1 ? sse(frame(ev(1)) + frame(ev(2))) : sse(frame(ev(2)) + frame(ev(3)))),
      2,
    )
    expect(r.events.map((e) => e.seq)).toEqual([1, 2, 3])
    expect(r.calls[0]?.url).toBe('/api/activity/stream')
    expect(r.calls[0]?.headers.authorization).toBe('Bearer tok')
    expect(r.calls[1]?.url).toBe('/api/activity/stream?after=2')
    expect(r.calls[1]?.headers['last-event-id']).toBe('2')
    expect(r.reasons).toEqual(['connect', 'connect'])
    expect(r.feed.get().lastSeq).toBe(3)
  })

  test('falls back to polling when the stream fails, then recovers', async () => {
    const r = await drive((url, n) => {
      if (url.includes('/activity/stream')) return n >= 5 ? sse(frame(ev(9))) : json({}, 503)
      if (url.includes('after=0')) return json({ events: [ev(1)], lastSeq: 1 })
      return json({ events: [ev(2), ev(3)], lastSeq: 3 })
    }, 5)
    // first poll (no cursor yet) only finds the head; the next one delivers
    expect(r.status).toContain('polling')
    expect(r.events.map((e) => e.seq)).toEqual([2, 3, 9])
    expect(r.calls.some((c) => c.url.startsWith('/api/activity?after=1'))).toBe(true)
    expect(r.status).toContain('live')
  })

  test('an unreachable server never throws and ends in stopped on stop()', async () => {
    const r = await drive(() => {
      throw new Error('offline')
    }, 4)
    expect(r.events).toEqual([])
    expect(r.status.at(-1)).toBe('stopped')
  })

  test('a resync frame refetches state and moves the cursor to the mark the server named', async () => {
    const resyncFrame = 'event: resync\ndata: {"seq":40}\n\n'
    const r = await drive((_url, n) => (n === 1 ? sse(resyncFrame + frame(ev(41))) : sse('')), 2)
    expect(r.events.map((e) => e.seq)).toEqual([41])
    expect(r.reasons).toEqual(['connect', 'resync-event', 'connect'])
    expect(r.calls[1]?.url).toBe('/api/activity/stream?after=41')
  })

  test('a resync below the cursor (the log was reset) lets new events through', async () => {
    const r = await drive(
      (_url, n) =>
        n === 1 ? sse(frame(ev(50))) : sse(`event: resync\ndata: {"seq":3}\n\n${frame(ev(4))}`),
      2,
    )
    expect(r.events.map((e) => e.seq)).toEqual([50, 4])
  })

  test('a poll page flagged resync reports a poll gap', async () => {
    const r = await drive((url, n) => {
      if (url.includes('/activity/stream'))
        return n === 1 ? sse(frame(ev(5))) : new Response('no', { status: 500 })
      return json({ events: [ev(9)], lastSeq: 9, resync: true })
    }, 4)
    expect(r.events.map((e) => e.seq)).toEqual([5, 9])
    expect(r.reasons).toContain('poll-gap')
  })

  test('initialAfter is sent on the first connect', async () => {
    const calls: string[] = []
    const client = createHarnessClient({
      baseUrl: '/api',
      fetch: (async (input: RequestInfo | URL) => {
        calls.push(String(input))
        return sse('')
      }) as typeof fetch,
    })
    const feed = createActivityFeed({ client, initialAfter: 12, clock: quick(() => feed.stop()) })
    feed.start()
    for (let i = 0; i < 50 && calls.length < 1; i++) await new Promise((r) => setTimeout(r, 1))
    feed.stop()
    expect(calls[0]).toBe('/api/activity/stream?after=12')
  })
})

describe('idle watchdog', () => {
  test('a connection that goes silent is dropped and the feed reconnects and resyncs', async () => {
    const urls: string[] = []
    let resyncs = 0
    const client = createHarnessClient({
      baseUrl: '/api',
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        urls.push(String(input))
        if (!String(input).includes('/activity/stream')) return json({ events: [], lastSeq: 0 })
        return new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(new TextEncoder().encode(': connected\n\n'))
              init?.signal?.addEventListener('abort', () => c.error(new Error('aborted')), {
                once: true,
              })
            },
          }),
          { status: 200 },
        )
      }) as typeof fetch,
    })
    const feed = createActivityFeed({
      client,
      idleMs: 30,
      backoff: [5],
      onResync: () => resyncs++,
      clock: { sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))) },
    })
    feed.start()
    const end = Date.now() + 2000
    while (urls.filter((u) => u.includes('/activity/stream')).length < 2 && Date.now() < end) {
      await new Promise((r) => setTimeout(r, 10))
    }
    feed.stop()
    expect(urls.filter((u) => u.includes('/activity/stream')).length).toBeGreaterThanOrEqual(2)
    expect(resyncs).toBeGreaterThanOrEqual(2)
  })
})

describe('activity feed: restart detection', () => {
  const open = (signal: AbortSignal, head = ': connected\n\n'): Response => {
    const enc = new TextEncoder()
    return new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(enc.encode(head))
          signal.addEventListener(
            'abort',
            () => c.error(new DOMException('aborted', 'AbortError')),
            {
              once: true,
            },
          )
        },
      }),
      { status: 200 },
    )
  }
  const until = async (f: () => boolean): Promise<void> => {
    for (let i = 0; i < 300 && !f(); i++) await new Promise((r) => setTimeout(r, 2))
  }

  function make(health: () => Promise<{ boot?: string }>) {
    let streams = 0
    const reasons: ResyncReason[] = []
    const boots: Array<[string, boolean]> = []
    const client = createHarnessClient({
      baseUrl: '/api',
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).endsWith('/health')) return json({ ok: true, ...(await health()) })
        streams++
        return open(init?.signal as AbortSignal)
      }) as typeof fetch,
    })
    const feed = createActivityFeed({
      client,
      onResync: (r) => reasons.push(r),
      onBoot: (id, restarted) => boots.push([id, restarted]),
      tickMs: 0,
      clock: { sleep: () => new Promise(() => {}) }, // only a wake ends a backoff
    })
    return { feed, streams: () => streams, reasons, boots }
  }

  test('a changed boot id reconnects at once and resyncs; the same id does nothing', async () => {
    let boot = 'a'
    const t = make(async () => ({ boot }))
    t.feed.start()
    await until(() => t.streams() === 1)
    await t.feed.check()
    expect(t.streams()).toBe(1)
    boot = 'b'
    await t.feed.check()
    await until(() => t.streams() === 2)
    expect(t.streams()).toBe(2)
    expect(t.reasons).toEqual(['connect', 'boot-changed'])
    expect(t.boots).toEqual([
      ['a', false],
      ['b', true],
    ])
    expect(t.feed.get().boot).toBe('b')
    t.feed.stop()
  })

  test('a failed ping drops a live stream and reconnects', async () => {
    let down = false
    const t = make(async () => {
      if (down) throw new Error('down')
      return { boot: 'a' }
    })
    t.feed.start()
    await until(() => t.streams() === 1)
    down = true
    await t.feed.check()
    await until(() => t.streams() === 2)
    expect(t.streams()).toBe(2)
    t.feed.stop()
  })
})

describe('activity feed: lifecycle', () => {
  test('starts with the first subscriber and stops one grace period after the last', async () => {
    let streams = 0
    const timers: Array<() => void> = []
    const client = createHarnessClient({
      baseUrl: '/api',
      fetch: (async (_i: RequestInfo | URL, init?: RequestInit) => {
        streams++
        return new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(new TextEncoder().encode(': connected\n\n'))
              init?.signal?.addEventListener('abort', () => c.error(new Error('aborted')), {
                once: true,
              })
            },
          }),
          { status: 200 },
        )
      }) as typeof fetch,
    })
    const feed = createActivityFeed({
      client,
      tickMs: 0,
      clock: {
        setTimeout: (fn) => {
          timers.push(fn)
          return timers.length
        },
        clearTimeout: () => {},
        sleep: () => new Promise(() => {}),
      },
    })
    expect(feed.get().status).toBe('idle')
    const off = feed.subscribe(() => {})
    for (let i = 0; i < 50 && streams < 1; i++) await new Promise((r) => setTimeout(r, 1))
    expect(streams).toBe(1)
    off()
    expect(feed.get().status).not.toBe('stopped')
    // the grace timer is the first store timer; the idle watchdog timers come from the same clock
    for (const fn of timers.splice(0)) fn()
    for (let i = 0; i < 50 && feed.get().status !== 'stopped'; i++) {
      await new Promise((r) => setTimeout(r, 1))
      for (const fn of timers.splice(0)) fn()
    }
    expect(feed.get().status).toBe('stopped')
  })
})
