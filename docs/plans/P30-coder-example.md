# P30 — Coding agent example (`examples/coder`)

Status: review (implementation done; migrated to the shipped P31 modules, awaiting maintainer confirmation) · Owner: — · Branch: `main` (direct commits, see the board)

## Goal

A terminal coding agent in the style of Claude Code, built **only** on the public eharness API:
a CLI (Commander) with an Ink TUI and a headless print mode, working inside one project folder
with a strict path guard, Claude-Code-style permission modes and rules, efficient partial file
edits, a shell tool, a todo list, plan mode, and subagents (built-in and user-defined, in
parallel). It is the first of the two benchmark applications for "eharness is flexible" (the
second is a team-agent app, a later phase). Everything it needs that eharness lacks is recorded
under [Requests to the library](#requests-to-the-library) instead of being hacked around silently.

It lives in `examples/` and is never published. Pieces that proved themselves here (disk
filesystem, shell, subagents, permission rules, ask, web) moved into library subpaths in
[P31](P31-library-from-coder.md); the example now consumes them
([Migration to the shipped modules](#migration-to-the-shipped-modules)) and keeps only product and UI
policy.

## Specs

The app is a consumer; it changes no spec. It relies on:

- spec 01 (plugins, hooks `turn.prepare`, `step.prepare`, `tool.approve`, `approval.decided`)
- spec 02 §5–6 (instructions vs reminders, stable tool order — prompt cache)
- spec 05 (session, storage adapters, `respond()`), spec 06 (compaction, prune, evict)
- spec 07 (skills from a folder), spec 08 (filesystem plugin, `FileSystem` contract)
- spec 09 (tool sources, output limits, `mcpServer`), spec 11 (approvals, pending, respond)
- spec 12 (model catalog, cost), spec 13 (todos)

## Owns

- `examples/coder/**` (new)
- `examples/README` entry / `docs/guides/README.md` row for the example (one line each)
- this file and its row on the board

Not owned: `src/**`. Library changes go through [Requests to the library](#requests-to-the-library).

---

## 1. Research: how Claude Code works (and what eharness already has)

Sources are listed at the end. Summary of the findings that shape the design:

**The loop is dumb.** Claude Code has no planner or graph. One loop: the model calls tools, the
results go back, repeat until the model answers without a tool call. "Step by step" behaviour
comes from five things around the loop, not from orchestration:

| Mechanism | Purpose | eharness |
|---|---|---|
| Single tool loop | the agent | done: manual step loop, one `streamText` per step (ADR-0002) |
| Todo list, reminded every step | decompose and stay on task | done: `eharness/todos` |
| Plan mode | read-only exploration until the user approves a plan | composable: `turn.prepare` / `step.prepare` `activeTools` + an approval-gated `exit_plan_mode` tool |
| Subagents with a fresh context | keep noisy work out of the parent; only a final report returns | pattern in `docs/guides/subagents.md`; no helper yet |
| Compaction + project memory file | long sessions keep working | done: compaction, prune, evict; project file loading is app code |

**Partial edits.** The edit tool takes `old_string` / `new_string`; `old_string` must match
exactly once. Reasons: (1) output tokens — the model writes only the changed snippet; (2) safety —
untouched code cannot be corrupted by a bad re-copy; (3) context — the result is one line, and
reads are windowed (`offset` / `limit`, line numbers) plus `grep` / `glob`, so large files are
never read whole. Read-before-edit and a staleness check prevent edits on outdated content.
**eharness `filesystem()` already implements all of this** (spec 08 §3–4: smart replace cascade,
`lastRead`, `STALE:`, `CONFLICT:`, windowed `read_file`). Several edits in one call
(Claude Code's former `MultiEdit`) and a `glob` tool were missing and were added in P31 (`edits[]`,
`glob`).

**Permissions** (Claude Code docs, "Configure permissions"):

- Modes: `default` (ask on first use of risky tools), `acceptEdits` (file edits and simple file
  commands in the working dirs auto-accepted), `plan` (read-only), `dontAsk` (auto-deny anything
  that would ask), `bypassPermissions` (no prompts except protected actions). `auto` (classifier)
  maps to `eharness/guard` and is out of scope for P30.
- Rules `allow` / `ask` / `deny`, evaluated **deny → ask → allow**, first match wins, specificity
  does not reorder. Syntax: `Tool`, `Bash(npm run *)`, `Read(./.env)`, `Edit(src/**)` (gitignore
  semantics), `Agent(name)`.
- Bash rules match **each subcommand** of `&&`, `||`, `;`, `|`, `&`, newline; deny/ask also match
  inside `$(…)`, subshells and loops; a few wrappers (`timeout`, `time`, `nice`, `nohup`, `xargs`
  without flags) are stripped; an unparseable command never matches an allow rule.
- Read-only tools need no approval inside the working directories; file modification asks
  ("don't ask again" lasts the session); shell asks except a built-in read-only command set
  ("don't ask again" persists per project and command prefix).

**Subagents** (Claude Code docs, "Subagents"):

- Markdown files with YAML frontmatter; body = system prompt. Locations: CLI `--agents` JSON,
  project `.claude/agents/`, user `~/.claude/agents/` (priority in that order).
- Fields: `name`, `description` (required), `tools`, `disallowedTools`, `model` (or `inherit`),
  `permissionMode`, `maxTurns`, `skills`, `mcpServers`, `omitClaudeMd`, `background`, `color`.
- Built-ins: `general-purpose` (all tools), `Explore` (read-only, thoroughness quick / medium /
  very thorough), `Plan` (read-only, used in plan mode).
- Fresh context: own system prompt, the delegation prompt, the project memory file, git status.
  It does not see the parent conversation. Only the final report returns to the parent.
- Nesting is allowed up to a depth limit (the `Agent` tool is withheld at the limit).
- Subagents inherit the parent's permission mode and rules (they may narrow them). **Foreground
  subagents pass permission prompts through to the user.**
- Several subagents can run in parallel; a failed subagent returns its partial output with a note.

**AI SDK primitives to use** (AI SDK first): `Experimental_SandboxSession` (`description`,
`readTextFile` with line ranges, `writeTextFile`, `run`, `spawn`) is the shape for the shell
driver, so a Vercel/Docker sandbox can replace the local one later. `@ai-sdk/tui` exists
(`runAgentTUI({ agent | transport })`) but is a fixed UI and needs a newer `ai` than the lockfile;
it stays an alternative (see §10).

---

## 2. Tech stack

Checked against the npm registry on 2026-10-08. Pin exact versions in `examples/coder/package.json`
(the workspace package, §2.1); Bun installs them into the repo's single `bun.lock`.

| Package | Version | Released | Use | Notes |
|---|---|---|---|---|
| `eharness` | repo source | — | core | not a package dependency: resolved to `src/` through the repo `tsconfig` `paths` (§2.1) |
| `ai` | `^7.0.127` (lockfile 7.0.127) | — | AI SDK | declared with the root's range, so both resolve to one copy |
| `zod` | root range (`^4.6.5`) | — | schemas | import from `zod/v4`; one copy as above |
| `commander` | 15.0.0 | 2026-05-29 | CLI parsing | ESM only, Node ≥ 22.12 |
| `ink` | 8.0.0 | 2026-10-03 | TUI | React ≥ 19.3, Node ≥ 22; `usePaste`, `useWindowSize`, `incrementalRendering`, `<Static>` fixes |
| `react` / `@types/react` | 19.3.0 | 2026-09-09 | Ink peer | |
| `ink-testing-library` | 4.0.0 | 2024-05-22 | UI tests | peer `@types/react` only; verify with Ink 8 in M1, else test the view model only |
| `tinyglobby` | 0.2.17 | 2026-05-30 | project memory file discovery | |
| `ignore` | 7.0.12 | 2026-10-02 | `.gitignore` rules | |
| `diff` | 9.0.0 | 2026-04-13 | diffs in approval prompts and edit cards | |
| `shell-quote` | 1.12.0 | 2026-10-02 | tokenize shell commands for rule matching | parse only; never used to build commands |
| `@ai-sdk/mcp` | root version | — | MCP servers from settings (M5) | already an optional peer |

Deliberately not used:

- `ink-text-input`, `@inkjs/ui` (2024, written for Ink 5 key semantics): the prompt needs
  multiline, paste, history and `/` + `@` completion, so it is a small own component on
  `useInput` + `usePaste`.
- `@vscode/ripgrep` (binary download in `postinstall`, blocked by default under Bun): `grep` uses
  the system `rg` when it is on `PATH` and falls back to the filesystem plugin's own grep.
- `execa`: `node:child_process` `spawn` is enough behind the sandbox interface.

**Ink 8 is five days old.** Use it (latest docs, `incrementalRendering`), but if a blocking bug
appears in M1, pin `ink@7.1.1` + `react@19.2` (released 2026-07-16; same APIs except Box width
percentages and stream typings).

### 2.1 Workspace, package manager and runtime

**Bun is the package manager and the runtime** of the example (Bun 1.4.2, the repo's
`packageManager`). Node is not needed to develop, run or test it.

**Bun workspace.** The root `package.json` gets `"workspaces": ["examples/coder"]`, and
`examples/coder/package.json` is a private workspace package:

```json
{
  "name": "eharness-coder",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "bin": { "coder": "./src/main.tsx" },
  "scripts": {
    "start": "bun src/main.tsx",
    "test": "bun test",
    "typecheck": "tsc --noEmit -p .",
    "compile": "bun build src/main.tsx --compile --outfile dist/coder"
  },
  "dependencies": {
    "ai": "^7.0.127",
    "zod": "^4.6.5",
    "commander": "15.0.0",
    "ink": "8.0.0",
    "react": "19.3.0",
    "tinyglobby": "0.2.17",
    "ignore": "7.0.12",
    "diff": "9.0.0",
    "shell-quote": "1.12.0"
  },
  "devDependencies": { "@types/react": "19.3.0", "ink-testing-library": "4.0.0" }
}
```

One `bun install` at the repo root installs the library and the example. `bun --filter
eharness-coder start` (or `bun examples/coder/src/main.tsx`) runs it from the root.

**How `eharness` resolves (verified 2026-10-08, Bun 1.4.2).** A workspace member cannot depend
on the **root** package: `"eharness": "workspace:*"` fails with `failed to resolve`, also with
`"."` listed in `workspaces`; `"file:../.."` installs a *copy* of the root (which contains the
example itself) instead of a link. So `eharness` is **not** listed in the example's
dependencies. Instead `examples/coder/tsconfig.json` extends `examples/tsconfig.json` (which
extends the root one), whose `paths` map `eharness` and `eharness/*` to `src/`. The Bun runtime
honours `paths` through `extends` (probe: `import.meta.resolve('eharness')` →
`src/index.ts`), and `tsc` uses the same mapping. Result: the example always runs against the
current library source, with no build step, exactly like the other examples. A check against the
built package (`dist/`) is the job of the existing `node-compat` CI job, not of this example.

`ai` and `zod` are declared by the example with the root's ranges. Both the library source and
the example then resolve the same installed copy (one lockfile entry), so `instanceof` checks and
AI SDK's internal symbols stay identical. M1 adds a test that fails when two copies of `ai` are
loaded.

**Changesets with a workspace (verified in a scratch repo with `@changesets/cli` 3.0.3).**
`changeset version` still bumps the root `eharness` package and leaves the private
`eharness-coder` at `0.0.0`. With the repo's `changedFilePatterns`, changes inside
`examples/coder/**` (its `package.json` included) need no changeset. Adding the `workspaces` field
to the root `package.json` matches the `package.json` pattern once: that commit carries an empty
changeset (`bunx changeset --empty`), because nothing user-facing changes. The published
`package.json` then contains a `workspaces` field, which npm ignores for consumers; `publint` and
`attw` must stay green (checked in M1).

**Root scripts and gates.**

- `bun test` at the root discovers `examples/coder/test/**` too, so the example is part of the
  normal test gate (its tests are offline, scripted models).
- `examples/tsconfig.json` excludes `coder/**` (it needs `jsx: "react-jsx"`), and the root
  `typecheck` script appends `&& tsc --noEmit -p examples/coder`.
- Biome already lints the whole repo, `.tsx` included.
- CI needs no new job: `bun install --frozen-lockfile` installs the workspace, the existing steps
  cover it.

**Linker (decided in M1).** Adding a workspace switches Bun 1.4.2 from the hoisted to the isolated
linker. Isolated hides transitive packages, and one library test imports types from
`@ai-sdk/provider`, which only `ai` depends on, so `tsc` failed. `bunfig.toml` pins
`[install] linker = "hoisted"`: the library keeps the layout it was developed with, and the
library and the example share one root `node_modules` (one copy of `ai`, checked by
`examples/coder/test/workspace.test.ts`).

**Distribution.** `bun build --compile` produces a single `coder` binary for local use (M5). The
code uses only `node:` APIs that Bun implements; Node support is not a goal of the example. The
library rule "runtime-neutral source" applies to `src/`, not to examples.

---

## 3. Layout

```
examples/coder/
  package.json            # private workspace package `eharness-coder` (§2.1)
  tsconfig.json           # extends ../tsconfig.json (eharness → src/ via paths); jsx: react-jsx
  README.md               # how to run, keys, settings, safety model, known limits
  src/
    main.tsx              # Commander program → interactive (Ink) or print mode; signals, trust prompt
    contracts.ts          # shared types: config, controller, engine, broker, tool names
    print.ts              # headless mode: text | json | stream-json
    app/
      agent.ts            # composes the shipped plugins into the main agent and the subagent agents
      checkpoints.ts      # /rewind and /branch policy over rewindFiles, checkpointsSince, session.fork
      tasks.ts            # the /tasks list: shellTasks service + background subagents from stored state
      web-search.ts       # turndown, DNS lookup, the provider-specific search function
      config.ts           # settings files + CLI flags + project trust → one resolved Config
      controller.ts       # CoderController: session, run, shell, resume, setModel, stats
      models.ts           # models.dev catalog: cache, refresh, offline
      prompt.ts           # static instructions; turn reminder (date, platform, git, mode, dirs)
      project-memory.ts   # AGENTS.md (and CLAUDE.md fallback) loading
      sessions.ts         # storage location, listing, newest session
    workspace/
      index.ts            # nodeWorkspace() over the config (library: eharness/filesystem/node)
      dir-access.ts       # request_directory_access tool (always asks)
    permissions/
      engine.ts           # the library engine configured for the app: tool kinds, protected paths, rule scopes
      audit.ts            # onDecision → audit.jsonl
      broker.ts           # in-process question queue for the UI (main agent and subagents, §6.4)
      describe.ts         # title, detail and suggested rule of a pending call
    agents/
      builtin.ts          # general-purpose, explore, plan
      load.ts             # .coder/agents/*.md, ~/.coder/agents/*.md, --agents JSON
      subagents.ts        # the `answer` callback of eharness/subagent (broker, "don't ask again")
      drive.ts            # answers tool-pending stops of the main agent (approvals, questions)
    ui/
      App.tsx  run-interactive.tsx  driver.ts   # layout, entry, stream/session-event driver
      Transcript.tsx  MessageView.tsx  ToolCard.tsx  DiffView.tsx  tool-summary.ts
      PermissionPrompt.tsx  SubagentTree.tsx  TodoPanel.tsx  SessionPicker.tsx
      PromptInput.tsx  editor.ts  mentions.ts   # multiline, paste, history, @ completion
      StatusBar.tsx  Spinner.tsx  theme.ts  keys.ts  sanitize.ts
      slash.ts            # slash command registry
      state.ts            # view model reducer over UI message chunks + session events
  test/                   # <name>.test.ts, plus helpers.ts and fake-controller.ts
    dir-access workspace engine permissions-plugin broker describe drive agent-tool tasks
    checkpoints agents-load config
    models prompt project-memory sessions controller print.e2e ui-render(.tsx) ui-state
    ui-slash ui-editor ui-mentions ui-tool-summary
```

Rule: `app/`, `workspace/`, `permissions/` and `agents/` never import Ink or React. The UI
and print mode are two consumers of the same `HarnessRun` streams and session events, so the
whole agent is testable headless.

---

## 4. CLI surface

```
coder [prompt]                       interactive TUI; optional first prompt
coder -p, --print <prompt>           headless: run one turn (and its continuations), print, exit
  --output-format text|json|stream-json   print mode output (default text)
  --model <id>                       AI Gateway id or provider:model (default from settings)
  --permission-mode <mode>           default | acceptEdits | plan | dontAsk | bypassPermissions
  --add-dir <path...>                extra directories, mounted at /@dirs/<basename>/
  --allowed-tools <rule...>          extra allow rules for this run
  --disallowed-tools <rule...>       extra deny rules for this run
  --agents <json>                    session-only subagent definitions
  -c, --continue                     continue the most recent session of this project
  -r, --resume [id]                  resume a session (picker without id)
  --max-steps <n>                    loop.maxSteps per turn
  --cwd <path>                       project root (default: process.cwd())
  --trust-project                    trust this project's .coder/ settings, agents and skills
```

Print mode never prompts: anything that would ask is denied (`dontAsk` semantics) unless
`--permission-mode bypassPermissions` is given. Exit code 0 for `complete`, 1 for any other stop,
2 for usage and config errors (unknown flag, invalid settings, invalid `--agents`); a denied write
does not change the code by itself. The `json` format prints `{ stop, text, usage, costUsd,
sessionId }`. SIGINT/SIGTERM abort the turn and kill the process group of every running command.
`--trust-project` trusts the project's `.coder/` content (§5).

**Interactive keys:** `Enter` submit, `Shift+Enter` / `\` + `Enter` newline, `Esc` interrupt the
running turn (`run.abort()`), `Shift+Tab` cycle permission mode, `Ctrl+C` twice exit, `↑`/`↓`
history, `!cmd` run a shell command directly (shown in the transcript, sent as context), `@path`
file mention with completion, `Ctrl+O` toggle expanded tool output.

**Slash commands:** `/help`, `/clear` (new session), `/compact`, `/model`, `/permissions` (list;
`allow|ask|deny <rule> [--project]`, `remove <kind> <rule>`, `mode <mode>` edit), `/agents [n]` and
`/transcript <n>` (list runs, open one read-only), `/resume [id]`, `/cost`, `/todos`, `/init` (draft
an `AGENTS.md`), `/exit`.

**Settings files** (JSON, merged in this order, later wins; rules concatenate):
`~/.coder/settings.json` (user), `<root>/.coder/settings.json` (project, committed, subject to project
trust §5), `<root>/.coder/settings.local.json` (personal, add to `.gitignore`), then CLI flags.

```json
{
  "model": "anthropic/claude-sonnet-4.6",
  "permissions": {
    "defaultMode": "default",
    "allow": ["Bash(bun test *)", "Bash(git diff *)"],
    "ask": ["Bash(git push *)"],
    "deny": ["Read(./.env)", "Read(./secrets/**)"],
    "additionalDirectories": ["../shared-lib"]
  },
  "mcpServers": { "github": { "type": "http", "url": "https://…" } }
}
```

---

## 5. Workspace and path guard

The model never sees real paths. It sees a virtual tree: `/` is the project root.

- **`diskFs(root)`** implements the eharness `FileSystem` contract over `node:fs/promises` and
  passes `fileSystemConformance` on a temp directory. `version` = `contentVersion(content)`,
  writes are compare-and-set on that version (read, compare, write via temp file + `rename`),
  `grep` uses `rg --json` when available, `list` honours ignore rules.
- **Containment.** Every virtual path is normalized by the plugin (`normalizePath`, no `..`
  survives), joined to the root, then `realpath`'d (for writes: the nearest existing parent). If
  the real path is not inside the real root → `REJECTED:` (a symlink pointing outside is the
  classic escape). Tests cover `..`, absolute paths, symlinked files and directories, and a
  symlink created by the shell between read and write.
- **Ignore and protected paths.** `.git/`, `node_modules/` and `.gitignore` entries are hidden
  from `list_files`, `glob` and `grep` (still readable by explicit path, like Claude Code).
  `.git/**`, `.coder/settings*.json` and `.coder/agents/**` are **write-protected**: always ask,
  in every mode, `bypassPermissions` included (protected actions), for file tools and for shell
  commands (textual detection of `.git` / `.coder` in a non-read-only command). `Read(…)` rules
  apply to file tools and to read-only shell commands (directories and globs they cover included),
  and they filter the output of `grep`, `list_files` and `glob` ("N results hidden"). Secrets such
  as `.env*` ask by a built-in rule that an explicit allow rule overrides (decided: ask, not deny).
- **Text only.** Files that are not valid UTF-8 or larger than 2 MB are reported as
  `ERROR: binary or too large` (binary file support is a library roadmap item).
- **Outside the project.** `mountFs` composes: `/` → project, `/@dirs/<name>/` → each
  `--add-dir` / `additionalDirectories` entry (same guard, own root), `/.coder/tool-outputs/` →
  `~/.coder/projects/<hash>/tool-outputs` (evicted tool outputs never land in the repo). A
  `request_directory_access({ path, reason })` tool lets the model ask for a new directory; it has
  `metadata.risk: 'external'` and **always** asks (no rule, mode or grant can auto-approve it); on
  approval the directory is mounted for the session and the tool returns its virtual path. It
  refuses `/`, the home directory and any parent of the project, and reports the real path when a
  symlink was followed. `glob` (the library tool since P31) lists through this guarded
  `FileSystem`, so results outside the mount (symlinks) and ignored paths never appear.
- **Project trust.** `<root>/.coder/settings.json`, `.coder/agents/` and `.coder/skills/` come with the
  repository. Until trusted, the project file's `allow`, `defaultMode`, `additionalDirectories` and
  `mcpServers` are ignored (`ask`, `deny`, `model`, `contextWindow` still apply), and project agents
  and skills are not loaded. Trust is recorded in `~/.coder/trusted.json` as a hash of that content,
  per real root; a change revokes it. A TTY asks `Trust this project? [y/N]`; print mode warns and
  needs `--trust-project`.
- **The shell is not jailed.** Commands run with `cwd` = the real project root, but a shell can
  touch anything the user can. This is stated in the README and enforced by permissions (§6), not
  by the filesystem. OS sandboxing (`sandbox-exec` on macOS, `bubblewrap` on Linux) behind the same
  sandbox interface is a stretch goal (M5).

---

## 6. Tools and permissions

### 6.1 Tool set (stable order — prompt cache)

Actual order (`app/agent.ts`; it differs from `TOOL_ORDER` in `contracts.ts` because the core has no
per-agent `toolOrder`): the root `tools` config first (`bash`, `agent` when depth allows,
`request_directory_access` for the main agent), then the plugins in order (`filesystem()` tools,
including the library `glob`,
`todo_write`, MCP tools, `exit_plan_mode` last). It is identical for every session and turn.

| Tool | From | Risk | Notes |
|---|---|---|---|
| `read_file`, `list_files`, `grep` | `eharness/filesystem` | read | windowed reads with line numbers |
| `edit_file`, `write_file`, `delete_file` | `eharness/filesystem` | write / destructive | read-before-edit, `STALE:`, smart replace; `edits[]` for several changes in one call |
| `glob` | `eharness/filesystem` | read | `pattern`, optional `path`; newest first, max 200; lists through `workspace.fs`, so the disk guard's containment and ignore rules apply |
| `bash` | app | external | `command`, `description`, `timeoutMs` (default 120 000, max 600 000) |
| `todo_write` | `eharness/todos` | read | |
| `agent` | app | (per child) | §7 |
| `exit_plan_mode` | app | external | only in plan mode; always asks; the plan is its input |
| `request_directory_access` | app | external | always asks |
| `load_skill`, `read_skill_file` | core | read | skills from `.coder/skills/` via `fsSkillSource` |
| MCP tools | `eharness/mcp` | from settings | M5; main agent only, project servers need trust; default `mcpServer()` options (no `defer`) |

Tool output limits: `toolOutput: { maxChars: 30_000, strategy: 'evict' }` so a huge test log is
stored under `/.coder/tool-outputs/` and the model pages through it with `read_file`. The `bash`
tool streams live output to the UI as a **transient** data part and returns only the capped final
output (head + tail, exit code, duration) to the model.

### 6.2 Modes

| Mode | Reads in working dirs | File edits | Shell | Ask-type actions |
|---|---|---|---|---|
| `default` | allowed | ask | read-only commands, else ask | ask |
| `acceptEdits` | allowed | allowed in working dirs | + `mkdir`, `touch`, `mv`, `cp` inside working dirs | ask |
| `plan` | allowed | denied (tools inactive) | read-only commands only (argument allow-lists) | `exit_plan_mode` asks |
| `dontAsk` | allowed | only via allow rules | only via allow rules | denied |
| `bypassPermissions` | allowed | allowed | allowed | protected paths and `request_directory_access` still ask |

`Shift+Tab` cycles `default → acceptEdits → plan → default`. The mode lives in the permission
engine (in memory, shared by the main agent and the children), not in plugin state, and is not
persisted: a restart starts in `defaultMode` again. It is shown in the status bar and in the turn
reminder. A mode change takes effect at the next step. `exit_plan_mode` restores the mode that was
active before plan mode. `/permissions mode bypassPermissions` needs `--yes`.

### 6.3 Rules and how they map onto eharness

- `rules.ts` parses `Tool` and `Tool(spec)`; tool aliases map Claude-Code-style names to ours
  (`Read` → `read_file`/`list_files`/`grep`/`glob`, `Edit` → `edit_file`/`write_file`/
  `delete_file`, `Bash` → `bash`, `Agent(name)` → `agent` with that `subagent_type`).
- Path specs use gitignore semantics via `ignore`, anchored as in the Claude Code table
  (`//abs`, `~/`, `/` = project root, relative = cwd).
- Bash specs: `bash-match.ts` tokenizes with `shell-quote`, splits on `&&`, `||`, `;`, `|`, `|&`, `&`,
  newline, strips `timeout`, `time`, `nice`, `nohup`, `stdbuf`, `command`, `builtin`, bare
  `xargs`, and safe leading env assignments. **Any** of `$(`, backticks, `<(`, subshell parens,
  heredocs, or a trailing operator makes the command *complex*: allow rules never match a complex
  command; deny/ask rules match any subcommand found. Redirect targets (`>`, `>>`, `tee`) are
  checked against `Edit` rules and the working directories.
- Evaluation (as implemented): deny rules, always-ask tools, plan-mode gate, protected paths, covered
  directories/globs, ask rules, allow rules, built-in `.env*` asks, mode default. Result per call:
  `denied` (with a reason the model reads), `user-approval` or `approved`.
- Read-only shell commands (`readonly-commands.ts`) are not matched by name alone: each command has
  an argument allow-list (`sort -o`, `find -exec`, `rg --pre`, `uniq in out`, `tail -f` are refused;
  `tree` is not on the list). Their path arguments must lie in a working directory. `$` expansions,
  `~user`, brace expansion and `xargs` stdin ask. Recursive searches (`rg`, `grep -r`) and globs ask
  when a `Read` ask/deny rule (built-in `.env*` included) could match below the target. An allow
  rule never approves a redirect outside the working directories.
- **eharness mapping.** The agent has **no** static `approval.policy`; the `permissions` plugin's
  `tool.approve` hook returns the decision for every call (most-restrictive-wins means a hook can
  only tighten what is otherwise allowed, and nothing else is configured, so the hook decides).
  The hook reads rules, mode and session allowances from the in-memory permission engine only: it
  is deterministic for a given engine state and has no side effects. Bare-tool deny rules and plan
  mode remove tools through `step.prepare` `activeTools` (`turn.prepare` has no tool list in its
  event; accepted: a cache bust at mode changes). After an approved `exit_plan_mode` the first step
  of the `respond()` continuation is prepared before the tool runs; the plugin reads
  `step.prepare` `continuing.approved` to offer the tools of the restored mode (R11, P31).
- **Prompt answers:** *Yes* → `respond({ approvals: [{ id, approved: true }] })`; *Yes, and don't
  ask again* → the UI first adds a session allow rule, then approves (persisted to
  `settings.local.json` when the user picks "always for this project"). The suggestion is narrow:
  edits → the `Edit` tool; bash → `Bash(prog sub *)` for ordinary programs (e.g. `Bash(bun test *)`),
  the **exact** command for interpreters, shells and wrappers (`bash -c`, `python3 -c`, `node`,
  `env`, `sudo`, `xargs`, `find`, `awk`, `sed`, `npx`, …), for a flag as second word and for
  `git -c/-C/config`; none for compound or complex commands, commands with `*`, protected paths,
  `exit_plan_mode` and `request_directory_access`; *No* (+ optional feedback) → approved
  `false` with `reason` = the feedback, which the model reads. Every decision is logged through
  `approval.decided` to `~/.coder/projects/<hash>/audit.jsonl`.
- Several pending approvals of one step are answered together in one `respond()` (partial answers
  are not supported by the core, roadmap).

### 6.4 Subagent approvals

Claude Code passes a child's permission prompts through to the user. In eharness a child turn
that needs approval stops `tool-pending` in **its own** session. Decision (revised during
implementation): the parent's `agent` tool drives that child like the controller drives the main
session. It awaits `run.result`, and for each `tool-pending` stop it asks the user through the
in-process `ApprovalBroker` (the prompt names the subagent), applies "don't ask again" rules, and
calls `respond()` on the **child** session, until the child turn ends. Parent and children
therefore both use real eharness approvals (`tool.approve`, pending state, `respond()`, audit);
the broker is only the UI's question queue. Print mode answers the broker with denials.

What stays a library gap (R1): the parent turn cannot *park* while a child waits for a person, so
this works in one process (a CLI) but not for a server that must survive restarts between the
question and the answer.

---

## 7. Subagents

- **Tool.** `agent({ subagent_type, description, prompt })`. `description` is a 3–5 word label
  for the UI. The tool's description lists the available types with their descriptions (built at
  session start, so the list is stable for the session).
- **Definitions.** Built-in `general-purpose` (all tools except `agent` at the depth limit),
  `explore` (read-only tools; prompt asks for a thoroughness level), `plan` (read-only). Both are
  `permissionMode: plan`: write tools are removed and their `bash` is read-only in every session
  mode, `bypassPermissions` included (a per-agent mode on their permissions plugin). Subagents never
  get `exit_plan_mode` or `request_directory_access`; project definitions load only when the
  project is trusted. User-defined from `--agents` JSON, `<root>/.coder/agents/*.md`,
  `~/.coder/agents/*.md` (priority in that order; built-ins lowest). Frontmatter subset: `name`,
  `description`, `tools`, `disallowedTools`, `model` (`inherit` default), `permissionMode`,
  `maxTurns`, `omitProjectMemory`. Parse with eharness `parseSkillMarkdown` (same YAML subset);
  invalid files are skipped with a warning in the UI.
- **Execution.** One `defineHarnessAgent` per definition, built once at startup, sharing the
  workspace `FileSystem`, the sandbox and the permission engine. Each call opens a child session
  `${parentId}:agent:${toolCallId}` with `SessionOptions.parent` (depth from the parent),
  `loop.maxSteps` = `maxTurns`, the tool's `abortSignal` passed to `send()`. Fresh context: the
  definition body, the project memory file (unless omitted), and the env reminder; the delegation
  prompt is the user message.
- **Progress.** The tool is an async generator: it yields preliminary outputs
  `{ status, steps, lastTool, text }` that the UI renders as a nested tree under the parent's tool
  card; the final output is only the child's last text (plus `stop` when not `complete`, with the
  partial text). Child usage and cost go to the parent turn with `ctx.turn.addUsage()`.
- **Parallel.** Several `agent` calls in one step run concurrently (AI SDK executes the step's
  tool calls in parallel); the instructions tell the model to batch independent delegations.
  Concurrency cap: 8 running children per nesting depth (one semaphore per depth, so parents
  waiting for their children cannot fill the cap and deadlock).
- **Nesting.** Depth limit 2 below the main agent (configurable); at the limit the child agent is
  built without the `agent` tool.
- **Transcripts.** Child sessions are stored like any session; `/agents <n>` (or `/transcript <n>`)
  opens the stored messages of run `n`. Only runs seen live in this process are listed: the final
  tool output carries no child session id (R10). Children are closed after their final output.

---

## 8. Prompt, loop and sessions

- **Static instructions** (system block 1, never changes per session): identity, tone (concise,
  no unasked summaries), tool policy (prefer `grep`/`glob` before reading; read with
  `offset`/`limit`; edit instead of rewrite; batch independent calls; use `todo_write` for tasks
  with three or more steps; delegate broad searches to `explore`; verify with the project's tests;
  never commit or push unless asked), the virtual path model ("`/` is the project root; the shell
  runs in the project root, use relative paths there").
- **Session instructions** (block 2): project memory — `AGENTS.md` at the root (fallback
  `CLAUDE.md`), plus nested `AGENTS.md` files listed by path for on-demand reading.
- **Turn reminder** (`refresh: 'turn'`, never stored): date, platform, git branch and short
  status, permission mode. Volatile values never go into `instructions` (ADR-0013).
- **Loop:** `maxSteps` 200, `wrapUp` on, progress guard default, `compaction.summarizeAt` 0.8 with
  `prune: {}`, `models` from the models.dev catalog via `modelsDevCatalog()` (decided: fetched, not bundled):
  `app/models.ts` caches it in `~/.coder/models.json`, refreshes a cache older than 24 h in the
  background, waits at most 3 s for the first fetch, and `CODER_OFFLINE=1` disables fetching. An
  explicit `contextWindow` setting beats the catalog. The status bar shows context % and USD.
- **Sessions:** `examples/json-file-storage.ts` adapters (messages + state) under
  `~/.coder/projects/<sha256(realRoot)[0:16]>/sessions/`. `--continue` picks the newest;
  `--resume` lists sessions with their first user message. A crash mid-turn is recovered by the
  core on the next operation (`stop: 'interrupted'`).

---

## 9. UI (Ink)

- **Transcript:** finished messages are rendered once in `<Static>`; only the running turn
  re-renders (`incrementalRendering: true`). State comes from `readUIMessageStream` over
  `run.stream` plus `session.events()` (pending, turn-end).
- **Tool cards:** one line per call, collapsed by default (`Read src/app.ts:120-180`,
  `Edited src/app.ts (+3 −1)`, `Ran bun test (exit 0, 4.2 s)`), expanded with `Ctrl+O`; edits show a
  coloured unified diff (`diff`), computed from the `data-filesystem.change` part and the tool
  input.
- **Permission prompt:** inline below the live turn: what will run (command or diff), the matching
  rule if any, options *Yes / Yes, don't ask again for … / No, tell the agent what to do instead*.
- **Subagent tree:** nested cards with status, step count and last tool; a finished child shows
  its one-line result.
- **Todo panel:** latest `data-todos.list`, above the prompt while items are open.
- **Status bar:** mode (coloured), model, context %, turn and session cost.
- Narrow terminals: layout uses `useWindowSize()` (Ink 8 has no percentage widths).

---

## 10. Alternatives considered

- **`@ai-sdk/tui` instead of Ink.** It takes an AI SDK `Agent` or a `ChatTransport`; an in-process
  transport over `handleChatRequest` could drive it today. Rejected for P30: fixed UI (no
  subagent tree, modes, slash commands), and it requires `ai@7.0.133` (lockfile 7.0.127). Worth
  a small separate example once the `asAgent()` adapter exists.
- **Asking the user from inside tool execution** (a wrapper that awaits the broker before
  `execute`, bypassing eharness approvals). Simpler, but the example would no longer exercise
  eharness approvals (`tool-pending`, `respond()`, audit), which is half its value. Rejected.
- **A real shell sandbox from the start.** Platform-specific and slow to get right; deferred to
  M5 behind the sandbox interface.

---

## 11. Milestones and checklist

Development first, one gate per milestone (lint, typecheck, tests of `examples/coder`), one review
at the end.

### M1 — Skeleton, workspace, file tools (single agent edits code)

- [x] Workspace setup (§2.1): root `workspaces`, `examples/coder/package.json`, `tsconfig.json`,
      `examples/tsconfig.json` exclude, root `typecheck` script, empty changeset, `bunfig.toml`
      (hoisted linker); `bun.lock` updated; `publint` / `attw` unchanged
- [x] Test: `eharness` resolves to `src/`, one copy of `ai` (`test/workspace.test.ts`)
- [x] Skeleton `src/main.tsx`: Commander program (`--version`, `-p`, `--cwd`) and an Ink splash
- [x] README (rewritten for the final code; see Implementation notes)
- [x] Commander program with print mode and the interactive entry; `config.ts` (settings + flags)
      (`config.test.ts`, `print.e2e.test.ts`)
- [x] `disk-fs.ts` + `guard.ts` passing `fileSystemConformance` on a temp dir; containment tests
      (`..`, absolute, symlink file, symlink dir, symlink swap) (`disk-fs.test.ts`, `guard.test.ts`)
- [x] `mount-fs.ts` with `/@dirs/*` and `/.coder/tool-outputs/` (`mount-fs.test.ts`)
- [x] `glob` tool (now the library tool, P31; `glob-tool.test.ts` runs it over the workspace); `rg` fast path for `grep` with fallback (`glob-tool.test.ts`; the fallback is
      tested, the `rg` path runs when `rg` is installed)
- [x] Agent factory with `filesystem()`, static prompt, project memory, turn reminder, tool order
      (`prompt.test.ts`, `project-memory.test.ts`, `controller.test.ts`; order: §6.1, not `toolOrder`)
- [x] Ink app: transcript, tool cards, prompt input (multiline, paste, history), status bar, `Esc`
      (`ui-render`, `ui-editor`, `ui-state`; paste and history have no dedicated test)
- [x] Sessions: JSON storage, `--continue`, `--resume` (`sessions.test.ts`, `controller.test.ts`,
      picker in `ui-render.test.tsx`)
- [x] Acceptance: scripted-model e2e in print mode passes offline; "rename function X across the
      project" with partial edits is tested with a scripted model (`controller.test.ts`). Not run
      with a real model.

### M2 — Permissions, shell, plan mode, todos

- [x] `rules.ts` with the Claude Code example table as test cases; `bash-match.ts` tests
      (operators, wrappers, complex forms, redirects) (`rules.test.ts`, `bash-match.test.ts`;
      `parse.ts` became `bash-match.ts` + `readonly-commands.ts`)
- [x] `permissions` plugin: modes, `tool.approve`, `activeTools`, audit via `approval.decided`
      (`engine.test.ts`, `permissions-plugin.test.ts`)
- [x] Permission prompt UI + `respond()`; "don't ask again" (session and project)
      (`ui-render.test.tsx`, `drive.test.ts`, `engine.test.ts`; the project scope is tested at the
      engine level)
- [x] `sandbox-local.ts` + `bash` tool (timeout, abort, live transient output, capped result,
      read-only commands) (`sandbox.test.ts`, `bash-tool.test.ts`)
- [x] Plan mode + `exit_plan_mode`; `Shift+Tab` cycling; protected paths ask in every mode
- [x] `todos()` plugin + todo panel; `!cmd` direct shell (`todos()` is wired; the panel is covered by
      the `ui-state` reducer test only; `!cmd` in `ui-render` and `controller` tests)
- [x] Acceptance: in `default` mode no write or non-allowlisted command runs without a prompt
      (engine test matrix per mode); plan mode cannot modify a file by any tool

### M3 — Subagents

- [x] Built-in definitions; loader for `--agents`, project and user `agents/*.md`
      (`agents-load.test.ts`, `print.e2e.test.ts`)
- [x] `agent` tool: child session, parent link, abort, usage, progress generator, final output
      (`agent-tool.test.ts`)
- [x] Parallel execution with the concurrency cap; depth limit (cap is per depth, §7)
- [x] Child approvals: the `agent` tool answers the child's `tool-pending` through the broker and
      `respond()` (§6.4); prompts labelled with the child name (`agent-tool.test.ts`,
      `drive.test.ts`)
- [x] Subagent tree UI; open a child transcript from `/agents <n>` (`ui-slash.test.ts`,
      `ui-render.test.tsx`; the tree component has no render test)
- [x] Acceptance: parallel children and the `reviewer` agent that cannot call `bash` are tested
      (`agent-tool.test.ts`). "explore in three areas" is not tested with exactly three children.

### M4 — Long sessions and polish

- [ ] Compaction + prune + evict tuned; `/compact`, `/cost`, `/clear`, `/model`, `/permissions`,
      `/agents`, `/init`, `/todos` (the slash commands are done and tested in `ui-slash.test.ts`;
      compaction, prune and evict are configured (`summarizeAt` 0.8, `prune: {}`, evict at 30 000
      chars) but not tuned or tested in the example)
- [x] `@path` completion; `Ctrl+O` expand; diff view in prompts and cards (`ui-mentions.test.ts`,
      `ui-tool-summary.test.ts`, `ui-render.test.tsx`; `Ctrl+O` has no test)
- [ ] Skills from `.coder/skills/` (`fsSkillSource` on the workspace fs): wired in `app/agent.ts`
      and gated by project trust (trust tested in `config.test.ts`); loading skills is not tested
- [ ] Acceptance: a two-hour session survives compaction and a process kill (`--continue`):
      not run; resume is tested, compaction is not

### M5 — Stretch

- [ ] MCP servers from settings (`mcpServer`, risk per server): implemented in `app/agent.ts`
      (main agent only, project servers need trust); no automated test, and the security of this
      path (MCP tools run with the user's privileges, they only ask by default) is untested
- [x] OS sandbox driver for `bash` (macOS `sandbox-exec`, Linux `bubblewrap`), opt-in via `sandbox.enabled` (see the remaining-features notes)
- [ ] `bun run compile` single binary; smoke-run it outside the repo: script exists, smoke not done
- [ ] Docs: guide page `docs/guides/coding-agent.md` walking through the example: not done

## Acceptance criteria

- [ ] All milestone acceptance items above (M1 to M3 hold with scripted models; M4 and the real-model
      checks are open)
- [x] `examples/coder` lint and typecheck clean; its tests run offline with `scriptedModel`
- [x] Root `bun run lint && bun run typecheck && bun test` stay green (1795 tests pass)
- [x] No import from `src/**` internals: only `eharness`, `eharness/*` subpaths (same rule as
      shipped plugins)
- [x] Every library gap found is written under [Requests to the library](#requests-to-the-library)
- [x] Only one changeset, empty, for the root `workspaces` field (§2.1); nothing in `src/` changes
      (`.changeset/coder-workspace.md` is empty)
- [ ] `bun install --frozen-lockfile` works from a clean clone (not re-verified in this review)

## Implementation notes (2026-10-08)

Review findings that were fixed after the first implementation:

- The shell read-only list was a name list: now every command has an argument allow-list (`sort -o`,
  `find -fprint`, `rg --pre`, `uniq in out`, `tail -f`, `git --output` are refused; `tree` removed).
- Read rules did not reach the shell, directories or globs: recursive searches and globs now ask when
  a `Read` ask/deny rule (built-in `.env*` included) could match below the target; `$` expansions ask.
- `grep`, `list_files` and `glob` leaked paths hidden by `Read` rules: their output is filtered and
  ends with a "results hidden" line. Bare `Read` patterns apply in every mount.
- "Don't ask again" could offer `Bash(bash *)` or similar: it is exact for interpreters, wrappers,
  flags as second word and `git -c/-C/config`.
- Protected paths only guarded file tools: shell commands that mention `.git` or `.coder` ask in
  every mode, `bypassPermissions` included (textual detection).
- An allow rule could approve a redirect outside the project: it now asks.
- `explore` and `plan` ran with the session mode: they now always run in plan mode (read-only bash).
- One global concurrency cap could deadlock nested children: the cap is per depth.
- `exit_plan_mode` always went to `default`: it restores the previous mode.
- `request_directory_access` accepted `/`, home and parents of the project, and hid symlinked
  targets: it refuses them and reports the real path.
- Project `.coder/` content could widen permissions or start MCP servers: project trust (§5).
- Context window and cost: the models.dev catalog replaced the fixed fallback (§8).
- Process groups of shell commands outlived the CLI: SIGINT, SIGTERM and exit kill them.

Decisions:

| Decision | Choice |
|---|---|
| Mode storage | in the permission engine, in memory, not persisted across restarts (§6.2) |
| `.env*` reads | ask by a built-in rule (an allow rule overrides it), not deny |
| Catalog | models.dev fetched and cached (`~/.coder/models.json`, 24 h, `CODER_OFFLINE=1`), not bundled |
| Tool order | root tools first, then plugins (§6.1); no per-agent `toolOrder` in the core |
| Exit codes | 0 complete, 1 other stop, 2 usage or config error; a denied write alone is 0 |
| Trust file | last writer wins; accepted for an example |

Known limits (also in the README): lexical shell path checks and symlinks; git config drivers can run
programs in auto-approved `git diff|log|show`; protected-path detection for shell is textual; `rg
<path>` is treated as recursive; transcripts of subagents only for runs seen live; mode is not
persisted.

### UI and provider update (2026-10-08)

- **OpenRouter provider.** `--provider openrouter|gateway` (also a settings key); OpenRouter is the
  default when `OPENROUTER_API_KEY` is set. Missing key: exit 2. Default models per provider in
  `src/app/provider.ts`.
- **Model and thinking switch** through a `turn.prepare` plugin (`src/app/model-switch.ts`) that
  reads shared state, so `/model` and `/thinking` apply to every agent at its next step without
  rebuilding agents. OpenRouter needs its own `providerOptions.openrouter.reasoning` next to the AI
  SDK `reasoning` option. Choices persist per project in `preferences.json`.
- **OpenRouter catalog** cached in `~/.coder/openrouter-models.json` (24 h, `CODER_OFFLINE`).
- **Pages on the alternate screen.** `/context`, `/status`, `/cost`, `/help`, `/agents`,
  `/permissions` and the transcript viewer. Ink's `alternateScreen` option is fixed per instance
  and the conversation lives in `<Static>` scrollback, so `ui/pages/host.ts` switches the screen by
  hand in four phases (`entering`, `open`, `leaving`, `closed`).
- **Pickers** for model and thinking (`ui/pickers/`), opened by Alt+P and Alt+T.
- **Enter inside an input chunk.** Terminals can deliver `hi\r` as one chunk (tmux, ssh, scripted
  input), which inserted a newline. `PromptInput` now splits a non-paste chunk at its first Enter
  (`splitEnter` in `ui/editor.ts`): the text before it is inserted, the Enter submits (or inserts a
  newline after `\`), and text after it becomes the next draft (dropped while a turn runs).
  Bracketed paste keeps newlines as text.
- **Welcome box** shortens home to `~` and truncates the middle of long paths to the window width.

### Implementation notes: UX batch (2026-10-08)

- **Steer outcome** (`app/controller.ts`): `run()` and `steer()` share an `ActiveTurn` (`started`,
  `deferred`, `deliveries`). A steer is sent with `ifBusy: 'steer'` and its outcome is read from
  `run.delivery` (P31): `'step'` needs nothing, `'turn'` needs nothing either (the turn's run reaches
  `adopt` through `session.onRun`, below), `'dropped'` puts the text into `deferred`. The loop awaits
  the outstanding deliveries and the adopted runs when the turn ends, so a queued turn never runs
  without its approvals being answered.
- **Deferred steers during approvals.** While the turn waits for an approval the session is not
  running (`session.running` is `false`) and a send would auto-deny it, so the text goes straight to
  `deferred`; so do steers the core dropped (`delivery` `'dropped'`). Deferred texts are sent as the
  next turn after the approval round.
- **Plan-exit mode.** The prompt's choice (`acceptEdits` / `default`) is passed to the engine with
  `setPlanExitMode` just before `respond()`; the `exit_plan_mode` tool switches to it instead of the
  previous mode.
- **Steered input in the transcript.** `data-eh.input` parts render where they sit
  (`MessageView`): `source: 'user'` as a `> text` line with a dim marker, an approval note
  (`approvalNote` set, P31) as a dim `Note: …` with the raw note, `source: 'event'` as a dim
  line, `plugin:*` hidden (model-only context).
- **Web safety** (`app/web-tools.ts`): http upgraded to https; private/local hosts, resolved private
  addresses, credentials in the URL and odd ports refused unless `WebFetch(domain:host)` allows the
  host; redirects followed only within the same host (else `REDIRECT:` for a new approval); 15 s,
  5 MB, 30 000 characters; HTML to Markdown. Both tools always ask and run in plan mode.
- **Search per provider.** OpenRouter: `generateText` with `google/gemini-2.5-flash` and the
  `web` plugin in `providerOptions.openrouter.plugins`. AI Gateway: `anthropic/claude-haiku-4.5` with
  `gateway.tools.perplexitySearch`. `CODER_SEARCH_MODEL` overrides; usage goes to the turn through
  `turn.addUsage`. No key or a scripted model: the tool reports it is unavailable.

## UX gap analysis (2026-10-08)

Compared with the reference terminal coding agent's documentation (interactive mode, commands,
tools, permissions; Sources). "Here" is the state of `examples/coder` after the approval-note and
question-dialog work. Priority: P1 = expected by every user of a coding agent, P2 = strong
quality-of-life, P3 = nice to have. Effort: S < 1 day, M 1–3 days, L > 3 days.

### Input and prompt

| Feature | Reference behaviour | Here | eharness support | Prio | Effort |
|---|---|---|---|---|---|
| Queue messages while the agent works | `Enter` during a turn queues; queued entries shown gray; `Up` takes them back; sent at the next step boundary or after the turn done: queued while a turn runs, steered at the next tool result or sent as the next prompt (`ActiveTurn` in `app/controller.ts`); `Up` takes back | `ifBusy: 'queue' \| 'steer' \| 'collect'` (spec 05) | done | — |
| Reverse history search | `Ctrl+R`, history of all projects, persisted done: `Ctrl+R` over `~/.coder/history.jsonl` of all projects | app | done | — |
| Persistent prompt history | across sessions per project done: `~/.coder/history.jsonl`, `Up`/`Down` per project | app | done | — |
| Double `Esc` | clears a draft (saved to history) or opens the rewind menu | done: `Esc Esc` clears a draft (saved) or opens `/rewind` on an empty prompt | app | done | — |
| Rewind / checkpoints | restore conversation and/or code to an earlier message | done: `/rewind` restores code, conversation or both; code from per-turn file snapshots (file tools only, not shell changes) | conversation: `regenerate` / `edit` (rewind markers); code: needs file snapshots (app) | done | — |
| External editor | `Ctrl+G` opens `$EDITOR` for the prompt | done: `Ctrl+G` runs `$VISUAL` / `$EDITOR` on a temp file | app | done | — |
| Stash prompt | `Ctrl+S` stash / restore | done: `Ctrl+S` stashes and restores the draft | app | done | — |
| Kill ring and word motions | `Ctrl+K/U/W/Y`, `Alt+B/F/D`, undo `Ctrl+_` | done: `Ctrl+K/U/W/Y`, `Alt+B/F/D/Y`, undo `Ctrl+_` | app | done | — |
| Large paste collapsed | `[Pasted text #1 +42 lines]` chip | done: `[Pasted text #N +L lines]` chips (over 800 characters or 10 lines) | app | done | — |
| Image paste | `Ctrl+V` inserts `[Image #N]`, sent as a file part | done: `Ctrl+V` / `Alt+V` reads the clipboard image, `[Image #N]` chip, sent as a file part | user file parts supported (spec 05 §3) | done | — |
| Prompt suggestions | ghost text from git history; next-prompt suggestion after a reply (`Tab` accepts) | done: `promptSuggestions` setting, dim placeholder, `Tab` or `Right` accepts | app (+ a cheap model call) | done | — |
| Vim mode | NORMAL/INSERT/VISUAL editing | done: `editorMode: "vim"` or `/vim` (insert, normal, visual, operators, counts, `.`) | app | done | — |
| `@` mentions of folders and agents | folders, files, agents | done: files, folders and `@agent-<name>` | app | done | — |

### Transcript and display

| Feature | Reference behaviour | Here | eharness support | Prio | Effort |
|---|---|---|---|---|---|
| Reasoning display | collapsed thinking block, expandable done: `✻ Thinking…` live, `∴ Thought for Ns`, full text in the transcript viewer (`Ctrl+O`) | reasoning parts are in the UI message | done | — |
| Task list toggle | `Ctrl+T` shows/hides the checklist (≤ 5 items) | done: `Ctrl+T` | todos plugin | done | — |
| Focus view | `/focus`: only last prompt, one-line tool summaries, diffstats | done: `/focus` shows prompts and final answers only | app | done | — |
| Message timestamps / model per message | in the transcript viewer | viewer shows them when metadata has them | `metadata.eharness` | done | — |
| Terminal title and notifications | title shows the task; bell/desktop notification when a long turn ends or input is needed | done: OSC title; `notifications` bell / desktop / off | app (`turn-end`, `pending` session events) | done | — |
| Session recap | one-line recap when returning; `/recap` | done: `/recap` (one cheap model call) | app (summarizer call) | done | — |
| Custom status line | user command renders the footer | done: `statusLine.command` with status JSON on stdin | app | done | — |
| Themes | `/theme`, light/dark, syntax colors | done: `dark`, `light`, `auto`; `/theme` | app | done | — |

### Commands

| Command | Reference behaviour | Here | eharness support | Prio | Effort |
|---|---|---|---|---|---|
| `/diff` | review working-tree changes and per-turn edits done: `/diff` page (git + agent edits) | app (git) + `data-filesystem.change` parts | done | — |
| `/compact [instructions]` | focus instructions for the summary | done: focus text added through `compaction.prompt` | `compaction.prompt` hook | done | — |
| `/plan [description]` | enter plan mode from the prompt done: `/plan [description]` | app | done | — |
| `/add-dir <path>` | mount a directory mid-session | done: mounts under `/@dirs/` | `workspace.addDirectory` | done | — |
| `/export`, `/copy [N]` | export conversation, copy a response | done: `/export [file]`, `/copy [n]` (clipboard command or OSC 52) | `session.messages()` | done | — |
| `/btw` side question | answer from context without adding to history | done: tool-less `streamText`, nothing stored, not charged | a separate `streamText` over the projected context | done | — |
| `/rename`, named sessions | name shown on the prompt bar; resume by name | done: `/rename <name>` | app (state) | done | — |
| `/branch`, `/fork` | branch the conversation | done: `/branch [name]` copies the stored messages into a new session | roadmap "Fork" (`session.fork`) | done | — |
| `/memory` | edit project memory files | done: page listing memory files incl. `~/.coder/AGENTS.md` | app | done | — |
| `/config` | settings dialog | done: page over the settings files (user / local scope) | app | done | — |
| `/init` | draft `AGENTS.md` | done | — | done | — |
| `/doctor` | setup diagnostics | done: environment checks page | app | done | — |
| `/release-notes`, `/feedback`, `/bug` | product-specific | not applicable | — | — | — |
| Custom commands and skills by `/name` | project/user command files, skills invokable as `/skill` done: `.coder/commands`, `~/.coder/commands`, skills as `/skill-name` | skill sources (spec 07) | done | — |

### Agent and tools

| Feature | Reference behaviour | Here | eharness support | Prio | Effort |
|---|---|---|---|---|---|
| Web fetch / web search tools | fetch a URL as markdown; search done: `web_fetch` and `web_search` with approval and `WebFetch(domain:…)` / `WebSearch` rules | app tools (+ approval) | done | — |
| Background shells | `Ctrl+B` backgrounds a command; output read later; `/tasks` | done: `run_in_background`, `bash_output`, `kill_shell`, `/tasks` | app (sandbox `spawn`) + external waits (spec 11 §4.2) | done | — |
| Background subagents | run while the user keeps working; completion notification | done: `agent { run_in_background }`; the report wakes the parent | inject + wake (spec 05 §12) | done | — |
| Monitor tool | stream a background command's lines back to the agent | done: `notify_on` regex on a background shell | inject `next-step` events | done | — |
| LSP diagnostics | definitions, references, type errors | done: `lsp` tool over a JSON-RPC client; default TypeScript server | MCP or app tool | done | — |
| Hooks | shell commands on tool/turn events | done: seven events, settings `hooks` (determinism deviation, see notes) | plugin hooks (spec 01 §5) | done | — |
| Plan approval options | approve with auto-accept edits / approve manual / keep planning with feedback done: auto-accept edits / manual / keep planning (`setPlanExitMode`) | `exit_plan_mode` + mode switch | done | — |
| Permission prompt notes | `Tab` adds a note to Yes/No | done: the note is `approvals[].note` (R16, P31) and the model reads it right after the tool result; a bare No ends the turn with `respond(…, { endTurn: 'if-denied' })` (R17, P31) | `approvals[].note` + denial reason | done | — |
| Multiple-choice questions | `ask_user_question` dialog, radio/checkbox, Other, notes | done (client tool answered in process through the broker) | client tools (spec 11) | done | — |
| Question timeout | optional auto-continue after idle | done: `askUserQuestionTimeout` seconds | client tool timeouts (spec 11 §7.1) | done | — |
| Output styles | switchable response styles | done: built-ins and Markdown files; session instruction | instructions | done | — |
| OS sandbox | sandboxed shell | done: Seatbelt / bubblewrap, opt-in `sandbox.enabled`; writes and network only | roadmap "Sandbox plugin" | done | — |

**Done since (the P1 batch):** message queueing, reasoning display, persistent history with
`Ctrl+R`, plan approval options, `/plan`, `/diff`, web fetch/search tools, custom `/commands` and
skill invocation. **Done since (the remaining features, 2026-10-08):** every row above marked
done: input polish, rewind and checkpoints, background tasks, hooks, LSP, output styles, themes,
status line, notifications, OS sandbox. Library follow-ups from this work are in
[P31](P31-library-from-coder.md).

### Implementation notes: remaining features (2026-10-08)

- **Wake-ups drive background turns.** A finished background shell, a throttled `notify_on` match
  (at most one event per 5 s, batched) and a finished background agent are injected into the
  parent session as `eh.event` messages with `{ deliver: 'next-step', wake: true }` (library: the `shell` and
  `subagents` plugins). A busy turn sees them at its next step
  boundary; an idle session starts a no-input turn. The controller subscribes to `session.onRun`
  (P31): every run that `drive` did not start itself (a wake, a queued turn, a steer that became a
  turn) is adopted, driven like a prompt (approvals through the broker) and streamed through the
  hooks of the most recent `run()` / `steer()`, or drained when there were none, so no wake run
  stops unanswered at an approval. The `turn-start` watcher and `attach()` are gone. A task the user stopped sends nothing.
- **Output style is a session instruction.** The style text goes into the session instruction
  block (after the static instructions), never into the static prefix. Switching style (or the
  sandbox setting) reopens the session handle when idle (`refreshSession`), so the prompt cache is
  rebuilt from the session block onwards; tools and the static instructions stay cached. `default`
  adds no text. Project styles need project trust (they are part of the trust hash).
- **Hook determinism deviation** (spec 01 section 5 wants `tool.approve` hooks to be deterministic and
  free of side effects). A `PreToolUse` hook is an arbitrary user command, so its decision is
  computed once per tool call id and cached (500 entries); the `tool.approve` re-evaluation of a
  `respond()` continuation sees the same answer without running the command again. `Stop` hooks
  may force at most 3 continuations in a row. Project hooks load only when the project is trusted.
- **Sandbox mechanism and limits** (`shell/os-sandbox.ts`). macOS: `sandbox-exec` with a generated
  Seatbelt profile (default allow, file writes denied except the project root, `allowWrite`, temp
  directories and a few device files; network denied unless `sandbox.network`, local unix sockets
  stay allowed). Linux: `bwrap` with a read-only bind of `/`, writable binds for the root and
  `allowWrite`, a private `/tmp`, `--unshare-net` unless the network is allowed. Not covered: reads
  (secrets in `$HOME` stay readable), CPU and memory, unix-socket IPC on macOS. When the tool is
  missing the state is `none` and the app says commands run unsandboxed instead of pretending.
  A project settings file may only tighten the sandbox until trusted. Seatbelt is deprecated by
  Apple but still ships.
- **Checkpoint scope.** The `checkpoints` plugin records a file's content before its first change
  in a turn (`edit_file`, `write_file`, `delete_file`; subagent edits are filed under the root
  turn), the last 50 turns per session, under `<projectDataDir>/checkpoints/`. `/rewind` restores
  code, conversation (a NEW session with the messages before the point; the old one is untouched)
  or both. Not checkpointed: shell and `!command` changes, other tools, edits made outside the
  agent. A file changed since is overwritten with the earliest snapshot of the later turns.

### Bugs found in real use

- **Continuation streams left approved calls in `approval-requested`.** After `respond()` the
  stream did not carry the answers, so an approved long-running tool looked as if it still waited.
  Fixed in the library (0.6.1 patch: `tool-approval-response` chunks at the start of a `respond()`
  continuation).
- **The thinking indicator hid during continuations** after an answered question or approval. Fixed
  in the example UI.

## Requests to the library

Gaps this example works around; each becomes a roadmap row or a phase with a spec.

| # | Request | Workaround in P30 |
|---|---|---|
| R1 | **Nested approvals across processes**: park the parent turn while a child session waits for an approval, resume both later from any instance | **Done in the library (P31): `subagents({ approvals: 'park' })` (ADR-0035).** The app uses `approvals: 'inline'` (profile b: one process), `answer` is the broker |
| R2 | `edit_file` with several edits in one call (atomic, one read check) | **Done in the library (P31): `edit_file({ path, edits: [...] })`.** The app's approval diff, tool card and summary handle `edits[]` |
| R3 | `glob` tool in `eharness/filesystem` (uses `list`, adapter fast path) | **Done in the library (P31): the `glob` tool.** The app's own tool was removed |
| R4 | Node-only `eharness/filesystem/node` disk adapter with the containment rules of §5 (ADR: first Node-only module) | **Done in the library (P31): `diskFs`, `mountFs`, `nodeWorkspace`.** `workspace/disk-fs.ts`, `guard.ts` and `mount-fs.ts` were removed; the tool-outputs mount is the library default `/.eharness/tool-outputs/` |
| R5 | Pass `experimental_sandbox` through to `streamText` / tools; a shell plugin over `Experimental_SandboxSession` (roadmap "Sandbox plugin") | **Done in the library (P31): `eharness/shell` (`shell`, `localSandbox`, `shellTasks`).** `shell/` and `app/background-bash.ts` were removed |
| R6 | `eharness/subagent` helper (child session, progress, usage, depth, cleanup) | **Done in the library (P31): `eharness/subagent`.** `agents/agent-tool.ts` was removed; background mode and `data-subagent.run` parts come with it |
| R7 | Rule-based grants (`Bash(git *)`) in core approvals (roadmap row) | **Done in the library (P31): `eharness/permissions`.** `permissions/{engine,rules,bash-match,readonly-commands,plugin}.ts` were replaced by a 183-line configuration of it |
| R8 | `addUsage` accepting the eharness `TurnResult.usage` shape directly | **Done in the library (P31): `addUsage()` takes `TurnResult['usage']` (`PlainUsage`).** The conversion helper was removed |
| R9 | Binary files / images in `FileSystem` (screenshots, PDFs) | **Done in the library (P31): `readBytes` / `writeBytes`, `read_file` shows images.** The tool card prints the media reference's `Image <path> (…)` line |
| R10 | Subagent transcripts after a resume: the final tool output of a child carries no session id, so the UI cannot reopen runs of an earlier process (an output part or `providerMetadata` with the child session id, or a `parent` index in the session API) | **Done in the library (P31): the persisted `data-subagent.run` part and `session.children()`.** `/agents` lists runs from the stored parts after a resume |
| R11 | `step.prepare` cannot see that an approved tool of the continuation will change the active tools (the first step of a `respond()` is prepared before the approved tool runs) | **Done in the library (P31): `StepPrepareEvent.continuing`.** The permissions plugin reads `e.continuing?.approved` |
| R12 | Per-agent `toolOrder` (the core has one global order; plugin tools always come after root tools) | **Done in the library (P31): `config.toolOrder`.** The app has not adopted it yet (it keeps "root tools, then plugins", §6.1); unknown names warn `W_TOOL_ORDER`, so a per-agent list is needed first |
| R13 | Adapter exceptions from `FileSystem` become `Error: ...` tool errors (spec 08 §3) instead of an `ERROR:` string; an option to catch and format them in the filesystem plugin (or a per-tool `toolErrorText`) | **Done in the library (P31): adapter exceptions reach the model as `ERROR: …` (`onAdapterError`).** `disk-fs.ts` keeps throwing plain sentences |
| R14 | A public API to list a session's resolved tools with their definitions (name, description, input schema), so a UI can itemise tool sizes | **Done in the library (P31): `session.tools()`.** `/context` itemises tools from it (per-tool tokens, `source`); `tool-inventory.ts` and its `~def` reader were removed |
| R15 | Per-category context stats in `session.stats()`: split `instructions` into memory, skills and MCP (today `ContextStats` has `instructions`, `tools` and `messages` only, spec 06 §2) | **Done in the library (P31): `ContextStats.instructionBlocks` and `toolSources`.** `/context` derives skills from `core:skills`, MCP from `source:mcp:*`; only the memory share of the `app` block is still estimated by the app (the core cannot tell which app block is memory) |
| R16 | An approval answer that carries a note for the model, delivered on the continuation's first step (today `PendingResponse.approvals[].reason` only reaches the model for denials, and no steer is delivered before step 0 of a `respond()` continuation) | **Done in the library (P31): `respond({ approvals: [{ id, approved, note }] })`.** The steer and carry code in `agents/drive.ts` was removed |
| R17 | `respond()` option to end the turn after recording the answers (e.g. stop on a bare denial) without starting a model step | **Done in the library (P31): `respond(…, { endTurn: 'after-answers' \| 'if-denied' })`.** The stream proxy in `agents/drive.ts` was removed |
| R18 | The tool input of a pending client-tool call in `PendingState.clientTools` (only `toolCallId` and `toolName` today) | **Done in the library (P31): `PendingState.clientTools[].input` (`inputTruncated` above 16 KB).** The stored part is read only for a truncated input |
| R19 | A steer API that reports what happened to the input: delivered at a step of the running turn, fell back to a queued turn, or was dropped because the turn waits for an approval (today `send({ ifBusy: 'steer' })` returns a run and the app infers the outcome from `session.attach()` and `input-dropped` session events) | **Done in the library (P31): `HarnessRun.delivery` (`'step' \| 'turn' \| 'dropped'`).** `steer()` reads it instead of watching `input-dropped`; it still checks `session.running` first, because a send while the turn waits for an approval would auto-deny it |
| R20 | Duration of a reasoning part in UI messages (only the message-level `durationMs` exists; a part carries no start/end time) | **Done in the library (P31): `providerMetadata.eharness.durationMs` on reasoning parts.** `partDuration` reads it, so stored and replayed reasoning shows `Thought for Ns`; the live measurement is only a fallback |

## Migration to the shipped modules

Done after P31 shipped the modules the example had proven (`35f17f6`). The example imports them and
deleted its own copies; what remains is product and UI policy.

| Was (example) | Now (library) | App-only part that stays |
|---|---|---|
| `workspace/{disk-fs,guard,mount-fs,index}.ts` | `eharness/filesystem/node`: `nodeWorkspace` | `request_directory_access` (`workspace/dir-access.ts`) |
| `app/checkpoints.ts` (JSON store, plugin, copy) | `filesystem({ checkpoints: nodeCheckpointStore(dir) })`, `rewindFiles`, `checkpointsSince`, `session.fork({ beforeMessageId })` | which prompts `/rewind` lists, nested subagent sessions for `sessionIds` (`children()` is direct only); session names. The fork copy is the plugin's `session.fork` hook |
| `shell/*`, `app/background-bash.ts`, shell part of `app/tasks.ts` | `eharness/shell`: `shell({ background: true })`, `localSandbox`, `shellTasks` | `app/tasks.ts` (merges `shellTasks` and `subagentTasks` for the UI), the sandbox setting |
| `permissions/{engine,rules,bash-match,readonly-commands,plugin}.ts` | `eharness/permissions` | `permissions/engine.ts` (app tool kinds with `alwaysAsk` directory access, `.coder` protected paths, `persist` writing project-scope rules to `settings.local.json`), broker, `describe.ts`, audit log |
| `agents/agent-tool.ts`, child part of `agents/drive.ts` | `eharness/subagent` (`approvals: 'inline'`, `background: true` on the main agent) | agent definitions from files, `agents/subagents.ts` (`answer` = broker), main-agent `driveTurn` |
| `agents/ask-tool.ts` | `eharness/ask`: `askUser`, `pendingQuestions`, `answerOutput` | the question dialog, the answer timeout |
| `app/web-tools.ts` | `eharness/web`: `webFetch`, `webSearch` | turndown, DNS lookup, provider search (`app/web-search.ts`) |

Behaviour differences (all deliberate or library behaviour):

- Tool-output eviction directory is `/.eharness/tool-outputs/` (was `/.coder/tool-outputs/`); the prompt,
  README and the permission roots follow.
- The sandbox state is in the library's `bash` description, no longer in the turn reminder; a toggle
  reopens the session handle (idle) so the description is resolved again.
- "Don't ask again" for `bun test …` offers the exact command (`bun` is an interpreter for the library
  engine); an invalid rule in a settings file is still dropped silently, an invalid `/permissions` rule
  is rejected with the library's message.
- Tool list order changed (app tools, `bash`, `agent`, filesystem tools, `todo_write`, web, ask, MCP,
  `exit_plan_mode`); it is stable per agent.
- `agent` tool: an unknown `subagent_type` is an invalid tool call (the input schema is an enum); the
  tool description is the library's. Background agents exist on the main agent only; a stopped
  background agent reports `aborted` to the main agent. Background shells exist on the main agent
  only (a child's would die with its session).
- `web_fetch` private-host refusal does not mention the `WebFetch(domain:…)` rule; the `web_search`
  fallback text is `ERROR: web search failed: web search is not available`.
- Old checkpoint files (`checkpoints/<session>/<message>.json`) are not read; the library store has its
  own layout.
- `request_directory_access` is denied (not asked) in plan mode, where the tool is hidden anyway.
- An invalid `/permissions` rule (and a stored one) is refused with the library's error instead of
  being ignored; removing a rule that only exists in `settings.local.json` but was never loaded into
  the engine is a no-op (the library removes what it knows).

Gaps closed after the migration (`ecc9b59`; workarounds deleted): `alwaysAsk` replaces the `decide`
upgrade for `request_directory_access`; `persist(rules, change)` with scopes replaces the change
tracking wrapper; `session.onRun` replaces the `turn-start` / `attach()` wake watcher and the
queued-run plumbing; the filesystem plugin's `session.fork` hook replaces the app's checkpoint copy;
`sessionIds` replaces the per-session loops of `rewindFiles` / `checkpointsSince`; `subagentTasks`
replaces the task list derived from stored messages; the `bash` description replaces the sandbox
line of the turn reminder. No library gap is left in the example.

Remaining app-only parts: the Ink UI and its state, commands and slash registry, settings and trust,
hooks, output styles, models catalog, LSP, session storage and names, memory files, recap, side
questions, status line, notifications, the approval broker and its diff descriptions, and the
agent-definition loader.

Lines of code (`*.ts`/`*.tsx` under `examples/coder`, before → after): sources 24 442 → 19 336
(−5 106), tests 16 612 → 13 963 (−2 649), total 41 054 → 33 299 (−7 755). By folder (`src/`):
`workspace/` 755 → 89, `shell/` 634 → 0 (the library's `shell` replaces it), `permissions/` 2 983 → 566
(engine 773 → 183, the rules / shell parser / read-only grammars / plugin are gone), `agents/` 950 →
447, `app/web-tools.ts` 463 → `app/web-search.ts` 139, `app/background-bash.ts` 314 → 0,
`app/checkpoints.ts` 365 → 132, `app/tasks.ts` 198 → 235 (it now also derives background subagents).
15 source files were deleted (4 419 lines). 10 test files (1 876 lines) that the library covers were
deleted (`bash-match`, `bash-tool`, `disk-fs`, `guard`, `mount-fs`, `os-sandbox`, `sandbox`, `rules`,
`web-fetch`, the old `tasks`); `engine.test.ts` shrank 1 260 → 461 (the app's policy only), and
`checkpoints`, `agent-tool`, `ask-tool`, `web-search` and `session-tools` tests were adapted.

## Open questions

1. ~~Dependencies of the example~~ — decided: a Bun workspace package with its own dependencies,
   `eharness` resolved through `tsconfig` `paths` (§2.1).
2. **App name and folder names.** Proposed `coder`, settings in `.coder/`, user data in
   `~/.coder/`. Reading `.claude/agents/` and `CLAUDE.md` as fallbacks is convenient but couples
   the example to another product's layout; proposed: `AGENTS.md` first, `CLAUDE.md` fallback only.
3. **Default model.** Proposed: AI Gateway id from settings, no hard-coded provider package.
4. **Windows.** Out of scope for P30 (shell parsing and paths are POSIX).

## Sources

- Claude Code docs, Subagents: https://code.claude.com/docs/en/sub-agents
- Claude Code docs, Configure permissions: https://code.claude.com/docs/en/permissions
- Ink releases (7.0, 8.0): https://github.com/vadimdemedes/ink/releases
- Commander releases (14, 15): https://github.com/tj/commander.js/releases
- `@ai-sdk/tui` README: https://www.npmjs.com/package/@ai-sdk/tui
- AI SDK `Experimental_SandboxSession`: `@ai-sdk/provider-utils` type declarations (ai 7.0.127)
- npm registry metadata for every package in §2 (versions and dates as of 2026-10-08)
- Bun workspaces: https://bun.com/docs/pm/workspaces
- Reference interactive-mode, commands and tools documentation: https://code.claude.com/docs/en/interactive-mode, https://code.claude.com/docs/en/commands, https://code.claude.com/docs/en/tools-reference
- Bun module resolution (`tsconfig` `paths`, export conditions): https://bun.com/docs/runtime/module-resolution
- Local probes (2026-10-08, Bun 1.4.2, `@changesets/cli` 3.0.3): root as a workspace dependency, `paths` through `extends`, `changeset version` / `status` with a private workspace
