/**
 * The browser of the team app (`eharness/browser`, docs/plans/P48-browser.md): configuration from
 * `TEAM_BROWSER_*`, one manager with the Chrome and Lightpanda adapters over profiles sealed with
 * the app's vault, and the status Settings shows. Engines are separate processes; the manager
 * kills them on `close()`. Nothing here is stored in the database but the profiles themselves:
 * the runtime root (downloaded engines, logins) is a disposable cache.
 */

import type { Database } from 'bun:sqlite'
import { accessSync, constants, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { remoteBrowserRuntime } from '@eharness-examples/sandbox-server/client'
import { HarnessError } from 'eharness'
import {
  type BrowserManager,
  type BrowserProfileStore,
  type BrowserRegistry,
  type BrowserRuntime,
  chromeAdapter,
  createBrowserManager,
  createBrowserRegistry,
  lightpandaAdapter,
  sealedBrowserProfiles,
} from 'eharness/browser'
import { chromeRuntime, lightpandaRuntime, systemMemory } from 'eharness/browser/node'
import type { SecretVault } from 'eharness/providers'
import type {
  BrowserDriver,
  BrowserInfo,
  BrowserRuntimeView,
  BrowserSystemMemory,
} from '../../domain/browser.ts'
import { sqliteBrowserProfiles } from '../db/browser-profiles-repo.ts'

type Env = Record<string, string | undefined>

export interface BrowserConfig {
  driver: BrowserDriver
  /** `<root>/chrome/<version>/`, `<root>/lightpanda/<version>/`, `<root>/profiles/<id>/`. */
  root: string
  /** Headed Chrome on a Linux server without a display (`xvfb-run`). */
  xvfb: boolean
  /** Concurrent running profiles (leases). */
  max: number
}

/** True when `dir`, or the nearest existing parent, can be written (nothing is created). */
function writable(dir: string): boolean {
  let at = dir
  while (!existsSync(at)) {
    const up = dirname(at)
    if (up === at) return false
    at = up
  }
  try {
    accessSync(at, constants.W_OK)
    return true
  } catch {
    return false
  }
}

/** `TEAM_BROWSER_*` of the environment (docs: `main.ts` header, README). */
export function browserConfigFromEnv(env: Env, dbFile: string): BrowserConfig {
  const dataDir = resolve(dbFile === ':memory:' ? join(tmpdir(), 'eharness-team') : dirname(dbFile))
  const root = resolve(env.TEAM_BROWSER_ROOT?.trim() || join(dataDir, 'browser'))
  const requested = env.TEAM_BROWSER_DRIVER?.trim()
  const driver: BrowserDriver =
    requested === 'off' || requested === 'local' ? requested : writable(root) ? 'local' : 'off'
  const max = Number(env.TEAM_BROWSER_MAX)
  return {
    driver,
    root,
    xvfb: env.TEAM_BROWSER_XVFB === '1',
    max: Number.isInteger(max) && max > 0 ? max : 4,
  }
}

export interface BrowserService {
  readonly config: BrowserConfig
  readonly registry: BrowserRegistry
  readonly manager: BrowserManager
  /** Profiles with plain settings; the table only holds ciphertext of secret fields. */
  readonly profiles: BrowserProfileStore
  /** The runtime of the connected Remote sandbox, undefined when none is connected. */
  remoteRuntime(): Promise<{ runtime: BrowserRuntime; host: string } | undefined>
  /** Runtime state of every adapter that has a managed mode. */
  runtimes(): Promise<BrowserRuntimeView[]>
  system(): Promise<BrowserSystemMemory | null>
  info(): Promise<BrowserInfo>
  /** Release every lease and stop every engine this process started. */
  close(): Promise<void>
}

/** Where a managed Chrome profile runs (`metadata.runtime` of the profile; absent means local). */
export type RunsOn = 'local' | 'remote'

/** The connected Remote sandbox (the connector's settings; the token never leaves the server). */
export interface RemoteSandboxSettings {
  url: string
  token: string
}

/** Id of the remote Chrome runtime in `runtimes()` and in `/browser/runtimes/{adapter}`. */
export const REMOTE_CHROME_RUNTIME = 'chrome@remote'

export interface BrowserServiceOptions {
  config: BrowserConfig
  sqlite: Database
  vault: SecretVault
  /** The Remote sandbox connection, when one is connected (read on every use: it can change). */
  remote?: () => Promise<RemoteSandboxSettings | undefined>
  /** Builds the runtime of a Remote sandbox (default: `remoteBrowserRuntime`; tests inject a fake). */
  remoteRuntime?: (settings: RemoteSandboxSettings) => BrowserRuntime
  fetch?: typeof fetch
  log?: { warn(message: string): void }
}

const hostOf = (url: string): string => {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

export function createBrowserService(options: BrowserServiceOptions): BrowserService {
  const { config } = options
  const local = config.driver === 'local'
  let profilesRef: BrowserProfileStore | undefined
  let remoteCache: { key: string; runtime: BrowserRuntime } | undefined
  const remoteRuntime = async (): Promise<
    { runtime: BrowserRuntime; host: string } | undefined
  > => {
    const s = await options.remote?.().catch(() => undefined)
    if (s === undefined) return undefined
    const key = `${s.url}\n${s.token}`
    if (remoteCache?.key !== key) {
      const runtime =
        options.remoteRuntime?.(s) ??
        remoteBrowserRuntime({
          baseUrl: s.url,
          token: s.token,
          ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        })
      remoteCache = { key, runtime }
    }
    return { runtime: remoteCache.runtime, host: hostOf(s.url) }
  }
  const whereOf = async (profileId: string): Promise<RunsOn | undefined> => {
    const profile = await profilesRef?.get(profileId)
    if (profile === null || profile === undefined) return undefined
    return profile.metadata?.runtime === 'remote' ? 'remote' : 'local'
  }
  const chromeLocal = local ? chromeRuntime({ root: config.root, xvfb: config.xvfb }) : undefined
  /**
   * The Chrome runtime of the adapter: this server's, or the Remote sandbox's per profile
   * (`metadata.runtime`). Install, status and uninstall of the adapter card are the local ones;
   * the remote engine has its own card (`chrome@remote`).
   */
  const chromeRouted: BrowserRuntime | undefined =
    chromeLocal === undefined
      ? undefined
      : {
          status: () => chromeLocal.status(),
          install: (o) => chromeLocal.install(o),
          uninstall: () => chromeLocal.uninstall?.() ?? Promise.resolve(),
          async start(profile, settings) {
            if ((await whereOf(profile.id)) !== 'remote')
              return chromeLocal.start(profile, settings)
            const remote = await remoteRuntime()
            if (remote === undefined) {
              throw new HarnessError(
                'EH_CONFIG_INVALID',
                'This profile runs on the Remote sandbox, which is not connected. Connect it in Connectors, or create the profile on this server.',
              )
            }
            return remote.runtime.start(profile, settings)
          },
          async stop(id) {
            const where = await whereOf(id)
            if (where !== 'remote') await chromeLocal.stop(id)
            // unknown (deleted) profile: try both
            if (where !== 'local') await (await remoteRuntime())?.runtime.stop(id).catch(() => {})
          },
          async removeProfileData(id) {
            const where = await whereOf(id)
            if (where !== 'remote') await chromeLocal.removeProfileData?.(id)
            if (where === 'remote') await (await remoteRuntime())?.runtime.removeProfileData?.(id)
          },
          async usage(id) {
            if ((await whereOf(id)) === 'remote') {
              return (await remoteRuntime())?.runtime.usage?.(id) ?? null
            }
            return (await chromeLocal.usage?.(id)) ?? null
          },
        }
  const registry = createBrowserRegistry([
    chromeAdapter(chromeRouted === undefined ? {} : { managed: chromeRouted }),
    lightpandaAdapter(local ? { managed: lightpandaRuntime({ root: config.root }) } : {}),
  ])
  const profiles = sealedBrowserProfiles({
    store: sqliteBrowserProfiles(options.sqlite),
    vault: options.vault,
    registry,
  })
  profilesRef = profiles
  const manager = createBrowserManager({
    registry,
    profiles,
    limits: { maxLeases: config.max },
    systemMemory,
    ...(options.log === undefined ? {} : { log: options.log as never }),
  })
  const system = async (): Promise<BrowserSystemMemory | null> => {
    try {
      return systemMemory()
    } catch {
      return null
    }
  }
  const runtimes = async (): Promise<BrowserRuntimeView[]> => {
    const out: BrowserRuntimeView[] = []
    for (const info of registry.list()) {
      const runtime = registry.get(info.id)?.runtime()
      if (runtime === undefined) continue
      const s = await runtime.status().catch((error: unknown) => ({
        state: 'error' as const,
        error: error instanceof Error ? error.message : String(error),
      }))
      out.push({
        adapter: info.id,
        label: info.label,
        state: s.state,
        ...('version' in s && s.version !== undefined ? { version: s.version } : {}),
        ...('diskBytes' in s && s.diskBytes !== undefined ? { diskBytes: s.diskBytes } : {}),
        ...('progress' in s && s.progress !== undefined ? { progress: s.progress } : {}),
        running: 'running' in s && s.running !== undefined ? s.running : [],
        ...(s.error === undefined ? {} : { error: s.error }),
      })
    }
    // the Chrome engine of the connected Remote sandbox (a managed profile can run there)
    const remote = local ? await remoteRuntime() : undefined
    if (remote !== undefined) {
      const s = await remote.runtime.status().catch((error: unknown) => ({
        state: 'error' as const,
        error: error instanceof Error ? error.message : String(error),
      }))
      out.push({
        adapter: REMOTE_CHROME_RUNTIME,
        label: `Chrome on ${remote.host}`,
        where: 'remote',
        host: remote.host,
        state: s.state,
        ...('version' in s && s.version !== undefined ? { version: s.version } : {}),
        ...('diskBytes' in s && s.diskBytes !== undefined ? { diskBytes: s.diskBytes } : {}),
        ...('progress' in s && s.progress !== undefined ? { progress: s.progress } : {}),
        running: 'running' in s && s.running !== undefined ? s.running : [],
        ...(s.error === undefined ? {} : { error: s.error }),
      })
    }
    return out
  }
  return {
    config,
    registry,
    manager,
    profiles,
    remoteRuntime,
    runtimes,
    system,
    async info() {
      const list = await runtimes()
      const running = new Set(list.flatMap((r) => r.running)).size
      const remote = list.find((r) => r.where === 'remote')
      return {
        driver: config.driver,
        max: config.max,
        xvfb: config.xvfb,
        system: await system(),
        runtimes: list,
        running,
        ...(remote === undefined ? {} : { remote: { host: remote.host as string } }),
        label: local
          ? `Browsers run on this server${remote === undefined ? '' : ` or on ${remote.host}`} (up to ${config.max} at once)`
          : 'Managed browsers are off: profiles connect to an existing browser',
      }
    },
    close: () => manager.close(),
  }
}
