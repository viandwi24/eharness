/**
 * `run_code` runner (decision D8): JavaScript the model wrote, executed by Bun in a subprocess over
 * a per-run scratch directory. This module knows nothing about the library or programs: the caller
 * hands it the input files (path to bytes) and gets back stdout, stderr and the files the code
 * created or changed. What may be read and written is decided before and after, by the caller.
 *
 * Isolation, as strong as the host allows:
 * - OS sandbox (`localSandbox({ os: { enabled: true, network: false } })`, Seatbelt on macOS,
 *   bubblewrap on Linux): the process cannot write outside the scratch directory (and the temp
 *   directories), and has no network. It CAN still read the host file system: the library OS
 *   sandbox restricts writes and network, not reads. Do not put secrets in files an agent could
 *   find, and use a container when the code is not trusted at all.
 * - without an OS sandbox (platform tool missing, or `osSandbox: false`): the same limits, the
 *   environment stripped (only the library's allow-list), and a soft network guard inside the
 *   process (fetch, WebSocket and Bun sockets throw). That guard is a courtesy for honest code,
 *   not a security boundary. `requireOsSandbox: true` refuses to run instead.
 * - always: the scratch directory is private to the run and removed afterwards, the environment is
 *   stripped (HOME points at the scratch directory), a wall-clock timeout, a CPU-time limit
 *   (`ulimit -t`), a file-size limit (`ulimit -f`), capped stdout/stderr, and caps on the number
 *   and bytes of files in and out. Memory is not limited.
 */
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'
import { detectOsSandbox, localSandbox } from 'eharness/shell'

export interface CodeLimits {
  /** Wall-clock limit of one run (ms). */
  timeoutMs: number
  /** The longest timeout a caller may ask for (ms). */
  maxTimeoutMs: number
  /** Bytes of stdout and of stderr returned (each). */
  maxOutputBytes: number
  /** Files copied into the scratch directory. */
  maxInputFiles: number
  /** Bytes copied into the scratch directory. */
  maxInputBytes: number
  /** Files the code may leave behind (new or changed). */
  maxOutputFiles: number
  /** Total bytes of the files left behind. */
  maxOutputFileBytes: number
  /** Largest single file left behind or created (also `ulimit -f`). */
  maxFileBytes: number
}

export const DEFAULT_LIMITS: CodeLimits = {
  timeoutMs: 30_000,
  maxTimeoutMs: 120_000,
  maxOutputBytes: 12_000,
  maxInputFiles: 600,
  maxInputBytes: 32 * 1024 * 1024,
  maxOutputFiles: 400,
  maxOutputFileBytes: 16 * 1024 * 1024,
  maxFileBytes: 8 * 1024 * 1024,
}

export interface CodeRunnerOptions {
  /** The Bun binary. Default: the running one. */
  bunPath?: string
  /** Where scratch directories are made. Default: the OS temp directory. */
  scratchRoot?: string
  /** Ask for the OS sandbox. Default true (used when the platform has the tool). */
  osSandbox?: boolean
  /** Refuse to run when no OS sandbox is available. Default false. */
  requireOsSandbox?: boolean
  limits?: Partial<CodeLimits>
}

export interface CodeRequest {
  code: string
  /** Library path (absolute, `/library/...`) to content. */
  inputs: ReadonlyMap<string, Uint8Array>
  timeoutMs?: number
  signal?: AbortSignal
}

export interface CodeResult {
  /** `null`: killed (timeout, output cap, abort). */
  exitCode: number | null
  timedOut: boolean
  aborted: boolean
  stdout: string
  stderr: string
  /** Output was cut at the cap (the run was stopped). */
  outputTruncated: boolean
  /** Files created or changed, library path to content. Empty unless the run succeeded. */
  files: Map<string, Uint8Array>
  /** Files the code left that were not collected, with why. */
  skipped: Array<{ path: string; reason: string }>
  durationMs: number
  sandbox: { os: boolean; kind: string; network: boolean }
  /** Set when the run could not start at all. */
  error?: string
}

const PRELUDE = `import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

const ROOT = join(process.cwd(), 'fs')
const real = (p) => {
  if (typeof p !== 'string' || !p.startsWith('/')) throw new Error('library paths start with "/": ' + p)
  if (p.split('/').includes('..')) throw new Error('no ".." in paths: ' + p)
  return join(ROOT, p)
}
const walk = (dir, out = []) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name)
    if (e.isDirectory()) walk(full, out)
    else if (e.isFile()) out.push(full)
  }
  return out
}
const readText = (p) => readFileSync(real(p), 'utf8')
const readJsonl = (p) =>
  readText(p)
    .split('\\n')
    .filter((l) => l.trim() !== '')
    .map((l, i) => {
      try { return JSON.parse(l) } catch { throw new Error(p + ': line ' + (i + 1) + ' is not JSON') }
    })
const list = (prefix = '/') => {
  const dir = real(prefix)
  if (!existsSync(dir)) return []
  if (statSync(dir).isFile()) return [prefix]
  return walk(dir).map((f) => f.slice(ROOT.length)).sort()
}
const write = (p, text) => {
  const file = real(p)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, text)
}
const api = {
  readText,
  readJson: (p) => JSON.parse(readText(p)),
  readJsonl,
  readJsonlDir: (prefix, ext = '.jsonl') => list(prefix).filter((p) => p.endsWith(ext)).flatMap(readJsonl),
  list,
  exists: (p) => existsSync(real(p)),
  writeText: write,
  writeJson: (p, value) => write(p, JSON.stringify(value, null, 2) + '\\n'),
  writeJsonl: (p, rows) => write(p, rows.map((r) => JSON.stringify(r)).join('\\n') + (rows.length ? '\\n' : '')),
  chunkBySize: (rows, maxBytes) => {
    const out = []
    let cur = []
    let size = 0
    for (const row of rows) {
      const n = JSON.stringify(row).length + 1
      if (cur.length > 0 && size + n > maxBytes) { out.push(cur); cur = []; size = 0 }
      cur.push(row)
      size += n
    }
    if (cur.length > 0) out.push(cur)
    return out
  },
  print: (v) => console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2)),
}
Object.assign(globalThis, api)

if (process.env.EH_NO_NET === '1') {
  const deny = () => { throw new Error('network access is not available in run_code') }
  try { globalThis.fetch = deny } catch {}
  try { globalThis.WebSocket = class { constructor() { deny() } } } catch {}
  if (globalThis.Bun) for (const name of ['connect', 'listen', 'serve', 'udpSocket']) { try { Bun[name] = deny } catch {} }
}
`

const shellQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`

/** Library path to a scratch path under `<root>/fs`. */
function scratchPath(root: string, libraryPath: string): string {
  return join(root, 'fs', ...libraryPath.split('/').filter((s) => s !== ''))
}

async function readCapped(
  stream: ReadableStream<Uint8Array>,
  cap: number,
  onOverflow: () => void,
): Promise<{ text: string; truncated: boolean }> {
  const chunks: Uint8Array[] = []
  let size = 0
  let truncated = false
  for await (const chunk of stream) {
    if (size >= cap) continue
    const room = cap - size
    chunks.push(chunk.length > room ? chunk.subarray(0, room) : chunk)
    size += Math.min(chunk.length, room)
    if (chunk.length > room || size >= cap) {
      if (!truncated) onOverflow()
      truncated = true
    }
  }
  return { text: new TextDecoder().decode(Buffer.concat(chunks)), truncated }
}

async function collectFiles(
  root: string,
  inputs: ReadonlyMap<string, Uint8Array>,
  limits: CodeLimits,
): Promise<{ files: Map<string, Uint8Array>; skipped: Array<{ path: string; reason: string }> }> {
  const files = new Map<string, Uint8Array>()
  const skipped: Array<{ path: string; reason: string }> = []
  const base = join(root, 'fs')
  let total = 0
  const walk = async (dir: string): Promise<void> => {
    let entries: string[]
    try {
      entries = (await readdir(dir)).sort()
    } catch {
      return
    }
    for (const name of entries) {
      const full = join(dir, name)
      const libraryPath = `/${relative(base, full).split(sep).join('/')}`
      const info = await lstat(full)
      if (info.isSymbolicLink()) {
        skipped.push({ path: libraryPath, reason: 'a symbolic link is not collected' })
      } else if (info.isDirectory()) {
        await walk(full)
      } else if (info.isFile()) {
        if (info.size > limits.maxFileBytes) {
          skipped.push({ path: libraryPath, reason: `larger than ${limits.maxFileBytes} bytes` })
          continue
        }
        const bytes = new Uint8Array(await readFile(full))
        const before = inputs.get(libraryPath)
        if (before !== undefined && Buffer.compare(before, bytes) === 0) continue // unchanged input
        if (files.size >= limits.maxOutputFiles) {
          skipped.push({ path: libraryPath, reason: `more than ${limits.maxOutputFiles} files` })
          continue
        }
        if (total + bytes.length > limits.maxOutputFileBytes) {
          skipped.push({ path: libraryPath, reason: 'the total size of the files is over the cap' })
          continue
        }
        total += bytes.length
        files.set(libraryPath, bytes)
      }
    }
  }
  await walk(base)
  return { files, skipped }
}

export interface CodeRunner {
  run(request: CodeRequest): Promise<CodeResult>
  limits: CodeLimits
  /** What this host gives: the OS sandbox kind (`none` = the fallback). */
  describe(): { os: boolean; kind: string; network: boolean }
}

export function createCodeRunner(options: CodeRunnerOptions = {}): CodeRunner {
  const limits: CodeLimits = { ...DEFAULT_LIMITS, ...options.limits }
  const bun = options.bunPath ?? process.execPath
  const detected = detectOsSandbox()
  const wantOs = options.osSandbox !== false
  const osOn = wantOs && detected.kind !== 'none'
  const kind = osOn ? detected.kind : 'none'

  return {
    limits,
    describe: () => ({ os: osOn, kind, network: false }),
    async run(request) {
      const started = Date.now()
      const empty: CodeResult = {
        exitCode: null,
        timedOut: false,
        aborted: false,
        stdout: '',
        stderr: '',
        outputTruncated: false,
        files: new Map(),
        skipped: [],
        durationMs: 0,
        sandbox: { os: osOn, kind, network: false },
      }
      if (!osOn && options.requireOsSandbox === true) {
        return {
          ...empty,
          error:
            'run_code needs an OS sandbox (Seatbelt or bubblewrap) and this host has none; it is configured to refuse unsandboxed code.',
        }
      }
      const timeoutMs = Math.min(request.timeoutMs ?? limits.timeoutMs, limits.maxTimeoutMs)
      const root = await mkdtemp(join(options.scratchRoot ?? tmpdir(), 'team-code-'))
      try {
        await writeFile(join(root, 'eh.mjs'), PRELUDE)
        await writeFile(join(root, 'main.mjs'), `import './eh.mjs'\n${request.code}\n`)
        for (const [path, bytes] of request.inputs) {
          const target = scratchPath(root, path)
          await mkdir(dirname(target), { recursive: true })
          await writeFile(target, bytes)
        }
        await mkdir(join(root, 'fs'), { recursive: true })

        const sandbox = localSandbox({
          root,
          os: { enabled: osOn, network: false },
          env: {
            HOME: root,
            TMPDIR: root,
            NO_COLOR: '1',
            ...(osOn ? {} : { EH_NO_NET: '1' }),
          },
        })
        const cpuSeconds = Math.max(1, Math.ceil(timeoutMs / 1000) + 2)
        const blocks = Math.ceil(limits.maxFileBytes / 512)
        const command = `ulimit -t ${cpuSeconds} 2>/dev/null; ulimit -f ${blocks} 2>/dev/null; exec ${shellQuote(bun)} --no-env-file main.mjs`

        const controller = new AbortController()
        let timedOut = false
        const timer = setTimeout(() => {
          timedOut = true
          controller.abort(new Error('timeout'))
        }, timeoutMs)
        const onOuter = (): void => controller.abort(request.signal?.reason)
        request.signal?.addEventListener('abort', onOuter, { once: true })
        if (request.signal?.aborted) onOuter()

        let proc: Awaited<ReturnType<typeof sandbox.spawn>>
        try {
          proc = await sandbox.spawn({ command, abortSignal: controller.signal })
        } catch (error) {
          clearTimeout(timer)
          request.signal?.removeEventListener('abort', onOuter)
          return { ...empty, error: `could not start the code runner: ${String(error)}` }
        }
        const kill = (): void => {
          void proc.kill()
        }
        const [out, err, exit] = await Promise.all([
          readCapped(proc.stdout, limits.maxOutputBytes, kill),
          readCapped(proc.stderr, limits.maxOutputBytes, kill),
          proc.wait().then(
            (r) => r.exitCode as number | null,
            () => null,
          ),
        ])
        clearTimeout(timer)
        request.signal?.removeEventListener('abort', onOuter)
        const outputTruncated = out.truncated || err.truncated
        // killed for output size: the exit code is the signal's, report it as no exit
        const exitCode = outputTruncated ? null : exit
        const ok = exitCode === 0 && !timedOut && !controller.signal.aborted
        const collected = ok
          ? await collectFiles(root, request.inputs, limits)
          : { files: new Map<string, Uint8Array>(), skipped: [] }
        return {
          ...empty,
          exitCode,
          timedOut,
          aborted: !timedOut && controller.signal.aborted,
          stdout: out.text,
          stderr: err.text,
          outputTruncated,
          files: collected.files,
          skipped: collected.skipped,
          durationMs: Date.now() - started,
        }
      } finally {
        await rm(root, { recursive: true, force: true }).catch(() => undefined)
      }
    },
  }
}
