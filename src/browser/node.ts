/**
 * `eharness/browser/node`: managed browser runtimes (Node-only, ADR-0036).
 *
 * **Draft:** every symbol of this subpath is experimental and may change in a minor release
 * (docs/engineering/api-stability.md).
 *
 * @experimental
 */
export {
  CHROME_VERSIONS_URL,
  type ChromePlatform,
  type ChromeRuntimeOptions,
  checkExtraArgs,
  chromePlatform,
  chromeRuntime,
  detectContainer,
} from './node/chrome.ts'
export type { FetchLike } from './node/download.ts'
export {
  LIGHTPANDA_RELEASES_URL,
  type LightpandaRuntimeOptions,
  lightpandaAsset,
  lightpandaRuntime,
} from './node/lightpanda.ts'
export type { LaunchedProcess, LaunchOptions, ProcessLauncher } from './node/process.ts'
export { processUsage, systemMemory } from './node/resources.ts'
export type {
  BrowserRuntime,
  InstallOptions,
  InstallProgress,
  ProcessUsage,
  RuntimeEndpoint,
  RuntimeProfile,
  RuntimeStatus,
  SystemMemory,
} from './node/types.ts'
