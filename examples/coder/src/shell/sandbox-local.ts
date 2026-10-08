/**
 * Local sandbox: the AI SDK `SandboxSession` shape over `node:child_process` and `node:fs/promises`.
 * Despite the name this is NOT isolated: commands run with the user's privileges (see the
 * plan's "The shell is not jailed" note); permissions are enforced by the permission engine.
 */
import { type ChildProcess, spawn as spawnChild } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { Readable } from 'node:stream'
import type {
  Experimental_SandboxProcess as SandboxProcess,
  Experimental_SandboxSession as SandboxSession,
} from 'ai'
import type { Sandbox } from '../contracts.ts'

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

function shellFor(): { file: string; flag: string } {
  return existsSync('/bin/bash')
    ? { file: '/bin/bash', flag: '-c' }
    : { file: '/bin/sh', flag: '-c' }
}

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
 * @param root Absolute project root.
 */
export function createLocalSandbox(root: string): Sandbox {
  const abs = (path: string): string => resolve(root, path)

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
    const { file, flag } = shellFor()
    const child: ChildProcess = spawnChild(file, [flag, options.command], {
      cwd: options.workingDirectory ? abs(options.workingDirectory) : root,
      env: { ...process.env, ...options.env },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    // Surface spawn failures (bad cwd, missing shell) to the caller instead of an event.
    await new Promise<void>((ok, fail) => {
      child.once('spawn', ok)
      child.once('error', fail)
    })

    const groupPid = child.pid
    if (groupPid !== undefined) liveGroups.add(groupPid)
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
      child.once('error', (e) => {
        if (groupPid !== undefined) liveGroups.delete(groupPid)
        fail(e)
      })
      child.once('close', (code, sig) => {
        exited = true
        if (groupPid !== undefined) liveGroups.delete(groupPid)
        if (killTimer) clearTimeout(killTimer)
        signal?.removeEventListener('abort', onAbort)
        if (aborted) fail(signal?.reason ?? new Error('Aborted'))
        else ok({ exitCode: code ?? 128 + (SIGNAL_NUMBERS[sig ?? ''] ?? 1) })
      })
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

  return {
    description: `Commands run in ${root} with the user's privileges (the shell is not isolated). Relative file paths resolve against that directory.`,

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
}
