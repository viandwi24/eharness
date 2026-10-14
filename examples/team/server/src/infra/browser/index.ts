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
import {
  type BrowserManager,
  type BrowserProfileStore,
  type BrowserRegistry,
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
  /** Runtime state of every adapter that has a managed mode. */
  runtimes(): Promise<BrowserRuntimeView[]>
  system(): Promise<BrowserSystemMemory | null>
  info(): Promise<BrowserInfo>
  /** Release every lease and stop every engine this process started. */
  close(): Promise<void>
}

export interface BrowserServiceOptions {
  config: BrowserConfig
  sqlite: Database
  vault: SecretVault
  log?: { warn(message: string): void }
}

export function createBrowserService(options: BrowserServiceOptions): BrowserService {
  const { config } = options
  const local = config.driver === 'local'
  const registry = createBrowserRegistry([
    chromeAdapter(
      local ? { managed: chromeRuntime({ root: config.root, xvfb: config.xvfb }) } : {},
    ),
    lightpandaAdapter(local ? { managed: lightpandaRuntime({ root: config.root }) } : {}),
  ])
  const profiles = sealedBrowserProfiles({
    store: sqliteBrowserProfiles(options.sqlite),
    vault: options.vault,
    registry,
  })
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
    return out
  }
  return {
    config,
    registry,
    manager,
    profiles,
    runtimes,
    system,
    async info() {
      const list = await runtimes()
      const running = new Set(list.flatMap((r) => r.running)).size
      return {
        driver: config.driver,
        max: config.max,
        xvfb: config.xvfb,
        system: await system(),
        runtimes: list,
        running,
        label: local
          ? `Browsers run on this server (up to ${config.max} at once)`
          : 'Managed browsers are off: profiles connect to an existing browser',
      }
    },
    close: () => manager.close(),
  }
}
