/**
 * Chrome for Testing runtime (spec 35 §6): downloads the pinned stable build, starts one process per
 * profile with its own user-data-dir, reads the debugging port from `DevToolsActivePort`.
 */
import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  diskUsage,
  downloadFile,
  extractZip,
  type FetchLike,
  makeExecutable,
  removeQuarantine,
  withInstallLock,
} from './download.ts'
import {
  delay,
  type LaunchedProcess,
  type ProcessLauncher,
  ProfileProcesses,
  runtimeError,
  spawnLauncher,
} from './process.ts'
import { processUsage } from './resources.ts'
import {
  clearStaleChromeLocks,
  defaultProcessOs,
  type ProcessOs,
  reapOrphan,
  removePidFile,
  writePidFile,
} from './stale.ts'
import type {
  BrowserRuntime,
  InstallOptions,
  ProcessUsage,
  RuntimeEndpoint,
  RuntimeProfile,
  RuntimeStatus,
} from './types.ts'

export const CHROME_VERSIONS_URL =
  'https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json'

export type ChromePlatform = 'linux64' | 'linux-arm64' | 'mac-arm64' | 'mac-x64' | 'win32' | 'win64'

/** Chrome for Testing platform id, or `undefined` when there is no build (e.g. FreeBSD). */
export function chromePlatform(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): ChromePlatform | undefined {
  if (platform === 'linux') {
    if (arch === 'x64') return 'linux64'
    if (arch === 'arm64') return 'linux-arm64'
    return undefined
  }
  if (platform === 'darwin')
    return arch === 'arm64' ? 'mac-arm64' : arch === 'x64' ? 'mac-x64' : undefined
  if (platform === 'win32') return arch === 'ia32' ? 'win32' : arch === 'x64' ? 'win64' : undefined
  return undefined
}

/** Path of the executable inside the extracted archive. */
export function chromeExecutableRelPath(platform: ChromePlatform): string {
  if (platform === 'mac-arm64' || platform === 'mac-x64') {
    return join(
      `chrome-${platform}`,
      'Google Chrome for Testing.app',
      'Contents',
      'MacOS',
      'Google Chrome for Testing',
    )
  }
  if (platform === 'win32' || platform === 'win64') return join(`chrome-${platform}`, 'chrome.exe')
  return join(`chrome-${platform}`, 'chrome')
}

/** True inside a container (Docker, Kubernetes, containerd, LXC, Podman). */
export function detectContainer(
  exists: (p: string) => boolean = existsSync,
  readText: (p: string) => string = (p) => readFileSync(p, 'utf8'),
): boolean {
  if (exists('/.dockerenv') || exists('/run/.containerenv')) return true
  try {
    return /docker|kubepods|containerd|lxc|libpod/.test(readText('/proc/1/cgroup'))
  } catch {
    return false
  }
}

const DEFAULT_FLAGS = [
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-sync',
  '--disable-background-networking',
  '--disable-dev-shm-usage',
  '--disable-search-engine-choice-screen',
]

const REFUSED_PREFIXES = [
  '--remote-debugging-address',
  '--user-data-dir',
  '--remote-debugging-port',
  '--remote-debugging-pipe',
]

/** Validates `extraArgs`: flags only, and never the ones that move or expose the debugging port. */
export function checkExtraArgs(args: unknown): string[] {
  if (args === undefined) return []
  if (!Array.isArray(args) || args.some((a) => typeof a !== 'string')) {
    throw runtimeError('extraArgs must be an array of strings')
  }
  for (const arg of args as string[]) {
    if (!arg.startsWith('--')) throw runtimeError(`extraArgs: "${arg}" is not a --flag`)
    if (REFUSED_PREFIXES.some((p) => arg === p || arg.startsWith(`${p}=`))) {
      throw runtimeError(`extraArgs: ${arg.split('=')[0]} is not allowed`)
    }
  }
  return args as string[]
}

export interface ChromeRuntimeOptions {
  /** Runtime root: `<root>/chrome/<version>/` and `<root>/profiles/<id>/`. */
  root: string
  /** Chrome for Testing channel, default `Stable`. */
  channel?: 'Stable' | 'Beta' | 'Dev' | 'Canary'
  fetch?: FetchLike
  launcher?: ProcessLauncher
  /** Default `true`. A profile's settings may override it. */
  headless?: boolean
  /** Headed on Linux without `DISPLAY`: wrap in `xvfb-run -a`. */
  xvfb?: boolean
  /** Skip the download: a system Chrome or another Chromium build. */
  executablePath?: string
  /** Override container detection (tests). */
  inContainer?: boolean
  /** Run `--version` after install (default true). */
  verify?: boolean
  /** Default 60 s. */
  startTimeoutMs?: number
  /** Wait after `Browser.close` before SIGTERM, default 5000. */
  stopGraceMs?: number
  platform?: NodeJS.Platform
  arch?: string
  /** Process calls of the stale-profile cleanup (tests). */
  os?: ProcessOs
}

interface VersionInfo {
  version: string
  url: string
}

function pickDownload(json: unknown, channel: string, platform: ChromePlatform): VersionInfo {
  const entry = (json as { channels?: Record<string, unknown> } | undefined)?.channels?.[channel] as
    | { version?: string; downloads?: { chrome?: { platform: string; url: string }[] } }
    | undefined
  const found = entry?.downloads?.chrome?.find((d) => d.platform === platform)
  if (entry?.version === undefined || found === undefined) {
    throw runtimeError(`Chrome for Testing has no ${channel} build for ${platform}`)
  }
  return { version: entry.version, url: found.url }
}

function execVersion(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(path, ['--version'], { timeout: 20_000 }, (error, stdout) =>
      error === null ? resolve(stdout.trim()) : reject(error),
    )
  })
}

export function chromeRuntime(opts: ChromeRuntimeOptions): BrowserRuntime {
  const doFetch: FetchLike = opts.fetch ?? ((url, init) => fetch(url, init))
  const launcher = opts.launcher ?? spawnLauncher
  const platformName = opts.platform ?? process.platform
  const platform = chromePlatform(platformName, opts.arch)
  const channel = opts.channel ?? 'Stable'
  const procs = new ProfileProcesses()
  const chromeDir = join(opts.root, 'chrome')
  let progress: RuntimeStatus['progress']
  let installing = false
  let lastError: string | undefined

  async function installedVersion(): Promise<string | undefined> {
    if (opts.executablePath !== undefined) {
      return existsSync(opts.executablePath) ? 'system' : undefined
    }
    try {
      return (await readFile(join(chromeDir, 'current'), 'utf8')).trim() || undefined
    } catch {
      return undefined
    }
  }

  async function executable(): Promise<string | undefined> {
    if (opts.executablePath !== undefined) {
      return existsSync(opts.executablePath) ? opts.executablePath : undefined
    }
    const version = await installedVersion()
    if (version === undefined || platform === undefined) return undefined
    const path = join(chromeDir, version, chromeExecutableRelPath(platform))
    return existsSync(path) ? path : undefined
  }

  async function install(o?: InstallOptions): Promise<void> {
    if (opts.executablePath !== undefined) {
      if (!existsSync(opts.executablePath)) {
        throw runtimeError(`executablePath does not exist: ${opts.executablePath}`)
      }
      return
    }
    if (platform === undefined) {
      throw runtimeError(
        `Chrome for Testing has no build for ${platformName}/${opts.arch ?? process.arch}`,
      )
    }
    if ((await executable()) !== undefined) return
    return withInstallLock(`chrome:${opts.root}`, async () => {
      installing = true
      progress = undefined
      lastError = undefined
      try {
        const res = await doFetch(
          CHROME_VERSIONS_URL,
          o?.signal === undefined ? {} : { signal: o.signal },
        )
        if (!res.ok) throw runtimeError(`Chrome version lookup answered ${res.status}`)
        const { version, url } = pickDownload(await res.json(), channel, platform)
        const finalDir = join(chromeDir, version)
        const tmpDir = join(chromeDir, `${version}.tmp`)
        const zip = join(chromeDir, `${version}.zip`)
        await rm(tmpDir, { recursive: true, force: true })
        await downloadFile({
          fetch: doFetch,
          url,
          dest: zip,
          ...(o?.signal === undefined ? {} : { signal: o.signal }),
          onProgress: (p) => {
            progress = p
            o?.onProgress?.(p)
          },
        })
        try {
          await extractZip(zip, tmpDir)
        } finally {
          await rm(zip, { force: true })
        }
        const exe = join(tmpDir, chromeExecutableRelPath(platform))
        if (!existsSync(exe))
          throw runtimeError(`archive did not contain ${chromeExecutableRelPath(platform)}`)
        await makeExecutable(exe)
        await removeQuarantine(tmpDir)
        await rm(finalDir, { recursive: true, force: true })
        await rename(tmpDir, finalDir)
        if (opts.verify !== false) {
          try {
            await execVersion(join(finalDir, chromeExecutableRelPath(platform)))
          } catch (error) {
            await rm(finalDir, { recursive: true, force: true })
            throw runtimeError(`the downloaded Chrome does not start: ${String(error)}`, error)
          }
        }
        await writeFile(join(chromeDir, 'current'), version)
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error)
        throw error
      } finally {
        installing = false
        progress = undefined
      }
    })
  }

  async function waitForPort(
    dir: string,
    proc: LaunchedProcess,
    timeoutMs: number,
  ): Promise<{ port: number; path: string }> {
    const file = join(dir, 'DevToolsActivePort')
    const deadline = Date.now() + timeoutMs
    let exited = false
    void proc.exited.then(() => {
      exited = true
    })
    while (Date.now() < deadline) {
      if (exited) {
        throw runtimeError(`Chrome exited before it was ready: ${proc.output().trim().slice(-500)}`)
      }
      try {
        const [port, path] = (await readFile(file, 'utf8')).split('\n')
        if (
          port !== undefined &&
          /^\d+$/.test(port.trim()) &&
          path !== undefined &&
          path.trim() !== ''
        ) {
          return { port: Number(port.trim()), path: path.trim() }
        }
      } catch {
        // not written yet
      }
      await delay(100)
    }
    proc.kill('SIGKILL')
    throw runtimeError(
      `Chrome did not report a debugging port within ${Math.round(timeoutMs / 1000)} s`,
    )
  }

  async function start(
    profile: RuntimeProfile,
    settings: Record<string, unknown> = {},
  ): Promise<RuntimeEndpoint> {
    if (!/^[A-Za-z0-9_-]+$/.test(profile.id))
      throw runtimeError(`invalid profile id: ${profile.id}`)
    const extra = checkExtraArgs(settings.extraArgs)
    return procs.start(profile.id, async () => {
      const exe = await executable()
      if (exe === undefined) throw runtimeError('Chrome is not installed: run install() first')
      const headless =
        typeof settings.headless === 'boolean' ? settings.headless : (opts.headless ?? true)
      const wantXvfb = opts.xvfb === true
      if (!headless && platformName === 'linux' && !wantXvfb && !process.env.DISPLAY) {
        throw runtimeError(
          'headed Chrome on Linux needs a display: set DISPLAY, enable xvfb, or use headless',
        )
      }
      const userDataDir = join(opts.root, 'profiles', profile.id)
      await mkdir(userDataDir, { recursive: true })
      // a hard crash leaves the engine and the profile locks behind (spec 35 §6)
      const pidFile = join(userDataDir, 'eharness.pid')
      const os = opts.os ?? defaultProcessOs
      await reapOrphan(pidFile, userDataDir, os)
      await clearStaleChromeLocks(userDataDir, os)
      const args = [
        `--user-data-dir=${userDataDir}`,
        '--remote-debugging-port=0',
        ...DEFAULT_FLAGS,
        ...(headless ? ['--headless=new'] : []),
        // headless Chrome defaults to 800×600: pages are read and shot at a common laptop size
        ...(extra.some((a) => a.startsWith('--window-size=')) ? [] : ['--window-size=1280,800']),
        ...((opts.inContainer ?? detectContainer()) ? ['--no-sandbox'] : []),
        ...extra,
        'about:blank',
      ]
      const useXvfb = !headless && platformName === 'linux' && wantXvfb && !process.env.DISPLAY
      const proc = useXvfb
        ? launcher('xvfb-run', ['-a', exe, ...args], { env: process.env })
        : launcher(exe, args, { env: process.env })
      await writePidFile(pidFile, proc.pid)
      void proc.exited.then(() => removePidFile(pidFile))
      const { port, path } = await waitForPort(userDataDir, proc, opts.startTimeoutMs ?? 60_000)
      const endpoint: RuntimeEndpoint = {
        cdpUrl: `ws://127.0.0.1:${port}${path}`,
        ...(proc.pid === undefined ? {} : { pid: proc.pid }),
      }
      const graceful = async (): Promise<void> => {
        const ws = new WebSocket(endpoint.cdpUrl)
        await new Promise<void>((resolve) => {
          const done = (): void => resolve()
          ws.addEventListener('open', () => {
            ws.send(JSON.stringify({ id: 1, method: 'Browser.close' }))
          })
          ws.addEventListener('close', done)
          ws.addEventListener('error', done)
          setTimeout(done, 3000)
        })
        try {
          ws.close()
        } catch {
          // already closed
        }
      }
      return { proc, endpoint, graceful }
    })
  }

  return {
    async status(): Promise<RuntimeStatus> {
      const version = await installedVersion()
      const running = procs.ids()
      const base = {
        ...(version === undefined ? {} : { version }),
        ...(running.length > 0 ? { running } : {}),
      }
      if (installing) {
        return { state: 'installing', ...base, ...(progress === undefined ? {} : { progress }) }
      }
      if (version === undefined) {
        return {
          state: lastError === undefined ? 'missing' : 'error',
          ...(lastError === undefined ? {} : { error: lastError }),
        }
      }
      const exe = await executable()
      const diskBytes =
        opts.executablePath !== undefined || exe === undefined
          ? undefined
          : await diskUsage(join(chromeDir, version))
      const state = procs.stopping
        ? 'stopping'
        : procs.starting
          ? 'starting'
          : running.length > 0
            ? 'running'
            : 'ready'
      return { state, ...base, ...(diskBytes === undefined ? {} : { diskBytes }) }
    },
    install,
    start,
    stop: (id) => procs.stop(id, opts.stopGraceMs),
    async removeProfileData(profileId: string): Promise<void> {
      if (!/^[A-Za-z0-9_-]+$/.test(profileId)) return
      await procs.stop(profileId, opts.stopGraceMs)
      // the exiting engine (or its pid-file cleanup) may still touch the directory: retry until gone
      const dir = join(opts.root, 'profiles', profileId)
      for (let attempt = 0; attempt < 5; attempt++) {
        await rm(dir, { recursive: true, force: true }).catch(() => undefined)
        if (!existsSync(dir)) return
        await new Promise((r) => setTimeout(r, 50))
      }
    },
    async uninstall(): Promise<void> {
      await procs.stopAll(opts.stopGraceMs)
      await rm(chromeDir, { recursive: true, force: true })
      lastError = undefined
    },
    usage: (id): Promise<ProcessUsage | null> => procs.usage(id, (pid) => processUsage(pid)),
  }
}
