# coder: a terminal coding agent on eharness

`coder` is a terminal coding agent: you chat with a model in an Ink UI, and it reads, searches, edits
and runs commands in your project. It is built only on the public eharness API (core and the
`eharness/filesystem`, `eharness/todos`, `eharness/mcp` and `eharness/testing` subpaths). It is an
example: it lives in a Bun workspace package (`eharness-coder`), is private and is never published.

Design and decisions: [`docs/plans/P30-coder-example.md`](../../docs/plans/P30-coder-example.md).

## Run it

```bash
bun install                                   # from the repo root
export AI_GATEWAY_API_KEY=...                 # for the default AI Gateway model
bun examples/coder/src/main.tsx               # interactive
bun --filter eharness-coder start             # same thing
```

The default model is `anthropic/claude-sonnet-4.6` (an AI Gateway id). Change it with `--model <id>`,
`"model"` in a settings file, `CODER_MODEL`, or `/model <id>` inside a session.

| Flag | Meaning |
|---|---|
| `[prompt]` | first prompt of the interactive session |
| `-p, --print <prompt>` | run one prompt headless, print the answer, exit |
| `--output-format text\|json\|stream-json` | print mode output (default `text`) |
| `--model <id>` | model id |
| `--permission-mode <mode>` | `default`, `acceptEdits`, `plan`, `dontAsk`, `bypassPermissions` |
| `--add-dir <path...>` | extra directories, mounted at `/@dirs/<basename>/` |
| `--allowed-tools <rule...>` / `--disallowed-tools <rule...>` | extra allow / deny rules for this run |
| `--agents <json>` | session-only subagent definitions |
| `-c, --continue` | continue the most recent session of this project |
| `-r, --resume [id]` | resume a session; without an id a picker opens |
| `--max-steps <n>` | step limit per turn (default 200) |
| `--cwd <path>` | project root (default: the current directory) |

Print mode examples:

```bash
bun examples/coder/src/main.tsx -p "List the TODO comments in src/"
bun examples/coder/src/main.tsx -p "Summarise this repo" --output-format json
bun examples/coder/src/main.tsx -p "Explain src/app.ts" --output-format stream-json > chunks.jsonl
```

In print mode `text` streams the answer to stdout and writes one-line tool notes to stderr. `json`
prints one summary object. `stream-json` prints one UI message chunk per line. Print mode never
asks: anything that would need approval is denied (unless a rule or mode allows it). The exit code
is 0 when the turn completed, 1 otherwise, 2 for bad flags or settings.

Single binary (from `examples/coder`):

```bash
bun run compile        # writes dist/coder
```

Offline runs: set `CODER_SCRIPTED_MODEL` to a JSON file holding an array of `scriptedModel` steps
(`eharness/testing`: `{ "text": "...", "toolCalls": [{ "toolName": "read_file", "input": {...} }] }`).
That scripted model replaces the real one for the main agent and every subagent. Set `CODER_HOME` to
move the user directory (default `~/.coder`), for example to a temp folder.

## Keys, slash commands, shell mode

| Key | Action |
|---|---|
| Enter | send |
| Shift+Enter, or `\` then Enter, Ctrl+J | newline |
| Esc | interrupt the running turn |
| Shift+Tab | cycle the mode: default, acceptEdits, plan |
| Ctrl+O | expand or collapse tool output |
| Ctrl+C twice | exit |
| Up / Down | prompt history |
| Ctrl+A / Ctrl+E / Ctrl+U | line start / line end / clear |

| Command | Does |
|---|---|
| `/help` | list commands and keys |
| `/clear` | start a new session |
| `/compact` | summarise the conversation to free context |
| `/model [id]` | show or switch the model |
| `/permissions` | show the mode and the allow / ask / deny rules |
| `/agents` | list the available subagents and where they come from |
| `/resume [number or id]` | list stored sessions, or resume one |
| `/cost` | context usage and cost |
| `/todos` | show the current todo list |
| `/init` | ask the agent to write an `AGENTS.md` for the project |
| `/exit` | quit |

Prompt features (added to the UI alongside this README; check `/help` for the final list):

- `!command` runs a shell command directly from the prompt, without the model.
- `@path` completes file paths from the project (and mounted directories).
- `--resume` without an id opens a session picker.

## Safety model

Read this before pointing the agent at anything you care about.

**The file tools use a virtual path tree.** The model never sees real paths.

| Virtual path | Real location |
|---|---|
| `/` | the project root (`--cwd`) |
| `/@dirs/<name>/` | an extra directory from `--add-dir`, settings, or an approved `request_directory_access` |
| `/.coder/tool-outputs/` | large tool outputs evicted from the context (in `~/.coder/projects/<hash>/tool-outputs`) |

- **Containment.** Every virtual path is joined to a real root, resolved with `realpath` and rejected
  if the result is outside that root. Symlinks that leave the root are refused by the file tools.
- **Ignore rules.** `.git/`, `node_modules/` and the root `.gitignore` hide paths from listings,
  `glob` and `grep`. They only hide; an explicit read of an ignored path still works.
- **Protected paths.** Writes to `.git`, `.coder/settings*.json` and `.coder/agents` always ask, in
  every mode, `bypassPermissions` included. Reads of `.env*` ask too (an allow rule overrides this).
- **New directories.** The model calls `request_directory_access` with a path and a reason. It always
  asks. On approval the directory is mounted under `/@dirs/`.

**The shell is not sandboxed.** The `bash` tool runs `/bin/bash -c` with your user's privileges. The
name of the local sandbox module is historical; it does not isolate anything. Protection comes only
from the permission engine:

- A command is auto-approved only if it is on a read-only allow list (for example `git status`,
  `ls`, `cat`, `grep`) **and** every path it reads lies inside the project or a mounted directory.
- Anything else asks: writes, installs, network tools, unknown commands, complex commands
  (substitutions, subshells), redirects to files.
- Commands with `$VAR`, `~user`, brace expansion or `xargs` stdin cannot be resolved, so they ask.

Known limits:

- Shell path checks are lexical. A symlink inside the project that points outside is not detected
  by the shell check (the file tools do detect it).
- Pattern arguments (a `grep` regex, for example) can be treated as paths. This errs toward asking.
- Approving a command runs it as written. Read the prompt.
- In `bypassPermissions` the shell containment and ask checks are skipped (deny rules still apply).

## Permissions

| Mode | Behaviour |
|---|---|
| `default` | reads and read-only commands inside the working dirs are allowed; edits and other commands ask |
| `acceptEdits` | file edits in writable dirs and simple `mkdir` / `touch` / `mv` / `cp` inside them are allowed |
| `plan` | read-only: edit tools are removed, only read-only commands run; `exit_plan_mode` asks you to approve the plan |
| `dontAsk` | anything that would ask is denied |
| `bypassPermissions` | everything is allowed except deny rules and protected paths |

**Rules** are strings in `permissions.allow`, `permissions.ask` and `permissions.deny`:

| Rule | Matches |
|---|---|
| `Bash(bun test *)` | commands starting with `bun test` (a trailing ` *` also matches the bare command; `:*` is the same) |
| `Bash(git status)` | that exact command |
| `Read(.env*)`, `Read(./secrets/**)` | read tools on matching paths (gitignore patterns) |
| `Edit(src/**)` | edit tools on matching paths |
| `Agent(explore)` | the `agent` tool with that `subagent_type` |
| `Edit`, `Bash`, `mcp__server__tool` | the whole tool |

Path specifiers: `//abs/path` is absolute, `~/x` is under the home directory, `/x` and `./x` are
relative to the project root, a bare `x` follows gitignore (no slash: matches at any depth).

Aliases: `Read` = `read_file`, `list_files`, `grep`, `glob`. `Edit` and `Write` = `edit_file`,
`write_file`, `delete_file`. `Bash` = `bash`. `Agent` = `agent`. Real tool names work too.

Bash allow rules must match every subcommand of a `&&`, `;`, `|` chain and never match a complex
command. Deny and ask rules match if any subcommand matches, and also apply to redirect targets
(`Edit` rules) and read paths (`Read` rules).

**Evaluation order:** deny rules, then (always-ask tools: `request_directory_access`,
`exit_plan_mode`), plan-mode gate, protected paths, ask rules, allow rules, built-in `.env` ask
rules, then the mode default.

**"Don't ask again."** An approval prompt can remember the suggested rule (for example
`Bash(bun test *)`) for this session, or for the project. "Project" writes it to
`.coder/settings.local.json`.

**Settings files**, merged in this order (later wins for scalars, rules and directories are
concatenated): `~/.coder/settings.json`, `<root>/.coder/settings.json`,
`<root>/.coder/settings.local.json`. Then CLI flags (`--model`, `--permission-mode`,
`--allowed-tools`, `--disallowed-tools`, `--add-dir`).

```json
{
  "model": "anthropic/claude-sonnet-4.6",
  "contextWindow": 200000,
  "permissions": {
    "defaultMode": "default",
    "allow": ["Bash(bun test *)", "Bash(bun run lint)", "Edit(src/**)"],
    "ask": ["Bash(git push *)"],
    "deny": ["Read(./secrets/**)", "Bash(rm -rf *)"],
    "additionalDirectories": ["../shared-lib"]
  },
  "mcpServers": {}
}
```

**Audit log.** Every approval decision is appended as a JSON line to
`~/.coder/projects/<sha256(root)[0:16]>/audit.jsonl`.

## Subagents

The main agent can start subagents with the `agent` tool. Each runs as a child session with a fresh
context and returns only its final report. Progress (steps, last tool, text) streams into the UI as
preliminary tool results and shows in a tree.

| Built-in | Tools | Use |
|---|---|---|
| `general-purpose` | all | multi-step tasks that explore and change code |
| `explore` | read tools and read-only `bash` | fast codebase search and analysis |
| `plan` | read tools and read-only `bash` | returns a step-by-step plan and the critical files |

Define your own as a Markdown file in `<root>/.coder/agents/*.md` or `~/.coder/agents/*.md`, or pass
`--agents '{"name": {...}}'` for one session. On a name collision the first wins: `--agents`,
project, user, built-in.

```markdown
---
name: reviewer
description: Reviews a diff for bugs. Use after larger changes.
tools: Read, Grep, Glob, Bash
disallowedTools: Edit
model: inherit
permissionMode: plan
maxTurns: 20
omitProjectMemory: false
---
You review code. Report concrete bugs with `path:line`. Do not edit anything.
```

Fields: `name` (lowercase, digits, hyphens) and `description` are required, the body is the prompt.
Optional: `tools`, `disallowedTools` (comma list or array; aliases `Read`, `Grep`, `Glob`, `Edit`,
`Write`, `Bash`, `Agent`, `Task`, `TodoWrite` or real names), `model` (`inherit` or a model id),
`permissionMode`, `maxTurns` (default 50), `omitProjectMemory`. In `--agents` JSON the same fields
are used with `prompt` instead of a body. Invalid files are skipped with a warning.

Notes:

- `permissionMode` can only make an agent stricter: `plan` removes its non-read-only tools. Other
  values are ignored, because the engine has one global mode.
- Subagents never get `exit_plan_mode` or `request_directory_access`.
- Parallel runs: several `agent` calls in one step run concurrently (at most 8 at once per
  process).
- Depth limit: 2 levels of nesting below the main agent.
- Approvals: a subagent's tool calls go through the same permission engine. A question from a child
  is shown to you in the same prompt UI, labelled with the agent name, and the child waits in
  process. This does not survive a restart (library request R1).

## Project memory, skills, MCP, sessions

- **Project memory.** `AGENTS.md` at the project root is added to the instructions (fallback:
  `CLAUDE.md`). Other `AGENTS.md` files in the tree are listed as virtual paths so the model can
  read them when working there. `/init` asks the agent to write one.
- **Skills.** If `<root>/.coder/skills/` exists it is loaded as a skill folder (`SKILL.md` per
  skill) through the filesystem plugin.
- **MCP.** `mcpServers` in a settings file maps a server name to an `mcpServer()` transport config.
  Servers are attached to the main agent only; a server that fails to configure is skipped with a
  warning. Requires the optional peer `@ai-sdk/mcp`.
- **Sessions.** JSON files in `~/.coder/projects/<sha256(root)[0:16]>/sessions/`, written with the
  example JSON-file adapters. The project data directory also holds `tool-outputs/` and
  `audit.jsonl`.

## How it is built

| Folder (`src/`) | Role and eharness features it exercises |
|---|---|
| `main.tsx`, `print.ts` | CLI (commander) and headless output; `HarnessRun` streams, `TurnResult.usage` |
| `app/` | config, controller, agents, prompt, storage. `defineHarnessAgent`, `session.send` / `respond`, `compaction` (`summarizeAt`, `prune`), `toolOutput` eviction, turn reminders (mode, extra dirs), `dataParts`, cost from the model catalog, JSON-file `MessageAdapter` / `StateAdapter` |
| `workspace/` | virtual tree over disk: a `FileSystem` for the `filesystem()` plugin (tool-output eviction, skills), `glob` and `request_directory_access` tools |
| `shell/` | `bash` tool over the AI SDK sandbox shape; streams stdout and stderr as a transient `data-bashOutput` part |
| `permissions/` | rule engine, broker, audit; a plugin using `tool.approve`, `approval.decided`, `activeTools` and `exit_plan_mode`; approvals via `tool-pending` and `respond()` |
| `agents/` | `agent` tool: child sessions, preliminary tool results for live progress, `addUsage` to roll child cost into the parent |
| `ui/` | Ink components: transcript, tool cards, diffs, todo panel (`data-todos.list`), subagent tree, permission prompt, status bar |

Layering: `workspace/`, `shell/`, `permissions/`, `agents/` and `app/` never import Ink or React.
`ui/` and `print.ts` use a `CoderController` (`src/contracts.ts`).

## Library gaps found

The example works around these; each is a candidate roadmap item. Details in the
[plan](../../docs/plans/P30-coder-example.md#requests-to-the-library).

| # | Gap | Workaround here |
|---|---|---|
| R1 | nested approvals across processes | the `agent` tool awaits child approvals in process |
| R2 | several edits in one `edit_file` call | several calls |
| R3 | `glob` tool in `eharness/filesystem` | app tool |
| R4 | Node-only disk adapter with containment rules | `workspace/disk-fs.ts` |
| R5 | pass a sandbox to tools; shell plugin | sandbox in a closure |
| R6 | `eharness/subagent` helper | `agents/agent-tool.ts` |
| R7 | rule-based grants in core approvals | rules in the app plugin |
| R8 | `addUsage` accepting `TurnResult.usage` | conversion helper |
| R9 | binary files and images in `FileSystem` | text only |
