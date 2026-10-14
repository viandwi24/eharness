/**
 * Lightpanda runtime (spec 35 §6): downloads the release binary, runs `serve` on a free loopback port.
 * AGPL-3.0: downloaded by the user's server and run unmodified as a separate process, never bundled.
 */
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  diskUsage,
  downloadFile,
  type FetchLike,
  makeExecutable,
  removeQuarantine,
  withInstallLock,
} from './download.ts'
import {
  delay,
  freePort,
  type ProcessLauncher,
  ProfileProcesses,
  runtimeError,
  spawnLauncher,
  tcpProbe,
} from './process.ts'
import { processUsage } from './resources.ts'
import type {
  BrowserRuntime,
  InstallOptions,
  ProcessUsage,
  RuntimeEndpoint,
  RuntimeProfile,
  RuntimeStatus,
} from './types.ts'

export const LIGHTPANDA_RELEASES_URL = 'https://github.com/lightpanda-io/browser/releases/download'

/** Release asset name, or `undefined` (Windows and unknown platforms have no build). */
export function lightpandaAsset(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string | undefined {
  const cpu = arch === 'x64' ? 'x86_64' : arch === 'arm64' ? 'aarch64' : undefined
  const os = platform === 'linux' ? 'linux' : platform === 'darwin' ? 'macos' : undefined
  return cpu === undefined || os === undefined ? undefined : `lightpanda-${cpu}-${os}`
}

export interface LightpandaRuntimeOptions {
  /** Runtime root: `<root>/lightpanda/<version>/lightpanda`. */
  root: string
  /** Release tag, default `nightly`. */
  version?: string
  fetch?: FetchLike
  launcher?: ProcessLauncher
  /** Skip the download. */
  executablePath?: string
  /** Readiness probe for the chosen port (default: TCP connect). */
  probe?: (port: number) => Promise<boolean>
  startTimeoutMs?: number
  platform?: NodeJS.Platform
  arch?: string
}

export function lightpandaRuntime(opts: LightpandaRuntimeOptions): BrowserRuntime {
  const doFetch: FetchLike = opts.fetch ?? ((url, init) => fetch(url, init))
  const launcher = opts.launcher ?? spawnLauncher
  const platformName = opts.platform ?? process.platform
  const asset = lightpandaAsset(platformName, opts.arch)
  const version = opts.version ?? 'nightly'
  const dir = join(opts.root, 'lightpanda', version)
  const binary = join(dir, 'lightpanda')
  const procs = new ProfileProcesses()
  let progress: RuntimeStatus['progress']
  let installing = false
  let lastError: string | undefined

  const unavailable = (): string | undefined =>
    asset === undefined && opts.executablePath === undefined
      ? platformName === 'win32'
        ? 'Lightpanda is not available on Windows'
        : `Lightpanda has no build for ${platformName}/${opts.arch ?? process.arch}`
      : undefined

  const exe = (): string => opts.executablePath ?? binary

  async function install(o?: InstallOptions): Promise<void> {
    const na = unavailable()
    if (na !== undefined) throw runtimeError(na)
    if (existsSync(exe())) return
    return withInstallLock(`lightpanda:${opts.root}:${version}`, async () => {
      installing = true
      progress = undefined
      lastError = undefined
      try {
        await mkdir(dir, { recursive: true })
        const part = `${binary}.download`
        await downloadFile({
          fetch: doFetch,
          url: `${LIGHTPANDA_RELEASES_URL}/${version}/${asset}`,
          dest: part,
          ...(o?.signal === undefined ? {} : { signal: o.signal }),
          onProgress: (p) => {
            progress = p
            o?.onProgress?.(p)
          },
        })
        await makeExecutable(part)
        await removeQuarantine(part)
        await rename(part, binary)
        await writeFile(join(dir, 'VERSION'), version)
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error)
        await rm(`${binary}.download`, { force: true })
        throw error
      } finally {
        installing = false
        progress = undefined
      }
    })
  }

  async function start(profile: RuntimeProfile): Promise<RuntimeEndpoint> {
    const na = unavailable()
    if (na !== undefined) throw runtimeError(na)
    return procs.start(profile.id, async () => {
      if (!existsSync(exe())) throw runtimeError('Lightpanda is not installed: run install() first')
      const port = await freePort()
      const proc = launcher(exe(), ['serve', '--host', '127.0.0.1', '--port', String(port)], {
        env: { ...process.env, LIGHTPANDA_DISABLE_TELEMETRY: 'true' },
      })
      let exited = false
      void proc.exited.then(() => {
        exited = true
      })
      const probe = opts.probe ?? tcpProbe
      const deadline = Date.now() + (opts.startTimeoutMs ?? 30_000)
      while (!(await probe(port))) {
        if (exited)
          throw runtimeError(
            `Lightpanda exited before it was ready: ${proc.output().trim().slice(-500)}`,
          )
        if (Date.now() > deadline) {
          proc.kill('SIGKILL')
          throw runtimeError('Lightpanda did not start listening in time')
        }
        await delay(100)
      }
      return {
        proc,
        endpoint: {
          cdpUrl: `ws://127.0.0.1:${port}`,
          ...(proc.pid === undefined ? {} : { pid: proc.pid }),
        },
      }
    })
  }

  return {
    async status(): Promise<RuntimeStatus> {
      const na = unavailable()
      if (na !== undefined) return { state: 'error', error: na }
      const running = procs.ids()
      const installed = existsSync(exe())
      const label = opts.executablePath !== undefined ? 'system' : version
      if (installing) {
        return { state: 'installing', version, ...(progress === undefined ? {} : { progress }) }
      }
      if (!installed) {
        return lastError === undefined ? { state: 'missing' } : { state: 'error', error: lastError }
      }
      let installedVersion = label
      try {
        if (opts.executablePath === undefined)
          installedVersion = (await readFile(join(dir, 'VERSION'), 'utf8')).trim() || label
      } catch {
        // keep label
      }
      const diskBytes = opts.executablePath === undefined ? await diskUsage(dir) : undefined
      const state = procs.stopping
        ? 'stopping'
        : procs.starting
          ? 'starting'
          : running.length > 0
            ? 'running'
            : 'ready'
      return {
        state,
        version: installedVersion,
        ...(diskBytes === undefined ? {} : { diskBytes }),
        ...(running.length > 0 ? { running } : {}),
      }
    },
    install,
    start,
    stop: (id) => procs.stop(id),
    async uninstall(): Promise<void> {
      await procs.stopAll()
      await rm(join(opts.root, 'lightpanda'), { recursive: true, force: true })
      lastError = undefined
    },
    usage: (id): Promise<ProcessUsage | null> => procs.usage(id, (pid) => processUsage(pid)),
  }
}
