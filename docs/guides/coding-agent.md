# A coding agent on eharness

`examples/coder` is a terminal coding agent (Ink UI, one process) built only on the public API. This
guide is the map: which library modules it uses, how permissions, the sandbox, resume and compaction
fit together, and how to extend it. For a line-by-line reading in build order see the
[single-process CLI walkthrough](walkthrough-cli.md); for every flag, command and setting see the
[coder README](../../examples/coder/README.md).

Run it: `bun examples/coder/src/main.tsx` (set `OPENROUTER_API_KEY` or `AI_GATEWAY_API_KEY`).
Windows is not supported; use WSL2.

## 1. Modules used

| Need | Module | Where it is wired |
|---|---|---|
| Agent, sessions, storage, compaction, cost | core (`defineHarnessAgent`, `session.send/respond/fork`) | `app/agent.ts`, `app/controller.ts` |
| Virtual file tree over the project | `eharness/filesystem` + `filesystem/node` (`nodeWorkspace`, checkpoints) | `workspace/`, `app/checkpoints.ts` |
| `bash`, background shells, OS sandbox | `eharness/shell` | `app/agent.ts`, `app/tasks.ts` |
| Rules, modes, plan mode, auto mode | `eharness/permissions` | `permissions/engine.ts` |
| Child agents | `eharness/subagent` | `agents/` |
| Questions, todos | `eharness/ask`, `eharness/todos` | `app/agent.ts` |
| Web | `eharness/web` | `app/web-search.ts` |
| MCP, skills | `eharness/mcp`, `filesystem({ skills })` | `app/agent.ts` |
| Step, cost and time ceilings | `eharness/limits` (`stepBudget`), core `budget` | `app/agent.ts`, `app/limits.ts` |
| Dates and time zones | `eharness/clock` (`datetime` tool) | `app/agent.ts` |

`app/agent.ts` is the one file that decides **which agent gets which plugin**. Tool order is the
prompt-cache prefix, so it is fixed and identical for every turn of an agent. The main agent has
`ask_user_question`, background shells and the step/time ceilings; subagents get the same tools
minus those, and never `request_directory_access` or `exit_plan_mode`.

## 2. Permissions

The library engine (`createPermissionEngine`) is configured in `permissions/engine.ts`: the app
adds tool kinds (`lsp` and `datetime` are `safe`, `request_directory_access` always asks), protected
paths (`.git`, `.coder/settings*.json`, `.env*`) and where "don't ask again" is stored. Everything
the model can do goes through `tool.approve`:

1. deny rules and protected paths first, in every mode;
2. the mode: `default` asks for writes and unknown commands, `acceptEdits` allows file edits, `plan`
   removes every non-read-only tool, `auto` lets a classifier decide, `dontAsk` denies what is not
   allowed, `bypassPermissions` skips asking (never deny rules);
3. allow rules (`Bash(bun test *)`, `Edit`, `mcp__server__tool`), then the prompt.

The prompt is a `HarnessRun` stop (`tool-pending`) that `agents/drive.ts` answers through the
`ApprovalBroker`; the UI shows a diff for edits and keeps the turn open until you answer. A
subagent's approvals travel the same way, labelled with its name. Project settings (`allow`,
`mcpServers`, `hooks`, `limits`, agents, skills) take effect only once the project is **trusted**
(`trusted.json`, per exact content), so a cloned repository cannot widen what the agent may do.

## 3. Sandbox

Permissions decide whether a call runs; the OS sandbox limits what a running `bash` command can
touch. `sandbox.enabled` wraps every shell command in Seatbelt (macOS) or bubblewrap (Linux):
writes only in the project and temp directories, network off unless `sandbox.network`. Reads are not
restricted. It is a second layer, off by default; `/doctor` recommends enabling it when the tool is
installed and never flips it for you. The file tools are not sandboxed: they use the virtual tree,
which only contains the project and directories you granted (`--add-dir`, `/add-dir`).

## 4. Limits

Each turn has a default ceiling: $5 and 30 minutes (`--max-cost`, `--max-time`, `limits.*`). Cost is
the core `budget.maxTurnUsd` (stop `cost-cap`), time is a 30-line plugin in `app/limits.ts` (stop
`plugin:turn-time-limit:time`), steps are `stepBudget` plus the progress guard. A capped turn ends at
a step boundary with a readable notice (what was reached, how to raise it); the conversation is
intact. `/cost` lists the caps.

## 5. Resume and compaction

- **Storage.** `MessageAdapter` and `StateAdapter` are JSON files under
  `~/.coder/projects/<hash of the root>/sessions/` (examples of adapters, not library code).
  `--continue` takes the newest session, `--resume [id]` / `/resume` another one, `/branch` forks.
- **Crash recovery.** A stable `recovery.instanceId` per process lets the library find a turn that
  died mid-flight: tool calls without results are answered with `Interrupted:` results (never
  re-executed) and `/retry` runs the reply again. Background shells die with the process and are not
  restored.
- **Compaction.** `compaction: { summarizeAt: 0.8, prune: {} }` summarises the history when the
  context passes 80 % of the window (the window comes from the models.dev catalog), older tool
  outputs are pruned, and a tool output over 30 000 characters is evicted to
  `/.eharness/tool-outputs/` where the model pages through it. `/compact [instructions]` does it on
  demand, `/context` shows what fills the window.
- **Rewind.** `filesystem({ checkpoints })` records files changed through the file tools;
  `/rewind` restores code and/or conversation to an earlier prompt. Shell changes are not recorded.

## 6. Git workflow

`/commit` and `/pr` are prompts, not new machinery: the model reads the staged diff or branch diff
with `bash`, drafts a Conventional Commit message or PR text, asks you with `ask_user_question`, and
only then runs `git commit` / `gh pr create` as normal permission-gated `bash` calls. Nothing is
staged or pushed implicitly. This is the pattern for any confirmed workflow: write the steps, the
stop conditions and the confirmation into a prompt (or a custom command in `.coder/commands/`).

## 7. Evals and the long-session soak

Two offline-testable tools check that the agent works, not only that its parts do.

**Eval suite** (`examples/coder/evals/`). 22 small tasks in TypeScript/JavaScript fixtures: fix a
failing test, add a function with tests, rename across files, fix a type error, edit config files,
refactor, add a CLI flag, handle an edge case. A task is a directory `tasks/<id>/` with `task.json`
(`prompt`, `check` shell command, `timeoutSec`, `maxCostUsd`, optional `setup`), `fixture/` (the
starting project), optional hidden `check/` files (copied in after the run) and `script.json` (a
recorded `scriptedModel` transcript). The runner copies the fixture to a temp directory, runs the
coder headless (`-p --output-format json --permission-mode bypassPermissions`, an isolated
`CODER_HOME`), then runs the check; a task passes when the check exits 0 and the run stayed in
budget. It reports pass rate, cost, tool calls, tokens and wall time per task as
`evals/results/<timestamp>/report.{json,md}` (gitignored).

```bash
cd examples/coder
bun run eval -- --scripted                       # offline: replay each task's transcript (CI-safe)
bun run eval -- --model anthropic/claude-sonnet-5.5   # real model; the provider key must be in the environment
bun run eval -- --scripted --task fix-failing-test,cli-flag
bun run eval -- --validate                       # every check must FAIL on its pristine fixture
```

Other flags: `--provider`, `--concurrency <n>`, `--sandbox` (turn the OS sandbox on), `--out <dir>`.
`--scripted` proves the harness and the tasks (all 22 pass, about 3 s with `--concurrency 4`); it
says nothing about a model. Only a `--model` run measures one, and the key is read by the coder
itself, never by the runner. Add a task by creating a directory with the files above and recording
its `script.json` against a fixture that fails `--validate`.

**Soak** (`examples/coder/scripts/soak-session.ts`, `bun run soak`). One session, 36 turns, a scripted
model that returns outputs of 11 000 to 45 000 characters so compaction, pruning and eviction
trigger again and again. The coder process is killed three times mid-turn (twice while a tool runs,
once while the model streams) and resumed with `--continue`; `/retry` and `/rewind` (conversation and
files) are used once each. It then asserts on the stored session: session invariants
(`assertStoredSessionInvariants`, quiescent), user prompts exactly the expected turns once and in
order, each completed turn's answer once, rewound turns and their files gone, every tool call
answered, killed replies stored as `interrupted` with a notice, at least three compaction summaries
and summarizer calls, outputs over 30 000 characters on disk, token usage recorded, and no model
call over the context window. `--turns <n>` and `--window <tokens>` change the shape. A shortened run
is `test/soak.test.ts`.

Scripted results (this repo, `bun scripts/soak-session.ts`): 36 turns, 209 model calls, 15 summarizer
calls and 13 compaction summaries, peak prompt 47.5k of a 60k window (0.79, just under
`summarizeAt` 0.8), about 6 s wall. A 30k window (single outputs near 10k tokens) held too: 33
summarizer calls, peak 0.88 of the window, all invariants true. The defaults (`summarizeAt` 0.8,
`prune: {}`, evict at 30 000 characters) showed no problem and stay. What the soak does not cover:
a real model's behaviour over two hours, and the "Interrupted:" result for a tool call that was
stored before the kill (a tool runs inside its step and the step is stored when it ends, so a kill
during a tool leaves an `interrupted` reply, not a dangling call; the library's chaos tests cover the
dangling case).

## 8. Extending it

| You want | Do |
|---|---|
| a new slash command | a Markdown file in `.coder/commands/` (prompt with `$ARGUMENTS`), or an entry in `ui/slash.ts` for a built-in |
| a new tool | a plugin with `definePlugin` ([Writing a plugin](writing-a-plugin.md)) added in `app/agent.ts`; give it a kind in `permissions/engine.ts` (`safe`, `read`, `write`, ...) and add it to `READ_ONLY_TOOLS` if plan mode may use it |
| a library tool you do not use yet | wire it like `clock` (one line in `plugins`), then its kind |
| a new subagent type | a Markdown file in `.coder/agents/` or `~/.coder/agents/` (`description`, `tools`, `model`, `permissionMode`) |
| an MCP server | `mcpServers` in a settings file (`type: 'http'` and a URL, or a command); project entries need trust |
| a skill | `.coder/skills/<name>/SKILL.md` |
| a different UI | everything below `ui/` talks to a `CoderController` (`src/contracts.ts`); `print.ts` is a second front end on it |
| a different storage | implement `MessageAdapter` / `StateAdapter` ([guide](writing-a-storage-adapter.md)) and pass it to `createStorage` |

Test it offline: every behaviour above has a test that uses `scriptedModel` from `eharness/testing`
and a temp directory (`examples/coder/test/`); see [Testing](testing.md). Rules that keep it a good
example: build on AI SDK and eharness primitives, never throw for expected tool failures, keep the
tool order stable, and put anything the model could abuse behind a permission or a trust check.
