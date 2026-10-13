/**
 * The sandbox server: `/v1` HTTP API over disposable `scratchSandbox` sessions (see README.md).
 * Dependency-free apart from the eharness shell module; runs on Bun.
 */

import { execFile } from 'node:child_process'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync } from 'node:fs'
import { promisify } from 'node:util'
import { removeStaleScratch, type ScratchSandbox, scratchSandbox } from 'eharness/shell'

const execFileAsync = promisify(execFile)

export interface ServerLimits {
  cpuSeconds: number
  memoryMb: number
  fileMb: number
  processes: number
  timeoutMs: number
  maxFileMb: number
  maxSessions: number
  idleMinutes: number
}

export interface ServerOptions {
  token: string
  /** 0 = random port. */
  port?: number
  hostname?: string
  /** Parent of the per-session scratch directories. */
  dataDir?: string
  /** Interpreter used for the probe and put on PATH of commands. Default `python3`. */
  python?: string
  limits?: Partial<ServerLimits>
  /** Use the OS sandbox (bubblewrap / sandbox-exec) when available. Default true. */
  osSandbox?: boolean
  /** Paths commands cannot read (the server's own source). */
  denyRead?: string[]
  /** Idle sweep period. Default 30 s. */
  sweepMs?: number
  log?: (line: string) => void
}

export interface RunningServer {
  url: string
  port: number
  sessions(): number
  stop(): Promise<void>
}

export const DEFAULT_LIMITS: ServerLimits = {
  cpuSeconds: 120,
  memoryMb: 1024,
  fileMb: 64,
  processes: 128,
  timeoutMs: 300_000,
  maxFileMb: 64,
  maxSessions: 32,
  idleMinutes: 30,
}

const PREFIX = 'eh-sbx-'
const ID = /^[0-9a-f]{32}$/
const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
const fail = (status: number, error: string): Response => json(status, { error })

/** Relative, no NUL, no `..` segment. Returns the path or an error text. */
export function checkPath(raw: string | null): { path: string } | { error: string } {
  if (raw === null || raw === '') return { error: 'path is required' }
  if (raw.includes('\0')) return { error: 'path contains NUL' }
  if (raw.startsWith('/') || raw.startsWith('\\') || /^[a-zA-Z]:/.test(raw))
    return { error: 'path must be relative' }
  if (raw.split(/[\\/]/).includes('..')) return { error: 'path must not contain ..' }
  return { path: raw }
}

function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest()
  const hb = createHash('sha256').update(b).digest()
  return timingSafeEqual(ha, hb)
}

async function probePython(
  python: string,
): Promise<{ python: string; packages: Array<[string, string]> }> {
  const script =
    'import sys, json, importlib.metadata as m\n' +
    'print(json.dumps({"v": "%d.%d.%d" % sys.version_info[:3], "p": sorted([[d.metadata["Name"], d.version] for d in m.distributions()], key=lambda x: x[0].lower())}))'
  try {
    const { stdout } = await execFileAsync(python, ['-c', script], { timeout: 20_000 })
    const parsed = JSON.parse(stdout) as { v: string; p: Array<[string, string]> }
    return { python: parsed.v, packages: parsed.p }
  } catch {
    return { python: 'unavailable', packages: [] }
  }
}

interface Session {
  sandbox: ScratchSandbox
  lastUsed: number
  running: number
}

export async function startServer(options: ServerOptions): Promise<RunningServer> {
  if (options.token.length < 8) throw new Error('SANDBOX_TOKEN must be at least 8 characters')
  const limits: ServerLimits = { ...DEFAULT_LIMITS, ...options.limits }
  const dataDir = options.dataDir ?? '/tmp/eh-sandboxes'
  const python = options.python ?? 'python3'
  const log = options.log ?? ((line: string) => console.log(line))
  const { mkdir } = await import('node:fs/promises')
  await mkdir(dataDir, { recursive: true })
  const removed = await removeStaleScratch({ parent: dataDir, prefix: PREFIX, olderThanMs: 0 })
  if (removed > 0) log(`removed ${removed} stale scratch directories`)
  const probe = await probePython(python)
  const pyDir = python.includes('/') ? python.slice(0, python.lastIndexOf('/')) : undefined
  const sessions = new Map<string, Session>()

  // The OS sandbox (bubblewrap) needs user namespaces, which a default container often lacks: probe
  // it once and fall back to the container itself as the isolation boundary.
  let osSandbox = options.osSandbox ?? true
  if (osSandbox) {
    const probeBox = await scratchSandbox({
      parent: dataDir,
      prefix: PREFIX,
      os: { enabled: true, network: false },
    })
    try {
      const st = probeBox.state()
      const r = st.enabled ? await probeBox.run({ command: 'true' }) : { exitCode: 1 }
      osSandbox = r.exitCode === 0
    } catch {
      osSandbox = false
    } finally {
      await probeBox.dispose()
    }
    log(
      osSandbox
        ? 'OS sandbox: on (commands run without network, writes only in their directory)'
        : 'OS sandbox: unavailable, the container is the isolation boundary (use an internal network)',
    )
  }

  const info = {
    version: 1,
    python: probe.python,
    pythonCommand: python,
    packages: probe.packages,
    isolation: { isolated: true, label: 'sandbox-server container' },
    limits: {
      cpuSeconds: limits.cpuSeconds,
      memoryMb: limits.memoryMb,
      fileMb: limits.fileMb,
      processes: limits.processes,
      timeoutMs: limits.timeoutMs,
      maxFileMb: limits.maxFileMb,
      maxSessions: limits.maxSessions,
      idleMinutes: limits.idleMinutes,
    },
  }

  const dispose = async (id: string): Promise<boolean> => {
    const s = sessions.get(id)
    if (!s) return false
    sessions.delete(id)
    await s.sandbox.dispose().catch(() => {})
    return true
  }

  const sweep = setInterval(() => {
    const cutoff = Date.now() - limits.idleMinutes * 60_000
    for (const [id, s] of sessions) {
      if (s.running === 0 && s.lastUsed < cutoff) {
        log(`session ${id.slice(0, 8)} idle, disposed`)
        void dispose(id)
      }
    }
  }, options.sweepMs ?? 30_000)
  sweep.unref()

  async function createSession(): Promise<Response> {
    if (sessions.size >= limits.maxSessions) return fail(429, 'too many sessions')
    const id = randomBytes(16).toString('hex')
    const env: Record<string, string> = {
      HOME: '/tmp',
      TMPDIR: '/tmp',
      MPLCONFIGDIR: '/tmp/.mpl',
      MPLBACKEND: 'Agg',
      PYTHONDONTWRITEBYTECODE: '1',
      LANG: 'C.UTF-8',
      PATH: `${pyDir ? `${pyDir}:` : ''}${process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin'}`,
    }
    if (pyDir) env.VIRTUAL_ENV = pyDir.replace(/\/bin$/, '')
    const sandbox = await scratchSandbox({
      parent: dataDir,
      prefix: PREFIX,
      env,
      os: {
        enabled: osSandbox,
        network: false,
        denyRead: (options.denyRead ?? []).filter((p) => existsSync(p)),
      },
      limits: {
        cpuSeconds: limits.cpuSeconds,
        fileBytes: limits.fileMb * 1024 * 1024,
        memoryBytes: limits.memoryMb * 1024 * 1024,
        processes: limits.processes,
      },
    })
    sessions.set(id, { sandbox, lastUsed: Date.now(), running: 0 })
    return json(201, { id })
  }

  async function files(req: Request, s: Session, url: URL): Promise<Response> {
    const checked = checkPath(url.searchParams.get('path'))
    if ('error' in checked) return fail(400, checked.error)
    try {
      if (req.method === 'GET') {
        const bytes = await s.sandbox.readBinaryFile({ path: checked.path })
        if (bytes === null) return fail(404, 'file not found')
        return new Response(bytes as BodyInit, {
          headers: { 'content-type': 'application/octet-stream' },
        })
      }
      const max = limits.maxFileMb * 1024 * 1024
      const declared = Number(req.headers.get('content-length') ?? 0)
      if (declared > max) return fail(413, `file larger than ${limits.maxFileMb} MB`)
      const bytes = new Uint8Array(await req.arrayBuffer())
      if (bytes.byteLength > max) return fail(413, `file larger than ${limits.maxFileMb} MB`)
      await s.sandbox.writeBinaryFile({ path: checked.path, content: bytes })
      return new Response(null, { status: 204 })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // symlink / outside-root refusals and I/O errors on bad targets (a directory) are client errors
      return fail(/refusing|EISDIR|ENOTDIR|EACCES|EPERM/.test(message) ? 400 : 500, message)
    }
  }

  async function run(req: Request, s: Session): Promise<Response> {
    let body: {
      command?: unknown
      workingDirectory?: unknown
      env?: unknown
      timeoutMs?: unknown
    }
    try {
      body = (await req.json()) as typeof body
    } catch {
      return fail(400, 'invalid JSON body')
    }
    if (typeof body.command !== 'string' || body.command === '')
      return fail(400, 'command is required')
    let workingDirectory: string | undefined
    if (body.workingDirectory !== undefined) {
      const wd = checkPath(String(body.workingDirectory) || '.')
      if ('error' in wd) return fail(400, `workingDirectory: ${wd.error}`)
      workingDirectory = wd.path
    }
    let env: Record<string, string> | undefined
    if (body.env !== undefined) {
      if (typeof body.env !== 'object' || body.env === null || Array.isArray(body.env))
        return fail(400, 'env must be an object of strings')
      env = {}
      for (const [k, v] of Object.entries(body.env)) {
        if (typeof v !== 'string') return fail(400, 'env must be an object of strings')
        env[k] = v
      }
    }
    const timeoutMs = Math.min(
      typeof body.timeoutMs === 'number' && body.timeoutMs > 0 ? body.timeoutMs : limits.timeoutMs,
      limits.timeoutMs,
    )
    const ac = new AbortController()
    const onAbort = (): void => ac.abort()
    req.signal.addEventListener('abort', onAbort)
    let proc: Awaited<ReturnType<ScratchSandbox['spawn']>>
    try {
      proc = await s.sandbox.spawn({
        command: body.command,
        workingDirectory,
        env,
        abortSignal: ac.signal,
      })
    } catch (error) {
      req.signal.removeEventListener('abort', onAbort)
      return fail(400, error instanceof Error ? error.message : String(error))
    }
    s.running++
    const enc = new TextEncoder()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      void proc.kill()
    }, timeoutMs)
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const line = (o: unknown): void => {
          try {
            controller.enqueue(enc.encode(`${JSON.stringify(o)}\n`))
          } catch {
            // client gone
          }
        }
        // flush the headers now: a silent command must not leave the client waiting for them
        line({ start: true })
        const pump = async (rs: ReadableStream<Uint8Array>, key: string): Promise<void> => {
          const dec = new TextDecoder()
          for await (const chunk of rs as unknown as AsyncIterable<Uint8Array>) {
            const text = dec.decode(chunk, { stream: true })
            if (text) line({ [key]: text })
          }
          const rest = dec.decode()
          if (rest) line({ [key]: rest })
        }
        try {
          const [res] = await Promise.all([
            Promise.resolve(proc.wait()).catch(() => ({ exitCode: 137 })),
            pump(proc.stdout, 'stdout').catch(() => {}),
            pump(proc.stderr, 'stderr').catch(() => {}),
          ])
          if (timedOut) line({ stderr: `\n[killed: timeout after ${timeoutMs} ms]\n` })
          line({ exit: res.exitCode })
        } finally {
          clearTimeout(timer)
          req.signal.removeEventListener('abort', onAbort)
          s.running--
          s.lastUsed = Date.now()
          try {
            controller.close()
          } catch {
            // already closed
          }
        }
      },
      cancel() {
        void proc.kill()
      },
    })
    return new Response(stream, { headers: { 'content-type': 'application/x-ndjson' } })
  }

  async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url)
    const path = url.pathname
    if (path === '/healthz' && req.method === 'GET') return json(200, { ok: true })
    const auth = req.headers.get('authorization') ?? ''
    const given = auth.startsWith('Bearer ') ? auth.slice(7) : ''
    if (!safeEqual(given, options.token)) return fail(401, 'unauthorized')
    if (path === '/v1/info' && req.method === 'GET') return json(200, info)
    if (path === '/v1/sessions' && req.method === 'POST') return createSession()
    const m = /^\/v1\/sessions\/([^/]+)(?:\/(files|run))?$/.exec(path)
    if (!m) return fail(404, 'not found')
    const id = m[1] as string
    if (!ID.test(id)) return fail(404, 'unknown session')
    const sub = m[2]
    if (sub === undefined && req.method === 'DELETE') {
      return (await dispose(id))
        ? new Response(null, { status: 204 })
        : fail(404, 'unknown session')
    }
    const s = sessions.get(id)
    if (!s) return fail(404, 'unknown session')
    s.lastUsed = Date.now()
    if (sub === 'files' && (req.method === 'GET' || req.method === 'PUT')) return files(req, s, url)
    if (sub === 'run' && req.method === 'POST') return run(req, s)
    return fail(405, 'method not allowed')
  }

  const server = Bun.serve({
    port: options.port ?? 0,
    hostname: options.hostname ?? '127.0.0.1',
    idleTimeout: 0,
    maxRequestBodySize: (limits.maxFileMb + 1) * 1024 * 1024,
    async fetch(req) {
      const started = Date.now()
      let res: Response
      try {
        res = await handle(req)
      } catch (error) {
        res = fail(500, error instanceof Error ? error.message : String(error))
      }
      // the path only (ids are random, the token is a header): no secrets in the line
      log(`${req.method} ${new URL(req.url).pathname} ${res.status} ${Date.now() - started}ms`)
      return res
    },
  })

  return {
    url: `http://${server.hostname}:${server.port}`,
    port: server.port as number,
    sessions: () => sessions.size,
    async stop() {
      clearInterval(sweep)
      await server.stop(true)
      await Promise.all([...sessions.keys()].map((id) => dispose(id)))
    },
  }
}
