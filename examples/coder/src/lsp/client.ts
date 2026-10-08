/**
 * Minimal LSP 3.17 client: JSON-RPC 2.0 with `Content-Length` framing over a child process'
 * stdio. No dependencies. Handles requests (ids + timeouts), notifications, server-initiated
 * requests (answered with null/empty), `publishDiagnostics` collection and graceful shutdown.
 */
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'

export interface LspPosition {
  line: number
  character: number
}
export interface LspRange {
  start: LspPosition
  end: LspPosition
}
export interface LspDiagnostic {
  range: LspRange
  /** 1 error, 2 warning, 3 information, 4 hint. */
  severity?: number
  code?: string | number
  source?: string
  message: string
}

export const REQUEST_TIMEOUT_MS = 10_000

const HEADER_END = Buffer.from('\r\n\r\n')

/** Incremental parser of `Content-Length` framed JSON messages; chunk boundaries do not matter. */
export class FrameParser {
  private buffer: Buffer = Buffer.alloc(0)

  /** Feed bytes; returns every complete message (malformed frames are skipped). */
  push(chunk: Uint8Array): unknown[] {
    this.buffer =
      this.buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.buffer, chunk])
    const out: unknown[] = []
    for (;;) {
      const headerEnd = this.buffer.indexOf(HEADER_END)
      if (headerEnd === -1) break
      const header = this.buffer.subarray(0, headerEnd).toString('ascii')
      const match = /content-length:\s*(\d+)/i.exec(header)
      if (!match) {
        // unusable header: drop it and resynchronise
        this.buffer = this.buffer.subarray(headerEnd + HEADER_END.length)
        continue
      }
      const length = Number(match[1])
      const start = headerEnd + HEADER_END.length
      if (this.buffer.length < start + length) break
      const body = this.buffer.subarray(start, start + length).toString('utf8')
      this.buffer = this.buffer.subarray(start + length)
      try {
        out.push(JSON.parse(body))
      } catch {
        // skip malformed JSON
      }
    }
    return out
  }
}

/** Encode one JSON-RPC message with its header. */
export function encodeMessage(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), 'utf8')
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body])
}

export interface LspClientOptions {
  /** Command and arguments, e.g. `['typescript-language-server', '--stdio']`. */
  command: string[]
  /** Working directory of the server (the project root). */
  cwd: string
  /** `file://` URI of the workspace root. */
  rootUri: string
  /** Request timeout; default 10 s. */
  requestTimeoutMs?: number
  /** Environment for the server; default `process.env`. */
  env?: Record<string, string | undefined>
}

interface Pending {
  resolve(value: unknown): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout>
  method: string
}

interface DiagnosticsEntry {
  diagnostics: LspDiagnostic[]
  /** Increments on every publish for the uri. */
  seq: number
}

/** One running language server. Create with {@link LspClient.start}. */
export class LspClient {
  readonly command: string[]
  private proc: ChildProcessWithoutNullStreams | undefined
  private readonly parser = new FrameParser()
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private readonly published = new Map<string, DiagnosticsEntry>()
  private readonly waiters = new Set<(uri: string) => void>()
  private stderrTail = ''
  private deadReason: string | undefined
  private exited: Promise<void> = Promise.resolve()
  /** Capabilities returned by `initialize`. */
  capabilities: Record<string, unknown> = {}

  private constructor(private readonly options: LspClientOptions) {
    this.command = options.command
  }

  /** Spawn the server and complete the `initialize` handshake. Rejects when it cannot start. */
  static async start(options: LspClientOptions): Promise<LspClient> {
    const client = new LspClient(options)
    try {
      await client.init()
    } catch (error) {
      await client.kill()
      throw error
    }
    return client
  }

  get alive(): boolean {
    return this.deadReason === undefined
  }

  /** Why the server is dead (exit code, spawn error), or undefined while alive. */
  get deathReason(): string | undefined {
    return this.deadReason
  }

  get pid(): number | undefined {
    return this.proc?.pid
  }

  private async init(): Promise<void> {
    const [file, ...args] = this.options.command
    if (!file) throw new Error('empty language server command')
    const proc = spawn(file, args, {
      cwd: this.options.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: (this.options.env ?? process.env) as NodeJS.ProcessEnv,
    })
    this.proc = proc
    let settle: () => void = () => {}
    this.exited = new Promise((resolve) => {
      settle = resolve
    })
    proc.once('close', (code, signal) => {
      this.markDead(`exited (${signal ?? `code ${code}`})`)
      settle()
    })
    proc.once('error', (error) => {
      this.markDead(`failed to start: ${error.message}`)
      if (proc.pid === undefined) settle()
    })
    proc.stdin.on('error', () => {
      // EPIPE after a crash: markDead handles it
    })
    proc.stdout.on('data', (chunk: Buffer) => {
      for (const message of this.parser.push(chunk)) this.handle(message)
    })
    proc.stderr.on('data', (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString('utf8')).slice(-2000)
    })

    // a spawn failure (ENOENT) is reported asynchronously: let it surface before writing
    await new Promise((resolve) => setImmediate(resolve))
    if (!this.alive) throw new Error(`language server ${this.deadReason}`)

    const root = this.options.rootUri
    const name = decodeURIComponent(root.split('/').filter(Boolean).pop() ?? 'root')
    const result = (await this.request('initialize', {
      processId: process.pid,
      clientInfo: { name: 'eharness-coder' },
      rootUri: root,
      workspaceFolders: [{ uri: root, name }],
      capabilities: {
        general: { positionEncodings: ['utf-16'] },
        workspace: { workspaceFolders: true, configuration: true, symbol: {} },
        window: { workDoneProgress: true },
        textDocument: {
          synchronization: { didSave: false, dynamicRegistration: false },
          definition: { linkSupport: true },
          references: {},
          hover: { contentFormat: ['markdown', 'plaintext'] },
          documentSymbol: { hierarchicalDocumentSymbolSupport: true },
          publishDiagnostics: { relatedInformation: false },
        },
      },
    })) as { capabilities?: Record<string, unknown> } | null
    this.capabilities = result?.capabilities ?? {}
    this.notify('initialized', {})
  }

  private markDead(reason: string): void {
    if (this.deadReason !== undefined) return
    const tail = this.stderrTail.trim()
    this.deadReason = tail ? `${reason}: ${tail.split('\n').slice(-3).join(' | ')}` : reason
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer)
      p.reject(new Error(`language server ${this.deadReason}`))
      this.pending.delete(id)
    }
    for (const wake of this.waiters) wake('')
  }

  private send(message: unknown): boolean {
    const stdin = this.proc?.stdin
    if (!stdin || !this.alive || stdin.destroyed) return false
    try {
      stdin.write(encodeMessage(message))
      return true
    } catch {
      return false
    }
  }

  /** Send a request and resolve with its `result`. Rejects on error responses, timeout, death. */
  request(method: string, params: unknown, timeoutMs?: number): Promise<unknown> {
    if (!this.alive) return Promise.reject(new Error(`language server ${this.deadReason}`))
    const id = this.nextId++
    const limit = timeoutMs ?? this.options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        // tell the server we no longer care
        this.send({ jsonrpc: '2.0', method: '$/cancelRequest', params: { id } })
        reject(new Error(`language server request ${method} timed out after ${limit} ms`))
      }, limit)
      this.pending.set(id, { resolve, reject, timer, method })
      if (!this.send({ jsonrpc: '2.0', id, method, params })) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(new Error(`language server ${this.deadReason ?? 'is not running'}`))
      }
    })
  }

  /** Send a notification (no response). */
  notify(method: string, params: unknown): void {
    this.send({ jsonrpc: '2.0', method, params })
  }

  private handle(raw: unknown): void {
    if (typeof raw !== 'object' || raw === null) return
    const msg = raw as {
      id?: number | string | null
      method?: string
      params?: unknown
      result?: unknown
      error?: { code: number; message: string }
    }
    if (typeof msg.method === 'string') {
      if (msg.id !== undefined && msg.id !== null) {
        this.send({
          jsonrpc: '2.0',
          id: msg.id,
          result: this.answerServerRequest(msg.method, msg.params),
        })
      } else if (msg.method === 'textDocument/publishDiagnostics') {
        const p = msg.params as { uri?: string; diagnostics?: LspDiagnostic[] } | undefined
        if (p?.uri) {
          const prev = this.published.get(p.uri)
          this.published.set(p.uri, { diagnostics: p.diagnostics ?? [], seq: (prev?.seq ?? 0) + 1 })
          for (const wake of this.waiters) wake(p.uri)
        }
      }
      return
    }
    if (typeof msg.id === 'number') {
      const p = this.pending.get(msg.id)
      if (!p) return
      this.pending.delete(msg.id)
      clearTimeout(p.timer)
      if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message}`))
      else p.resolve(msg.result ?? null)
    }
  }

  /** Server → client requests get an empty answer so the server never blocks on us. */
  private answerServerRequest(method: string, params: unknown): unknown {
    if (method === 'workspace/configuration') {
      const items = (params as { items?: unknown[] } | undefined)?.items
      return Array.isArray(items) ? items.map(() => null) : []
    }
    if (method === 'workspace/workspaceFolders') {
      return [{ uri: this.options.rootUri, name: 'root' }]
    }
    return null
  }

  /** Latest diagnostics for a uri (empty when none were published). */
  diagnosticsFor(uri: string): LspDiagnostic[] {
    return this.published.get(uri)?.diagnostics ?? []
  }

  /** Publish counter of a uri; pass it to {@link waitForDiagnostics} as `afterSeq`. */
  diagnosticsSeq(uri: string): number {
    return this.published.get(uri)?.seq ?? 0
  }

  /** Uris that have published diagnostics. */
  diagnosticUris(): string[] {
    return [...this.published.keys()]
  }

  /** Resolve true when a publish newer than `afterSeq` arrives for `uri`, false on timeout/death. */
  waitForDiagnostics(uri: string, afterSeq: number, timeoutMs: number): Promise<boolean> {
    if (this.diagnosticsSeq(uri) > afterSeq) return Promise.resolve(true)
    if (!this.alive) return Promise.resolve(false)
    return new Promise((resolve) => {
      const done = (value: boolean): void => {
        clearTimeout(timer)
        this.waiters.delete(wake)
        resolve(value)
      }
      const wake = (changed: string): void => {
        if (!this.alive) done(false)
        else if (changed === uri && this.diagnosticsSeq(uri) > afterSeq) done(true)
      }
      const timer = setTimeout(() => done(false), timeoutMs)
      this.waiters.add(wake)
    })
  }

  /** Forget stored diagnostics of a uri (after `didClose`). */
  forget(uri: string): void {
    this.published.delete(uri)
  }

  /** `shutdown` + `exit`, then SIGKILL if the process lingers. Safe to call repeatedly. */
  async stop(): Promise<void> {
    if (this.alive) {
      try {
        await this.request('shutdown', null, 2000)
        this.notify('exit', null)
      } catch {
        // fall through to kill
      }
    }
    await this.kill()
  }

  private async kill(): Promise<void> {
    const proc = this.proc
    if (!proc) return
    if (proc.exitCode === null && proc.signalCode === null) {
      const grace = setTimeout(() => proc.kill('SIGKILL'), 1000)
      try {
        proc.stdin.end()
      } catch {
        // ignore
      }
      // give a polite exit a moment, then terminate
      const polite = setTimeout(() => proc.kill('SIGTERM'), 300)
      await this.exited
      clearTimeout(polite)
      clearTimeout(grace)
    }
    this.markDead('stopped')
  }
}
