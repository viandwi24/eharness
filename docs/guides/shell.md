# Shell

`eharness/shell` gives an agent a command line: the `bash` tool with live output, caps and
timeouts, optional background tasks, and a local sandbox that can isolate commands at the OS level.
Contract: [spec 19](../specs/19-shell-plugin.md). It is Node-only (child processes).

```ts
import { defineHarnessAgent } from 'eharness'
import { localSandbox, shell } from 'eharness/shell'

const agent = defineHarnessAgent({
  model,
  plugins: [shell({ sandbox: localSandbox(process.cwd(), { os: { enabled: true } }) })],
})
```

## Safety is configuration, not a prompt

The module never asks anyone. The tool declares `risk: 'external'`; the core decides what that
means for you (`tool.approve`, `approval.risk`, see [approvals](approvals-and-interaction.md)):

- **Autonomous server:** no approvals. The safety net is the sandbox (`os: { enabled: true }`, or a
  container/VM `Experimental_SandboxSession` driver) and the limits (`timeoutMs`, `maxTimeoutMs`,
  `maxOutputChars`, `background.maxTasks`).
- **CLI:** prompt on `external`, and let the user toggle isolation with `sandbox.setOs({ enabled })`.
- **Web + server:** the shell runs on the server, approvals travel through `respond()`.

`os: { enabled: true }` uses Seatbelt on macOS and bubblewrap on Linux (writes only in the root,
`allowWrite` and temp; network off unless `network: true`). Check `sandbox.state().enabled`: when the
platform tool is missing it is `false` and you must not tell users they are isolated.

The `bash` tool description states the sandbox state for the model ("Commands run in an OS
sandbox: writes only inside …" or "… without an OS sandbox …"). It is computed when the session's
tools are resolved, so a `setOs()` toggle shows up in the next session or tool resolution; the
prompt cache is only busted when the setting actually changed.

## Live output

Foreground commands write transient `data-shell.output` parts (`{ toolCallId, stream, chunk }`).
Render them under the tool call with the same id ([rendering guide](rendering-data-parts.md)); they
are never stored.

## Background tasks

```ts
shell({
  sandbox,
  background: { maxTasks: 4, notify: 'wake' },
})
```

The model gets `run_in_background`, `notify_on` (a regex that reports matching lines, batched), and
the tools `bash_output` and `kill_shell`. When a task exits, or a monitor matches, the plugin
injects an `eh.event` into its own session (`ctx.session.inject`). With `wake`, an idle session
starts a turn so the agent can react. Because the result goes through the session it is stored,
and a web client that disconnected still finds it in the history. A woken turn has no consumer of
its own: follow it with `session.events()` / `session.attach()`, or set
`onTaskEvent: (e) => session.inject('eh.event', e.payload, e.options)` to take delivery over and
drive the returned run yourself.

## Moving a running command to the background

`ctx.services.shellTasks.background()` detaches every running foreground `bash` call (Claude Code's
Ctrl+B) and returns the new task ids. The call returns to the model at once ("Command moved to the
background as task bash-3 by the user. Output so far: …"), the command keeps running as a normal
background task (no foreground timeout any more) and its exit is delivered like a
`run_in_background` task. Needs `background` enabled; otherwise it returns `[]`.

## UIs: the `shellTasks` service

```ts
// in a hook or tool of your own plugin (`requires: ['shellTasks']`), after shell() in the plugin list
const tasks = ctx.services.shellTasks
tasks.list(); tasks.output('bash-1'); await tasks.stop('bash-1')
const off = tasks.subscribe((list) => render(list))
```

The service is per session. All running tasks are stopped when the
session closes; in a CLI also call `killAllSandboxProcesses()` from your exit handlers.

## Other drivers

`shell({ sandbox })` accepts any `Experimental_SandboxSession`; a factory
(`sandbox: (ctx) => driverFor(ctx.runtime.tenant)`) is called once per session. OS isolation is
defence in depth, not a jail for hostile code: use a container or VM driver for that.
