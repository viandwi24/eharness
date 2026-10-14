/**
 * The browser driver (`TEAM_BROWSER_*`, plan P48) as the Settings and Browser pages show it, and
 * the pure texts of a takeover. Pure.
 */
export type BrowserDriver = 'off' | 'local'

/** The state of one adapter's managed runtime (`RuntimeStatus` of `eharness/browser`). */
export interface BrowserRuntimeView {
  adapter: string
  label: string
  state: 'missing' | 'installing' | 'ready' | 'starting' | 'running' | 'stopping' | 'error'
  version?: string
  diskBytes?: number
  progress?: { received: number; total?: number }
  /** Profile ids with a running engine. */
  running: string[]
  /** `remote`: the engine of the connected Remote sandbox (adapter id `chrome@remote`). Absent: this server. */
  where?: 'local' | 'remote'
  /** Host of the Remote sandbox for a `remote` runtime. */
  host?: string
  error?: string
}

export interface BrowserSystemMemory {
  totalBytes: number
  freeBytes: number
}

/** `GET /settings/browser`. */
export interface BrowserInfo {
  driver: BrowserDriver
  /** Concurrent running profiles (`TEAM_BROWSER_MAX`). */
  max: number
  /** Headed Chrome on Linux through Xvfb (`TEAM_BROWSER_XVFB`). */
  xvfb: boolean
  /** Machine memory; null when unknown. */
  system: BrowserSystemMemory | null
  runtimes: BrowserRuntimeView[]
  /** Profiles with a running engine. */
  running: number
  /** The connected Remote sandbox that can host managed Chrome profiles. */
  remote?: { host: string }
  /** One line for people. */
  label: string
}

/** The name the agent reads for a live viewer (viewer ids are `client:<n>`, one per socket). */
export const viewerName = (id: string): string =>
  id.startsWith('client:') || id === 'client' ? 'The client' : id

/** What a declined takeover tells the agent. */
export function declinedTakeoverText(note: string): string {
  const why = note.trim()
  return `The client declined to take over the browser${why === '' ? '' : `: ${why}`}. Continue without it, or tell the user that you could not finish.`
}
