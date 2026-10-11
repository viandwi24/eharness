# Shell

`eharness/shell` gives an agent a command line: the `bash` tool with live output, caps and
timeouts, optional background tasks, and a local sandbox that can isolate commands at the OS level.
Contract: [spec 19](../specs/19-shell-plugin.md). It is Node-only (child processes).

```ts
import { defineHarnessAgent } from 'eharness'
import { localSandbox, shell } from 'eharness/shell'

// yours: `model` is an AI SDK LanguageModel
const agent = defineHarnessAgent({
  model,
  plugins: [shell({ sandbox: localSandbox({ root: process.cwd(), os: { enabled: true } }) })],
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

## Environment and sandbox limits

- **The command inherits only a safe part of the host environment.** `localSandbox` passes
  only an allow-list of `process.env` (`SAFE_ENV_NAMES`, exported from `eharness/shell`: `PATH`,
  `HOME`, `USER`, `LOGNAME`, `SHELL`, `LANG`, `TERM`, `TMPDIR`, `TZ`, the usual Windows variables,
  and every `LC_*`), not provider API keys or database URLs. Add what a project needs (git,
  package-manager or proxy variables, say) with `localSandbox({ root, env: { NODE_ENV: 'test' } })`;
  `inheritEnv: true` passes the whole `process.env` and with it the risk: any approved script (`npm test`) can read every variable,
  even though `echo $X` and `env` are not auto-approved. Keep secrets in the process that runs the
  harness, not in the shell's environment.
- **The OS sandbox limits writes and network, not reads.** Seatbelt and bubblewrap leave the
  whole file system readable (SSH keys, `~/.aws`); keep credentials out of the user that runs the
  server or use a container/VM driver. The macOS profile also keeps outbound unix sockets, which
  reaches `/var/run/docker.sock` or an ssh-agent socket: do not describe it as a hard jail when
  those exist. `sandbox.state()` only says whether the tool is active.
- **bubblewrap inside a container needs namespaces.** The Linux profile unshares the PID, IPC and
  network namespaces (`--unshare-pid --unshare-ipc --new-session`, plus `--unshare-net` without
  `network: true`). In a default Docker container this fails with
  `bwrap: loopback: Failed RTM_NEWADDR` because setting up the loopback device needs
  `CAP_NET_ADMIN`; run the container with the namespaces bubblewrap needs (user namespaces, or
  `--cap-add NET_ADMIN --cap-add SYS_ADMIN` with an unconfined seccomp/AppArmor profile), or rely on
  the container itself as the boundary and leave `os` off.
- **Timeouts kill the process group** with SIGTERM then SIGKILL after 2 s; a descendant that
  detached from the group and ignores SIGTERM can outlive a timeout. Use a container for
  untrusted workloads.

## Live output

Foreground commands write transient `data-shell.output` parts (`{ toolCallId, stream, chunk }`).
Render them under the tool call with the same id ([rendering guide](rendering-data-parts.md)); they
are never stored.

## Background tasks

```ts
// yours: `sandbox` is a localSandbox(...) or another driver
shell({
  sandbox,
  background: { maxTasks: 4, notify: 'wake' },
})
```

The model gets `run_in_background`, `notify_on` (a regex that reports matching lines, batched, at
most one event per `monitorIntervalMs`, default 5 000), and the tools `bash_output` (with an
optional `filter` regex) and `kill_shell`. `maxTasks` defaults to 8 and `notify` to `'wake'`.

The model supplies the `filter` and `notify_on` patterns, so they accept only the safe regex subset
of the `grep` tool: at most 512 characters, one variable-width quantifier in total, no quantified
groups, no backreferences or lookarounds. Each output line is tested on its first 2 000 characters
only. An unsafe pattern is returned to the model as an error string that states the rule, so it can
retry with a simpler one. When a task exits, or a monitor matches, the plugin
injects an `eh.event` into its own session (`ctx.session.inject`). With `wake`, an idle session
starts a turn so the agent can react. Because the result goes through the session it is stored,
and a web client that disconnected still finds it in the history. A woken turn has no consumer of
its own: follow it with `session.events()` / `session.attach()`, or set
`onTaskEvent: (e) => session.inject('eh.event', e.payload, e.options)` to take delivery over and
drive the returned run yourself.

## Moving a running command to the background

`ctx.services.shellTasks.moveToBackground()` detaches every running foreground `bash` call (Claude Code's
Ctrl+B) and returns the new task ids. The call returns to the model at once ("Command moved to the
background as task bash-3 by the user. Output so far: …"), the command keeps running as a normal
background task (no foreground timeout any more) and its exit is delivered like a
`run_in_background` task. Needs `background` enabled; otherwise it returns `[]`.

## UIs: the `shellTasks` service

```ts
// in a hook or tool of your own plugin (`requires: ['shellTasks']`), after shell() in the plugin list
// yours: `ctx` (the hook or tool context), `render`
const tasks = ctx.services.shellTasks
tasks.list(); tasks.output('bash-1'); await tasks.stop('bash-1')
const off = tasks.subscribe((list) => render(list))
```

The service is per session. All running tasks are stopped when the
session closes; in a CLI also call `killAllSandboxProcesses()` from your exit handlers.

## Other drivers

`shell({ sandbox })` accepts any `Experimental_SandboxSession`; a factory
(`sandbox: (ctx) => driverFor(ctx.runtime.tenant)`, where `driverFor` is yours) is called once per session. OS isolation is
defence in depth, not a jail for hostile code: use a container or VM driver for that.
