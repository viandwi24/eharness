/**
 * The sync bridge (spec 28 §4): the mounted part of the virtual file system is copied into the
 * sandbox before a run and what the run created, changed or deleted is written back after it.
 * The sandbox is a disposable cache; the file system is the source of truth.
 *
 * Built only with the public core API (ADR-0008); Web APIs only.
 *
 * @see docs/specs/28-code-plugin.md
 */
import type { Experimental_SandboxSession as Sandbox } from 'ai'
import { compileGlobRegExp, errorText, normalizeRootedPath } from '../index.ts'
import { CODE_DIR, LIST_ARGS_PATH, LIST_SCRIPT, LIST_SCRIPT_PATH, MARKER_PATH } from './scripts.ts'

/** The sandbox type of the code plugin: AI SDK's `Experimental_SandboxSession`. */
export type { Sandbox }

/** A synced prefix of the virtual file system. */
export interface CodeMount {
  /** Directory prefix with a leading and a trailing `/` (`/work/`). */
  virtual: string
  /** Copied in, never written back. */
  readonly?: boolean
}

/** Resource limits of the code plugin (spec 28 §1). */
export interface CodeLimits {
  /** Default timeout of a run. Default 60 000 ms. */
  timeoutMs: number
  /** Upper bound of the model-chosen timeout. Default 300 000 ms. */
  maxTimeoutMs: number
  /** Cap of the output returned to the model (head + tail). Default 30 000 characters. */
  maxOutputChars: number
  /** Files per sync-in. Default 2 000. */
  maxSyncFiles: number
  /** Bytes per sync-in. Default 200 MiB. */
  maxSyncBytes: number
  /** Bytes per file, in and out. Default 50 MiB. */
  maxFileBytes: number
  /** Files written back per run. Default 500. */
  maxWriteBackFiles: number
}

/** Default {@link CodeLimits}. */
export const DEFAULT_CODE_LIMITS: Readonly<CodeLimits> = {
  timeoutMs: 60_000,
  maxTimeoutMs: 300_000,
  maxOutputChars: 30_000,
  maxSyncFiles: 2_000,
  maxSyncBytes: 200 * 1024 * 1024,
  maxFileBytes: 50 * 1024 * 1024,
  maxWriteBackFiles: 500,
}

/** Default ignore patterns of write-back (spec 28 §4.4). */
export const DEFAULT_CODE_IGNORE: readonly string[] = [
  '**/__pycache__/**',
  '**/*.pyc',
  '**/.ipynb_checkpoints/**',
  '**/.DS_Store',
]

/**
 * A sandbox with the optional extras of the code plugin (spec 28 §1). A `localSandbox` exposes
 * `state()` instead of `isolation`.
 */
export interface CodeSandbox extends Sandbox {
  /** Called at session close (remove a scratch directory, stop a container). */
  dispose?(): Promise<void>
  /** What isolation the driver gives. */
  isolation?: { isolated: boolean; label: string }
  /** Optional fast path for sync-out: files under `dir` with sha1, paths relative to the root. */
  listFiles?(dir: string): Promise<Array<{ path: string; size: number; sha1: string }>>
}

/** The part of a file's metadata the bridge uses (structural mirror of `FileMeta`). */
export interface CodeFileMeta {
  path: string
  version: string
  size: number
  binary?: boolean
  mediaType?: string
}

/**
 * The part of the `FileSystem` contract (spec 08 §1) the bridge uses. `eharness/code` never
 * imports another subpath (ADR-0008), so the contract is mirrored structurally: every
 * `FileSystem` is a `CodeFileSystem`.
 */
export interface CodeFileSystem {
  read(path: string): Promise<(CodeFileMeta & { content: string }) | null>
  write(
    path: string,
    content: string,
    opts?: { ifVersion?: string | null; author?: string },
  ): Promise<
    | { ok: true; version: string }
    | { ok: false; reason: 'conflict' | 'exists'; currentVersion?: string }
  >
  delete(
    path: string,
    opts?: { ifVersion?: string },
  ): Promise<{ ok: true } | { ok: false; reason: 'missing' | 'conflict'; currentVersion?: string }>
  list(prefix?: string): Promise<CodeFileMeta[]>
  readBytes?(path: string): Promise<{ bytes: Uint8Array; meta: CodeFileMeta } | null>
  writeBytes?(
    path: string,
    bytes: Uint8Array,
    opts?: { ifVersion?: string | null; mediaType?: string; author?: string },
  ): Promise<
    | { ok: true; version: string }
    | { ok: false; reason: 'conflict' | 'exists'; currentVersion?: string }
  >
}

/** The `filePolicy` service of the filesystem plugin (spec 08 §2), read structurally. */
export interface FilePolicyLike {
  isHidden(path: string): boolean
  isReadonly(path: string): boolean
  extensionAllowed(path: string): boolean
  isUndeletable(path: string): boolean
}

/** Why a file was not copied in or not saved. */
export interface SkippedFile {
  path: string
  reason: string
}

/** Result of {@link SyncedSandbox.syncIn}. */
export interface SyncInReport {
  /** The manifest was empty (first run, marker mismatch, reset): everything was considered. */
  full: boolean
  uploaded: string[]
  removed: string[]
  notCopied: SkippedFile[]
}

/** Result of {@link SyncedSandbox.syncOut}. */
export interface SyncOutReport {
  saved: string[]
  deleted: string[]
  notSaved: SkippedFile[]
  /** Set when nothing was written back because the run failed: the number of changed files. */
  failedRun?: number
}

/** One manifest entry (spec 28 §4.1). */
export interface ManifestEntry {
  fsVersion: string
  sha1: string
  size: number
}

/** Result of {@link SyncedSandbox.run}. */
export interface SandboxRunResult {
  /** `null` when the command did not finish normally. */
  exitCode: number | null
  /** stdout and stderr interleaved, capped (head + tail). */
  output: string
  timedOut: boolean
  aborted: boolean
  /** Set when the sandbox could not start or lost the command. */
  failure?: string
  seconds: number
}

/** Options of {@link SyncedSandbox.run}. */
export interface SandboxRunOptions {
  env?: Record<string, string>
  timeoutMs: number
  signal?: AbortSignal
  maxOutputChars: number
  /** Called with every decoded output chunk. */
  onOutput?: (chunk: string) => void
}

/** The bridge (spec 28 §4.6). */
export interface SyncedSandbox {
  syncIn(): Promise<SyncInReport>
  /** `ok = false` after a failed run: nothing is written back (see `writeBack`, spec 28 §4.3). */
  syncOut(ok: boolean): Promise<SyncOutReport>
  run(command: string, options: SandboxRunOptions): Promise<SandboxRunResult>
  manifest(): ReadonlyMap<string, ManifestEntry>
  /** Drop the manifest: the next sync-in is full. */
  reset(): void
  /** Run `fn` when no other exclusive section of this bridge runs (one run per session). */
  exclusive<T>(fn: () => Promise<T>): Promise<T>
}

/** Options of {@link syncedSandbox}. */
export interface SyncedSandboxOptions {
  fs: CodeFileSystem
  sandbox: Sandbox
  mounts: CodeMount[]
  limits?: Partial<CodeLimits>
  /** Glob patterns of paths never written back. Default {@link DEFAULT_CODE_IGNORE}. */
  ignore?: readonly string[]
  policy?: FilePolicyLike
  /** Authority per path (default: everything allowed). */
  access?: (path: string, op: 'read' | 'write' | 'delete') => boolean | Promise<boolean>
  /** Interpreter that runs the listing helper (a function is called each time). Default `python3`. */
  listCommand?: string | (() => string)
}

/** The listing of the sandbox's files failed (sync-out): no file was written back. */
export class SandboxListingError extends Error {}

/** Quote a string for a POSIX shell. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** SHA-1 hex of a string (Web Crypto). */
export async function sha1Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(text))
  let hex = ''
  for (const byte of new Uint8Array(digest)) hex += byte.toString(16).padStart(2, '0')
  return hex
}

const strictUtf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

/** Strict UTF-8 text of `bytes`, or `undefined` when the bytes are not text (NUL or invalid). */
function textOf(bytes: Uint8Array): string | undefined {
  if (bytes.subarray(0, 8192).includes(0)) return undefined
  try {
    return strictUtf8.decode(bytes)
  } catch {
    return undefined
  }
}

const MEDIA_TYPES: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  csv: 'text/csv',
  json: 'application/json',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  parquet: 'application/vnd.apache.parquet',
  zip: 'application/zip',
}

function mediaTypeOf(path: string): string | undefined {
  const dot = path.lastIndexOf('.')
  return dot < 0 ? undefined : MEDIA_TYPES[path.slice(dot + 1).toLowerCase()]
}

/** `50 MB` style size for a limit (decimal places dropped). */
export function megabytes(bytes: number): string {
  return `${Math.max(1, Math.round(bytes / (1024 * 1024)))} MB`
}

/** Names that cannot round-trip (control characters, lone surrogates, a path the file system rejects). */
function nameSupported(path: string): boolean {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are the point
  if (/[\u0000-\u001f\u007f]/.test(path)) return false
  if (/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(path)) {
    return false
  }
  const n = normalizeRootedPath(path)
  return n.ok && n.path === path
}

/** Sandbox-relative path of a virtual path (`/work/a.csv` → `work/a.csv`). */
export function sandboxPath(virtual: string): string {
  return virtual.slice(1)
}

function mountDir(mount: CodeMount): string {
  return mount.virtual === '/' ? '.' : mount.virtual.slice(1, -1)
}

function underReserved(virtual: string): boolean {
  return virtual === `/${CODE_DIR}` || virtual.startsWith(`/${CODE_DIR}/`)
}

/**
 * The sync bridge without the tools (spec 28 §4.6). Used by `code()`; usable by other plugins.
 *
 * @example
 * ```ts
 * const bridge = syncedSandbox({ fs, sandbox, mounts: [{ virtual: '/work/' }] })
 * await bridge.exclusive(async () => {
 *   await bridge.syncIn()
 *   const run = await bridge.run('python3 work/a.py', { timeoutMs: 60_000, maxOutputChars: 30_000 })
 *   return bridge.syncOut(run.exitCode === 0)
 * })
 * ```
 * @see docs/specs/28-code-plugin.md#46-syncedsandbox
 */
export function syncedSandbox(options: SyncedSandboxOptions): SyncedSandbox {
  const { fs, sandbox, mounts, policy } = options
  const limits: CodeLimits = { ...DEFAULT_CODE_LIMITS, ...options.limits }
  const allow = options.access ?? (() => true)
  const listCommand = (): string =>
    typeof options.listCommand === 'function'
      ? options.listCommand()
      : (options.listCommand ?? 'python3')
  const ignoreRegexes: RegExp[] = []
  for (const pattern of options.ignore ?? DEFAULT_CODE_IGNORE) {
    const compiled = compileGlobRegExp(pattern, { dot: true })
    if (compiled.ok) ignoreRegexes.push(compiled.regex)
  }
  const ignoreSources = ignoreRegexes.map((r) => r.source)
  const ignored = (virtual: string): boolean =>
    ignoreRegexes.some((r) => r.test(sandboxPath(virtual)))

  const manifest = new Map<string, ManifestEntry>()
  let markerId: string | undefined
  /** Set by `reset()`: the sandbox's mount directories may hold stale files; the next sync-in clears them. */
  let dirty = false
  let chain: Promise<unknown> = Promise.resolve()

  const mountOf = (virtual: string): CodeMount | undefined => {
    let best: CodeMount | undefined
    for (const m of mounts) {
      if (
        virtual.startsWith(m.virtual) &&
        (best === undefined || m.virtual.length > best.virtual.length)
      ) {
        best = m
      }
    }
    return best
  }

  /** Remove files in the sandbox; a failed removal marks the bridge dirty (full wipe on the next sync-in). */
  async function removeInSandbox(paths: string[]): Promise<void> {
    for (let i = 0; i < paths.length; i += 50) {
      const batch = paths.slice(i, i + 50)
      try {
        const result = await sandbox.run({
          command: `rm -f -- ${batch.map((p) => shellQuote(sandboxPath(p))).join(' ')}`,
        })
        if (result.exitCode !== 0) dirty = true
      } catch {
        dirty = true
      }
    }
  }

  /** Returns true when the marker did not match (first run or a replaced sandbox). */
  async function ensureMarker(): Promise<boolean> {
    const found = await sandbox.readTextFile({ path: MARKER_PATH })
    if (markerId !== undefined && found === markerId) return false
    manifest.clear()
    markerId = crypto.randomUUID()
    await sandbox.writeTextFile({ path: LIST_SCRIPT_PATH, content: LIST_SCRIPT })
    await sandbox.writeTextFile({ path: MARKER_PATH, content: markerId })
    return true
  }

  /** Files of the sandbox under the mounts (or only `only`), ignore patterns applied by the helper. */
  async function listSandbox(
    only?: string[],
  ): Promise<Map<string, { size: number; sha1: string }>> {
    const out = new Map<string, { size: number; sha1: string }>()
    const keep = only === undefined ? undefined : new Set(only.map(sandboxPath))
    const fast = (sandbox as CodeSandbox).listFiles
    if (typeof fast === 'function') {
      for (const m of mounts) {
        for (const f of await fast.call(sandbox, mountDir(m))) {
          if (keep !== undefined && !keep.has(f.path)) continue
          out.set(`/${f.path}`, { size: f.size, sha1: f.sha1 })
        }
      }
    } else {
      // The helper and its arguments live in a directory the script can write: rewrite both before
      // every listing so a forged lister never runs, and run it isolated (`-I`).
      await sandbox.writeTextFile({ path: LIST_SCRIPT_PATH, content: LIST_SCRIPT })
      await sandbox.writeTextFile({
        path: LIST_ARGS_PATH,
        content: JSON.stringify({
          dirs: mounts.map(mountDir),
          ignore: ignoreSources,
          ...(keep === undefined ? {} : { only: [...keep] }),
        }),
      })
      const result = await sandbox.run({
        command: `${shellQuote(listCommand())} -I ${shellQuote(LIST_SCRIPT_PATH)} ${shellQuote(LIST_ARGS_PATH)}`,
      })
      if (result.exitCode !== 0) {
        throw new SandboxListingError((result.stderr || result.stdout).slice(-300))
      }
      let rows: unknown
      try {
        rows = JSON.parse(result.stdout)
      } catch {
        throw new SandboxListingError('the helper printed no JSON')
      }
      for (const row of rows as Array<{ path: string; size: number; sha1: string }>) {
        out.set(`/${row.path}`, { size: row.size, sha1: row.sha1 })
      }
    }
    for (const virtual of [...out.keys()]) {
      if (underReserved(virtual) || ignored(virtual) || mountOf(virtual) === undefined) {
        out.delete(virtual)
      }
    }
    return out
  }

  async function syncIn(): Promise<SyncInReport> {
    if (await ensureMarker()) dirty = true
    if (dirty) {
      manifest.clear()
      const dirs = mounts.filter((m) => m.virtual !== '/').map((m) => shellQuote(mountDir(m)))
      if (dirs.length > 0) await sandbox.run({ command: `rm -rf -- ${dirs.join(' ')}` })
      if (mounts.some((m) => m.virtual === '/')) {
        await sandbox.run({
          command: 'find . -mindepth 1 -maxdepth 1 ! -name .eh-code -exec rm -rf {} +',
        })
      }
      dirty = false
    }
    // Symlinks are never syncable: a script may have planted one that points out of the root.
    // Remove them before anything is uploaded (the host-side writes must not follow them).
    await sandbox.run({
      command: `find ${mounts.map((m) => shellQuote(mountDir(m))).join(' ')} -type l -delete 2>/dev/null; true`,
    })
    const full = manifest.size === 0
    const notCopied: SkippedFile[] = []
    const wanted: CodeFileMeta[] = []
    for (const m of mounts) {
      const metas = await fs.list(m.virtual)
      for (const meta of metas) {
        if (!meta.path.startsWith(m.virtual) || underReserved(meta.path)) continue
        if (policy?.isHidden(meta.path) === true) continue
        if (!(await allow(meta.path, 'read'))) continue
        wanted.push(meta)
      }
    }
    wanted.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    const included: CodeFileMeta[] = []
    let bytes = 0
    for (const meta of wanted) {
      if (meta.size > limits.maxFileBytes) {
        notCopied.push({ path: meta.path, reason: `larger than ${megabytes(limits.maxFileBytes)}` })
      } else if (included.length >= limits.maxSyncFiles) {
        notCopied.push({ path: meta.path, reason: `too many files (limit ${limits.maxSyncFiles})` })
      } else if (bytes + meta.size > limits.maxSyncBytes) {
        notCopied.push({
          path: meta.path,
          reason: `over the sync size limit (${megabytes(limits.maxSyncBytes)})`,
        })
      } else {
        bytes += meta.size
        included.push(meta)
      }
    }
    const includedPaths = new Set(included.map((f) => f.path))
    const uploaded: string[] = []
    for (const meta of included) {
      if (manifest.get(meta.path)?.fsVersion === meta.version) continue
      const target = sandboxPath(meta.path)
      if (meta.binary === true) {
        if (fs.readBytes === undefined) {
          notCopied.push({
            path: meta.path,
            reason: 'binary files are not supported by this file system',
          })
          includedPaths.delete(meta.path)
          continue
        }
        const file = await fs.readBytes(meta.path)
        if (file === null) {
          includedPaths.delete(meta.path)
          continue
        }
        await sandbox.writeBinaryFile({ path: target, content: file.bytes })
        manifest.set(meta.path, { fsVersion: file.meta.version, sha1: '', size: file.bytes.length })
      } else {
        const file = await fs.read(meta.path)
        if (file === null) {
          includedPaths.delete(meta.path)
          continue
        }
        await sandbox.writeTextFile({ path: target, content: file.content })
        manifest.set(meta.path, { fsVersion: file.version, sha1: '', size: file.size })
      }
      uploaded.push(meta.path)
    }
    const removed: string[] = []
    for (const path of manifest.keys()) {
      if (!includedPaths.has(path)) removed.push(path)
    }
    if (removed.length > 0) {
      await removeInSandbox(removed)
      for (const path of removed) manifest.delete(path)
    }
    if (uploaded.length > 0) {
      const listing = await listSandbox(uploaded)
      for (const path of uploaded) {
        const entry = manifest.get(path)
        const seen = listing.get(path)
        if (entry !== undefined) manifest.set(path, { ...entry, sha1: seen?.sha1 ?? '' })
      }
    }
    return { full, uploaded, removed, notCopied }
  }

  async function syncOut(ok: boolean): Promise<SyncOutReport> {
    const listing = await listSandbox()
    const created: string[] = []
    const changed: string[] = []
    const gone: string[] = []
    for (const [path, now] of listing) {
      const base = manifest.get(path)
      if (base === undefined) created.push(path)
      else if (base.sha1 !== now.sha1) changed.push(path)
    }
    for (const path of manifest.keys()) {
      if (!listing.has(path) && !ignored(path)) gone.push(path)
    }
    created.sort()
    changed.sort()
    gone.sort()
    const report: SyncOutReport = { saved: [], deleted: [], notSaved: [] }
    if (!ok) {
      const total = created.length + changed.length + gone.length
      for (const path of [...changed, ...gone]) manifest.delete(path)
      if (created.length > 0) await removeInSandbox(created)
      if (total > 0) report.failedRun = total
      return report
    }
    const work = [
      ...created.map((path) => ({ path, op: 'write' as const })),
      ...changed.map((path) => ({ path, op: 'write' as const })),
      ...gone.map((path) => ({ path, op: 'delete' as const })),
    ].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    const skip = (path: string, reason: string): void => {
      report.notSaved.push({ path, reason })
      manifest.delete(path)
    }
    let count = 0
    for (const { path, op } of work) {
      try {
        await writeBackOne(path, op)
      } catch (error) {
        skip(path, `could not be saved: ${errorText(error)}`)
      }
    }
    return report

    async function writeBackOne(path: string, op: 'write' | 'delete'): Promise<void> {
      if (count >= limits.maxWriteBackFiles) {
        skip(path, `too many files changed (limit ${limits.maxWriteBackFiles})`)
        return
      }
      count++
      const mount = mountOf(path)
      if (mount === undefined) return
      if (op === 'delete') {
        if (mount.readonly === true || policy?.isReadonly(path) === true) {
          skip(path, 'read-only')
        } else if (policy?.isUndeletable(path) === true) {
          skip(path, 'cannot be deleted')
        } else if (!(await allow(path, 'delete'))) {
          skip(path, 'not allowed')
        } else {
          const base = manifest.get(path)
          const result = await fs.delete(
            path,
            base === undefined ? {} : { ifVersion: base.fsVersion },
          )
          if (result.ok || result.reason === 'missing') {
            report.deleted.push(path)
            manifest.delete(path)
          } else {
            skip(path, 'changed in the file system while the code ran')
          }
        }
        return
      }
      const now = listing.get(path) as { size: number; sha1: string }
      if (!nameSupported(path)) {
        skip(path, 'file name not supported')
      } else if (mount.readonly === true || policy?.isReadonly(path) === true) {
        skip(path, 'read-only')
      } else if (policy?.isHidden(path) === true || !(await allow(path, 'write'))) {
        skip(path, 'not allowed')
      } else if (policy?.extensionAllowed(path) === false) {
        skip(path, 'extension not allowed')
      } else if (now.size > limits.maxFileBytes) {
        skip(path, `larger than ${megabytes(limits.maxFileBytes)}`)
      } else {
        const content = await sandbox.readBinaryFile({ path: sandboxPath(path) })
        if (content === null) return
        const text = textOf(content)
        const ifVersion = manifest.get(path)?.fsVersion ?? null
        let result: Awaited<ReturnType<CodeFileSystem['write']>>
        if (text !== undefined) {
          result = await fs.write(path, text, { ifVersion })
        } else if (fs.writeBytes === undefined) {
          skip(path, 'binary files are not supported by this file system')
          return
        } else {
          const mediaType = mediaTypeOf(path)
          result = await fs.writeBytes(path, content, {
            ifVersion,
            ...(mediaType === undefined ? {} : { mediaType }),
          })
        }
        if (result.ok) {
          manifest.set(path, { fsVersion: result.version, sha1: now.sha1, size: now.size })
          report.saved.push(path)
        } else {
          skip(path, 'changed in the file system while the code ran')
        }
      }
    }
  }

  async function run(command: string, opts: SandboxRunOptions): Promise<SandboxRunResult> {
    const started = Date.now()
    const seconds = (): number => (Date.now() - started) / 1000
    let proc: Awaited<ReturnType<Sandbox['spawn']>>
    try {
      proc = await sandbox.spawn({ command, ...(opts.env === undefined ? {} : { env: opts.env }) })
    } catch (error) {
      return {
        exitCode: null,
        output: '',
        timedOut: false,
        aborted: false,
        failure: errorText(error),
        seconds: seconds(),
      }
    }
    let timedOut = false
    let aborted = false
    const timer = setTimeout(() => {
      timedOut = true
      void proc.kill()
    }, opts.timeoutMs)
    const onAbort = (): void => {
      aborted = true
      void proc.kill()
    }
    if (opts.signal?.aborted) onAbort()
    else opts.signal?.addEventListener('abort', onAbort, { once: true })
    const buffer = new OutputBuffer(opts.maxOutputChars)
    const pump = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
      const decoder = new TextDecoder()
      const emit = (chunk: string): void => {
        if (chunk === '') return
        buffer.add(chunk)
        opts.onOutput?.(chunk)
      }
      try {
        for await (const part of stream) emit(decoder.decode(part, { stream: true }))
        emit(decoder.decode())
      } catch {
        // stream torn down by a kill
      }
    }
    let exitCode: number | null = null
    let failure: string | undefined
    try {
      const [, , result] = await Promise.all([pump(proc.stdout), pump(proc.stderr), proc.wait()])
      exitCode = result.exitCode
    } catch (error) {
      if (!aborted && !timedOut) failure = errorText(error)
    } finally {
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
    }
    return {
      exitCode: failure === undefined && !timedOut && !aborted ? exitCode : null,
      output: buffer.text(),
      timedOut,
      aborted,
      ...(failure === undefined ? {} : { failure }),
      seconds: seconds(),
    }
  }

  return {
    syncIn,
    syncOut,
    run,
    manifest: () => manifest,
    reset: () => {
      manifest.clear()
      dirty = true
    },
    exclusive: <T>(fn: () => Promise<T>): Promise<T> => {
      const next = chain.then(fn, fn)
      chain = next.catch(() => undefined)
      return next
    },
  }
}

const HEAD_CHARS = 10_000

/** Keeps the head and a rolling tail of an output stream: memory is bounded by the cap. */
class OutputBuffer {
  private head = ''
  private tail = ''
  private total = 0
  private readonly headMax: number
  private readonly tailMax: number
  constructor(private readonly max: number) {
    this.headMax = Math.min(HEAD_CHARS, Math.floor(max / 3))
    this.tailMax = max - this.headMax
  }
  add(chunk: string): void {
    this.total += chunk.length
    let rest = chunk
    if (this.head.length < this.headMax) {
      const take = this.headMax - this.head.length
      this.head += rest.slice(0, take)
      rest = rest.slice(take)
    }
    this.tail += rest
    if (this.tail.length > this.tailMax * 2) this.tail = this.tail.slice(-this.tailMax)
  }
  text(): string {
    if (this.total <= this.max) return this.head + this.tail
    const tail = this.tail.slice(-this.tailMax)
    const omitted = this.total - this.head.length - tail.length
    return `${this.head}\n… [${omitted} characters omitted] …\n${tail}`
  }
}
