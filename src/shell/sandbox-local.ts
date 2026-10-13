/**
 * Local sandbox: the AI SDK `SandboxSession` shape over `node:child_process` and `node:fs/promises`.
 * By default NOT isolated: commands run with the user's privileges and permissions are enforced
 * by the permission engine. With `opts.os.enabled` (and a platform tool, see `os-sandbox.ts`)
 * every command runs in an OS sandbox: writes only in the root, `allowWrite` and temp dirs.
 * File tools (`readFile`/`writeFile`) are unaffected: they run in this process.
 */
import { type ChildProcess, spawn as spawnChild } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import type {
  Experimental_SandboxProcess as SandboxProcess,
  Experimental_SandboxSession as SandboxSession,
} from 'ai'
import { HarnessError } from '../index.ts'
import {
  defaultShell,
  detectOsSandbox,
  type OsSandboxKind,
  readPolicy,
  wrapCommand,
} from './os-sandbox.ts'

/** The sandbox type of the shell plugin: AI SDK's `Experimental_SandboxSession`. */
export type Sandbox = SandboxSession

/** OS sandbox settings of a local sandbox. */
export interface OsSandboxOptions {
  enabled: boolean
  /** Allow network access inside the OS sandbox. Default `false`. */
  network?: boolean
  /** Extra writable directories (absolute, or relative to the root). */
  allowWrite?: string[]
  /** Paths (absolute, or relative to the root) whose content commands cannot read. */
  denyRead?: string[]
  /**
   * Deny reading the home directory, except the root, `allowWrite` and `allowRead` entries inside
   * it. Default `false`.
   */
  denyReadHome?: boolean
  /** Paths re-allowed for reading inside a denied path (absolute, or relative to the root). */
  allowRead?: string[]
  /** Home directory `denyReadHome` hides. Default `os.homedir()`. */
  home?: string
}

/** Resource limits of every command (`ulimit` in the spawned shell). */
export interface SandboxLimits {
  /** CPU seconds (`ulimit -t`). */
  cpuSeconds?: number
  /** Largest file a command may write, in bytes (`ulimit -f`; rounded up to the shell's block size). */
  fileBytes?: number
  /** Address space in bytes (`ulimit -v`). Linux only: not enforced (not applied) on macOS. */
  memoryBytes?: number
  /** Processes of the user (`ulimit -u`); applied best effort, ignored where unsupported. */
  processes?: number
}

/** Options of {@link localSandbox}. */
export interface LocalSandboxOptions {
  /** Absolute project root: the default working directory of every command. */
  root: string
  /** OS isolation of commands (default: off). */
  os?: OsSandboxOptions
  /**
   * Extra environment variables of every command, on top of the inherited ones. By default a
   * command sees only the {@link SAFE_ENV_NAMES} of `process.env`, so API keys and database URLs
   * of the host process do not reach commands the model writes.
   */
  env?: Record<string, string>
  /**
   * Pass the whole `process.env` to commands (inherit the whole process environment). Default `false`: only the
   * safe allow-list ({@link SAFE_ENV_NAMES}, `LC_*`) is inherited.
   */
  inheritEnv?: boolean
  /** Shell binary (`<shell> -c <command>`). Default `/bin/bash`, else `/bin/sh`. */
  shell?: string
  /** Resource limits applied to every command with `ulimit` (see {@link SandboxLimits}). */
  limits?: SandboxLimits
}

/** Current OS sandbox state: `enabled` is true only when requested AND the platform tool exists. */
export interface SandboxState {
  enabled: boolean
  kind: OsSandboxKind
  network: boolean
  /** Directories commands may write to (the root and `allowWrite`; temp dirs come on top). */
  writableRoots: string[]
  /** Effective list of paths commands cannot read (empty when the OS sandbox is not active). */
  denyRead: string[]
}

/** A {@link Sandbox} whose OS isolation can be inspected and toggled at runtime. */
export type LocalSandbox = Sandbox & {
  /** Current OS sandbox state. */
  state(): SandboxState
  /** Replace the OS sandbox settings; applies to commands started afterwards. */
  setOs(opts: OsSandboxOptions): void
}

/** Names of `process.env` variables a command inherits by default (also `LC_*`), see {@link safeEnv}. */
export const SAFE_ENV_NAMES: readonly string[] = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'TERM',
  'TMPDIR',
  'TZ',
  // Windows
  'SYSTEMROOT',
  'SYSTEMDRIVE',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
  'TEMP',
  'TMP',
  'USERPROFILE',
]

/** The allow-listed part of an environment: {@link SAFE_ENV_NAMES} and `LC_*` (names compared upper-case). */
export function safeEnv(
  source: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue
    const key = name.toUpperCase()
    if (SAFE_ENV_NAMES.includes(key) || key.startsWith('LC_')) out[name] = value
  }
  return out
}

type ProcessOptions = Parameters<SandboxSession['spawn']>[0]

const KILL_GRACE_MS = 2000
/** Pids (= process group ids) of live commands, across all sandboxes in this process. */
const liveGroups = new Set<number>()

function signalGroupPid(pid: number, name: NodeJS.Signals): void {
  try {
    process.kill(-pid, name)
  } catch {
    try {
      process.kill(pid, name)
    } catch {
      // already gone
    }
  }
}

/**
 * Terminate every command still running in a local sandbox (call it from SIGINT/SIGTERM/exit
 * handlers). Sends `signal` (default SIGTERM) synchronously to each process group, then SIGKILL
 * after 2 s via an unref'd timer; the timer cannot run during `process.exit`, so a handler that
 * exits right away should call this with `'SIGKILL'` or wait ~2 s.
 */
export function killAllSandboxProcesses(signal: NodeJS.Signals = 'SIGTERM'): void {
  const pids = [...liveGroups]
  for (const pid of pids) signalGroupPid(pid, signal)
  if (signal === 'SIGKILL' || pids.length === 0) return
  setTimeout(() => {
    for (const pid of pids) if (liveGroups.has(pid)) signalGroupPid(pid, 'SIGKILL')
  }, KILL_GRACE_MS).unref()
}

const SIGNAL_NUMBERS: Record<string, number> = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15, SIGKILL: 9 }

/** Decode text with a TextDecoder label; unknown labels fall back to UTF-8. */
function decoder(encoding: string | undefined): TextDecoder {
  try {
    return new TextDecoder(encoding ?? 'utf-8')
  } catch {
    return new TextDecoder('utf-8')
  }
}

function isMissing(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

function checkLimit(name: string, value: number | undefined): void {
  if (value === undefined) return
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new HarnessError(
      'EH_CONFIG_INVALID',
      `shell: \`limits.${name}\` must be an integer ≥ 1.`,
      {
        details: { plugin: 'shell', option: `limits.${name}` },
      },
    )
  }
}

/** `ulimit` prefix of a command; `''` without limits. */
function limitsPrefix(limits: SandboxLimits | undefined, shell: string): string {
  if (!limits) return ''
  const parts: string[] = []
  if (limits.cpuSeconds !== undefined) parts.push(`ulimit -t ${limits.cpuSeconds} || exit 126`)
  if (limits.fileBytes !== undefined) {
    // bash counts -f in 1024-byte blocks, POSIX shells (sh, dash) in 512-byte blocks.
    const block = basename(shell) === 'bash' ? 1024 : 512
    parts.push(`ulimit -f ${Math.ceil(limits.fileBytes / block)} || exit 126`)
  }
  if (limits.memoryBytes !== undefined && process.platform === 'linux') {
    parts.push(`ulimit -v ${Math.ceil(limits.memoryBytes / 1024)} || exit 126`)
  }
  if (limits.processes !== undefined)
    parts.push(`ulimit -u ${limits.processes} 2>/dev/null || true`)
  return parts.length > 0 ? `${parts.join('; ')}; ` : ''
}

/** Pids of the commands of each local sandbox (for {@link scratchSandbox}'s dispose). */
const ownGroups = new WeakMap<object, Set<number>>()

/**
 * Create a sandbox that runs commands in `root` (default working directory) with the user's
 * privileges and reads/writes files on the real filesystem. Relative file paths resolve against
 * `root`. Not isolated: it is a thin adapter, not a jail.
 *
 * Process handling: each command starts in its own process group (`detached`); `kill()`, an abort
 * or a timeout sends SIGTERM to the whole group and SIGKILL after 2 s. `wait()` rejects with the
 * abort reason when the abort signal fires. File reads/writes check the abort signal only before
 * starting (they are not interruptible mid-flight).
 *
 * @param options See {@link LocalSandboxOptions} (`root` is the absolute project root).
 */
export function localSandbox(options: LocalSandboxOptions): LocalSandbox {
  const { root, ...opts } = options
  for (const [name, value] of Object.entries(opts.limits ?? {})) checkLimit(name, value)
  const own = new Set<number>()
  const detected = detectOsSandbox()
  const shellBin = opts.shell ?? defaultShell()
  const normalize = (o: OsSandboxOptions): Required<OsSandboxOptions> => ({
    enabled: o.enabled,
    network: o.network ?? false,
    allowWrite: [...(o.allowWrite ?? [])],
    denyRead: [...(o.denyRead ?? [])],
    denyReadHome: o.denyReadHome ?? false,
    allowRead: [...(o.allowRead ?? [])],
    home: o.home ?? homedir(),
  })
  let os = normalize(opts.os ?? { enabled: false })
  const active = (): boolean => os.enabled && detected.kind !== 'none'
  const readNote = (): string => {
    const { deny } = readPolicy(readOpts())
    return deny.length > 0 ? `reads denied under ${deny.join(', ')}, ` : ''
  }
  const describeState = (): string =>
    active()
      ? `Commands run in ${root} in an OS sandbox: writes only inside ${[root, ...os.allowWrite].join(', ')} (and temp dirs), ${readNote()}network ${os.network ? 'on' : 'off'}. Relative file paths resolve against that directory.`
      : `Commands run in ${root} with the user's privileges (not sandboxed). Relative file paths resolve against that directory.`
  const abs = (path: string): string => resolve(root, path)
  const readOpts = (): Parameters<typeof readPolicy>[0] => ({
    root,
    allowWrite: os.allowWrite.map(abs),
    denyRead: os.denyRead.map(abs),
    denyReadHome: os.denyReadHome,
    allowRead: os.allowRead.map(abs),
    home: os.home,
  })

  function throwIfAborted(signal: AbortSignal | undefined): void {
    signal?.throwIfAborted()
  }

  async function readBytes(
    path: string,
    signal: AbortSignal | undefined,
  ): Promise<Uint8Array | null> {
    throwIfAborted(signal)
    try {
      return new Uint8Array(await readFile(abs(path)))
    } catch (error) {
      if (isMissing(error)) return null
      throw error
    }
  }

  async function writeBytes(
    path: string,
    content: Uint8Array,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    throwIfAborted(signal)
    const target = abs(path)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, content)
  }

  async function spawn(options: ProcessOptions): Promise<SandboxProcess> {
    const signal = options.abortSignal
    throwIfAborted(signal)
    const command = limitsPrefix(opts.limits, shellBin) + options.command
    const [cmd, ...args] = active()
      ? wrapCommand(command, {
          ...readOpts(),
          network: os.network,
          kind: detected.kind,
          toolPath: detected.path,
          shell: shellBin,
        })
      : [shellBin, '-c', command]
    const child: ChildProcess = spawnChild(cmd as string, args, {
      cwd: options.workingDirectory ? abs(options.workingDirectory) : root,
      env: { ...(opts.inheritEnv === true ? process.env : safeEnv()), ...opts.env, ...options.env },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    // Surface spawn failures (bad cwd, missing shell) to the caller instead of an event.
    await new Promise<void>((ok, fail) => {
      child.once('spawn', ok)
      child.once('error', fail)
    })

    const groupPid = child.pid
    if (groupPid !== undefined) {
      liveGroups.add(groupPid)
      own.add(groupPid)
    }
    let exited = false
    let killTimer: ReturnType<typeof setTimeout> | undefined
    const signalGroup = (name: NodeJS.Signals): void => {
      const pid = child.pid
      if (pid === undefined) return
      try {
        process.kill(-pid, name)
      } catch {
        try {
          child.kill(name)
        } catch {
          // already gone
        }
      }
    }
    const kill = async (): Promise<void> => {
      if (exited || killTimer) return
      signalGroup('SIGTERM')
      killTimer = setTimeout(() => signalGroup('SIGKILL'), KILL_GRACE_MS)
    }

    let aborted = false
    const onAbort = (): void => {
      aborted = true
      void kill()
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    const waited = new Promise<{ exitCode: number }>((ok, fail) => {
      let settled = false
      let drainTimer: ReturnType<typeof setTimeout> | undefined
      const settle = (code: number | null, sig: NodeJS.Signals | null): void => {
        if (settled) return
        settled = true
        exited = true
        if (groupPid !== undefined) {
          liveGroups.delete(groupPid)
          own.delete(groupPid)
        }
        if (killTimer) clearTimeout(killTimer)
        if (drainTimer) clearTimeout(drainTimer)
        signal?.removeEventListener('abort', onAbort)
        if (aborted) fail(signal?.reason ?? new Error('Aborted'))
        else ok({ exitCode: code ?? 128 + (SIGNAL_NUMBERS[sig ?? ''] ?? 1) })
      }
      child.once('error', (e) => {
        if (groupPid !== undefined) {
          liveGroups.delete(groupPid)
          own.delete(groupPid)
        }
        fail(e)
      })
      // `close` waits for the stdio pipes to end; a grandchild that escaped the process group
      // (setsid, detached) can hold them open forever. Resolve from `exit` after a grace period
      // and destroy the pipes so the tool cannot hang.
      child.once('exit', (code, sig) => {
        drainTimer = setTimeout(() => {
          for (const pipe of [child.stdout, child.stderr]) {
            if (!pipe) continue
            // end the stream normally (readers see EOF, not an error), then release the fd
            pipe.once('end', () => pipe.destroy())
            pipe.push(null)
          }
          settle(code, sig)
        }, KILL_GRACE_MS)
      })
      child.once('close', (code, sig) => settle(code, sig))
    })
    waited.catch(() => {}) // callers may only read the streams; avoid unhandled rejections

    return {
      pid: child.pid,
      stdout: Readable.toWeb(child.stdout as Readable) as unknown as ReadableStream<Uint8Array>,
      stderr: Readable.toWeb(child.stderr as Readable) as unknown as ReadableStream<Uint8Array>,
      wait: () => waited,
      kill,
    }
  }

  async function collect(stream: ReadableStream<Uint8Array>): Promise<string> {
    const dec = new TextDecoder()
    let out = ''
    for await (const chunk of stream) out += dec.decode(chunk, { stream: true })
    return out + dec.decode()
  }

  const sandbox: LocalSandbox = {
    get description(): string {
      return describeState()
    },

    state: () => ({
      enabled: active(),
      kind: detected.kind,
      network: os.network,
      writableRoots: [root, ...os.allowWrite.map(abs)],
      denyRead: active() ? readPolicy(readOpts()).deny : [],
    }),

    setOs(next) {
      os = normalize(next)
    },

    async readFile(options) {
      const bytes = await readBytes(options.path, options.abortSignal)
      if (!bytes) return null
      return new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes)
          controller.close()
        },
      })
    },

    readBinaryFile: (options) => readBytes(options.path, options.abortSignal),

    async readTextFile(options) {
      const bytes = await readBytes(options.path, options.abortSignal)
      if (!bytes) return null
      const text = decoder(options.encoding).decode(bytes)
      if (options.startLine === undefined && options.endLine === undefined) return text
      const start = Math.max(1, options.startLine ?? 1)
      const lines = text.split('\n')
      return lines.slice(start - 1, options.endLine ?? lines.length).join('\n')
    },

    async writeFile(options) {
      throwIfAborted(options.abortSignal)
      const chunks: Uint8Array[] = []
      for await (const chunk of options.content) chunks.push(chunk)
      await writeBytes(options.path, Buffer.concat(chunks), options.abortSignal)
    },

    writeBinaryFile: (options) => writeBytes(options.path, options.content, options.abortSignal),

    async writeTextFile(options) {
      const enc = options.encoding?.toLowerCase()
      const bytes =
        !enc || enc === 'utf-8' || enc === 'utf8'
          ? new TextEncoder().encode(options.content)
          : new Uint8Array(Buffer.from(options.content, enc as BufferEncoding))
      await writeBytes(options.path, bytes, options.abortSignal)
    },

    spawn,

    async run(options) {
      const proc = await spawn(options)
      const [stdout, stderr, { exitCode }] = await Promise.all([
        collect(proc.stdout),
        collect(proc.stderr),
        proc.wait(),
      ])
      return { exitCode, stdout, stderr }
    },
  }
  ownGroups.set(sandbox, own)
  return sandbox
}

/** Options of {@link scratchSandbox}. */
export type ScratchSandboxOptions = Omit<LocalSandboxOptions, 'root'> & {
  /** Directory the scratch directory is created in. Default `os.tmpdir()`. */
  parent?: string
  /** Name prefix of the scratch directory. Default `eh-code-`. */
  prefix?: string
}

/** A local sandbox over a fresh temporary directory, see {@link scratchSandbox}. */
export type ScratchSandbox = LocalSandbox & {
  /** The scratch directory (the sandbox root). */
  root: string
  /** Kill the sandbox's commands and remove the directory recursively. Idempotent. */
  dispose(): Promise<void>
}

/**
 * Create a {@link localSandbox} whose root is a fresh directory under `parent` (default
 * `os.tmpdir()`, name starting with `prefix`, default `eh-code-`). `dispose()` kills the commands
 * the sandbox started (SIGKILL to their process groups) and removes the directory; it is
 * idempotent. Leftovers of crashed processes: {@link removeStaleScratch}.
 */
export async function scratchSandbox(options: ScratchSandboxOptions = {}): Promise<ScratchSandbox> {
  const { parent, prefix, ...rest } = options
  const root = await realpath(await mkdtemp(join(parent ?? tmpdir(), prefix ?? 'eh-code-')))
  const sandbox = localSandbox({ ...rest, root })
  let disposed: Promise<void> | undefined
  const dispose = (): Promise<void> => {
    disposed ??= (async () => {
      for (const pid of [...(ownGroups.get(sandbox) ?? [])]) signalGroupPid(pid, 'SIGKILL')
      await rm(root, { recursive: true, force: true })
    })()
    return disposed
  }
  return Object.assign(sandbox, { root, dispose })
}

/**
 * Remove scratch directories (name starts with `prefix`, default `eh-code-`) in `parent` (default
 * `os.tmpdir()`) not modified for `olderThanMs` (default 24 h): leftovers of crashed processes.
 * Returns how many were removed. Run it at startup; never while an old session may still use one.
 */
export async function removeStaleScratch(
  options: { parent?: string; prefix?: string; olderThanMs?: number } = {},
): Promise<number> {
  const parent = options.parent ?? tmpdir()
  const prefix = options.prefix ?? 'eh-code-'
  const cutoff = Date.now() - (options.olderThanMs ?? 24 * 3600 * 1000)
  let removed = 0
  let names: string[]
  try {
    names = await readdir(parent)
  } catch {
    return 0
  }
  for (const name of names) {
    if (!name.startsWith(prefix)) continue
    const path = join(parent, name)
    try {
      const info = await stat(path)
      if (!info.isDirectory() || info.mtimeMs > cutoff) continue
      await rm(path, { recursive: true, force: true })
      removed++
    } catch {
      // raced with another remover
    }
  }
  return removed
}
