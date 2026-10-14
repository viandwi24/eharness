/**
 * Public types of `eharness/browser` (spec 35): endpoints, capabilities, the operation-level
 * connection, profiles, leases and live channels.
 *
 * @see docs/specs/35-browser.md
 */
import type {
  ActInput,
  ActResult,
  CdpLimits,
  LiveFeed,
  LiveFrame,
  LiveInput,
  PageInfo,
  Shot,
  Snapshot,
  TabInfo,
} from './cdp/types.ts'

export type {
  ActInput,
  ActResult,
  LiveFeed,
  LiveFrame,
  LiveInput,
  PageInfo,
  Shot,
  Snapshot,
  TabInfo,
}

/** Where a browser is reachable, and how to talk to it (spec 35 §2). */
export interface BrowserEndpoint {
  /** `'cdp'` in core; `'playwright-ws'` in the Camoufox package, and so on. */
  protocol: string
  /** `ws(s)://` or `http(s)://` (CDP `/json/version` is resolved). */
  url: string
  /** Secret values; never logged, never shown. */
  headers?: Record<string, string>
  /** A provider's own live view page (shown in an iframe). */
  liveUrl?: string
}

/** What an engine can do; decides which tools a session gets (spec 35 §2). */
export interface BrowserCapabilities {
  snapshot: boolean
  screenshot: boolean
  /** `external`: only `liveUrl` (an iframe), no frames from us. */
  liveView: 'screencast' | 'poll' | 'external' | 'none'
  /** Remote input from a person. */
  takeover: boolean
  tabs: boolean
  /** The engine keeps cookies across leases in this mode. */
  persistentProfile: boolean
}

/** Sizes, waits and the manager's own limits (spec 35 §7). */
export interface BrowserLimits extends CdpLimits {
  /** A lease is released after this long without a call (ms). Default 300 000. */
  idleMs: number
  /** Leases open at once. Default 8. */
  maxLeases: number
  /** Time to start an engine and connect (ms). Default 60 000. */
  startTimeoutMs: number
  /** Hosts that are never opened (patterns, see `matchesHost`). */
  denyDomains: string[]
  /** Open private, loopback and link-local hosts. Default `false`. */
  allowPrivateHosts: boolean
  /** Stop a managed engine when its idle lease is released (logins stay on disk). Default `true`. */
  stopOnIdle: boolean
}

/** Defaults of {@link BrowserLimits}. */
export const DEFAULT_BROWSER_LIMITS: BrowserLimits = {
  snapshotChars: 20_000,
  readChars: 30_000,
  waitMs: 10_000,
  timeoutMs: 30_000,
  navigateMs: 30_000,
  settleMs: 2_000,
  quietMs: 300,
  shotMaxHeight: 8_000,
  idleMs: 300_000,
  maxLeases: 8,
  startTimeoutMs: 60_000,
  denyDomains: [],
  allowPrivateHosts: false,
  stopOnIdle: true,
}

/**
 * An open browser for one lease (spec 35 §4). Expected failures are `ERROR:` / `STALE:` /
 * `BLOCKED:` strings (a string result, or an `error` field), never throws.
 */
export interface BrowserConnection {
  navigate(
    input: { url?: string; action?: 'back' | 'forward' | 'reload' },
    signal?: AbortSignal,
  ): Promise<PageInfo & { error?: string }>
  snapshot(
    input: { scope?: string; interactive?: boolean; offset?: number },
    signal?: AbortSignal,
  ): Promise<Snapshot | string>
  act(input: ActInput, signal?: AbortSignal): Promise<ActResult>
  screenshot(
    input: { fullPage?: boolean; ref?: string; maxWidth?: number },
    signal?: AbortSignal,
  ): Promise<Shot | string>
  read(
    input: { offset?: number; maxChars?: number },
    signal?: AbortSignal,
  ): Promise<{ text: string; page: PageInfo; nextOffset?: number } | string>
  tabs?(
    input: { action: 'list' | 'open' | 'switch' | 'close'; tab?: string; url?: string },
    signal?: AbortSignal,
  ): Promise<TabInfo[] | string>
  /** URL and title of the current page (cheap). */
  page?(signal?: AbortSignal): Promise<PageInfo>
  /** Start a live feed of the current page (the manager adds the controller rules). */
  live?(): Promise<LiveFeed>
  /** Run a script in the page; returns the result as text. Only used when `allowEval` is on. */
  eval?(expression: string, signal?: AbortSignal): Promise<string>
  /** Forget every ref (a person handed the browser back; the page may have changed). */
  clearRefs?(): void
  /** The connection ended by itself (browser crash, proxy cut): the manager drops the lease. */
  onClose?(handler: (reason: string) => void): () => void
  close(): Promise<void>
}

/** Given to {@link BrowserAdapter.connect}. */
export interface ConnectContext {
  signal?: AbortSignal
  /** Sizes and waits of the manager (the adapter passes them on). */
  limits: CdpLimits
  profile: { id: string; name: string }
}

/** A stored, named browser configuration (spec 35 §3). */
export interface BrowserProfile {
  /** Server-generated. */
  id: string
  /** Unique per store, case-insensitive. */
  name: string
  adapter: string
  mode: 'manual' | 'managed'
  /** Validated by the adapter's schema for the mode; secret fields are sealed at rest. */
  settings: Record<string, unknown>
  /** Only these hosts may be opened (`*.example.com`, `example.com:8080`). Empty or absent: any public host. */
  allowDomains?: string[]
  /** An admin trusts this profile: its acting tools run without asking (risk `write` instead of `external`). */
  trusted?: boolean
  createdAt: number
  updatedAt: number
  /** App data (owner, workspace). */
  metadata?: Record<string, unknown>
}

/** A profile as sent to a browser: secrets replaced by `{ set, hint? }`. */
export type PublicBrowserProfile = Omit<BrowserProfile, 'settings'> & {
  settings: Record<string, unknown>
}

/** Who has a lease. */
export interface LeaseHolder {
  kind: 'session' | 'person'
  id: string
}

/** Who is driving the browser (spec 35 §7). */
export interface ControllerState {
  by: 'agent' | 'human'
  /** The person who took over; unset while a human was asked for (`browser_request_human`) and nobody took it yet. */
  holder?: string
  /** Epoch ms of the last change. */
  since: number
  /** Why the agent asked for a human. */
  reason?: string
}

/** The browser was not leased. `text` is what a tool answers (`BUSY: …` or `ERROR: …`). */
export interface LeaseRefusal {
  refused: true
  kind: 'busy' | 'limit' | 'error'
  text: string
}

/** A profile's open browser, held by one session or person. */
export interface Lease {
  readonly profileId: string
  readonly profile: BrowserProfile
  readonly holder: LeaseHolder
  readonly capabilities: BrowserCapabilities
  readonly connection: BrowserConnection
  controller(): ControllerState
  /** `BUSY: …` text while a person controls the browser, else `undefined` (acting tools check it). */
  busyText(): string | undefined
  /** Reset the idle timer (every tool call does). */
  touch(): void
  /** Remember the page the last tool saw (shown by `status()`). */
  setPage(page: PageInfo): void
  /** The agent asks a person to take over; acting tools answer `BUSY:` until it is handed back. */
  requestHuman(reason: string): void
  /** True until the lease was released or the connection ended. */
  readonly open: boolean
  release(): Promise<void>
}

/** One entry of `manager.status()`. */
export interface LeaseStatus {
  profileId: string
  profileName: string
  adapter: string
  holder: LeaseHolder
  controller: ControllerState
  /** Epoch ms the lease was taken. */
  since: number
  page?: PageInfo
  /** Viewers attached through `live()`. */
  viewers: number
}

/** What changed in the manager (for UIs and for resolving a parked `browser_request_human`). */
export type BrowserEvent =
  | { type: 'lease'; profileId: string; holder: LeaseHolder }
  | {
      type: 'release'
      profileId: string
      reason: 'released' | 'idle' | 'closed' | 'lost' | 'stopped'
    }
  | { type: 'request-human'; profileId: string; reason: string }
  | { type: 'takeover'; profileId: string; by: string }
  | { type: 'handback'; profileId: string; info: HandBackInfo }

/** Who handed the browser back, and where the page is. */
export interface HandBackInfo {
  by: string
  at: number
  page?: PageInfo
  /** `viewer-left`: the person closed the live view while in control. */
  reason: 'handed-back' | 'viewer-left'
}

/** A viewer of a profile's live view. */
export interface LiveChannel {
  info: {
    width: number
    height: number
    liveView: BrowserCapabilities['liveView']
    liveUrl?: string
  }
  /** Frames, newest wins: a slow reader skips frames instead of buffering them. */
  frames: ReadableStream<LiveFrame>
  controller(): ControllerState
  /** Take control. Returns a refusal text (`BUSY: …`), or `undefined` when it worked. */
  takeOver(): Promise<string | undefined>
  /** Give control back to the agent (refs are cleared). Returns a refusal text, or `undefined`. */
  handBack(): Promise<string | undefined>
  /** Send input. Refused (an `ERROR:` text) unless this viewer took over; `navigate` obeys the domain rules. */
  input(event: LiveInput): Promise<string | undefined>
  close(): void
}

/** Same as {@link LeaseRefusal}, for `live()`. */
export type LiveRefusal = LeaseRefusal

/** Memory and CPU per running profile, and the machine's memory when known. */
export interface BrowserUsage {
  profiles: Array<{
    profileId: string
    adapter: string
    rssBytes?: number
    cpuPercent?: number
  }>
  totals: { rssBytes: number; cpuPercent: number }
  system?: { totalBytes: number; freeBytes: number }
}
