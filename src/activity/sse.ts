/**
 * Server-sent events over an {@link ActivityStore}: an encoder, a `ReadableStream` that tails the
 * store, and a framework-neutral request handler. Web APIs only (runs on Node and Bun).
 *
 * Wire format (spec 25 §4): `retry` + a `: connected` comment + `event: boot` first; then one
 * frame per record (`id: <seq>`, `event: <type>`, `data: <record JSON>`); `: keep-alive` comments
 * while quiet; `event: resync` when the cursor is outside what the store still holds.
 *
 * @see docs/specs/25-activity.md#4-sse
 */
import type { ActivityRecord, ActivityStore } from './types.ts'

const encoder = new TextEncoder()

/** One SSE frame of a record. */
export function encodeActivityEvent(record: ActivityRecord): string {
  const type = record.type.replace(/[\r\n]/g, ' ')
  return `id: ${record.seq}\nevent: ${type}\ndata: ${JSON.stringify(record)}\n\n`
}

/** Options of {@link activityStream}. */
export interface ActivityStreamOptions {
  store: ActivityStore
  /**
   * Resume cursor (the last `seq` the client saw). Undefined = start at the current head (new
   * events only, no resync check).
   */
  after?: number | undefined
  /** Only records this returns true for are sent (the cursor still advances over the others). */
  filter?: (record: ActivityRecord) => boolean
  /** Id of this server process, sent in the `boot` event: a changed id tells a client the server restarted. */
  bootId?: string
  /** Store poll interval in ms. Default 500. */
  pollMs?: number
  /** A comment frame after this many quiet ms. Default 15 000. */
  keepAliveMs?: number
  /** Reconnect delay hint (`retry:` field) in ms. Default 3000. */
  retryMs?: number
  /** Records per store read. Default 200. */
  batch?: number
  /** Ends the stream. */
  signal?: AbortSignal
  /** Called with a store failure; the stream ends. */
  onError?: (error: unknown) => void
}

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const timer = setTimeout(done, ms)
    function done(): void {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done, { once: true })
  })

/**
 * A byte stream of SSE frames that tails `store`. The first frame is written before the first
 * store read, so proxies and `fetch()` see the response at once.
 */
export function activityStream(options: ActivityStreamOptions): ReadableStream<Uint8Array> {
  const { store } = options
  const pollMs = options.pollMs ?? 500
  const keepAliveMs = options.keepAliveMs ?? 15_000
  const batch = options.batch ?? 200
  const internal = new AbortController()
  const onOuterAbort = (): void => internal.abort()
  if (options.signal?.aborted === true) internal.abort()
  else options.signal?.addEventListener('abort', onOuterAbort, { once: true })

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const write = (text: string): void => {
        if (!internal.signal.aborted) controller.enqueue(encoder.encode(text))
      }
      try {
        write(
          `retry: ${options.retryMs ?? 3000}\n: connected\n` +
            (options.bootId === undefined
              ? ''
              : `event: boot\ndata: ${JSON.stringify({ boot: options.bootId })}\n\n`),
        )
        const head = await store.lastSeq()
        let cursor = options.after ?? head
        if (options.after !== undefined && options.after > 0) {
          const pruned = await store.prunedThrough()
          // below the retention mark, or ahead of the head (the log was reset): events were missed
          if (options.after < pruned || options.after > head) {
            const seq = options.after > head ? head : pruned
            write(`event: resync\ndata: ${JSON.stringify({ seq })}\n\n`)
            cursor = seq
          }
        }
        let quiet = 0
        while (!internal.signal.aborted) {
          const records = await store.read({ after: cursor, limit: batch })
          for (const record of records) {
            cursor = record.seq
            if (options.filter === undefined || options.filter(record)) {
              write(encodeActivityEvent(record))
              quiet = 0
            }
          }
          if (records.length >= batch) continue // more is waiting: no sleep
          quiet += pollMs
          if (quiet >= keepAliveMs) {
            write(': keep-alive\n\n')
            quiet = 0
          }
          await sleep(pollMs, internal.signal)
        }
      } catch (error) {
        if (!internal.signal.aborted) options.onError?.(error)
      } finally {
        options.signal?.removeEventListener('abort', onOuterAbort)
        internal.abort()
        try {
          controller.close()
        } catch {
          // already closed by cancel()
        }
      }
    },
    cancel() {
      internal.abort()
    },
  })
}

/** Options of {@link handleActivityStream}. */
export interface ActivityStreamHandlerOptions
  extends Omit<ActivityStreamOptions, 'after' | 'signal'> {
  /** Extra headers of the response. */
  headers?: HeadersInit
}

const CURSOR = /^\d{1,15}$/

/** The cursor of a request: `?after=` wins over `Last-Event-ID`. `undefined` = none; `null` = invalid. */
export function activityCursor(request: Request): number | undefined | null {
  const query = new URL(request.url).searchParams.get('after')
  const raw = query ?? request.headers.get('last-event-id') ?? undefined
  if (raw === undefined || raw === '') return undefined
  return CURSOR.test(raw) ? Number(raw) : null
}

/**
 * Serve the feed as an SSE `Response` for any framework that speaks `Request`/`Response`. The
 * cursor comes from `?after=` or `Last-Event-ID`; an invalid one is a `400`. The stream ends when
 * the request aborts. Authentication is the caller's: check it before calling.
 *
 * @example
 * ```ts
 * app.get('/events/stream', (c) => handleActivityStream(c.req.raw, { store, bootId }))
 * ```
 */
export function handleActivityStream(
  request: Request,
  options: ActivityStreamHandlerOptions,
): Response {
  const after = activityCursor(request)
  if (after === null) {
    return new Response(JSON.stringify({ error: 'after must be a non-negative integer' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    })
  }
  const { headers, ...rest } = options
  const body = activityStream({ ...rest, after, signal: request.signal })
  const out = new Headers(headers)
  out.set('content-type', 'text/event-stream; charset=utf-8')
  out.set('cache-control', 'no-cache, no-transform')
  out.set('connection', 'keep-alive')
  out.set('x-accel-buffering', 'no')
  return new Response(body, { status: 200, headers: out })
}

/** A page of the feed for polling clients (the JSON twin of the stream). */
export interface ActivityPage {
  events: ActivityRecord[]
  /** Cursor for the next call: the last `seq` returned, else the current head (never below `after`). */
  lastSeq: number
  /** `after` is outside what the store holds: events were missed, refetch the state. */
  resync?: true
}

/** Read a page after `after` (the cursor `0` never resyncs). */
export async function readActivityPage(
  store: ActivityStore,
  query: { after: number; limit: number; filter?: (record: ActivityRecord) => boolean },
): Promise<ActivityPage> {
  const [pruned, head] = await Promise.all([store.prunedThrough(), store.lastSeq()])
  const resync = query.after > 0 && (query.after < pruned || query.after > head)
  const read = await store.read({ after: query.after, limit: query.limit })
  return {
    events: query.filter === undefined ? read : read.filter(query.filter),
    lastSeq: read.at(-1)?.seq ?? Math.max(query.after, head),
    ...(resync ? { resync: true as const } : {}),
  }
}
