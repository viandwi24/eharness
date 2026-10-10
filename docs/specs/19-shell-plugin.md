# Spec 19 — Shell plugin (`eharness/shell`)

Status: **Draft (0.7)**. Module: `src/shell/*`. Built only with the public core API
(ADR-0008). Node-only: it uses `node:child_process` and `node:fs` (ADR-0036); never `Bun.*`.
Design: ADR-0034 (one module, three deployment profiles).

`shell()` gives an agent a command-line tool: `bash` (live output, caps, timeouts), optional
background tasks (`bash_output`, `kill_shell`, `notify_on`), and a `shellTasks` service for UIs.
`localSandbox()` is the shipped driver (child processes in their own process groups, optional OS
isolation). The sandbox type is AI SDK's `Experimental_SandboxSession`; any driver that implements
it (a container, a remote VM) works with `shell()`.

## 1. API

```ts
import { shell, localSandbox, detectOsSandbox, killAllSandboxProcesses } from 'eharness/shell'

shell({
  sandbox: Sandbox | ((ctx: HarnessContext) => Sandbox | Promise<Sandbox>), // factory: once per session
  timeoutMs?: number            // default 120_000 (foreground)
  maxTimeoutMs?: number         // default 600_000 (cap of the model's `timeoutMs`)
  maxOutputChars?: number       // default 30_000 (head 10_000 + tail)
  background?: boolean | {      // default false
    maxTasks?: number           // running at once, per session. Default 8
    notify?: 'next-step' | 'wake' | false   // default 'wake'
    monitorIntervalMs?: number  // min. time between two notify_on events. Default 5000
  }
  onTaskEvent?: (e: ShellTaskEvent) => void | Promise<void>   // §5; overrides the default ctx.session.inject
  toolName?: string             // default 'bash'
  risk?: ToolRisk               // default 'external'
}): HarnessPlugin<'shell', ShellDataParts>

localSandbox(root: string, opts?: {
  os?: { enabled: boolean; network?: boolean; allowWrite?: string[] }   // default: off
  env?: Record<string, string>   // added to process.env for every command
  shell?: string                 // default /bin/bash, else /bin/sh
}): LocalSandbox  // Sandbox & { state(): SandboxState; setOs(os): void }

detectOsSandbox(): { kind: 'seatbelt' | 'bubblewrap' | 'none'; path?: string }
killAllSandboxProcesses(signal = 'SIGTERM'): void
```

The plugin is named `shell`: part `data-shell.output`, state namespace `plugins.shell.*` (unused),
service `shellTasks`. It contributes **no instructions** (the tool descriptions carry the usage
text) and does not touch the prompt-cache prefix: tool order is `bash`, then `bash_output`,
`kill_shell` (only with `background`).

Exports besides the above: `capOutput`, `seatbeltProfile`, `wrapCommand`, `SANDBOX_HINT`,
`BASH_TOOL` (`'bash'`), `BASH_OUTPUT_TOOL`, `KILL_SHELL_TOOL`, `MAX_TASK_OUTPUT` and the types.

## 2. Tools (model-visible; text changes are a minor change)

### `bash`

Input: `{ command, description?, timeoutMs? }`; with `background`: plus `run_in_background?`,
`notify_on?`. `metadata.risk` = `risk` (default `'external'`). The description is the text in
`src/shell/texts.ts` (`BASH_DESCRIPTION` with the timeouts filled in, plus `BACKGROUND_NOTE` when
`background` is on). When the sandbox exposes `state()` (`localSandbox` does) a sandbox line is
appended, computed when the session's tools are resolved: `Commands run in an OS sandbox: writes
only inside <roots> (and temp dirs), network on|off.` or `Commands run without an OS sandbox, with
your user's privileges.` The description changes (and the prompt-cache prefix with it) only when
the sandbox setting changed between sessions or tool resolutions. `state()` also carries
`writableRoots` (the root and `allowWrite`).

Foreground result (always a string, never a throw):

| Situation | Result |
|---|---|
| finished | `<output>\nExit code <n> · <s>s` (only the footer when there is no output); a non-zero code is **not** an error |
| timed out | `<output>\n(timed out after <n>s)`; the process group is killed |
| aborted (turn abort) | `<output>\n(aborted after <s>s)` |
| cannot start | `ERROR: could not start the command: <message>` |
| other failure | `ERROR: <message>` |

Output is stdout and stderr interleaved as they arrive, capped at `maxOutputChars`: the first
`min(10 000, max/3)` characters, `\n… [<n> characters omitted] …\n`, and the tail. Memory is
bounded (head plus a rolling tail), not the output size. When the sandbox has an enabled OS
sandbox (`sandbox.state().enabled`) and the output contains `Operation not permitted` or
`Read-only file system`, the line `(The command ran in the OS sandbox: writes outside the project
and network access are blocked.)` is appended before the footer.

Background (`run_in_background: true`): the command starts and the result is
`Started background task bash-N. Use bash_output to read its output.` at once; ids count per
session (`bash-1`, `bash-2`, …). The process is **not** tied to the turn's abort signal (it lives
until it exits, is killed, or the session closes). `notify_on` is a regex (invalid:
`ERROR: notify_on is not a valid regular expression: …`, nothing starts). More than `maxTasks`
running: `ERROR: <n> background tasks are already running. Stop one with kill_shell first.`

### `bash_output` (only with `background`, risk `read`)

Input `{ id, filter? }`. Returns `[bash-N: <status>]` plus the output printed since the last read
(`running`, `completed`, `failed, exit code <n>`, `stopped`), `(no new output)` when empty. `filter`
is a regex: only matching lines are returned and the rest is skipped. Output is capped like
`bash`. Unknown id: `ERROR: no background task "<id>". Known: bash-1, …`. Per task the retained
output is 1 MB (newest kept); a read that missed dropped output starts with
`[… <n> characters of older output dropped]`.

### `kill_shell` (only with `background`, risk `write`)

Input `{ id }`. `Stopped bash-N.`, `bash-N is not running (<status>).` or
`ERROR: no background shell "<id>". To stop a background agent (agent-N) use agent_stop.` Stopping sends SIGTERM to the process group and SIGKILL after
2 s. A stopped task never sends an exit event.

## 3. Data part

`data-shell.output`, **transient** (never persisted, never projected to the model):
`{ toolCallId, stream: 'stdout' | 'stderr', chunk }`, one part per chunk of a **foreground**
command, written only while the stream is active (`ctx.stream.active`). A UI shows it under the
tool call with that `toolCallId`. Background output is read through `shellTasks`.

## 4. Service `shellTasks`

Per session, in memory (a restart loses the processes anyway):

```ts
interface ShellTasks {
  list(): ShellTask[]                       // oldest first
  get(id: string): ShellTask | undefined
  output(id: string): string                // whole retained output
  stop(id: string): Promise<void>           // marks 'stopped', then kills the group
  stopAll(): Promise<void>
  subscribe(listener: (tasks: ShellTask[]) => void): () => void
  moveToBackground(toolCallId?: string): string[] // move running foreground bash calls to the background (§4.1)
}
interface ShellTask {
  id: string; label: string; command: string
  status: 'running' | 'completed' | 'failed' | 'stopped'
  exitCode?: number | null; startedAt: number; endedAt?: number; tail: string
}
```

`subscribe` fires on start, on completion and (throttled to 100 ms) while output arrives; listener
errors are swallowed. A completed task is `completed` with exit code 0, else `failed`; a task that
was stopped stays `stopped` whatever the process reports. On session close (and when the
session's `ctx.signal` aborts) every running task is stopped.

### 4.1 Moving a running foreground command to the background

`moveToBackground(toolCallId?)` (Ctrl+B in Claude Code) detaches the running foreground `bash` calls of
the session (all, or only that tool call) and returns the new task ids (`[]` when nothing was
running, the call was unknown, `maxTasks` is reached, or `background` is not enabled). Each call
registers a task in the same registry (`bash-<n>`, same id counter as `run_in_background`); the
output so far is copied into it and the process keeps being captured. The foreground timeout and
the tool call's abort signal no longer apply (a background task lives until it exits, is stopped,
or the session closes). The tool call resolves at once with `Command moved to the background as
task <id> by the user. Output so far:\n<tail>\nUse bash_output to read more; you will be notified
when it finishes.` (`…Use bash_output to read more.` when `notify: false`). On exit the registry
is completed and the `exit` event is delivered exactly like a `run_in_background` task (§5);
`notify_on` monitors do not apply. The live `data-shell.output` chunks stop at the detach.

## 5. Task events and the three profiles

When a background task exits (not when stopped) or `notify_on` lines match, an event is built:

```ts
interface ShellTaskEvent {
  sessionId: string; taskId: string; type: 'exit' | 'match'
  payload: { name: 'task'; text: string; data: { id; kind: 'exit' | 'match'; exitCode? } }
  options: { deliver: 'next-step'; wake?: true }    // wake with notify: 'wake'
}
```

Texts (API): exit `Background task bash-N (<command, 80 chars>) exited with code <n>.`; match
`Background task bash-N (<command>) printed <n> line(s) matching /<re>/:\n<lines>` (batched, at
most 40 lines / 4000 characters, rate-limited by `monitorIntervalMs`; the first match goes out at
once, the rest at the interval and at exit).

**Delivery.** The plugin hands the event to its own session with `ctx.session.inject('eh.event',
payload, options)` (spec 01 §4). `inject` persists a kind message, so the event survives a restart
of the UI process and works across instances with an inbox; with `deliver: 'next-step'` it reaches
a running turn at its next step boundary. With `wake: true` an idle session starts a no-input turn
(spec 05 / 11 §6.3); that run is not returned to anyone, so the application observes it through
`session.events()` / `session.attach()` (or overrides delivery with `onTaskEvent`, below).

- `onTaskEvent` not set (default): `ctx.session.inject(...)`. When it rejects (a closed session, a
  failed store) the error is logged and the text is queued as a `step.prepare` reminder for a
  running turn.
- `onTaskEvent` set: the plugin calls it **instead** (errors are logged, never thrown). Use it to
  inject through your own handle and drive the returned run (stream it, answer approvals), or to
  route events elsewhere.
- `notify: false`: no events; the model polls `bash_output`.

Typical configurations:

| Profile | Configuration |
|---|---|
| **Autonomous server** (no human, no approvals) | `localSandbox(workdir, { os: { enabled: true } })` (or a container driver); core approval configured so `risk: 'external'` runs unattended (spec 11); `timeoutMs`/`maxTimeoutMs`/`maxOutputChars` as limits; `background` usually off, or `notify: 'wake'` with an `onTaskEvent` that injects. The sandbox and the limits are the safety net. |
| **Single-process CLI** | `localSandbox(cwd, { os })` with a UI toggle through `sandbox.setOs()`; `background: true`; render `data-shell.output` under the tool call and `shellTasks.subscribe` in a task list; `onTaskEvent` injects into the live session and the CLI drives the returned run; `killAllSandboxProcesses()` in exit handlers. Prompts via `tool.approve` on `risk`. |
| **Split web + server** | The shell runs on the server: sandbox factory per session (per-tenant root); `onTaskEvent` injects with `wake: true` so results are delivered through the session (durable), never only through a callback to a browser; the browser sees `data-shell.output` in the UI stream and approves through `respond()`. No UI-process state is needed to keep a task result. |

## 6. Local sandbox

`localSandbox(root)` implements the AI SDK `SandboxSession`: `spawn`, `run`, `readFile`,
`readTextFile` (line ranges), `readBinaryFile`, `writeFile`, `writeTextFile`, `writeBinaryFile`,
and a `description` that states whether commands are sandboxed. Relative file paths resolve against
`root`; file operations run in the calling process (they are **not** covered by the OS sandbox).

- Each command runs in its own **process group** (`detached`); `kill()`, an abort or a timeout
  sends SIGTERM to the group and SIGKILL after 2 s. `wait()` rejects with the abort reason when the
  abort signal fired; a signal exit is `128 + signal` (143 for SIGTERM).
- stdin is closed (`ignore`). The environment is `process.env` + `opts.env` + per-call `env`.
- `killAllSandboxProcesses(signal?)` terminates every live group of every local sandbox in the
  process (exit handlers). With `SIGKILL`, or when nothing runs, it returns at once; otherwise a
  SIGKILL follows after 2 s from an unref'd timer, which cannot run inside `process.exit`.
- `state()` is `{ enabled, kind, network }`: `enabled` is true only when requested **and** the
  platform tool exists; never claim isolation when `kind` is `'none'`. `setOs()` applies to
  commands started afterwards.

### OS sandbox profiles

Same policy on both platforms: everything is readable; writes only under the root, `allowWrite`
and temp locations; network off unless `network: true`.

- **macOS** Seatbelt (`/usr/bin/sandbox-exec`, deprecated by Apple but shipped): profile
  `(allow default) (deny file-write*)`, re-allow `subpath` of root, `allowWrite` (symlink-resolved
  and as given), `/tmp`, `/private/tmp`, `/private/var/folders`, `os.tmpdir()`, `/dev/null`,
  `/dev/zero`, `/dev/dtracehelper`, ttys; `(deny network*)` except unix sockets (git credential
  helpers, ssh-agent, DNS through mDNSResponder).
- **Linux** bubblewrap (`bwrap`): `--ro-bind / /`, `--dev /dev`, `--proc /proc`, `--tmpfs /tmp`
  (before the binds, the root may live in `/tmp`), `--bind` for root and `allowWrite`,
  `--unshare-net` unless network, `--die-with-parent`, `--chdir <root>`.
- Other platforms or a missing tool: `kind: 'none'`, the command runs unwrapped.

Not covered: reads (secrets under `$HOME` stay readable), CPU/memory/process limits, local
unix-socket IPC on macOS. It is defence in depth, not a jail for hostile code: use a container or
VM driver for that.

## 7. Errors and warnings

No new error codes. Expected failures are `ERROR:` strings (§2). Programmer errors (a sandbox
factory that throws) fail the session open (`EH_*` open failure, spec 05 §2).

## 8. Tests (conformance of this module)

`src/shell/*.test.ts`: sandbox process groups, abort, kill-all, env and shell options; profile
and argv generation, real Seatbelt/bubblewrap runs where available; the tool through real
sessions with a scripted model (footer, timeout, cap, spawn failure, live output chunks, risk);
background start, `bash_output`, filter, `kill_shell`, `maxTasks`, monitor batching, notify modes,
reminder fallback and the `inject` wake path.
