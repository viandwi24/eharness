/**
 * `/v1/browser`: a managed Chrome of `eharness/browser/node` run on this server, driven remotely
 * (plan P48 phase F, spec 35 §6). Chrome only ever listens on loopback; the CDP socket is
 * reachable through `GET /v1/browser/cdp/{profileId}` (a WebSocket proxy) and nothing else.
 *
 * Auth: every route needs the bearer token, except the WebSocket upgrade, which also accepts a
 * short-lived signed query token (`?t=`) that `POST /v1/browser/start` hands out. WebSocket
 * clients cannot set headers in every runtime (browsers, some Node versions), and a CDP URL with
 * a signed token is a credential of one profile for a few minutes only. Never logged.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { BrowserRuntime, RuntimeEndpoint } from 'eharness/browser'

/** Lifetime of the signed CDP token (it only matters at connect time). */
export const CDP_TOKEN_TTL_MS = 10 * 60_000

const ID = /^[A-Za-z0-9_-]{1,64}$/

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
const fail = (status: number, error: string): Response => json(status, { error })

export interface ProxyData {
  profileId: string
}

type Socket = import('bun').ServerWebSocket<ProxyData>

interface Upstream {
  ws: WebSocket
  queue: Array<string | ArrayBuffer>
  open: boolean
}

export interface BrowserRoutes {
  /** The `/v1/browser*` routes (the caller checked the bearer token), undefined for other paths. */
  handle(req: Request, url: URL): Promise<Response | undefined>
  /** True when a bearer-less request is a valid CDP upgrade (signed token). */
  tokenOk(url: URL): boolean
  /** Upgrade a `/v1/browser/cdp/{id}` request; a Response when refused. */
  upgrade(
    req: Request,
    url: URL,
    server: { upgrade(req: Request, options: { data: ProxyData }): boolean },
  ): Response | undefined
  websocket: {
    open(ws: Socket): void
    message(ws: Socket, data: string | Buffer): void
    close(ws: Socket): void
  }
  close(): Promise<void>
}

export interface BrowserRoutesOptions {
  runtime: BrowserRuntime
  log?: (line: string) => void
}

export function browserRoutes(options: BrowserRoutesOptions): BrowserRoutes {
  const { runtime } = options
  const secret = randomBytes(32)
  /** Loopback CDP URL of each running profile (never leaves this process). */
  const local = new Map<string, string>()
  const sockets = new Map<Socket, Upstream>()
  let installing: Promise<void> | undefined
  let installError: string | undefined

  const sign = (profileId: string, exp: number): string =>
    createHmac('sha256', secret).update(`${profileId}.${exp}`).digest('hex')
  const issue = (profileId: string): string => {
    const exp = Date.now() + CDP_TOKEN_TTL_MS
    return `${exp}.${sign(profileId, exp)}`
  }
  const verify = (profileId: string, token: string | null): boolean => {
    if (token === null) return false
    const [expRaw, sig] = token.split('.')
    const exp = Number(expRaw)
    if (!Number.isFinite(exp) || exp < Date.now() || sig === undefined) return false
    const want = Buffer.from(sign(profileId, exp))
    const got = Buffer.from(sig)
    return want.length === got.length && timingSafeEqual(want, got)
  }
  const profileOfCdp = (url: URL): string | undefined => {
    const m = /^\/v1\/browser\/cdp\/([^/]+)$/.exec(url.pathname)
    return m?.[1] !== undefined && ID.test(m[1]) ? m[1] : undefined
  }

  const message = (error: unknown): string =>
    error instanceof Error ? error.message : String(error)

  async function status(): Promise<Response> {
    const s = await runtime.status()
    // a failed background install shows until the next attempt
    if (installError !== undefined && s.state !== 'installing' && s.error === undefined) {
      return json(200, { ...s, state: 'error', error: installError })
    }
    return json(200, s)
  }

  function install(): Response | Promise<Response> {
    if (installing === undefined) {
      installError = undefined
      installing = runtime
        .install()
        .catch((error: unknown) => {
          installError = message(error)
          options.log?.(`browser install failed: ${installError}`)
        })
        .finally(() => {
          installing = undefined
        })
    }
    // let `install` flip the state to `installing` before answering
    return new Promise((resolve) => setTimeout(() => resolve(status()), 0))
  }

  async function start(req: Request): Promise<Response> {
    let body: { profileId?: unknown; name?: unknown; settings?: unknown }
    try {
      body = (await req.json()) as typeof body
    } catch {
      return fail(400, 'invalid JSON body')
    }
    if (typeof body.profileId !== 'string' || !ID.test(body.profileId))
      return fail(400, 'profileId is required (letters, digits, - and _)')
    const settings =
      typeof body.settings === 'object' && body.settings !== null && !Array.isArray(body.settings)
        ? (body.settings as Record<string, unknown>)
        : undefined
    let endpoint: RuntimeEndpoint
    try {
      endpoint = await runtime.start(
        { id: body.profileId, ...(typeof body.name === 'string' ? { name: body.name } : {}) },
        settings,
      )
    } catch (error) {
      return fail(409, message(error))
    }
    local.set(body.profileId, endpoint.cdpUrl)
    return json(200, {
      endpoint: {
        cdpPath: `/v1/browser/cdp/${body.profileId}?t=${issue(body.profileId)}`,
        ...(endpoint.pid === undefined ? {} : { pid: endpoint.pid }),
      },
    })
  }

  async function stop(req: Request): Promise<Response> {
    let body: { profileId?: unknown }
    try {
      body = (await req.json()) as typeof body
    } catch {
      return fail(400, 'invalid JSON body')
    }
    if (typeof body.profileId !== 'string' || !ID.test(body.profileId))
      return fail(400, 'profileId is required')
    await forget(body.profileId)
    try {
      await runtime.stop(body.profileId)
    } catch (error) {
      return fail(409, message(error))
    }
    return new Response(null, { status: 204 })
  }

  /** Close the proxied sockets of a profile. */
  async function forget(profileId: string): Promise<void> {
    local.delete(profileId)
    for (const [ws] of sockets) if (ws.data.profileId === profileId) ws.close(1001, 'stopped')
  }

  async function handle(req: Request, url: URL): Promise<Response | undefined> {
    const path = url.pathname
    if (path !== '/v1/browser' && !path.startsWith('/v1/browser/')) return undefined
    try {
      if (path === '/v1/browser/status' && req.method === 'GET') return await status()
      if (path === '/v1/browser/install' && req.method === 'POST') return await install()
      if (path === '/v1/browser/start' && req.method === 'POST') return await start(req)
      if (path === '/v1/browser/stop' && req.method === 'POST') return await stop(req)
      if (path === '/v1/browser/uninstall' && req.method === 'POST') {
        if (installing !== undefined) return fail(409, 'a download is running')
        for (const id of [...local.keys()]) await forget(id)
        await runtime.uninstall?.()
        return await status()
      }
      if (path === '/v1/browser/usage' && req.method === 'GET') {
        const id = url.searchParams.get('profileId') ?? ''
        if (!ID.test(id)) return fail(400, 'profileId is required')
        return json(200, { usage: (await runtime.usage?.(id)) ?? null })
      }
      const profile = /^\/v1\/browser\/profiles\/([^/]+)$/.exec(path)
      if (profile?.[1] !== undefined && req.method === 'DELETE') {
        if (!ID.test(profile[1])) return fail(400, 'invalid profile id')
        await forget(profile[1])
        await runtime.stop(profile[1]).catch(() => {})
        await runtime.removeProfileData?.(profile[1])
        return new Response(null, { status: 204 })
      }
      if (profileOfCdp(url) !== undefined) return fail(426, 'WebSocket upgrade required')
      return fail(404, 'not found')
    } catch (error) {
      return fail(500, message(error))
    }
  }

  return {
    handle,
    tokenOk(url) {
      const id = profileOfCdp(url)
      return id !== undefined && verify(id, url.searchParams.get('t'))
    },
    upgrade(req, url, server) {
      const profileId = profileOfCdp(url)
      if (profileId === undefined) return fail(404, 'not found')
      if (!local.has(profileId)) return fail(404, 'profile is not running')
      if (!server.upgrade(req, { data: { profileId } })) return fail(400, 'WebSocket expected')
      return undefined
    },
    websocket: {
      open(ws) {
        const target = local.get(ws.data.profileId)
        if (target === undefined) {
          ws.close(1011, 'not running')
          return
        }
        const up: Upstream = { ws: new WebSocket(target), queue: [], open: false }
        sockets.set(ws, up)
        up.ws.binaryType = 'arraybuffer'
        up.ws.addEventListener('open', () => {
          up.open = true
          for (const m of up.queue) up.ws.send(m)
          up.queue = []
        })
        up.ws.addEventListener('message', (e) => {
          ws.send(e.data as string | ArrayBuffer)
        })
        up.ws.addEventListener('close', () => ws.close())
        up.ws.addEventListener('error', () => ws.close(1011, 'upstream error'))
      },
      message(ws, data) {
        const up = sockets.get(ws)
        if (up === undefined) return
        // Bun hands text as string and binary as Buffer: send binary as an exact ArrayBuffer
        const out: string | ArrayBuffer =
          typeof data === 'string' ? data : (new Uint8Array(data).buffer as ArrayBuffer)
        if (up.open) up.ws.send(out)
        else up.queue.push(out)
      },
      close(ws) {
        const up = sockets.get(ws)
        sockets.delete(ws)
        try {
          up?.ws.close()
        } catch {
          // already closed
        }
      },
    },
    async close() {
      for (const [ws] of sockets) ws.close(1001, 'server stopping')
      for (const id of [...local.keys()]) await runtime.stop(id).catch(() => {})
      local.clear()
    },
  }
}
