/**
 * `run_python` of the coder (`eharness/code`, spec 28): Python over the project files through the
 * library's synchronised sandbox, for data and scripting tasks. Opt-in through the `code` setting.
 *
 * The sandbox is a disposable scratch directory (`scratchSandbox`, one per session) with the OS
 * sandbox on and the network off. The project stays the source of truth: the folders in
 * `code.mounts` are copied in before each run and what the script changed is written back to the
 * project through the file system (so `/rewind` checkpoints see it). The tool exists on the main
 * agent only.
 */
import { type CodeOptions, RUN_PYTHON_TOOL } from 'eharness/code'
import { type ScratchSandbox, scratchSandbox } from 'eharness/shell'
import type { CodeSettings } from '../contracts.ts'

export { RUN_PYTHON_TOOL }

/** Default synced folder: scripts and data the agent keeps in `work/` of the project. */
export const DEFAULT_CODE_MOUNTS: readonly string[] = ['/work/']

/** What the code tool needs from the app. */
export interface CodeSupport {
  options: CodeOptions
  mounts: string[]
  /** The tool refuses to run when the OS sandbox cannot be used (`code.allowUnsandboxed` lifts it). */
  requireIsolation: boolean
}

/** Options of {@link createCodeSupport}. */
export interface CreateCodeSupportOptions {
  settings: CodeSettings | undefined
  /** The OS sandbox (sandbox-exec / bubblewrap) can be started here. */
  osUsable: boolean
  /** Environment passed into the sandbox (dev-tool variables, no API keys). */
  env?: Record<string, string>
  /** Replace the scratch sandbox (tests). */
  sandbox?: () => Promise<ScratchSandbox> | ScratchSandbox
}

/** A mount must be `/folder/` (or `/`); anything else is dropped. */
function validMounts(list: readonly string[] | undefined): string[] {
  const mounts = (list ?? DEFAULT_CODE_MOUNTS).filter(
    (m) => m.startsWith('/') && m.endsWith('/') && !m.includes('..') && !m.startsWith('/.eh-code/'),
  )
  return mounts.length > 0 ? [...new Set(mounts)] : [...DEFAULT_CODE_MOUNTS]
}

/** Build the `code()` options, or `undefined` when the `code` setting is off. */
export function createCodeSupport(options: CreateCodeSupportOptions): CodeSupport | undefined {
  const settings = options.settings
  if (settings?.enabled !== true) return undefined
  const mounts = validMounts(settings.mounts)
  const requireIsolation = settings.allowUnsandboxed !== true
  return {
    mounts,
    requireIsolation,
    options: {
      sandbox:
        options.sandbox ??
        ((): Promise<ScratchSandbox> =>
          scratchSandbox({
            // model-written code never gets the network (no `install_packages` either)
            os: { enabled: options.osUsable, network: false, allowWrite: [] },
            ...(options.env === undefined ? {} : { env: options.env }),
          })),
      mounts: mounts.map((virtual) => ({ virtual })),
      requireIsolation,
      limits: { timeoutMs: 60_000, maxTimeoutMs: 300_000 },
    },
  }
}
