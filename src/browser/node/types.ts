/**
 * Runtime-side types for managed browser runtimes (spec 35 §6). They are the module's own types
 * (`src/browser/runtime.ts`); `usage` is required here because the Node runtimes always have it.
 */
import type {
  BrowserRuntime as BaseBrowserRuntime,
  ProcessUsage,
  RuntimeEndpoint,
  RuntimeProfile,
} from '../runtime.ts'

export type {
  InstallOptions,
  InstallProgress,
  ProcessUsage,
  RuntimeEndpoint,
  RuntimeProfile,
  RuntimeStatus,
  SystemMemory,
} from '../runtime.ts'

/** A {@link BaseBrowserRuntime} whose `usage` is always there (the Node runtimes implement it). */
export interface BrowserRuntime extends BaseBrowserRuntime {
  start(profile: RuntimeProfile, settings?: Record<string, unknown>): Promise<RuntimeEndpoint>
  usage(profileId: string): Promise<ProcessUsage | null>
}
