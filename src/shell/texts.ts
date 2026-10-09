/** Model-visible texts of the shell plugin (API: changing them is a minor change, spec 19 §2). */

/** Description of the `bash` tool (`{toolName}` is not substituted: the tool keeps its own name). */
export const BASH_DESCRIPTION = `Run a shell command in the project root and return its combined output and exit code.

- Commands run in the project root with your user's privileges; use relative paths. Each call is a fresh shell: \`cd\` and exported variables do not persist.
- Prefer dedicated file tools for reading, listing, searching and editing files when you have them; use the shell for builds, tests, git, package managers and other commands.
- Quote paths that contain spaces. Chain dependent commands with && (or ; when failures do not matter).
- No interactive commands (editors, pagers, prompts waiting for input): stdin is closed.
- Long output is truncated to the first and last part. A non-zero exit code is reported, not an error.
- Default timeout {defaultTimeoutSeconds} s, at most {maxTimeoutSeconds} s (timeoutMs); a timed-out command is killed. Set \`description\` to a 5-10 word summary of what the command does.`

/** Appended to the description when background tasks are enabled. */
export const BACKGROUND_NOTE = `

Background mode: set \`run_in_background: true\` to start a long-running command (dev server, watcher, slow test run) and return at once with a task id. Read its output with bash_output and stop it with kill_shell; you are told when it exits. Add \`notify_on\` (a regex) to be told about each new output line matching it (at most one notification per 5 seconds, batched), e.g. "error|ready in".`

export const BASH_OUTPUT_DESCRIPTION =
  'Read the output a background task (bash-N) printed since you last read it, with its status and exit code. Optional `filter` is a regular expression: only matching lines are returned (the rest is skipped, not kept for later).'

export const KILL_SHELL_DESCRIPTION =
  'Stop a running background shell (bash-N). Use it for servers and watchers you started and no longer need.'

/** Hint appended to results when a sandbox denial shows up while the OS sandbox is on. */
export { SANDBOX_HINT } from './os-sandbox.ts'

/**
 * Sandbox state line appended to the `bash` description when the sandbox exposes `state()`
 * (computed when the session's tools are resolved; `{roots}` and `{network}` are filled in).
 */
export const SANDBOX_ON_NOTE =
  'Commands run in an OS sandbox: writes only inside {roots} (and temp dirs), network {network}.'
export const SANDBOX_OFF_NOTE = "Commands run without an OS sandbox, with your user's privileges."
