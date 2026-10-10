---
"eharness": minor
---

New subpath `eharness/shell` (Node-only): the `shell()` plugin and a local sandbox.

- `shell({ sandbox, timeoutMs?, maxTimeoutMs?, maxOutputChars?, background?, onTaskEvent?, toolName?, risk? })` contributes the `bash` tool (`metadata.risk: 'external'` by default; capped output, timeouts, process-group kill, a description that states the sandbox state) and the transient `data-shell.output` part for live output. Tool names are exported as `BASH_TOOL`, `BASH_OUTPUT_TOOL` and `KILL_SHELL_TOOL`.
- With `background` it also offers `run_in_background` and `notify_on` on `bash`, plus `bash_output` and `kill_shell` (names kept from Claude Code). Task exits and monitor matches are injected into the session as `eh.event` messages by the plugin itself (`wake` by default); `onTaskEvent` overrides delivery.
- The `shellTasks` service (`list`, `get`, `output`, `stop`, `stopAll`, `subscribe`, `moveToBackground(toolCallId?)`) serves UIs. `moveToBackground()` detaches running foreground `bash` calls into `bash-<n>` tasks (Claude Code's Ctrl+B); the call returns at once and the task notifies on exit.
- `localSandbox(root, { os?, env?, shell? })`: an AI SDK sandbox over child processes in their own process groups, with optional OS isolation (macOS Seatbelt, Linux bubblewrap) and `state()` / `setOs()` (`SandboxState` includes `writableRoots`). Also `detectOsSandbox()` and `killAllSandboxProcesses()`.

See spec 19 and the shell guide.
