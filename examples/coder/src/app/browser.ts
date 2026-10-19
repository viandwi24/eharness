/**
 * Browser tools of the coder (`eharness/browser`, spec 35): the agent opens the app it is
 * building (a localhost dev server), reads it as an accessibility snapshot, clicks, scrolls and
 * looks at screenshots. Opt-in through the `browser` setting.
 *
 * The module only wires the library: one manager and one managed profile per process, the
 * `browser()` plugin options, the permission kinds of its tools and a status text for `/browser`.
 * The tools exist on the main agent only (a lease has one holder; a subagent would get `BUSY:`).
 */
import { join } from 'node:path'
import { errorText } from 'eharness'
import {
  type BrowserAdapter,
  type BrowserManager,
  type BrowserOptions,
  chromeAdapter,
  createBrowserManager,
  createBrowserRegistry,
  lightpandaAdapter,
  memoryBrowserProfileStore,
} from 'eharness/browser'
import { chromeRuntime, lightpandaRuntime } from 'eharness/browser/node'
import { DEFAULT_TOOL_OUTPUTS_DIR } from 'eharness/filesystem'
import type { ToolKinds } from 'eharness/permissions'
import type { BrowserSettings, BrowserStatusInfo } from '../contracts.ts'

/** Hosts a dev server runs on. Opening them needs no ask; anything else follows `allowDomains`. */
export const LOCAL_HOSTS: readonly string[] = ['localhost', '127.0.0.1', '[::1]']

/** Names of the tools `browser()` registers for the coder (no eval, no human hand-over). */
export const BROWSER_TOOLS: readonly string[] = [
  'browser_open',
  'browser_snapshot',
  'browser_act',
  'browser_screenshot',
  'browser_read',
  'browser_tabs',
  'browser_scroll',
]

/** Where screenshots go: the evicted-tool-outputs mount, so the project tree stays clean. */
export const BROWSER_SHOTS_DIR = `${DEFAULT_TOOL_OUTPUTS_DIR}/browser-shots/`

/** The browser of one app instance. */
export interface BrowserSupport {
  manager: BrowserManager
  profileId: string
  engine: 'chrome' | 'lightpanda'
  allowDomains: string[]
  /** Options of the `browser()` plugin. */
  plugin: BrowserOptions
  /** True when only local dev-server hosts may be opened. */
  localOnly: boolean
  status(): Promise<BrowserStatusInfo>
  close(): Promise<void>
}

/** Options of {@link createBrowserSupport}. */
export interface CreateBrowserSupportOptions {
  settings: BrowserSettings | undefined
  /** `~/.coder`: engines are installed under `<userDir>/browser`. */
  userDir: string
  /** Replace the real adapters (tests). Must contain an adapter with the id of the engine. */
  adapters?: BrowserAdapter[]
}

/**
 * Create the manager and the profile, or `undefined` when the `browser` setting is off.
 * Nothing is downloaded or started here: the engine is installed and launched when the agent
 * first uses a browser tool.
 */
export async function createBrowserSupport(
  options: CreateBrowserSupportOptions,
): Promise<BrowserSupport | undefined> {
  const settings = options.settings
  if (settings?.enabled !== true) return undefined
  const engine = settings.runtime ?? 'chrome'
  const root = join(options.userDir, 'browser')
  const executablePath = settings.executablePath
  const adapters =
    options.adapters ??
    (engine === 'chrome'
      ? [
          chromeAdapter({
            managed: chromeRuntime({
              root,
              headless: settings.headless ?? true,
              ...(executablePath === undefined ? {} : { executablePath }),
            }),
          }),
        ]
      : [
          lightpandaAdapter({
            managed: lightpandaRuntime({
              root,
              ...(executablePath === undefined ? {} : { executablePath }),
            }),
          }),
        ])
  const registry = createBrowserRegistry(adapters)
  const profiles = memoryBrowserProfileStore()
  const manager = createBrowserManager({ registry, profiles })
  // the profile's allow list is the gate: an explicit local host is opened although it is private
  const allowDomains =
    settings.allowDomains !== undefined && settings.allowDomains.length > 0
      ? [...new Set([...LOCAL_HOSTS, ...settings.allowDomains])]
      : [...LOCAL_HOSTS]
  const profile = await profiles.create({
    name: 'coder',
    adapter: engine,
    mode: 'managed',
    settings: engine === 'chrome' ? { headless: settings.headless ?? true } : {},
    allowDomains,
  })
  const localOnly = allowDomains.every((d) => LOCAL_HOSTS.includes(d))
  const plugin: BrowserOptions = {
    manager,
    profile: profile.id,
    // screenshots are files; they go next to evicted tool outputs, not into the project
    screenshots: { folder: BROWSER_SHOTS_DIR },
    // no `browser_eval` and no `browser_request_human`: the coder has no person to hand over to
    risk: { browser_scroll: 'read' },
  }
  return {
    manager,
    profileId: profile.id,
    engine,
    allowDomains,
    plugin,
    localOnly,
    async status() {
      const lines = [
        `Browser tools are on: ${engine}${engine === 'chrome' ? (settings.headless === false ? ' (window)' : ' (headless)') : ''}.`,
        `Allowed sites: ${allowDomains.join(', ')}${localOnly ? ' (local dev servers only; add "browser.allowDomains" for more)' : ''}.`,
      ]
      const runtime = manager.runtime(engine)
      if (runtime !== undefined) {
        const state = await runtime.status().catch((error: unknown) => ({
          state: 'error' as const,
          error: errorText(error),
        }))
        const detail =
          'error' in state && state.error !== undefined
            ? ` (${state.error})`
            : 'version' in state && state.version !== undefined
              ? ` ${state.version}`
              : ''
        lines.push(
          `Engine: ${state.state}${detail}${state.state === 'missing' ? ' (downloaded on first use)' : ''}.`,
        )
      }
      const leases = await manager.status()
      if (leases.length === 0) lines.push('No browser is open right now.')
      for (const lease of leases) {
        lines.push(
          `Open: ${lease.page?.title ? `"${lease.page.title}" ` : ''}${lease.page?.url ?? 'about:blank'} (controlled by ${lease.controller.by})`,
        )
      }
      return { enabled: true, lines }
    },
    close: () => manager.close(),
  }
}

/**
 * Tool kinds of the browser tools for the permission engine. Reading tools are `safe`; acting
 * (`browser_act`) is `other`: it asks in default and plan-safe modes like any tool the engine does
 * not know, and an allow rule or `bypassPermissions` approves it. `browser_open` is `safe` while
 * only local hosts can be opened (the profile's allow list is the gate), else a `fetch` so
 * `WebFetch(domain:host)` rules decide.
 */
export function browserToolKinds(localOnly: boolean): ToolKinds {
  return {
    browser_open: localOnly ? { kind: 'safe' } : { kind: 'fetch', urlField: 'url' },
    browser_snapshot: { kind: 'safe' },
    browser_read: { kind: 'safe' },
    browser_screenshot: { kind: 'safe' },
    // `tabs open` takes a URL too: it follows `browser_open`'s rule
    browser_tabs: localOnly ? { kind: 'safe' } : { kind: 'other' },
    // scrolling reads more of the page: the library gives it `read` risk too
    browser_scroll: { kind: 'safe' },
    browser_act: { kind: 'other' },
  }
}
