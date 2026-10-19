/**
 * `eharness/code`: the `code()` plugin (`run_python`, `install_packages`, the `codeSandbox`
 * service) and the sync bridge `syncedSandbox()` that runs code over the virtual file system in a
 * disposable sandbox (AI SDK `Experimental_SandboxSession`). Runtime-neutral.
 *
 * **Draft:** every symbol of this subpath is experimental and may change in a minor release
 * (docs/engineering/api-stability.md).
 *
 * @experimental
 * @see docs/specs/28-code-plugin.md
 */

export { type ParsedRequirement, parseRequirement } from './env.ts'
export {
  type CodeOptions,
  type CodeSandboxService,
  type CodeSandboxStatus,
  code,
  INSTALL_PACKAGES_TOOL,
  RUN_PYTHON_TOOL,
} from './plugin.ts'
export {
  type CodeFileMeta,
  type CodeFileSystem,
  type CodeLimits,
  type CodeMount,
  type CodeSandbox,
  DEFAULT_CODE_IGNORE,
  DEFAULT_CODE_LIMITS,
  type FilePolicyLike,
  type ManifestEntry,
  type SandboxRunOptions,
  type SandboxRunResult,
  type SkippedFile,
  type SyncedSandbox,
  type SyncedSandboxOptions,
  type SyncInReport,
  type SyncOutReport,
  syncedSandbox,
} from './sync.ts'
