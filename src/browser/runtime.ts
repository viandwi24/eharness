/**
 * Managed runtime contract (spec 35 §6): what makes a `managed` profile run. Implementations are
 * Node-only (`eharness/browser/node`) or remote (an app's HTTP driver). Types only: the module
 * never spawns a process.
 */

/** Where a started engine listens. Local runtimes always use loopback. */
export interface RuntimeEndpoint {
  /** `ws://127.0.0.1:<port>[/devtools/browser/<id>]`, or any CDP URL a remote runtime exposes. */
  cdpUrl: string
  /** Engine process id, when known (for resource display). */
  pid?: number
  /** Secret headers a remote runtime needs on the connection (never logged, never shown). */
  headers?: Record<string, string>
  /** A live view page the runtime offers itself (shown in an iframe). */
  liveUrl?: string
}

/** The part of a browser profile a runtime needs. */
export interface RuntimeProfile {
  id: string
  name?: string
}

/** Download progress. */
export interface InstallProgress {
  received: number
  total?: number
}

/** State of a runtime (one per adapter, serving many profiles). */
export interface RuntimeStatus {
  /** `installing` while a download/extract runs; `running` while at least one profile runs. */
  state: 'missing' | 'installing' | 'ready' | 'starting' | 'running' | 'stopping' | 'error'
  version?: string
  /** Disk used by the installed engine, bytes. */
  diskBytes?: number
  /** Download progress while `installing`. */
  progress?: InstallProgress
  /** Profile ids with a running engine process. */
  running?: string[]
  error?: string
}

/** Memory and CPU of an engine process tree. */
export interface ProcessUsage {
  rssBytes: number
  cpuPercent: number
}

/** Memory of the machine the engines run on. */
export interface SystemMemory {
  totalBytes: number
  freeBytes: number
}

/** Options of {@link BrowserRuntime.install}. */
export interface InstallOptions {
  signal?: AbortSignal
  onProgress?(p: InstallProgress): void
}

/**
 * Downloads, prepares, starts and stops an engine. One runtime serves every profile of its adapter;
 * the adapter's managed settings go to `start`. Failures throw (`HarnessError` or `Error` with a
 * readable message); the manager turns them into `ERROR:` text for tools.
 */
export interface BrowserRuntime {
  status(): Promise<RuntimeStatus>
  install(opts?: InstallOptions): Promise<void>
  /** Idempotent per profile. */
  start(profile: RuntimeProfile, settings?: Record<string, unknown>): Promise<RuntimeEndpoint>
  stop(profileId: string): Promise<void>
  removeProfileData?(profileId: string): Promise<void>
  uninstall?(): Promise<void>
  /** Memory/CPU of a running profile's process tree, `null` when not running or unknown. */
  usage?(profileId: string): Promise<ProcessUsage | null>
}
