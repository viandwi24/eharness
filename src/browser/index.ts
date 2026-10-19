/**
 * `eharness/browser`: agents drive a real browser (accessibility snapshots with refs, acting on
 * refs, screenshots the model sees), people watch it live and take it over. A registry of
 * adapters (Chrome, Lightpanda), profiles, a manager with leases and live view, and the
 * `browser()` plugin.
 *
 * Runtime-neutral: engines are separate processes reached over a protocol, started by an injected
 * runtime (`eharness/browser/node`, or a remote one). Imports core only through `src/index.ts`
 * (ADR-0008) and `eharness/providers` for forms and the vault.
 *
 * **Draft:** every symbol of this subpath is experimental and may change in a minor release
 * (docs/engineering/api-stability.md).
 *
 * @experimental
 * @see docs/specs/35-browser.md
 */
export {
  type BrowserAdapter,
  type BrowserAdapterDef,
  type BrowserAdapterInfo,
  type BrowserMode,
  type BrowserRegistry,
  createBrowserRegistry,
  defineBrowserAdapter,
} from './adapter.ts'
export { type ChromeAdapterOptions, chromeAdapter } from './adapters/chrome.ts'
export { type LightpandaAdapterOptions, lightpandaAdapter } from './adapters/lightpanda.ts'
export { type CdpBrowserOptions, cdpBrowserConnection } from './cdp/connection.ts'
export { checkUrl, type DomainRules, matchesHost } from './domains.ts'
export {
  type BrowserManager,
  type BrowserManagerOptions,
  type BrowserProfileDraft,
  type BrowserTestResult,
  createBrowserManager,
} from './manager.ts'
export {
  BROWSER_SHOTS_FOLDER,
  type BrowserOptions,
  type BrowserPluginLimits,
  type BrowserService,
  type BrowserShotRef,
  type BrowserToolName,
  browser,
  formatHandBack,
  isBrowserShotRef,
  OLDER_SCREENSHOT_TEXT,
} from './plugin.ts'
export {
  type BrowserProfileInput,
  type BrowserProfilePatch,
  type BrowserProfileStore,
  type BrowserProfileUpdate,
  type MemoryBrowserProfileStoreOptions,
  memoryBrowserProfileStore,
  publicProfile,
  type SealedBrowserProfilesOptions,
  sealedBrowserProfiles,
} from './profiles.ts'
export type {
  BrowserRuntime,
  InstallOptions,
  InstallProgress,
  ProcessUsage,
  RuntimeEndpoint,
  RuntimeProfile,
  RuntimeStatus,
  SystemMemory,
} from './runtime.ts'
export {
  type ActInput,
  type ActResult,
  type BrowserCapabilities,
  type BrowserConnection,
  type BrowserEndpoint,
  type BrowserEvent,
  type BrowserLimits,
  type BrowserProfile,
  type BrowserUsage,
  type ConnectContext,
  type ControllerState,
  DEFAULT_BROWSER_LIMITS,
  type HandBackInfo,
  type Lease,
  type LeaseHolder,
  type LeaseRefusal,
  type LeaseStatus,
  type LiveChannel,
  type LiveFeed,
  type LiveFrame,
  type LiveInput,
  type PageInfo,
  type PublicBrowserProfile,
  type Shot,
  type Snapshot,
  type TabInfo,
} from './types.ts'
