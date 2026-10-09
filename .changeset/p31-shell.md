---
"eharness": minor
---

New subpath `eharness/shell` (Node-only): the `shell()` plugin and a local sandbox.

- **`shell({ sandbox, timeoutMs?, maxTimeoutMs?, maxOutputChars?, background?, onTaskEvent?, toolName?, risk? })`** contributes the `bash` tool (`metadata.risk: 'external'` by default; capped output, timeouts, process-group kill), the transient `data-shell.output` part for live output, and with `background` also `run_in_background` / `notify_on`, `bash_output` and `kill_shell`. Task exits and monitor matches are handed to `onTaskEvent` (inject them with `session.inject('eh.event', e.payload, e.options)` so they are stored and can wake an idle session); without it they appear as a step reminder in a running turn.
- **`shellTasks` service** (`list`, `get`, `output`, `stop`, `stopAll`, `subscribe`) for UIs.
- **`localSandbox(root, { os?, env?, shell? })`**: an AI SDK `Experimental_SandboxSession` over child processes in their own process groups, with optional OS isolation (macOS Seatbelt, Linux bubblewrap) and `state()` / `setOs()`. Also `detectOsSandbox()` and `killAllSandboxProcesses()`.
- Contract: spec 19; guide: `docs/guides/shell.md`.
