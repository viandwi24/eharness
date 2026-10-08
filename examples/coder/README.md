# coder: a terminal coding agent on eharness

`coder` is a terminal coding agent: you chat with a model in an Ink UI, and it reads, searches, edits
and runs commands in your project. It is built only on the public eharness API (core and the
`eharness/filesystem`, `eharness/todos`, `eharness/mcp` and `eharness/testing` subpaths). It is an
example: it lives in a Bun workspace package (`eharness-coder`), is private and is never published.

Design and decisions: [`docs/plans/P30-coder-example.md`](../../docs/plans/P30-coder-example.md).

## Run it

```bash
bun install                                   # from the repo root
export OPENROUTER_API_KEY=...                 # OpenRouter (or AI_GATEWAY_API_KEY, see Providers)
bun examples/coder/src/main.tsx               # interactive
bun --filter eharness-coder start             # same thing
```

## Providers, models, thinking

| Provider | Key | Default model |
|---|---|---|
| `openrouter` | `OPENROUTER_API_KEY` (optional `OPENROUTER_BASE_URL`) | `anthropic/claude-sonnet-5.5` |
| `gateway` (Vercel AI Gateway) | `AI_GATEWAY_API_KEY` | `anthropic/claude-sonnet-4.6` |

The provider is `--provider`, else `"provider"` in a settings file, else OpenRouter when
`OPENROUTER_API_KEY` is set, else the gateway. A missing key for the chosen provider is a startup
error with exit code 2 (scripted offline runs with `CODER_SCRIPTED_MODEL` need no key). Keys are
read from the environment only and are never logged.

Model: `--model <id>`, `"model"` in settings, `CODER_MODEL`, then the model last chosen in this
project (see Preferences), then the provider default. `/model <id>` switches inside a session.

- **Model picker** (`/model`, Alt+P): a filterable list; typing an id that is not listed uses it as is.
  The OpenRouter list comes from the OpenRouter model catalog, cached in
  `~/.coder/openrouter-models.json` (24 h, refreshed in the background, 3 s fetch limit; with
  `CODER_OFFLINE=1` only the cache is used).
- **Thinking** (`--thinking <level>`, `/thinking [level]`, Alt+T opens the picker). Levels:
  `provider-default` (send nothing), `none`, `minimal`, `low`, `medium`, `high`, `xhigh`. The app
  sets the AI SDK `reasoning` option and, for OpenRouter, also `providerOptions.openrouter.reasoning`,
  because the OpenRouter provider ignores the generic option.
- **Preferences.** The last model, provider and thinking level are saved per project in
  `~/.coder/projects/<hash>/preferences.json` and used at the next start (a flag, a settings file or
  `CODER_MODEL` wins for the model).
- A switch applies to the next step of every agent, subagents included (a `turn.prepare` plugin
  reads shared state), without rebuilding agents.

Context window and prices come from the [models.dev](https://models.dev) catalog. It is fetched once
at startup (at most 3 s of waiting) and cached in `~/.coder/models.json`. A cache older than 24 h is
used as is and refreshed in the background for the next start. Set `CODER_OFFLINE=1` to never fetch.
Without a catalog entry the context window falls back to `contextWindow` (default 200000) and no
cost is shown. `contextWindow` in a settings file always wins over the catalog.

| Flag | Meaning |
|---|---|
| `[prompt]` | first prompt of the interactive session |
| `-p, --print <prompt>` | run one prompt headless, print the answer, exit |
| `--output-format text\|json\|stream-json` | print mode output (default `text`) |
| `--model <id>` | model id for the provider |
| `--provider <name>` | `openrouter` or `gateway` |
| `--thinking <level>` | reasoning effort (see Providers, models, thinking) |
| `--permission-mode <mode>` | `default`, `acceptEdits`, `plan`, `dontAsk`, `bypassPermissions` |
| `--add-dir <path...>` | extra directories, mounted at `/@dirs/<basename>/` |
| `--allowed-tools <rule...>` / `--disallowed-tools <rule...>` | extra allow / deny rules for this run |
| `--agents <json>` | session-only subagent definitions |
| `-c, --continue` | continue the most recent session of this project |
| `-r, --resume [id]` | resume a session; without an id a picker opens |
| `--max-steps <n>` | step limit per turn (default 200) |
| `--cwd <path>` | project root (default: the current directory) |
| `--trust-project` | trust this project's `.coder/` settings, agents and skills (see Project trust) |

Print mode examples:

```bash
bun examples/coder/src/main.tsx -p "List the TODO comments in src/"
bun examples/coder/src/main.tsx -p "Summarise this repo" --output-format json
bun examples/coder/src/main.tsx -p "Explain src/app.ts" --output-format stream-json > chunks.jsonl
```

In print mode `text` streams the answer to stdout and writes one-line tool notes to stderr. `json`
prints one summary object (`stop`, `text`, `usage`, `costUsd`, `sessionId`). `stream-json` prints one
UI message chunk per line. Print mode never asks: anything that would need approval is denied
(unless a rule or mode allows it). The model sees the denial reason.

| Exit code | Meaning |
|---|---|
| 0 | the turn completed (`stop: complete`). A denied write does not change this by itself: the model decides what to do with the denial |
| 1 | any other stop (error, step limit, interrupted, pending approval) |
| 2 | usage or config error: unknown flag, bad value, invalid settings file or `--agents`, unreadable `CODER_SCRIPTED_MODEL` |

Signals: SIGINT and SIGTERM abort the running turn, kill the process group of every running shell
command (SIGTERM, then SIGKILL) and exit (130 and 143). A last-resort `exit` handler also kills
leftover groups.

Single binary (from `examples/coder`):

```bash
bun run compile        # writes dist/coder
```

The compiled binary has not been smoke-tested outside the repository yet.

Offline runs: set `CODER_SCRIPTED_MODEL` to a JSON file holding an array of `scriptedModel` steps
(`eharness/testing`: `{ "text": "...", "toolCalls": [{ "toolName": "read_file", "input": {...} }] }`).
That scripted model replaces the real one for the main agent and every subagent. Set `CODER_HOME` to
move the user directory (default `~/.coder`), for example to a temp folder.

## The interface

A rounded welcome box (version, `cwd` with `~` and a shortened middle, model, provider, thinking) opens
the session. The transcript is plain scrollback: user prompts as `> text`, assistant text with
Markdown, one compact card per tool call (`Ctrl+O` shows the full transcript). A footer under the
prompt shows the permission mode, the model and thinking level, the context left and the cost. `?`
on an empty prompt opens the shortcuts panel.

| Key | Action |
|---|---|
| Enter | send (also when the terminal delivers text and Enter as one chunk: `hi\r` sends `hi`; text after the Enter becomes the next draft) |
| Shift+Enter, or `\` then Enter, Ctrl+J | newline (a bracketed paste keeps its newlines as text) |
| Esc | interrupt the running turn, close a page or picker |
| Shift+Tab | cycle the mode: default, acceptEdits, plan |
| Alt+P | model picker |
| Alt+T | thinking picker |
| Ctrl+O | transcript viewer (full tool output) |
| Ctrl+L | redraw the screen |
| Ctrl+C twice | exit (the first press clears the input) |
| `?` | shortcuts panel (empty prompt) |
| Up / Down | prompt history |
| Ctrl+A / Ctrl+E / Ctrl+U | line start / line end / clear |

| Command | Does |
|---|---|
| `/help` | commands and keys (page) |
| `/clear` | start a new session |
| `/compact` | summarise the conversation to free context |
| `/context` | what fills the context window (page) |
| `/status` | version, model, mounts, trust, settings (page) |
| `/cost` | token usage and estimated cost (page) |
| `/model [id]` | model picker, or switch to `id` |
| `/thinking [level]` | thinking picker, or set the level |
| `/permissions` | mode and rules (page); `allow\|ask\|deny <rule> [--project]`, `remove <kind> <rule>`, `mode <mode>` edit them |
| `/agents [n]` | subagents and this session's runs (page); `/agents <n>` (or `/transcript <n>`) opens a run read-only |
| `/resume [id]` | pick a stored session, or resume one by id |
| `/todos` | show the current todo list |
| `/init` | ask the agent to write an `AGENTS.md` for the project |
| `/exit` | quit |

**Fullscreen pages.** `/context`, `/status`, `/cost`, `/help`, `/agents`, `/permissions` and the
transcript viewer open on the terminal's alternate screen, so your scrollback is untouched, and
`Esc` or `q` returns to it. Scroll with the arrow keys (`g` / `G` for top / bottom), `Tab` jumps to the
next section. `/context` draws the window as a grid of 1% cells (system, memory, skills, tools, MCP,
messages, free space, autocompact buffer) and lists tools, memory files, messages and thresholds below.

Prompt features:

- `!command` runs a shell command directly from the prompt, without the model. It is your own
  command: no permission check applies.
- `@path` completes file paths from the project (and mounted directories); Tab completes.
- `--resume` without an id, and `/resume` without an id, open a session picker.
- `/agents <n>` and `/transcript <n>` open run `n` of this session's subagent runs read-only
  (numbers are listed by `/agents`).
- `/permissions mode bypassPermissions` needs `--yes` to confirm.

## Safety model

Read this before pointing the agent at anything you care about.

**The file tools use a virtual path tree.** The model never sees real paths.

| Virtual path | Real location |
|---|---|
| `/` | the project root (`--cwd`) |
| `/@dirs/<name>/` | an extra directory from `--add-dir`, settings, or an approved `request_directory_access` |
| `/.coder/tool-outputs/` | large tool outputs evicted from the context (in `~/.coder/projects/<hash>/tool-outputs`) |

- **Containment.** Every virtual path is joined to a real root, resolved with `realpath` and rejected
  if the result is outside that root. Symlinks that leave the root are refused by the file tools
  and are not listed by `glob`. A symlink swapped in between a read and a write is caught.
- **Ignore rules.** `.git/`, `node_modules/` and the root `.gitignore` hide paths from listings,
  `glob` and `grep`. They only hide; an explicit read of an ignored path still works.
- **Protected paths.** Writes to `.git`, `.coder/settings*.json` and `.coder/agents` always ask, in
  every mode, `bypassPermissions` included. This holds for the file tools and for shell commands
  (see below). Reads of `.env*` ask too (an allow rule for the path overrides this).
- **New directories.** The model calls `request_directory_access` with a path and a reason. It always
  asks. On approval the directory is mounted under `/@dirs/`. The tool refuses `/`, your home
  directory and any directory that contains the project, and it reports the real path when a
  symlink was followed.
- **Read rules filter listings.** `grep`, `list_files` and `glob` are approved on a directory, but
  their output drops every path that a `Read` deny or ask rule (the built-in `.env*` included)
  matches, and ends with `(N results hidden by permission rules)`.
- **`glob` containment.** Patterns with `..`, an absolute path, `~` or backslashes are rejected;
  results are re-checked with `realpath` against the mount.

**The shell is not sandboxed.** The `bash` tool runs `/bin/bash -c` with your user's privileges. The
name of the local sandbox module is historical; it does not isolate anything. Protection comes only
from the permission engine:

- A command is auto-approved only if every part is a read-only command with a **per-command
  argument allow-list** (flags and positional arguments are checked, not just the program name) and
  every path it reads lies inside the project or a mounted directory. Examples of what the grammar
  refuses: `sort -o FILE`, `find -exec`/`-delete`/`-fprint`, `rg --pre`, `grep -f`, `tail -f`,
  `uniq in out` (only one file is accepted), `git diff --output`, `git -c`. `tree` is not on the
  list. `node` and `bun` are read-only only for `--version`.
- Anything else asks: writes, installs, network tools, unknown commands, complex commands
  (substitutions, subshells, heredocs), redirects to files.
- Any `$` expansion, `~user`, brace expansion or `xargs` stdin cannot be resolved, so the command
  asks.
- Recursive searches (`rg`, `grep -r`) and globs (`cat .e*`) ask when a `Read` ask or deny rule
  (the built-in `.env*` included) could match a file under the target. `rg <path>` is always
  treated as recursive.
- A non-read-only command whose text mentions `.git` or `.coder` asks in every mode, including
  `bypassPermissions`. The detection is textual (see Known limits).
- An allow rule never approves a command that redirects (or `tee`s) outside the working
  directories; it asks instead.

**Project trust.** `<root>/.coder/settings.json`, `<root>/.coder/agents/` and `<root>/.coder/skills/`
come with the repository, so a cloned repo could widen permissions or start MCP servers. Until you
trust the project, these keys of the project settings file are ignored: `permissions.allow`,
`permissions.defaultMode`, `permissions.additionalDirectories` and `mcpServers`. The project's
agents and skills are not loaded either. `model`, `contextWindow` and `permissions.ask`/`deny`
still apply (they only tighten). `settings.local.json` and the user settings are yours and always
apply.

- Interactive, on a TTY: coder asks `Trust this project? [y/N]` and names what it would enable.
- Print mode never asks: it warns on stderr and ignores the content. Pass `--trust-project` (CI).
- Trust is stored in `~/.coder/trusted.json` as a hash of the project settings file plus every
  project agent and skill file, keyed by the real project root. Any change to that content makes
  the project untrusted again.

Known limits:

- Shell path checks are lexical. A symlink inside the project that points outside is not detected
  by the shell check (the file tools do detect it).
- A repository's own git config (`diff.external`, textconv drivers, a pager) can run programs for
  auto-approved `git diff`, `git log` and `git show`.
- Protected-path detection for shell commands is textual: it looks for `.git` or `.coder` as a word
  in the command. A command that builds the path at run time (a variable, an encoded string, a
  script that does it) is not recognised. Commands with `$` expansions ask anyway, but a script you
  approved can touch anything.
- Pattern arguments (a `grep` regex, for example) can be treated as paths. This errs toward asking.
- Approving a command runs it as written. Read the prompt.
- In `bypassPermissions` the shell containment and ask checks are skipped (deny rules and protected
  paths still apply).
- Trust is per exact content, and the trust file is last-writer-wins when two coder processes
  trust different projects at the same moment.
- The permission mode is not persisted: a restart (or `--continue`) starts in the configured
  `defaultMode` again, not in the mode the session ended in.
- Transcripts of subagents (`/agents <n>`) exist only for runs seen live in this process. After a
  resume the final tool output carries no child session id.

## Permissions

| Mode | Behaviour |
|---|---|
| `default` | reads and read-only commands inside the working dirs are allowed; edits and other commands ask |
| `acceptEdits` | file edits in writable dirs and simple `mkdir` / `touch` / `mv` / `cp` inside them are allowed |
| `plan` | read-only: edit tools are removed, only read-only commands run; `exit_plan_mode` asks you to approve the plan, then the previous mode is restored |
| `dontAsk` | anything that would ask is denied |
| `bypassPermissions` | everything is allowed except deny rules and protected paths |

The mode lives in the permission engine, in memory. `Shift+Tab`, `/permissions mode` and approved
plans change it; it takes effect at the next step.

**Rules** are strings in `permissions.allow`, `permissions.ask` and `permissions.deny`:

| Rule | Matches |
|---|---|
| `Bash(bun test *)` | commands starting with `bun test` (a trailing ` *` also matches the bare command; `:*` is the same) |
| `Bash(git status)` | that exact command |
| `Read(.env*)`, `Read(./secrets/**)` | read tools on matching paths (gitignore patterns); also read-only shell commands that read a matching path, directory or glob |
| `Edit(src/**)` | edit tools on matching paths; also redirect targets of shell commands |
| `Agent(explore)` | the `agent` tool with that `subagent_type` |
| `Edit`, `Bash`, `mcp__server__tool` | the whole tool |

Path specifiers: `//abs/path` is absolute, `~/x` is under the home directory, `/x` and `./x` are
relative to the project root, a bare `x` follows gitignore (no slash: matches at any depth). A bare
pattern also applies inside every mounted directory, not only the project root.

Aliases: `Read` = `read_file`, `list_files`, `grep`, `glob`. `Edit` and `Write` = `edit_file`,
`write_file`, `delete_file`. `Bash` = `bash`. `Agent` = `agent`. Real tool names work too. A rule
without a specifier on a tool (`Edit`) in `deny` also removes that tool from the model's tool list.

Bash allow rules must match every subcommand of a `&&`, `;`, `|` chain and never match a complex
command. Deny and ask rules match if any subcommand matches, and also apply to redirect targets
(`Edit` rules) and read paths (`Read` rules).

**Evaluation order:** deny rules; always-ask tools (`request_directory_access`, `exit_plan_mode`);
the plan-mode gate; protected paths (also in `bypassPermissions`); directories and globs that a
deny rule could cover; ask rules; allow rules (but not for a command that writes outside the working
dirs); built-in `.env*` ask rules; then the mode default. Ask rules and the built-in asks are
skipped in `bypassPermissions`. A global `dontAsk` turns every ask into a denial.

**"Don't ask again."** An approval prompt can remember a suggested rule for this session, or for the
project. "Project" writes it to `.coder/settings.local.json`. The suggestion is deliberately narrow:

- edits: the whole `Edit` tool;
- an ordinary command: `Bash(prog sub *)`, for example `Bash(bun test *)`;
- interpreters, shells and wrappers (`bash -c`, `python3 -c`, `node`, `env`, `sudo`, `xargs`,
  `find`, `awk`, `sed`, `npx`, ...), commands whose second word is a flag, `git -c`/`-C`/`config`:
  the exact command only;
- no suggestion for compound or complex commands, commands containing `*`, protected paths,
  `exit_plan_mode` and `request_directory_access`. `bun test` is the one prefix rule kept for `bun`.

**Settings files**, merged in this order (later wins for scalars, rules and directories are
concatenated): `~/.coder/settings.json`, `<root>/.coder/settings.json` (subject to project trust),
`<root>/.coder/settings.local.json`. Then CLI flags (`--model`, `--permission-mode`,
`--allowed-tools`, `--disallowed-tools`, `--add-dir`).

```json
{
  "provider": "openrouter",
  "model": "anthropic/claude-sonnet-5.5",
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

`/permissions allow|ask|deny <rule> [--project]` and `/permissions remove <kind> <rule>` edit the
rules at run time. `--project` writes to `settings.local.json`; `remove` also removes the rule from
that file.

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

`explore` and `plan` always run in plan mode: no write tools, and their `bash` is limited to read-only
commands whatever mode the session is in (also `bypassPermissions`).

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

- `permissionMode` can only make an agent stricter: `plan` removes its non-read-only tools and runs
  its `bash` read-only whatever the session mode is. Other values are ignored, because the engine
  has one global mode.
- Project agents (`<root>/.coder/agents/`) are loaded only after you trust the project.
- Subagents never get `exit_plan_mode` or `request_directory_access`.
- Parallel runs: several `agent` calls in one step run concurrently, at most 8 at once per nesting
  depth (the cap is per depth so waiting parents cannot starve their children).
- Depth limit: 2 levels of nesting below the main agent; at the limit a child has no `agent` tool.
- Approvals: a subagent's tool calls go through the same permission engine. A question from a child
  is shown to you in the same prompt UI, labelled with the agent name, and the child waits in
  process. This does not survive a restart (library request R1).
- Transcripts: `/agents <n>` opens a child's stored messages. Only runs started in this process are
  listed.

## Project memory, skills, MCP, sessions

- **Project memory.** `AGENTS.md` at the project root is added to the instructions (fallback:
  `CLAUDE.md`). Other `AGENTS.md` files in the tree are listed as virtual paths so the model can
  read them when working there. `/init` asks the agent to write one.
- **Skills.** If `<root>/.coder/skills/` exists and the project is trusted, it is loaded as a skill
  folder (`SKILL.md` per skill) through the filesystem plugin.
- **MCP.** `mcpServers` in a settings file maps a server name to an `mcpServer()` transport config.
  A project's `mcpServers` need project trust. Servers are attached to the main agent only; a
  server that fails to configure is skipped with a warning. Requires the optional peer
  `@ai-sdk/mcp`. MCP tools ask in every mode except `bypassPermissions`, unless an allow rule names
  them (`mcp__server__tool`). This path has no automated test yet.
- **Sessions.** JSON files in `~/.coder/projects/<sha256(root)[0:16]>/sessions/`, written with the
  example JSON-file adapters. `-c` picks the newest, `-r` / `/resume` a given one. The project data
  directory also holds `tool-outputs/` and `audit.jsonl`. User data (`~/.coder`, or `CODER_HOME`):
  `settings.json`, `agents/`, `trusted.json`, `models.json`, `openrouter-models.json`, `projects/`
  (each project folder also has `preferences.json`).

## How it is built

| Folder (`src/`) | Role and eharness features it exercises |
|---|---|
| `main.tsx`, `print.ts` | CLI (commander) and headless output; `HarnessRun` streams, `TurnResult.usage` |
| `app/` | config (settings, trust), controller, agents, prompt, storage, models.dev catalog. `defineHarnessAgent`, `session.send` / `respond`, `compaction` (`summarizeAt`, `prune`), `toolOutput` eviction, turn reminders (mode, extra dirs), `dataParts`, cost and context window from the models.dev catalog, JSON-file `MessageAdapter` / `StateAdapter` |
| `workspace/` | virtual tree over disk: a `FileSystem` for the `filesystem()` plugin (tool-output eviction, skills), `glob` and `request_directory_access` tools |
| `shell/` | `bash` tool over the AI SDK sandbox shape (own process group per command, killed on abort, timeout and exit); streams stdout and stderr as a transient `data-bashOutput` part |
| `permissions/` | rule engine, shell command parsing and read-only grammars, broker, audit; a plugin using `tool.approve`, `approval.decided`, `activeTools` and `exit_plan_mode`; approvals via `tool-pending` and `respond()` |
| `agents/` | `agent` tool: child sessions, preliminary tool results for live progress, `addUsage` to roll child cost into the parent; `drive.ts` answers `tool-pending` stops for main and children |
| `ui/` | Ink components: welcome box, transcript, tool cards, diffs, todo panel (`data-todos.list`), subagent tree, permission prompt, footer; `pages/` (alternate-screen pages) and `pickers/` (model, thinking) |

Tool order is stable (prompt-cache prefix): `glob`, `bash`, `agent`, `request_directory_access`, the
filesystem tools, `todo_write`, MCP tools, `exit_plan_mode` last.

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

More (per-agent `toolOrder`, error text for adapter exceptions, subagent transcripts after resume) are
listed in the plan.
