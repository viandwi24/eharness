# Building a single-process CLI agent: a walkthrough of `examples/coder`

[`examples/coder`](../../examples/coder) is the reference for the **single-process** profile
([ADR-0034](../decisions/0034-deployment-profiles.md), profile b): one interactive process, one
user, approvals answered in the same process, an [Ink](https://github.com/vadimdemedes/ink) UI. It
is a terminal coding agent built only on the public API.

For every piece you get **what it does**, **where it is wired**, **why it is needed** and **what
breaks without it**. A real harness always needs you to understand and change each piece, so this is
a map into the code, not a preset. Building a server instead? Read the
[server walkthrough](walkthrough-server.md); the [production checklist](production-checklist.md) is
the short list.

## The shape

```
main.tsx            commander flags (--continue, --resume, -p), claims the instance, starts Ink or print mode
app/controller.ts   the composition root: workspace, sandbox, permissions, storage, agents, one session
app/agent.ts        builds the main agent and the subagent agents: WHICH plugin, with WHAT policy
agents/drive.ts     the turn driver: answers every tool-pending stop through the broker, then respond()
permissions/        engine config (tool kinds, protected paths), the in-process approval broker
ui/                 Ink components; ui/driver.ts turns run streams into view state
```

[`app/agent.ts`](../../examples/coder/src/app/agent.ts) is the file to read first. Its header says it
exactly: *every capability is a library plugin; this file decides which agent gets which plugin and
with what policy*.

## 1. The agent and its plugins

```ts
// app/agent.ts (build())
const plugins = [shell({ sandbox, background }), subagent({...}), filesystem({ fs: workspace.fs, ... }),
  projectInstructions(...), todos(), webFetch({...}), webSearch({ search }),
  ...(isMain ? [ask()] : []), permissions({ engine: permissions, ... }), modelSwitchPlugin(...)]
const agent = defineHarnessAgent({ id, model, instructions, tools, mcp, plugins, storage, recovery,
  loop, compaction: { summarizeAt: 0.8, prune: {} }, toolOutput: { maxChars: 30_000, strategy: 'evict' },
  observe, hooks: { timeoutMs: 30_000 }, settings: { timeout: { firstChunkMs: 180_000, chunkMs: 120_000 } },
  toolSources: { timeoutMs: 30_000 }, warnings: { dedupeWindowMs: 60_000 } })
```

Why:

- **Plugins, not a monolith.** The main agent and each subagent type are built by the same `build()`
  with different options (`isMain`, a definition). Only the main agent gets `ask_user_question`,
  background shells and `exit_plan_mode`: a child has no way to show a dialog.
- **A fixed plugin and tool order, identical for every session and turn** (header of `agent.ts`,
  spec 02 §6). *Without it:* every turn changes the tool prefix and the prompt cache is rebuilt, which
  is most of the cost of a coding session.
- **Static instructions first, volatile text in a turn reminder.** The mode, the date and the extra
  directories are `turnReminder` with `refresh: 'turn'`; session-scoped text (user memory, output
  style) is a function evaluated once per session. Changing the output style therefore *reopens the
  session handle* (`refreshSession` in `controller.ts`) so the cached block is rebuilt on purpose.
- **Bounded waits and observability.** A CLI user is watching, so the bounds are spelled out
  instead of left to the defaults: an awaited hook (`hooks.timeoutMs`), a silent model stream
  (`settings.timeout`) and a hung MCP or tool source (`toolSources.timeoutMs`) fail the step, not the
  session. `observe` is a small adapter ([`app/observe.ts`](../../examples/coder/src/app/observe.ts))
  that logs slow or failed spans and every counter to `~/.coder/observe.log`
  ([observability](observability.md)). `TurnResult.error.code` is always set; `app/turn-error.ts`
  turns `EH_PROVIDER_AUTH` into "set your API key" and `EH_LOCK_UNAVAILABLE` into "storage
  unavailable".
- **Models** come from `eharness/providers` ([`app/provider.ts`](../../examples/coder/src/app/provider.ts)),
  with the model and thinking level in a shared `ModelState` that a `turn.prepare` plugin
  (`modelSwitchPlugin`) reads each turn, so `/model` switches every agent without rebuilding it.

## 2. Storage and resume

```ts
// app/sessions.ts (jsonFileMessages / jsonFileState come from examples/json-file-storage.ts)
export function createStorage(config) {
  return { messages: jsonFileMessages(dir), state: jsonFileState(dir) }
}
```

The CLI uses the example JSON-file adapters ([`examples/json-file-storage.ts`](../../examples/json-file-storage.ts)):
one `.messages.json` and one `.state.json` per session, atomic writes (temp file and rename),
serialized per file inside the process. That is enough for **one process**; the header of that file
says several processes need real locking. There is no lock, stream log or inbox here because nothing
else shares the files.

- **`--continue` / `--resume`.** The session id is the one thing you must keep. `latestSessionId`
  picks the newest stored session; ids are UUIDv7 (`newSessionId`), so "newest" sorts correctly
  without reading the files ([`sessions.ts`](../../examples/coder/src/app/sessions.ts)).
  *Without stable ids:* a resume cannot find its history, and a subagent's child session (id
  contains `:agent:`) would be listed as a top-level session, which `listSessions` skips.
- **Atomic file writes.** *Without temp file and rename,* a crash mid-write leaves a half-written JSON
  file; `listSessions` has to tolerate unreadable files for the same reason.

## 3. Workspace, filesystem and the shell

- **Virtual tree over real directories.** [`workspace/index.ts`](../../examples/coder/src/workspace/index.ts)
  uses `nodeWorkspace()` from `eharness/filesystem/node`: `/` is the project root, extra directories
  are `/@dirs/<name>/`, evicted tool outputs live in `/.eharness/tool-outputs/`. The model sees only
  virtual paths. *Without containment:* `../../etc` and symlink escapes are your problem, in every
  file tool ([filesystem](filesystem.md)).
- **Staleness.** The file tools refuse an edit when the file changed on disk since the model read it,
  and return that as an error *string*, so the model reads again instead of overwriting your
  concurrent edit (CLAUDE.md rule 6).
- **Shell.** `shell({ sandbox })` with `localSandbox({ root, os, env })`
  ([`controller.ts`](../../examples/coder/src/app/controller.ts)): a working directory, output
  caps, background tasks with `bash_output` / `kill_shell`, and optional OS isolation. Safety is
  configuration, not a prompt ([shell](shell.md)). *Without a sandbox and caps:* one `cat` of a log
  fills the context and `rm` runs with your rights. `killAllSandboxProcesses` runs at exit so an
  aborted shell does not outlive the CLI. The shell does not inherit `process.env`: `env: devToolEnv(process.env)` hands the sandbox only
  dev-tool variables (`GIT_*`, `SSH_AUTH_SOCK`, proxies, `CI`, ...) on top of its safe allow-list, so
  provider API keys never reach a command the model runs. `web_fetch` gets
  `resolveHost: nodeResolveHost` (`eharness/web/node`), so a public name that resolves to a private
  address is refused as well, and the permission engine gets `realpath: nodeRealpath` and
  `containsProtected: nodeContainsProtected` for the same reason on disk (symlinks, `.env` below a
  recursive read).
- **Rewind.** `filesystem({ checkpoints })` with `nodeCheckpointStore` records file versions per
  prompt; `/rewind` restores files and, with `session.fork()`, the conversation
  ([`app/checkpoints.ts`](../../examples/coder/src/app/checkpoints.ts)).

## 4. Interactive permissions

This is the piece that differs most from the server. Nothing is persisted across processes, so the
"pending approval" is answered by the same process that raised it.

```ts
// agents/drive.ts  driveTurn
let result = await run.result
while (result.stop === 'tool-pending' && result.pending !== undefined && !signal?.aborted) {
  for (const entry of pending.approvals) { ... answer = await broker.ask(request, signal) ... }
  run = session.respond({ approvals, toolOutputs }, { abortSignal: signal, ... })
  result = await run.result
}
```

Parts:

1. **The engine** ([`permissions/engine.ts`](../../examples/coder/src/permissions/engine.ts)):
   `createPermissionEngine` from `eharness/permissions` plus the app's policy: tool kinds of its own
   tools (`lsp` is safe; `request_directory_access` is `alwaysAsk` and asks in every mode), protected
   paths (`.git`, `.coder/settings*.json`, `.coder/agents` always ask before a write), and `persist`,
   which writes a "don't ask again" rule to `.coder/settings.local.json`.
2. **The plugin** (`permissions` in `agent.ts`) turns rules and modes into per-call
   approvals and writes an audit line (`onDecision: auditLog(...)`).
3. **The broker** ([`permissions/broker.ts`](../../examples/coder/src/permissions/broker.ts)): a FIFO
   queue the UI renders and answers. `ask` never rejects; an abort resolves it as `Interrupted.`
4. **The driver** loops `respond()` until the turn ends, applies "remember" rules and, with
   `stopOnBareDeny`, passes `endTurn: 'if-denied'` so a bare "No" ends the turn without a model call.
5. **Subagents use `approvals: 'inline'`** with `answer: subagentAnswer(...)`
   ([`agents/subagents.ts`](../../examples/coder/src/agents/subagents.ts)): the child's approval is
   asked on the same broker, labelled with the agent name. In-process is fine here because a crash
   ends the whole CLI (the server uses `park`, [server walkthrough](walkthrough-server.md#7-background-children-and-reconcile)).
6. **Print mode** (`-p`) uses a *denying* broker: anything that would ask is denied, so a script never
   hangs on a prompt (`createDenyingBroker` in [`main.tsx`](../../examples/coder/src/main.tsx)).

What the core guarantees here, and why you must keep using `respond()`:

- The pending set is consumed atomically before any tool runs
  ([ADR-0012](../decisions/0012-approvals-server-owned-pending.md)). *Without it:* answering twice, or
  a Ctrl+C racing an answer, runs a command twice.
- A continuation streams into the same message. The UI reducer therefore updates one message
  (`readUIMessageStream` with the previous message as `base`, in `ui/driver.ts`).
- A new message while approvals are pending denies them by default (`onNewInput: 'deny'`), so a
  steer never silently executes an old request. The controller's `steer()` defers texts that cannot
  be delivered and sends them after the turn.

Guide: [permissions](permissions.md), [approvals](approvals-and-interaction.md).

## 5. Ask

`ask()` is main-agent-only. In a CLI it is a client tool: the turn stops `tool-pending` with the
questions in `pending.clientTools`. `driveTurn` reads them with `pendingQuestions`, shows
[`QuestionDialog.tsx`](../../examples/coder/src/ui/QuestionDialog.tsx) through `broker.question`, and
returns `answerOutput(...)` in `respond({ toolOutputs })`. Any other client tool is answered with an
error string (`Not supported in this client.`): *a client tool nobody answers leaves the turn
`tool-pending` forever.* The `askUserQuestionTimeout` setting dismisses an unanswered dialog with a
note ([`app/ask-timeout.ts`](../../examples/coder/src/app/ask-timeout.ts)). Guide: [ask](ask.md).

## 6. Todos

`todos()` (`agent.ts`) gives the model `todo_write`; the list is a data part in the assistant
message, so it is stored with the conversation and survives resume. The CLI renders it in
[`ui/TodoPanel.tsx`](../../examples/coder/src/ui/TodoPanel.tsx) from the typed `Todo` shape. Without
it, a 30-step turn gives the user nothing to read between "thinking" spinners. Guide: [todos](todos.md).

## 7. Memory and project instructions

The coder does **not** use `eharness/memory`. It uses two simpler mechanisms, which is a valid
choice for a single-user CLI:

- **Project instructions** (`AGENTS.md` / `CLAUDE.md`): `projectInstructions(...)` right after
  `filesystem()` (it reads the `fs` service), a *static* instruction block. `/init` asks the agent
  to write the file. Subagents with `omitProjectMemory` skip it.
- **User memory** (`~/.coder/AGENTS.md`): a *session* instruction function, loaded once per session.

*Why not volatile:* memory text in `instructions` that changes per turn would break the prompt-cache
prefix; the library puts project memory in the static block and user memory in the session block on
purpose. If your harness needs a per-user memory store agents write to, use the
[memory plugin](memory.md) (the team example does).

## 8. Subagents

`subagent({ agents: () => subagentCatalog(depth), approvals: 'inline', answer, maxDepth, background, selfAgent })`
(`agent.ts`). Definitions come from files ([`agents/load.ts`](../../examples/coder/src/agents/load.ts),
built-ins in [`agents/builtin.ts`](../../examples/coder/src/agents/builtin.ts)); each type's agent is
built on first use through a getter, so unused types cost nothing. Three details matter:

- **`selfAgent`** lets the library rebuild agent names and finished agents when a stored session is
  reopened. *Without it:* a reopened session cannot rebuild the names and finished state of its earlier
  children (the library calls it to do exactly that).
- **Background agents only on the main agent.** A child's own background reports would die with its
  session.
- **Limits:** `maxDepth` (`config.maxAgentDepth`) and `maxConcurrent` bound a runaway tree.

Subagent `permissionMode` is deliberately weak: the engine has one global mode, so a definition can
only make its agent stricter (`plan` removes every non-read-only tool, see the comment above
`createAgents`). Guide: [subagents](subagents.md).

## 9. Skills

```ts
...(hasSkills ? { skills: { root: '/.coder/skills' } } : {}),   // agent.ts
```

`filesystem({ skills })` loads `SKILL.md` folders from the virtual path. Project skills are **repo
content**, so they load only when the project is trusted (`config.trusted`,
[`agent.ts`](../../examples/coder/src/app/agent.ts)). *Without a trust gate:* cloning a repository
and starting the CLI lets that repository add instructions to your agent. Skill file paths are
relative to the skill, never real paths ([skills](skills.md)).

## 10. MCP

`mcpServerSource({ name, transport, defer })` per configured server, main agent only (`agent.ts`). A
bad server entry is skipped with a `W_TOOL_SOURCE_FAILED`-style warning instead of failing startup.
`defer` (default `config.deferTools`) hides MCP tools behind `tool_search`, and the core lists the
names in the turn reminder. *Without deferral:* ten MCP servers put hundreds of tool schemas into
every request. *Without the skip:* one dead server stops the CLI from starting.
Guide: [tools and MCP](tools-and-mcp.md).

## 11. Compaction

```ts
compaction: { summarizeAt: 0.8, prune: {} },
toolOutput: { maxChars: 30_000, strategy: 'evict' },
```

The window comes from the models.dev catalog (`contextWindow` as a function of the model, with the
config value as fallback, `agent.ts`); a `contextWindowExplicit` setting wins. `/compact [text]`
calls `session.compact({ keepLast: 0, instructions })` ([`controller.ts`](../../examples/coder/src/app/controller.ts)),
and `/context` shows the breakdown, subtracting the estimated memory text from the instruction
block. *Without a window:* compaction cannot trigger and the provider eventually answers "too long".
Guide: [compaction](compaction.md).

## 12. Crash recovery and `/retry`

A CLI crashes too (Ctrl+C is graceful; a killed terminal is not).

```ts
// app/instance.ts: one stable id per project, a pid file keeps two live coders apart
const STABLE_ID = 'coder'
// agent.ts
recovery: { instanceId }
// main.tsx
if (await controller.recoverInterrupted()) { ... 'the previous reply was interrupted; continuing' }
```

- **Stable `recovery.instanceId`.** The new process owns the turn the old one left `activeTurn` in
  the session file, so `session.recover()` repairs it at once. *Without it:* the new process sees a
  foreign live turn and answers `EH_SESSION_BUSY` for about two minutes after a crash
  ([ADR-0056](../decisions/0056-restart-recovery-and-background-reconcile.md)).
- **The pid file** ([`app/instance.ts`](../../examples/coder/src/app/instance.ts)): a second coder on
  the same project gets a *random* id. *Without it,* two CLIs would share one id and treat each
  other's live turn as their own to recover.
- **`recoverInterrupted()`** (`controller.ts`) calls `recover()` and also checks whether the last
  message already has `stop: 'interrupted'` (recovered earlier). Dangling tool calls were answered
  with `Interrupted:` results ([ADR-0014](../decisions/0014-interrupted-tool-calls-answered.md)),
  and interrupted tools are never re-run automatically: the user decides.
- **`/retry`** is `session.regenerate()` through the same driver (`controller.ts`).

## 13. Rendering with Ink

The UI is policy, not library, but a few rules come from the message model:

- **Read run streams with `readUIMessageStream`**, seeded with the stored message as `base`
  ([`ui/driver.ts`](../../examples/coder/src/ui/driver.ts)). Updates are batched at 50 ms so
  Ink is not re-rendered per token.
- **Transient parts never appear in messages.** Live shell output is a transient `data-shell.output`
  part, so the driver reads it from the raw chunk stream with a tap.
- **Render kind messages and data parts yourself** (`eh.compaction`, `eh.notice`, `data-todos.list`,
  `data-eh.input`): [rendering data parts](rendering-data-parts.md).
- **Library warnings go to `~/.coder/warnings.log`, never the terminal** (`onWarning` in
  `controller.ts`). The default handler is `console.warn`, which prints through Ink and corrupts the
  screen.

## 14. Verify it

Offline tests use `scriptedModel` through `CODER_SCRIPTED_MODEL` and `ink-testing-library`
(`examples/coder/test`; its `bunfig.toml` preload turns `debug.invariants` on for every agent). A UI test must wait for input handlers; a fixed sleep flakes on CI. See [testing](testing.md).

## What to change when you copy it

| In the example | In your harness |
|---|---|
| JSON-file storage | keep it for one process; a database adapter if two processes can share the data |
| In-process broker | a channel to wherever the human is (the server pattern: `park` + a pending list) |
| `approvals: 'inline'` | `'park'` as soon as a child may outlive the process |
| Project trust gate | keep any gate that stops repo content from changing the agent |
| Pid-file instance id | host or pod name when several processes share storage |
