# P30 — Coding agent example (`examples/coder`)

Status: todo · Owner: — · Branch: `main` (direct commits, see the board)

## Goal

A terminal coding agent in the style of Claude Code, built **only** on the public eharness API:
a CLI (Commander) with an Ink TUI and a headless print mode, working inside one project folder
with a strict path guard, Claude-Code-style permission modes and rules, efficient partial file
edits, a shell tool, a todo list, plan mode, and subagents (built-in and user-defined, in
parallel). It is the first of the two benchmark applications for "eharness is flexible" (the
second is a team-agent app, a later phase). Everything it needs that eharness lacks is recorded
under [Requests to the library](#requests-to-the-library) instead of being hacked around silently.

It lives in `examples/` and is never published. Pieces that prove themselves here (disk
filesystem, shell, subagents, permission rules) move into library subpaths later, each with a
spec and an ADR (a follow-up phase, not this one).

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
`lastRead`, `STALE:`, `CONFLICT:`, windowed `read_file`). Missing: several edits in one call
(Claude Code's former `MultiEdit`) and a `glob` tool.

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
| `tinyglobby` | 0.2.17 | 2026-05-30 | `glob` tool | |
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
  README.md               # how to run, keys, settings, safety model
  src/
    main.tsx              # Commander program → interactive (Ink) or print mode
    app/
      agent.ts            # builds the main HarnessAgent and subagent agents from config
      config.ts           # settings files + CLI flags → one resolved Config
      prompt.ts           # static instructions; turn reminder (env, git status, date)
      project-memory.ts   # AGENTS.md (and CLAUDE.md fallback) loading
      sessions.ts         # storage location, --continue / --resume, listing
    workspace/
      disk-fs.ts          # FileSystem over a real directory, with the path guard
      mount-fs.ts         # composite FileSystem: / = project, /@dirs/<n>/, /.coder/tool-outputs/
      guard.ts            # realpath containment, protected paths, ignore rules
      glob-tool.ts        # glob tool (tinyglobby + ignore)
      dir-access.ts       # request_directory_access tool (always asks)
    shell/
      sandbox-local.ts    # Experimental_SandboxSession over child_process (cwd = project root)
      bash-tool.ts        # bash tool: timeout, output cap, live output, abort
      parse.ts            # split into subcommands, strip wrappers, detect unparseable forms
      readonly-commands.ts# built-in read-only allowlist (ls, cat, rg, git status/log/diff, …)
    permissions/
      modes.ts            # default | acceptEdits | plan | dontAsk | bypassPermissions
      rules.ts            # parse + match Tool(spec) rules, deny → ask → allow
      plugin.ts           # definePlugin: tool.approve, turn.prepare/step.prepare, exit_plan_mode
      broker.ts           # in-process question queue for the UI (main agent and subagents, §6.4)
    agents/
      builtin.ts          # general-purpose, explore, plan
      load.ts             # .coder/agents/*.md, ~/.coder/agents/*.md, --agents JSON
      agent-tool.ts       # the `agent` tool: child sessions, parallel, progress, usage
    ui/
      App.tsx             # layout: <Static> transcript + live turn + prompt + status bar
      Transcript.tsx  MessageView.tsx  ToolCard.tsx  DiffView.tsx
      PermissionPrompt.tsx  SubagentTree.tsx  TodoPanel.tsx
      PromptInput.tsx     # multiline, paste, history, / and @ completion
      StatusBar.tsx       # mode, model, context %, cost
      slash.ts            # slash command registry
      state.ts            # view model reducer over UI message chunks + session events
    print.ts              # headless mode: text | json | stream-json
  test/
    disk-fs.test.ts  guard.test.ts  rules.test.ts  parse.test.ts
    agent-tool.test.ts  permissions.test.ts  print.e2e.test.ts  ui.test.tsx
```

Rule: `app/`, `workspace/`, `shell/`, `permissions/` and `agents/` never import Ink or React. The UI
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
```

Print mode never prompts: anything that would ask is denied (`dontAsk` semantics) unless
`--permission-mode bypassPermissions` is given. Exit code 0 for `complete`, 1 otherwise; the
`json` format prints `{ stop, text, usage, costUsd, sessionId }`.

**Interactive keys:** `Enter` submit, `Shift+Enter` / `\` + `Enter` newline, `Esc` interrupt the
running turn (`run.abort()`), `Shift+Tab` cycle permission mode, `Ctrl+C` twice exit, `↑`/`↓`
history, `!cmd` run a shell command directly (shown in the transcript, sent as context), `@path`
file mention with completion, `Ctrl+O` toggle expanded tool output.

**Slash commands:** `/help`, `/clear` (new session), `/compact`, `/model`, `/permissions` (list and
edit rules), `/agents` (list), `/resume`, `/cost`, `/todos`, `/init` (draft an `AGENTS.md`),
`/exit`.

**Settings files** (JSON, merged in this order, later wins; rules concatenate):
`~/.coder/settings.json` (user), `<root>/.coder/settings.json` (project, committed),
`<root>/.coder/settings.local.json` (personal, add to `.gitignore`), then CLI flags.

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
  in every mode, `bypassPermissions` included (protected actions). `deny` rules on `Read(…)` apply
  to file tools; secrets such as `.env*` are denied by a default rule the user can override.
- **Text only.** Files that are not valid UTF-8 or larger than 2 MB are reported as
  `ERROR: binary or too large` (binary file support is a library roadmap item).
- **Outside the project.** `mountFs` composes: `/` → project, `/@dirs/<name>/` → each
  `--add-dir` / `additionalDirectories` entry (same guard, own root), `/.coder/tool-outputs/` →
  `~/.coder/projects/<hash>/tool-outputs` (evicted tool outputs never land in the repo). A
  `request_directory_access({ path, reason })` tool lets the model ask for a new directory; it has
  `metadata.risk: 'external'` and **always** asks (no rule, mode or grant can auto-approve it); on
  approval the directory is mounted for the session and the tool returns its virtual path.
- **The shell is not jailed.** Commands run with `cwd` = the real project root, but a shell can
  touch anything the user can. This is stated in the README and enforced by permissions (§6), not
  by the filesystem. OS sandboxing (`sandbox-exec` on macOS, `bubblewrap` on Linux) behind the same
  sandbox interface is a stretch goal (M5).

---

## 6. Tools and permissions

### 6.1 Tool set (stable order, `toolOrder` — prompt cache)

| Tool | From | Risk | Notes |
|---|---|---|---|
| `read_file`, `list_files`, `grep` | `eharness/filesystem` | read | windowed reads with line numbers |
| `edit_file`, `write_file`, `delete_file` | `eharness/filesystem` | write / destructive | read-before-edit, `STALE:`, smart replace |
| `glob` | app | read | `pattern`, optional `path`; newest first, max 200 |
| `bash` | app | external | `command`, `description`, `timeoutMs` (default 120 000, max 600 000) |
| `todo_write` | `eharness/todos` | read | |
| `agent` | app | (per child) | §7 |
| `exit_plan_mode` | app | external | only in plan mode; always asks; the plan is its input |
| `request_directory_access` | app | external | always asks |
| `load_skill`, `read_skill_file` | core | read | skills from `.coder/skills/` via `fsSkillSource` |
| MCP tools | `eharness/mcp` | from settings | M5; `defer: 'auto'` |

Tool output limits: `toolOutput: { maxChars: 30_000, strategy: 'evict' }` so a huge test log is
stored under `/.coder/tool-outputs/` and the model pages through it with `read_file`. The `bash`
tool streams live output to the UI as a **transient** data part and returns only the capped final
output (head + tail, exit code, duration) to the model.

### 6.2 Modes

| Mode | Reads in working dirs | File edits | Shell | Ask-type actions |
|---|---|---|---|---|
| `default` | allowed | ask | read-only allowlist, else ask | ask |
| `acceptEdits` | allowed | allowed in working dirs | + `mkdir`, `touch`, `mv`, `cp` inside working dirs | ask |
| `plan` | allowed | denied (tools inactive) | read-only allowlist only | `exit_plan_mode` asks |
| `dontAsk` | allowed | only via allow rules | only via allow rules | denied |
| `bypassPermissions` | allowed | allowed | allowed | protected paths and `request_directory_access` still ask |

`Shift+Tab` cycles `default → acceptEdits → plan → default`; the mode lives in plugin state
(`ctx.state`) and is shown in the status bar. A mode change takes effect at the next step.

### 6.3 Rules and how they map onto eharness

- `rules.ts` parses `Tool` and `Tool(spec)`; tool aliases map Claude-Code-style names to ours
  (`Read` → `read_file`/`list_files`/`grep`/`glob`, `Edit` → `edit_file`/`write_file`/
  `delete_file`, `Bash` → `bash`, `Agent(name)` → `agent` with that `subagent_type`).
- Path specs use gitignore semantics via `ignore`, anchored as in the Claude Code table
  (`//abs`, `~/`, `/` = project root, relative = cwd).
- Bash specs: `parse.ts` tokenizes with `shell-quote`, splits on `&&`, `||`, `;`, `|`, `|&`, `&`,
  newline, strips `timeout`, `time`, `nice`, `nohup`, `stdbuf`, `command`, `builtin`, bare
  `xargs`, and safe leading env assignments. **Any** of `$(`, backticks, `<(`, subshell parens,
  heredocs, or a trailing operator makes the command *complex*: allow rules never match a complex
  command; deny/ask rules match any subcommand found. Redirect targets (`>`, `>>`, `tee`) are
  checked against `Edit` rules and the working directories.
- Evaluation: deny → ask → allow → mode default. Result per call: `denied` (with a reason the
  model reads), `user-approval` or `approved`.
- **eharness mapping.** The agent has **no** static `approval.policy`; the `permissions` plugin's
  `tool.approve` hook returns the decision for every call (most-restrictive-wins means a hook can
  only tighten what is otherwise allowed, and nothing else is configured, so the hook decides).
  The hook reads rules, mode and session allowances from config + `ctx.state` only: deterministic
  and side-effect free, as spec 01 §5 requires. Bare-tool deny rules and plan mode remove tools
  through `turn.prepare` / `step.prepare` `activeTools` (accepting a cache bust at mode changes).
- **Prompt answers:** *Yes* → `respond({ approvals: [{ id, approved: true }] })`; *Yes, and don't
  ask again* → the UI first adds a session allow rule (edits: the tool; bash: the command prefix
  up to the first argument, e.g. `Bash(bun test *)`; persisted to `settings.local.json` when the
  user picks "always for this project"), then approves; *No* (+ optional feedback) → approved
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
  `explore` (read-only tools; prompt asks for a thoroughness level), `plan` (read-only, used from
  plan mode). User-defined from `--agents` JSON, `<root>/.coder/agents/*.md`,
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
  Concurrency cap: 8 running children per session (a semaphore in the tool).
- **Nesting.** Depth limit 2 below the main agent (configurable); at the limit the child agent is
  built without the `agent` tool.
- **Transcripts.** Child sessions are stored like any session; `/agents` and the tree can open a
  child transcript (`messages()` of the child id). Children are closed after their final output.

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
  `prune: {}`, `models` from a bundled models.dev snapshot via `modelsDevCatalog()` for windows and
  cost (status bar shows context % and USD).
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
- [ ] README skeleton
- [ ] Commander program with print mode and the interactive entry; `config.ts` (settings + flags)
- [ ] `disk-fs.ts` + `guard.ts` passing `fileSystemConformance` on a temp dir; containment tests
      (`..`, absolute, symlink file, symlink dir, symlink swap)
- [ ] `mount-fs.ts` with `/@dirs/*` and `/.coder/tool-outputs/`
- [ ] `glob` tool; `rg` fast path for `grep` with fallback
- [ ] Agent factory with `filesystem()`, static prompt, project memory, turn reminder, toolOrder
- [ ] Ink app: transcript, tool cards, prompt input (multiline, paste, history), status bar, `Esc`
- [ ] Sessions: JSON storage, `--continue`, `--resume`
- [ ] Acceptance: with a real model, "rename function X across the project" works with partial
      edits; scripted-model e2e in print mode passes offline

### M2 — Permissions, shell, plan mode, todos

- [ ] `rules.ts` with the Claude Code example table as test cases; `parse.ts` tests
      (operators, wrappers, complex forms, redirects)
- [ ] `permissions` plugin: modes, `tool.approve`, `activeTools`, audit via `approval.decided`
- [ ] Permission prompt UI + `respond()`; "don't ask again" (session and project)
- [ ] `sandbox-local.ts` + `bash` tool (timeout, abort, live transient output, capped result,
      read-only allowlist)
- [ ] Plan mode + `exit_plan_mode`; `Shift+Tab` cycling; protected paths ask in every mode
- [ ] `todos()` plugin + todo panel; `!cmd` direct shell
- [ ] Acceptance: in `default` mode no write or non-allowlisted command runs without a prompt
      (test matrix per mode); plan mode cannot modify a file by any tool

### M3 — Subagents

- [ ] Built-in definitions; loader for `--agents`, project and user `agents/*.md`
- [ ] `agent` tool: child session, parent link, abort, usage, progress generator, final output
- [ ] Parallel execution with the concurrency cap; depth limit
- [ ] Child approvals: the `agent` tool answers the child's `tool-pending` through the broker and `respond()` (§6.4); prompts labelled with the child name
- [ ] Subagent tree UI; open a child transcript from `/agents`
- [ ] Acceptance: "explore how X works in three areas" runs three `explore` children in parallel,
      the parent's context gets only their reports; a user-defined `reviewer` agent with
      `tools: read_file, grep` cannot call `bash` (test)

### M4 — Long sessions and polish

- [ ] Compaction + prune + evict tuned; `/compact`, `/cost`, `/clear`, `/model`, `/permissions`,
      `/agents`, `/init`, `/todos`
- [ ] `@path` completion; `Ctrl+O` expand; diff view in prompts and cards
- [ ] Skills from `.coder/skills/` (`fsSkillSource` on the workspace fs)
- [ ] Acceptance: a two-hour session survives compaction and a process kill (`--continue`)

### M5 — Stretch

- [ ] MCP servers from settings (`mcpServer`, risk per server)
- [ ] OS sandbox driver for `bash` (macOS `sandbox-exec`, Linux `bubblewrap`) behind the sandbox
      interface; network off by default
- [ ] `bun run compile` single binary; smoke-run it outside the repo
- [ ] Docs: guide page `docs/guides/coding-agent.md` walking through the example

## Acceptance criteria

- [ ] All milestone acceptance items above
- [ ] `examples/coder` lint and typecheck clean; its tests run offline with `scriptedModel`
- [ ] Root `bun run lint && bun run typecheck && bun test` stay green (the example does not break
      the library gate)
- [ ] No import from `src/**` internals: only `eharness`, `eharness/*` subpaths (same rule as
      shipped plugins)
- [ ] Every library gap found is written under [Requests to the library](#requests-to-the-library)
- [ ] Only one changeset, empty, for the root `workspaces` field (§2.1); nothing in `src/` changes
- [ ] `bun install --frozen-lockfile` works from a clean clone (workspace and lockfile agree)

## Requests to the library

Gaps this example works around; each becomes a roadmap row or a phase with a spec.

| # | Request | Workaround in P30 |
|---|---|---|
| R1 | **Nested approvals across processes**: park the parent turn while a child session waits for an approval, resume both later from any instance | the `agent` tool awaits the child's approvals in process (§6.4) |
| R2 | `edit_file` with several edits in one call (atomic, one read check) | the model calls `edit_file` several times |
| R3 | `glob` tool in `eharness/filesystem` (uses `list`, adapter fast path) | app tool |
| R4 | Node-only `eharness/filesystem/node` disk adapter with the containment rules of §5 (ADR: first Node-only module) | `examples/coder/src/workspace/disk-fs.ts` |
| R5 | Pass `experimental_sandbox` through to `streamText` / tools; a shell plugin over `Experimental_SandboxSession` (roadmap "Sandbox plugin") | sandbox held in a closure |
| R6 | `eharness/subagent` helper (child session, progress, usage, depth, cleanup) | `agents/agent-tool.ts` |
| R7 | Rule-based grants (`Bash(git *)`) in core approvals (roadmap row) | rules in the app plugin |
| R8 | `addUsage` accepting the eharness `TurnResult.usage` shape directly | a conversion helper |
| R9 | Binary files / images in `FileSystem` (screenshots, PDFs) | text only |

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
- Bun module resolution (`tsconfig` `paths`, export conditions): https://bun.com/docs/runtime/module-resolution
- Local probes (2026-10-08, Bun 1.4.2, `@changesets/cli` 3.0.3): root as a workspace dependency, `paths` through `extends`, `changeset version` / `status` with a private workspace
