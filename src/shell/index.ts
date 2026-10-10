/**
 * `eharness/shell`: the `shell()` plugin (`bash`, `bash_output`, `kill_shell`, live output,
 * background tasks, the `shellTasks` service) and the local sandbox (child processes, optional
 * OS isolation with Seatbelt / bubblewrap). Node-only (ADR-0036).
 *
 * @see docs/specs/19-shell-plugin.md
 */

export {
  detectOsSandbox,
  type OsSandboxKind,
  SANDBOX_HINT,
  seatbeltProfile,
  wrapCommand,
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
  type Sandbox,
  type SandboxState,
} from './sandbox-local.ts'
export { MAX_TASK_OUTPUT, type ShellTask, type ShellTaskStatus, type ShellTasks } from './tasks.ts'
