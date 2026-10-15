/**
 * `eharness/shell`: the `shell()` plugin (`bash`, `bash_output`, `kill_shell`, live output,
 * background tasks, the `shellTasks` service) and the local sandbox (child processes, optional
 * OS isolation with Seatbelt / bubblewrap). Node-only (ADR-0036).
 *
 * **Draft:** every symbol of this subpath is experimental and may change in a minor release
 * (docs/engineering/api-stability.md).
 *
 * @see docs/specs/19-shell-plugin.md
 */

export {
  detectOsSandbox,
  type OsSandboxKind,
  type OsSandboxProbe,
  probeOsSandbox,
} from './os-sandbox.ts'
export {
  BASH_OUTPUT_TOOL,
  BASH_TOOL,
  capOutput,
  KILL_SHELL_TOOL,
  type ShellDataParts,
  type ShellOptions,
  type ShellOutputData,
  type ShellTaskEvent,
  shell,
} from './plugin.ts'
export {
  killAllSandboxProcesses,
  type LocalSandbox,
  type LocalSandboxOptions,
  localSandbox,
  type OsSandboxOptions,
  removeStaleScratch,
  SAFE_ENV_NAMES,
  type Sandbox,
  type SandboxLimits,
  type SandboxState,
  type ScratchSandbox,
  type ScratchSandboxOptions,
  scratchSandbox,
} from './sandbox-local.ts'
export type { ShellTask, ShellTaskStatus, ShellTasks } from './tasks.ts'
