/**
 * Minimal Chrome DevTools Protocol client over one WebSocket (spec 35 §4): request ids, per-call
 * timeouts, abort, events, flattened sessions, `http(s)://` endpoints resolved through
 * `/json/version`, readable errors when the socket closes, no reconnect (a lease reopens).
 *
 * Runtime-neutral: the global `WebSocket` and `fetch` only.
 */
import { HarnessError } from '../../index.ts'

/** The slice of the WebSocket interface the client needs (the fake peer implements it too). */
export interface CdpSocket {
  readonly readyState: number
  send(data: string): void
  close(code?: number, reason?: string): void
  addEventListener(type: string, listener: (event: never) => void): void
  removeEventListener(type: string, listener: (event: never) => void): void
}

/** Where to connect. `url` is `ws(s)://` or `http(s)://` (resolved through `/json/version`). */
export interface CdpEndpoint {
  url: string
  /** Secret values: sent on the upgrade request when the runtime supports it, never logged. */
  headers?: Record<string, string>
}

/** Options of {@link cdpConnection}. */
export interface CdpConnectionOptions {
  /** Default per-command timeout, ms. Default 30 000. */
  timeoutMs?: number
  /** Time allowed to open the socket, ms. Default 30 000. */
  connectTimeoutMs?: number
  signal?: AbortSignal
  fetch?: typeof fetch
  /** Socket factory (tests, other runtimes). Default: the global `WebSocket`. */
  webSocket?: (url: string, init?: { headers?: Record<string, string> }) => CdpSocket
  /** Send `Target.setAutoAttach { flatten: true }` after connecting. Default true. */
  autoAttach?: boolean
}

/** Per-call options of {@link CdpClient.send}. */
export interface CdpSendOptions {
  /** Flattened session id; omitted = the browser target. */
  sessionId?: string
  timeoutMs?: number
  signal?: AbortSignal
}

/** A command failed, timed out, was aborted, or the socket closed. `message` is readable text. */
export class CdpError extends Error {
  readonly method?: string
  /** CDP error code when the browser answered with an error. */
  readonly code?: number
  constructor(message: string, options?: { method?: string; code?: number }) {
    super(message)
    this.name = 'CdpError'
    if (options?.method !== undefined) this.method = options.method
    if (options?.code !== undefined) this.code = options.code
  }
}

/** An event handler: `params` of the event and the flattened session it came from, if any. */
export type CdpEventHandler = (params: Record<string, unknown>, sessionId?: string) => void

/** One open CDP connection. */
export interface CdpClient {
  send<R = Record<string, unknown>>(
    method: string,
    params?: Record<string, unknown>,
    options?: CdpSendOptions,
  ): Promise<R>
  /** Subscribe to an event (`'*'` = every event). Returns the unsubscribe function. */
  on(event: string, handler: CdpEventHandler): () => void
  /** Resolve with the first matching event; rejects on timeout, abort and close. */
  waitFor(
    event: string,
    options?: {
      sessionId?: string
      predicate?: (params: Record<string, unknown>) => boolean
      timeoutMs?: number
      signal?: AbortSignal
    },
  ): Promise<Record<string, unknown>>
  /** `Target.attachToTarget { flatten: true }`: the new flattened session id. */
  attach(targetId: string): Promise<string>
  /** Called once when the socket closed (also after {@link close}). */
  onClose(handler: (reason: string) => void): () => void
  readonly closed: boolean
  /** Why the connection ended, once it did. */
  readonly closeReason: string | undefined
  close(): Promise<void>
}

const OPEN = 1

/**
 * Resolve an endpoint to a WebSocket URL. `ws(s)://` is returned as is; `http(s)://host:port` asks
 * `/json/version` for `webSocketDebuggerUrl`.
 *
 * @throws CdpError when the endpoint cannot be resolved.
 */
export async function resolveCdpUrl(
  endpoint: CdpEndpoint,
  options: { fetch?: typeof fetch; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<string> {
  const raw = endpoint.url.trim()
  if (/^wss?:\/\//i.test(raw)) return raw
  if (!/^https?:\/\//i.test(raw)) {
    throw new HarnessError(
      'EH_INVALID_INPUT',
      `A CDP endpoint must start with ws://, wss://, http:// or https:// (got "${raw.slice(0, 40)}").`,
    )
  }
  const f = options.fetch ?? fetch
  const base = new URL(raw)
  const versionUrl = new URL(base)
  versionUrl.pathname = `${base.pathname.replace(/\/$/, '')}/json/version`
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 30_000)
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
  let body: { webSocketDebuggerUrl?: unknown }
  try {
    const init: RequestInit = { signal }
    if (endpoint.headers) init.headers = endpoint.headers
    const res = await f(versionUrl, init)
    if (!res.ok) throw new CdpError(`HTTP ${res.status}`)
    body = (await res.json()) as { webSocketDebuggerUrl?: unknown }
  } catch (error) {
    throw new CdpError(
      `could not reach the browser at ${base.origin} (${error instanceof Error ? error.message : String(error)})`,
    )
  }
  if (typeof body.webSocketDebuggerUrl !== 'string' || body.webSocketDebuggerUrl === '') {
    throw new CdpError(`${base.origin}/json/version has no webSocketDebuggerUrl`)
  }
  const ws = new URL(body.webSocketDebuggerUrl)
  // A browser behind a proxy reports its own loopback address: keep the host the caller used.
  if (['127.0.0.1', 'localhost', '[::1]', '0.0.0.0'].includes(ws.hostname)) {
    ws.hostname = base.hostname
    ws.port = base.port
    ws.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:'
  }
  return ws.toString()
}

function defaultSocket(url: string, init?: { headers?: Record<string, string> }): CdpSocket {
  const Ctor = globalThis.WebSocket as unknown as new (url: string, options?: unknown) => CdpSocket
  if (typeof Ctor !== 'function') {
    throw new HarnessError('EH_CONFIG_INVALID', 'No global WebSocket in this runtime.')
  }
  return init?.headers && Object.keys(init.headers).length > 0
    ? new Ctor(url, { headers: init.headers })
    : new Ctor(url)
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Open a CDP connection to the browser target.
 *
 * @throws CdpError when the browser cannot be reached or the socket does not open in time.
 * @example
 * ```ts
 * const cdp = await cdpConnection({ url: 'http://127.0.0.1:9222' })
 * const { targetInfos } = await cdp.send<{ targetInfos: unknown[] }>('Target.getTargets')
 * ```
 */
export async function cdpConnection(
  endpoint: CdpEndpoint,
  options: CdpConnectionOptions = {},
): Promise<CdpClient> {
  const defaultTimeout = options.timeoutMs ?? 30_000
  const wsUrl = await resolveCdpUrl(endpoint, {
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    timeoutMs: options.connectTimeoutMs ?? defaultTimeout,
  })
  const make = options.webSocket ?? defaultSocket
  const socket = make(wsUrl, endpoint.headers ? { headers: endpoint.headers } : undefined)

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => fail(new CdpError('timed out opening the browser connection')),
      options.connectTimeoutMs ?? defaultTimeout,
    )
    const onOpen = (): void => {
      cleanup()
      resolve()
    }
    const onError = (): void => fail(new CdpError('could not open the browser connection'))
    const onClose = (): void =>
      fail(new CdpError('the browser closed the connection while opening'))
    const onAbort = (): void => fail(new CdpError('aborted'))
    function cleanup(): void {
      clearTimeout(timer)
      socket.removeEventListener('open', onOpen)
      socket.removeEventListener('error', onError)
      socket.removeEventListener('close', onClose)
      options.signal?.removeEventListener('abort', onAbort)
    }
    function fail(error: CdpError): void {
      cleanup()
      try {
        socket.close()
      } catch {}
      reject(error)
    }
    socket.addEventListener('open', onOpen)
    socket.addEventListener('error', onError)
    socket.addEventListener('close', onClose)
    options.signal?.addEventListener('abort', onAbort)
    if (options.signal?.aborted) onAbort()
    else if (socket.readyState === OPEN) onOpen()
  })

  let nextId = 1
  let closeReason: string | undefined
  const pending = new Map<
    number,
    { method: string; resolve: (v: never) => void; reject: (e: unknown) => void; done: () => void }
  >()
  const handlers = new Map<string, Set<CdpEventHandler>>()
  const closeHandlers = new Set<(reason: string) => void>()

  const onMessage = (event: { data: unknown }): void => {
    let msg: {
      id?: number
      method?: string
      params?: Record<string, unknown>
      result?: unknown
      error?: { code?: number; message?: string }
      sessionId?: string
    }
    try {
      const raw = event.data
      msg = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw as ArrayBuffer))
    } catch {
      return
    }
    if (typeof msg.id === 'number') {
      const p = pending.get(msg.id)
      if (!p) return
      pending.delete(msg.id)
      p.done()
      if (msg.error) {
        p.reject(
          new CdpError(`${p.method} failed: ${msg.error.message ?? 'unknown error'}`, {
            method: p.method,
            ...(msg.error.code !== undefined ? { code: msg.error.code } : {}),
          }),
        )
      } else p.resolve((msg.result ?? {}) as never)
      return
    }
    if (typeof msg.method === 'string') {
      const params = msg.params ?? {}
      for (const key of [msg.method, '*']) {
        for (const h of [...(handlers.get(key) ?? [])]) {
          try {
            h(params, msg.sessionId)
          } catch {}
        }
      }
    }
  }

  const onSocketClose = (event: { code?: number; reason?: string }): void => {
    if (closeReason !== undefined) return
    closeReason = `the browser connection closed${event.code ? ` (code ${event.code}${event.reason ? `: ${event.reason}` : ''})` : ''}`
    teardown()
  }
  const onSocketError = (): void => {
    // `close` follows an error; the reason is set there.
  }

  function teardown(): void {
    socket.removeEventListener('message', onMessage as never)
    socket.removeEventListener('close', onSocketClose as never)
    socket.removeEventListener('error', onSocketError)
    const reason = closeReason ?? 'the browser connection closed'
    for (const [id, p] of pending) {
      pending.delete(id)
      p.done()
      p.reject(new CdpError(`${p.method} failed: ${reason}`, { method: p.method }))
    }
    for (const h of [...closeHandlers]) {
      try {
        h(reason)
      } catch {}
    }
    closeHandlers.clear()
    handlers.clear()
  }

  socket.addEventListener('message', onMessage as never)
  socket.addEventListener('close', onSocketClose as never)
  socket.addEventListener('error', onSocketError)

  const send: CdpClient['send'] = <R>(
    method: string,
    params?: Record<string, unknown>,
    sendOptions?: CdpSendOptions,
  ): Promise<R> =>
    new Promise<R>((resolve, reject) => {
      if (closeReason !== undefined) {
        reject(new CdpError(`${method} failed: ${closeReason}`, { method }))
        return
      }
      const signal = sendOptions?.signal
      if (signal?.aborted) {
        reject(new CdpError('aborted', { method }))
        return
      }
      const id = nextId++
      const ms = sendOptions?.timeoutMs ?? defaultTimeout
      const timer = setTimeout(() => {
        if (!pending.delete(id)) return
        signal?.removeEventListener('abort', onAbort)
        reject(new CdpError(`${method} timed out after ${ms} ms`, { method }))
      }, ms)
      const onAbort = (): void => {
        if (!pending.delete(id)) return
        clearTimeout(timer)
        reject(new CdpError('aborted', { method }))
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      pending.set(id, {
        method,
        resolve: resolve as (v: never) => void,
        reject,
        done: () => {
          clearTimeout(timer)
          signal?.removeEventListener('abort', onAbort)
        },
      })
      const payload: Record<string, unknown> = { id, method }
      if (params) payload.params = params
      if (sendOptions?.sessionId) payload.sessionId = sendOptions.sessionId
      try {
        socket.send(JSON.stringify(payload))
      } catch (error) {
        pending.delete(id)
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        reject(new CdpError(`${method} failed: ${describeError(error)}`, { method }))
      }
    })

  const on: CdpClient['on'] = (event, handler) => {
    const set = handlers.get(event) ?? new Set<CdpEventHandler>()
    handlers.set(event, set)
    set.add(handler)
    return () => {
      set.delete(handler)
    }
  }

  const client: CdpClient = {
    send,
    on,
    waitFor(event, opts = {}) {
      return new Promise((resolve, reject) => {
        if (closeReason !== undefined) {
          reject(new CdpError(`waiting for ${event} failed: ${closeReason}`))
          return
        }
        const ms = opts.timeoutMs ?? defaultTimeout
        const cleanup = (): void => {
          clearTimeout(timer)
          off()
          offClose()
          opts.signal?.removeEventListener('abort', onAbort)
        }
        const timer = setTimeout(() => {
          cleanup()
          reject(new CdpError(`timed out after ${ms} ms waiting for ${event}`))
        }, ms)
        const off = on(event, (params, sessionId) => {
          if (opts.sessionId !== undefined && sessionId !== opts.sessionId) return
          if (opts.predicate && !opts.predicate(params)) return
          cleanup()
          resolve(params)
        })
        const offClose = client.onClose((reason) => {
          cleanup()
          reject(new CdpError(`waiting for ${event} failed: ${reason}`))
        })
        const onAbort = (): void => {
          cleanup()
          reject(new CdpError('aborted'))
        }
        opts.signal?.addEventListener('abort', onAbort, { once: true })
        if (opts.signal?.aborted) onAbort()
      })
    },
    async attach(targetId) {
      const res = await send<{ sessionId?: string }>('Target.attachToTarget', {
        targetId,
        flatten: true,
      })
      if (typeof res.sessionId !== 'string') {
        throw new CdpError('Target.attachToTarget returned no session', {
          method: 'Target.attachToTarget',
        })
      }
      return res.sessionId
    },
    onClose(handler) {
      if (closeReason !== undefined) {
        const reason = closeReason
        queueMicrotask(() => handler(reason))
        return () => {}
      }
      closeHandlers.add(handler)
      return () => {
        closeHandlers.delete(handler)
      }
    },
    get closed() {
      return closeReason !== undefined
    },
    get closeReason() {
      return closeReason
    },
    async close() {
      if (closeReason === undefined) {
        closeReason = 'the browser connection was closed'
        try {
          socket.close(1000, 'closed by client')
        } catch {}
        teardown()
      }
    },
  }

  if (options.autoAttach !== false) {
    try {
      await send('Target.setAutoAttach', {
        autoAttach: true,
        waitForDebuggerOnStart: false,
        flatten: true,
      })
    } catch (error) {
      await client.close()
      throw error
    }
  }
  return client
}
