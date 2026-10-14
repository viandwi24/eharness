/** Process helpers shared by the Node runtimes: launcher, free port, graceful stop. */
import { type ChildProcess, spawn } from 'node:child_process'
import { createConnection, createServer } from 'node:net'
import { HarnessError } from '../../index.ts'
import type { ProcessUsage, RuntimeEndpoint } from './types.ts'

export interface LaunchedProcess {
  pid?: number
  /** Resolves with the exit code (null when killed by a signal). Never rejects. */
  exited: Promise<number | null>
  kill(signal?: NodeJS.Signals): void
  /** Tail of stdout+stderr, for readable start errors. */
  output(): string
}

export interface LaunchOptions {
  env: Record<string, string | undefined>
  cwd?: string
}

/** Starts a process. Injectable so tests never spawn a real engine. */
export type ProcessLauncher = (
  command: string,
  args: string[],
  opts: LaunchOptions,
) => LaunchedProcess

/** Runtime failures reach callers as `EH_CONFIG_INVALID` (spec 35 §10: no new codes). */
export function runtimeError(message: string, cause?: unknown): HarnessError {
  return new HarnessError('EH_CONFIG_INVALID', message, cause === undefined ? {} : { cause })
}

export const spawnLauncher: ProcessLauncher = (command, args, opts) => {
  const detached = process.platform !== 'win32'
  const child: ChildProcess = spawn(command, args, {
    env: opts.env as NodeJS.ProcessEnv,
    ...(opts.cwd === undefined ? {} : { cwd: opts.cwd }),
    stdio: ['ignore', 'pipe', 'pipe'],
    detached,
  })
  let tail = ''
  const collect = (chunk: Buffer): void => {
    tail = (tail + chunk.toString('utf8')).slice(-4000)
  }
  child.stdout?.on('data', collect)
  child.stderr?.on('data', collect)
  const exited = new Promise<number | null>((resolve) => {
    child.once('exit', (code) => resolve(code))
    child.once('error', (error) => {
      tail += `\n${String(error)}`
      resolve(null)
    })
  })
  return {
    ...(child.pid === undefined ? {} : { pid: child.pid }),
    exited,
    kill(signal: NodeJS.Signals = 'SIGTERM'): void {
      try {
        // Kill the whole group so `xvfb-run` and engine helpers die with it.
        if (detached && child.pid !== undefined) process.kill(-child.pid, signal)
        else child.kill(signal)
      } catch {
        try {
          child.kill(signal)
        } catch {
          // already gone
        }
      }
    },
    output: () => tail,
  }
}

/** A free TCP port on 127.0.0.1. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}

/** Default readiness probe: can we open a TCP connection to the loopback port? */
export function tcpProbe(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('error', () => resolve(false))
  })
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Waits for `exited` or `ms`; true when the process exited. */
async function exitedWithin(proc: LaunchedProcess, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const result = await Promise.race([
    proc.exited.then(() => true),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), ms)
    }),
  ])
  if (timer !== undefined) clearTimeout(timer)
  return result
}

/** Graceful close first (`Browser.close`), SIGTERM, then SIGKILL after `graceMs`. */
export async function stopProcess(
  proc: LaunchedProcess,
  graceful?: () => Promise<void>,
  graceMs = 5000,
): Promise<void> {
  if (graceful !== undefined) {
    try {
      await graceful()
    } catch {
      // fall through to the kill
    }
  }
  if (await exitedWithin(proc, graceful === undefined ? 0 : graceMs)) return
  proc.kill('SIGTERM')
  if (await exitedWithin(proc, 2000)) return
  proc.kill('SIGKILL')
  await exitedWithin(proc, 2000)
}

/** Tracks running engine processes per profile id: idempotent start, exit cleanup, stop. */
export class ProfileProcesses {
  readonly #running = new Map<
    string,
    { proc: LaunchedProcess; endpoint: RuntimeEndpoint; graceful?: () => Promise<void> }
  >()
  readonly #starting = new Map<string, Promise<RuntimeEndpoint>>()
  readonly #stopping = new Set<string>()

  ids(): string[] {
    return [...this.#running.keys()]
  }

  get starting(): boolean {
    return this.#starting.size > 0
  }

  get stopping(): boolean {
    return this.#stopping.size > 0
  }

  get(profileId: string): { proc: LaunchedProcess; endpoint: RuntimeEndpoint } | undefined {
    return this.#running.get(profileId)
  }

  /** Runs `begin` once per profile; concurrent callers share the result. */
  start(
    profileId: string,
    begin: () => Promise<{
      proc: LaunchedProcess
      endpoint: RuntimeEndpoint
      graceful?: () => Promise<void>
    }>,
  ): Promise<RuntimeEndpoint> {
    const running = this.#running.get(profileId)
    if (running !== undefined) return Promise.resolve(running.endpoint)
    const pending = this.#starting.get(profileId)
    if (pending !== undefined) return pending
    const promise = (async (): Promise<RuntimeEndpoint> => {
      try {
        const started = await begin()
        this.#running.set(profileId, started)
        void started.proc.exited.then(() => {
          if (this.#running.get(profileId)?.proc === started.proc) this.#running.delete(profileId)
        })
        return started.endpoint
      } finally {
        this.#starting.delete(profileId)
      }
    })()
    this.#starting.set(profileId, promise)
    return promise
  }

  async stop(profileId: string, graceMs?: number): Promise<void> {
    const pending = this.#starting.get(profileId)
    if (pending !== undefined) await pending.catch(() => undefined)
    const entry = this.#running.get(profileId)
    if (entry === undefined) return
    this.#stopping.add(profileId)
    try {
      await stopProcess(entry.proc, entry.graceful, graceMs)
    } finally {
      this.#running.delete(profileId)
      this.#stopping.delete(profileId)
    }
  }

  async stopAll(graceMs?: number): Promise<void> {
    await Promise.all(this.ids().map((id) => this.stop(id, graceMs)))
  }

  async usage(
    profileId: string,
    measure: (pid: number) => Promise<ProcessUsage | null>,
  ): Promise<ProcessUsage | null> {
    const pid = this.#running.get(profileId)?.proc.pid
    return pid === undefined ? null : measure(pid)
  }
}
