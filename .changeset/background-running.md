---
"eharness": minor
---

Move running foreground work to the background (Claude Code's Ctrl+B). `shellTasks.background(toolCallId?)` detaches running foreground `bash` calls into `bash-<n>` tasks (result `Command moved to the background as task bash-N by the user. …`, no more foreground timeout, exit notification like `run_in_background`); `subagentTasks.background(toolCallId?)` does the same for foreground `agent` calls (`agent-<n>`, `inline` / `policy`, needs `background: true`; no-op for `park`). Both return the new task ids.
