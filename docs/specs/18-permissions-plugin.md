# Spec 18 — Permissions (`eharness/permissions`)

Status: **Draft (0.7)**. Module: `src/permissions/*`. Built only with the public core API
(ADR-0008). Design: [ADR-0034](../decisions/0034-deployment-profiles.md). Promoted from the coder
example's proven permission system (`examples/coder`).

A rule engine that decides every tool call — approve, ask a person, or deny with a reason the
model reads — plus a plugin that wires it onto the core's approval chain (spec 11 §3). It is
policy only: it never asks anyone itself. Asking is the core's `tool-pending` + `respond()` flow,
so the same engine serves all three deployment profiles (§9).

## 1. Usage

```ts
import { createPermissionEngine, permissions } from 'eharness/permissions'

const engine = createPermissionEngine({
  roots: () => [{ virtual: '/', real: '/work/proj' }],   // what the file tools address
  home: '/home/me',
  mode: 'default',
  rules: { allow: ['Bash(bun test *)', 'Edit(src/**)'], deny: ['Read(~/.ssh/**)'] },
  protectedPaths: ['.git', '.app/settings*.json'],
})
defineHarnessAgent({ model, plugins: [filesystem({ fs }), permissions({ engine })] })
```

```ts
export interface PermissionEngineOptions {
  roots: () => readonly PermissionRoot[]               // read on every decision
  home?: string                                         // required by rules that use `~/`
  mode?: PermissionMode                                 // default 'default'
  rules?: Partial<PermissionRules>
  protectedPaths?: readonly string[]                    // default ['.git']
  builtinAsk?: readonly string[]                        // default ['Read(.env*)', 'Read(**/.env*)']
  readOnlyCommands?: 'default' | readonly string[]      // default 'default'
  toolKinds?: ToolKinds                                 // merged over DEFAULT_TOOL_KINDS
  aliases?: Record<string, readonly string[]>           // merged over DEFAULT_ALIASES
  modeCycle?: readonly PermissionMode[]                 // default ['default','acceptEdits','plan'], see modeCycleFor
  classifier?: AutoClassifier                           // enables `auto` mode, §12
  realpath?: (real: string) => Promise<string | undefined>   // symlink-aware matching in decideAsync, §5
  persist?: (rules: PermissionRules, change: RuleChange) => void | Promise<void>
}

export interface PermissionEngine {
  readonly mode: PermissionMode
  setMode(mode): void;  cycleMode(): PermissionMode;  subscribe(listener): () => void
  decide(call: PermissionCall, mode?: PermissionMode): PermissionDecision
  decideAsync(call, options?: DecideOptions): Promise<PermissionDecision>   // decide + the auto classifier (§12)
  autoAvailable: boolean;  autoState(): AutoState;  noteApproval(toolCallId?);  resumeAuto();  subscribeAuto(listener): () => void
  suggestRule(call): string | undefined;  grantScope(call): string | null | undefined   // §7
  allow(rule): Promise<void>;  addRule(kind, rule): Promise<void>;  removeRule(kind, rule): Promise<boolean>
  rules(): PermissionRules
  inactiveTools(mode?, toolNames?): string[]
  readBlocked(virtualPath): boolean
  kindOf(tool): ToolKind;  toolsOfKind(kind): string[];  toolSpec(tool);  expandRuleTool(ruleTool)
  modeBeforePlan();  setPlanExitMode(mode);  planExitMode();  leavePlanMode()
}

export function permissions(opts: PermissionsOptions): HarnessPlugin<'permissions'>
export function isReadOnlyCommand(command: string, filter?: ReadonlySet<string>): boolean
export function matchRule(rule: string, call: PermissionCall, options: MatchRuleOptions): boolean
```

Also exported: `parseRule`, `domainSpecifierMatches`, `DEFAULT_TOOL_KINDS`,
`DEFAULT_PROTECTED_PATHS`, `DEFAULT_MODE_CYCLE`, `PERMISSION_MODES`, `DONT_ASK_REASON`,
`PLAN_MODE_REASON`, `AUTO_PAUSED_REASON`, `modeCycleFor`, `modelClassifier`,
`ClassifierUnavailableError` and the types. The command tokenizer (`parseCommand`), the rule
matching helpers for shell specifiers, the read-only grammar tables, the default aliases,
`DEFAULT_BUILTIN_ASK` (values in the options above), the auto-pause limits and the classifier
instructions are internal.

`decide` is **deterministic and free of side effects** (the core calls `tool.approve` again for
approved calls, spec 11 §3). The engine holds three pieces of mutable state: the rules, the mode
and the plan-exit bookkeeping; none changes during `decide`.

Invalid options throw `EH_CONFIG_INVALID` from `createPermissionEngine`: an unparsable initial
rule (an inert deny rule would be a hole), a rule using `~/` without `home`. `addRule` / `allow`
throw the same way for the rule they are given.

## 2. Rules

A rule is `Tool` or `Tool(specifier)`. The tool part is an **alias** or a tool name (including
`mcp__server__tool`). A rule without specifier covers the whole tool.

| Rule | Matches |
|---|---|
| `Bash(bun test *)` | shell commands (§5). `*` is any text; a trailing ` *` also matches the bare command; `:*` at the end is the same as ` *` |
| `Read(.env*)`, `Edit(src/**)` | the path of a read/write tool, **and** the paths a shell command reads (`Read`) or redirects to (`Edit`) |
| `WebFetch(domain:example.com)` | the host of the URL; `domain:*.example.com` its subdomains |
| `Agent(name)` | the `subagent_type` (field configurable) of an agent tool; `*` wildcard |
| `mcp__srv__tool` | that tool, any input |

**Path specifiers** are gitignore patterns evaluated against the real path of the target:
`//abs/path` absolute; `~/x` under `home`; `/x` and `./x` and `a/b` anchored at the project root
(the root mounted at `/`); a pattern **without a slash** (`.env*`, `secrets`) matches at any
depth in the project root **and inside every other root**. A trailing `/` matches directories
only; `**` any number of directories; negations (`!`) never un-match. `*` and `?` do match a
leading dot (they are gitignore patterns, not shell globs). They are compiled by the shared core
compiler (`compileGitignorePattern`, options `dot`, `gitignore`, `caseFold`) that also serves the
`glob` tool, `diskFs` ignore files, OpenAPI path filters and provider model filters; consecutive
`**` collapse and a pattern with more than 4 `**` segments or 8 `*` wildcards is not compiled
(an uncompilable rule never matches; invalid initial rules throw as before). Trailing spaces of a
case-insensitive pattern are dropped like in the case-sensitive one.

**Aliases** (`DEFAULT_ALIASES`): `Read` = every tool of kind `read`; `Edit` and `Write` = kind
`write`; `Bash` = kind `shell`; `WebFetch` = `fetch`; `WebSearch` = `search`; `Agent` = `agent`.
They follow the tool map (§3), so a custom read tool is covered by `Read(...)` rules. Configure
more with `aliases: { Docs: ['kind:read', 'my_tool'] }` (`kind:<kind>` or tool names).

**Polarity.** An *allow* rule is strict: for `Bash` it must match **every** subcommand and never
matches a complex command (§5). *Deny* and *ask* rules match when **any** subcommand (or the raw
command, or any inner `$(...)`) matches.

**Precedence** (first hit wins), see §4 for the full order: deny > (plan gate) > protected paths >
ask > allow > built-in ask > mode default.

`suggestRule(call)` offers a rule for "don't ask again": `Bash(prog sub *)` for ordinary
programs, the exact command for interpreters, shells and wrappers (`bash -c`, `python3 -c`, `env`,
`sudo`, `xargs`, `bun`, `node`, …), flags as second word and `git config`; `Edit` for writes;
`WebFetch(domain:host)`; `WebSearch`; the tool name otherwise. None for compound or complex
commands, commands with `*`, protected paths, the plan-exit and ask tools.

`persist(rules, change)` is called with a copy of the stored rules and the change
`{ op: 'add' | 'remove', kind: 'allow' | 'ask' | 'deny', rule, scope: 'session' | 'project' }`
after `allow(rule, scope?)`, `addRule(kind, rule, scope?)` and `removeRule` changed the in-memory
rules; the returned promise is what those methods return. The library stores nothing. `scope`
defaults to `'project'`. A rule added with scope `'session'` takes effect at once but is not
stored: `persist` is not called and later copies leave it out (adding it again at `'project'`
scope promotes it). `removeRule` of a session rule does not call `persist` either. 

## 3. Tool map

The engine does not know tool names; it knows **kinds**:

```ts
type ToolKind = 'read' | 'write' | 'shell' | 'fetch' | 'search' | 'agent' | 'ask' | 'plan-exit' | 'safe' | 'other'
interface ToolKindSpec {
  kind: ToolKind
  pathField?: string | readonly string[]   // read/write: virtual path field(s), first present wins
  defaultPath?: string                      // read: used when the field is absent ('/' for list/grep/glob)
  commandField?: string                     // shell, default 'command'
  urlField?: string                         // fetch, default 'url'
  nameField?: string                        // agent, default 'subagent_type'
  listing?: 'grep' | 'list' | 'paths'       // read: how to find paths in the text output (§8)
  alwaysAsk?: boolean                       // every mode asks, see below
}
```

`DEFAULT_TOOL_KINDS` describes eharness's own tools: `read_file`, `list_files`, `grep`, `glob`
(read), `edit_file` (including `edits[]`; only `path` matters), `write_file`, `delete_file`
(write), `bash` (shell, `eharness/shell`), `bash_output`, `kill_shell`, `todo_write`, `agent_output`, `agent_stop` (safe),
`memory_view`, `memory_create`, `memory_str_replace`, `memory_insert`, `memory_delete`, `memory_rename` (safe: `eharness/memory` confines them to the agent's own memory roots, not the project, so they are approved in every mode including `plan`; use `toolKinds` to make them `write` or `alwaysAsk` when notes need approval),
`web_fetch`, `web_search`, the core tools `tool_search`, `load_skill`, `read_skill_file`, `search_skills` (safe, so deferred tools stay discoverable in `plan` mode), `agent`, `send_message` (safe: it only reaches agents that already run under the same rules, ADR-0038), `ask_user_question`, `exit_plan_mode`. A tool the map does not
know is `other`. Pass `toolKinds` to add or override (`{ run: { kind: 'shell', commandField: 'cmd' } }`).

**`alwaysAsk: true`** (any kind except `ask`/`plan-exit`): the tool's calls are `user-approval` in
every mode including `bypassPermissions`, no allow rule approves them (and `suggestRule` offers
none), `dontAsk` turns the ask into a denial (`DONT_ASK_REASON`) and deny rules still deny. Use it
for tools that must always involve a human (directory access, payments, deploys). Autonomous
servers (profile a) run in `dontAsk`, so such tools are denied there.

| Kind | default / acceptEdits / bypass | plan | dontAsk |
|---|---|---|---|
| `read` | approved (path must be inside a root) | approved | approved |
| `write` | ask / approved / approved (read-only root: denied) | denied | ask becomes denied |
| `shell` | §5 | read-only commands only | ask becomes denied |
| `fetch`, `search` | ask / ask / approved | ask | denied |
| `agent`, `safe` | approved | approved | approved |
| `ask` | approved, never gated by ask rules | approved | approved |
| `plan-exit` | denied outside plan mode; asks in plan mode | asks | denied |
| `other` | ask / ask / approved | denied | denied |

## 4. Modes and evaluation order

| Mode | Meaning |
|---|---|
| `default` | reads free; writes, shell and unknown tools ask |
| `acceptEdits` | file edits free; shell `mkdir`/`touch`/`mv`/`cp` inside writable roots free |
| `plan` | read-only: no writes, no shell except read-only commands; ends through the plan-exit tool |
| `dontAsk` | never asks: every would-be ask is a denial (`DONT_ASK_REASON`) — the autonomous allow-list mode |
| `bypassPermissions` | everything approved except deny rules, protected paths and "a deny rule could match" (§5) |
| `auto` | like `acceptEdits`, but what no rule or read-only check settles goes to a classifier model that allows it or blocks it (§12). Needs the engine's `classifier` |

`decide(call, mode?)` evaluates, first hit wins:

1. **deny rules** (also `Edit` deny rules against redirect targets and `Read` deny rules against
   the paths a read-only command reads), in every mode.
2. `ask` kind → approved. `plan-exit` → denied outside plan mode, ask in plan mode.
3. **plan gate**: in `plan`, only kinds `read`, `search`, `fetch`, `agent`, `ask`, `safe` and read-only
   shell commands go on; everything else is denied with `PLAN_MODE_REASON`.
4. **protected paths**: a write (or shell redirect) target matching `protectedPaths` asks **in every
   mode, bypass included**; so does a non-read-only shell command whose *text* mentions the first
   segment of a protected pattern (`rm -rf .git`, `cd .git && …`). An allow rule never unprotects.
5. a directory or glob read by a command that a deny rule *could* match asks, even in bypass.
6. **ask rules** (not in bypass), then the same coverage check for ask rules.
7. **allow rules**. An allow rule never approves a shell command that redirects or `tee`s outside the
   writable roots or to a path it cannot resolve; it asks instead.
8. **built-in ask rules** (`builtinAsk`, default `Read(.env*)`): asks unless an allow rule names the
   path. Not in bypass. A directory read recursively (`grep -rn x src`) is **not** covered by the
   built-in ask (it would make every recursive grep prompt); a glob that could name env files
   (`cat .e*`) and explicit paths are. User `Read` rules cover subtrees (steps 5, 6).
   **Recursive reads are lexical unless the engine gets `containsProtected`** (§5): without it a
   recursive `grep`/`rg`/`find -exec` through `bash` can read `.env` files without asking. With it,
   `decideAsync` looks into the directory: a `Read` deny rule match denies (checked with the deny
   rules, step 1), a built-in ask or protected-path match asks here (an allow rule overrides it
   like it does for an explicit read; not in bypass).
9. **mode default** (§3).

A per-call mode (`decide(call, 'plan')`) replaces the engine's mode; the engine's own `dontAsk`
still turns asks into denials, so a global allow-list cannot be loosened by a per-agent mode.

`inactiveTools(mode?, toolNames?)`: in plan mode every `write` and `other` tool (and, with
`toolNames`, every tool the map does not know); in every other mode the `plan-exit` tool; plus
every tool a rule without specifier denies. The plugin hides them with `activeTools`.

`setMode('plan')` remembers the previous mode (`modeBeforePlan()`); `leavePlanMode()` returns the
mode chosen with `setPlanExitMode('acceptEdits' | 'default')`, else the remembered one.
`cycleMode()` follows `modeCycle`; from a mode outside the cycle (`dontAsk`, or `auto` when it is not
in the cycle) it goes to the first, `default`. `modeCycleFor({ bypass, auto })` builds the cycle the way
Claude Code does: `default`, `acceptEdits`, `plan`, then `bypassPermissions` (when `bypass`), then
`auto` (when `auto`), last. `dontAsk` is never in a cycle, and `auto` is dropped from `modeCycle`
when the engine has no classifier. Deciding which optional modes the user may reach (flags,
settings) is the application's: it passes the result as `modeCycle`.

## 5. Shell commands (threat model)

The model — or a prompt injection steering it — chooses the command line. Everything below is
**text analysis**; nothing here runs a command. When in doubt the analysis refuses (asks).

**Parsing** (an own tokenizer: no dependency). Words, single/double quotes, backslash
escapes, comments (to end of line), operators `&& || ; | |& & ( ) < > >> >& &> …` and newlines.
Result: `subcommands` (wrappers stripped, whitespace normalised), `redirects` (`>`, `>>`, `2>`,
`&>`, `tee` arguments), `inputs` (`<` targets), `xargs` and `complex`.

- Stripped wrappers: `time`, `nohup`, `noglob`, `timeout <n>`, `nice [-n x]`, `stdbuf <opts>`,
  `command`, `builtin`, bare `xargs` (recorded: its arguments come from stdin) and safe env
  assignments (`NODE_ENV`, `CI`, `FORCE_COLOR`, `NO_COLOR`, `LANG`, `LC_ALL`, `TZ`, `DEBUG`, `TERM`,
  `COLORTERM`). Any other `VAR=x cmd` keeps its assignment (it changes what the command does).
- **complex** (never allowed or auto-approved): `$(…)`, backticks, `$'…'`, `$"…"`, subshells and
  groups, process substitution, heredocs, control flow keywords, `;;`, a dangling or leading binary
  operator, an unterminated quote, a redirect without a word target, no command at all. For a complex
  command the contents of `$(…)` / backticks are **also** surfaced as subcommands (nested to depth
  3), so deny and ask rules see them.
- A comment ends at the newline, so a command after it is still parsed.

**Deny and ask normalisation.** Only deny and ask rules (and the
built-in asks) match a second, normalised view of each subcommand; allow rules never do, so this
cannot widen an approval. The extra forms: a leading `!` and control keywords dropped; every
`VAR=x` assignment dropped; an absolute or relative program path reduced to its name (`/bin/rm`,
`./rm` → `rm`); git global options removed before the subcommand (`-C <dir>`, `-c k=v`,
`--no-pager`, `--git-dir=…`, `--work-tree=…`, …); the wrappers `sudo`, `doas`, `env`, `exec`, `nice`,
`timeout <n>`, `nohup`, `command`, `builtin`, `time` looked through; and the payload of
`sh|bash|zsh|dash|ksh -c '<payload>'` and `eval '<payload>'` parsed with the same parser and matched
the same way (nested to depth 4). A payload that cannot be parsed (empty, no command) makes the
call ask when any deny or ask rule exists. So `deny: ['Bash(rm:*)', 'Bash(git push:*)']` denies `! rm x`,
`/bin/rm x`, `sudo rm x`, `env A=1 rm x`, `sh -c "rm -rf /"`, `git -C . push`, `git --no-pager push`
and `git -c x=y push`. `busybox <applet>` and the commands after `find … -exec|-execdir` (and `xargs`) are looked through too. Still best-effort: an aliased or renamed binary,
a script that runs the program, or a variable-built command name are not seen.

**Read-only commands** (`isReadOnlyCommand`). Auto-approved (default, plan, acceptEdits; bypass skips
the path checks) only when the whole line is: not complex, no redirect except to `/dev/null`, and
every subcommand accepted by its **argument grammar**. A grammar is an allow-list — accepted flags
exactly as written (GNU abbreviations such as `--ou` are not accepted), which take a value, how many
positionals and what each is. A deny-list always loses to a flag nobody thought of (`sort -oFILE`,
`find -fprint0`, `uniq in out`).

| Command | Accepted | Refused (examples) |
|---|---|---|
| `ls du df stat realpath pwd` | display flags, paths | unknown flags |
| `cat head tail wc file cut` | counting/format flags, `-n N`, files | `tail -f`, `file -C`, `wc --files0-from` |
| `sort` | ordering flags, `-k -t -S`, files | `-o*`, `--o*`, `--output`, `-T`, `--compress-program` |
| `uniq` | display flags, at most ONE file | `uniq in out` (the 2nd is the output) |
| `grep` | match flags, `-e`, `-A/-B/-C/-m`, `--include` | `-f FILE`, `--exclude-from` |
| `rg` | match flags, `-g`, `-t`, `-A/-B/-C/-m` | `--pre`, `--pre-glob`, `--hostname-bin`, `-z`, `-f` |
| `find` | tests and `-print*`/`-ls`/`-printf` | `-exec* -ok* -delete -f*`, `-files0-from` |
| `git` | `status log diff show rev-parse ls-files blame`, `branch -a/-r/-v/--list`, `remote -v` | `--output`, `--ext-diff`, `--textconv`, `--contents`, `-c`, `-C`, mutations |
| `echo tr which basename dirname whoami true false` | text arguments | any `$` expansion or backtick |
| `node bun` | `--version` / `-v` | everything else |

`readOnlyCommands: ['ls', 'git']` restricts the list to those names; `[]` disables auto-approval. `tree` is not on the list (`-o FILE` writes). Residual limit:
a repository's own git config (`diff.external`, textconv drivers, pager) can run programs for
`git diff|log|show`.

**Path containment.** A read-only command's path arguments (and `<` targets) are resolved
**lexically** against the project root (`..` collapsed, `~/` from `home`, absolute paths as is). It
auto-approves only if every path is inside a *working directory* (a root with `workingDir !== false`)
and none is unresolvable: `$` expansion in any argument, `~user`, brace expansion, `xargs` stdin.
Outside paths ask. `Read` deny/ask rules (and the built-in `.env` ask, for explicit paths and globs
only) are matched against the paths: a deny match denies, an ask match asks. A **directory read recursively** (`grep -r KEY .`,
`rg KEY`) or a **glob** (`cat .e*`) covers its subtree: if any user `Read` deny/ask rule *could* match
something there, the command asks. Matching is lexical unless the engine gets the **`realpath`
option** (`nodeRealpath` from `eharness/filesystem/node`): then `decideAsync` also resolves the
file tools' paths and the path words of a shell command through symlinks. Protected paths and
`deny`/`ask`/built-in rules match the lexical **or** the resolved path (so a committed `g -> .git` or
`x -> .env` keeps its protection); an `allow` rule must match both. `decide` (sync) and adapters
without a resolver stay lexical; a file system adapter that exposes symlinks must still enforce its
own path guard (spec 08).

**Recursive reads and `containsProtected`.** The engine cannot list directories (core is
runtime-neutral), so a directory read recursively is judged lexically: a user `Read` deny/ask rule
that could match something below it asks, but the built-in `.env*` ask and the protected paths do
not (they would make every `grep -r` prompt). The optional `containsProtected(realDir, patterns)`
option closes this: `decideAsync` calls it for every directory a command reads recursively and acts
on the answer. The directories are found per command: the read-only grammar's recursive commands
(`grep -r/-R/--recursive`, `rg`; default `.`, an explicit file argument is not a directory read) and
the commands outside it that recurse (`ag`, `ack`, `find` with `-exec`/`-execdir`/`-ok` unless
`-maxdepth 0|1`, `cp -r|-a`, `rsync -r|-a` (sources), `tar`, `zip -r`). `patterns` are gitignore-style:
the relative specifiers of the `Read` deny rules (one call), then the built-in ask specifiers plus
`protectedPaths` (a second call); when the deny call matches, the deny rule is found by asking per
rule. `true` means "something below `realDir` matches": a deny match makes the call `denied`, the
other match makes it `user-approval`. A rejection counts as `true` (fail closed), a command with
more than 8 such directories asks without looking, and `decide` (sync) never calls it. Implementations
must fail closed when they give up: `nodeContainsProtected` (`eharness/filesystem/node`) walks the
tree breadth first, never follows symlinks, honours no `.gitignore` (a `.env` in `node_modules` still
matches) and answers `true` when it exceeds 32 levels, 50 000 entries or 2 s. A `.git` directory is
a protected path, so with the default `protectedPaths` a recursive `grep -r` from a repository root
asks; narrow it with `--exclude-dir=.git`-style commands, an allow rule (`Bash(grep *)`) or a
smaller `protectedPaths`.

**Deny rules are best effort.** The normalised view looks through `sudo`, `doas`, `env`, `exec`,
`nohup`, `command`, `builtin`, `time`, `nice`, `timeout`, `xargs [flags]`, `find … -exec|-execdir|-ok
… ;|+`, `busybox`, `setsid`, `flock <file>`, `sh|bash|… -c` and `eval`. It cannot see through an
interpreter (`python -c`, `node -e`, `perl -e`, `ruby -e`, `php -r`) or a script: an allow rule with
a wildcard (`Bash(python3 *)`) never approves a command that runs inline interpreter code, it asks
(only an exact, wildcard-free rule approves it). The **OS sandbox (spec 19 §6) is the real
boundary**; rules, protected paths and the read-only grammar are guard rails for the common cases.

**Session grants and suggested rules** (`grantScope`, `suggestRule`) are scoped to `prog sub` but
never cover a high-risk flag: `--force*`, `-f` of `git push`, `--hard`, `--privileged`, `--mount`,
`--pid|net|network|ipc|userns=host`, `-v|--volume` of an absolute path, `rm` with `-r/-R/-f`. A
command carrying one gets no grant (`grantScope` returns `null`, so it asks every time) and only an
exact rule is suggested.

**acceptEdits** additionally approves `mkdir`, `touch`, `mv`, `cp` whose paths are inside writable
roots, outside protected paths, with no `-t`/`--target*`/`--`, no `$`, no redirect.

## 6. Protected paths

`protectedPaths` are gitignore patterns relative to each root (default `['.git']`). A tool write, or
a shell redirect, to a match asks in every mode. Applications add their own state
(`'.myapp/settings*.json'`). A shell command mentions a protected pattern when its first literal
segment appears as a word (`.git`, not `.gitignore`, not `foo.git`).

Matching is **case-insensitive and Unicode-NFC** for everything that can only restrict: protected
paths and their shell-text search, the built-in `Read(.env*)` ask, and user `deny` / `ask` rules
(macOS and Windows file systems ignore case, so `.GIT/hooks/x` and `.ENV` name the real files).
Trailing dots and spaces of a path segment are ignored (`.git.`, `.git ` are `.git` on Windows).
It is the same on every platform: a false match costs one question. `allow` rules stay exact, so a
case variant never inherits an allow. A new protected name needs no case variants. The shell-text search (a command mentioning a protected
name) also catches `.git.`, `.git /config`, `".git /config"` and Unicode forms that normalise to the
name (NFC), so `cp x .git./config` asks.

## 7. The plugin

`permissions({ engine, mode?, allowedTools?, disallowedTools?, planExitTool?, filterOutputs?, onDecision?, onPlanExit? })`
(name `permissions`). Hooks and contributions:

| Where | What |
|---|---|
| `tool.approve` | `await engine.decideAsync(...)` (the classifier of `auto` mode runs here, with the event's `toolCallId`, restricted `transcript()` and the turn's abort signal) → `{ type: 'approved' }`, `{ type: 'user-approval', reason? }`, `{ type: 'denied', reason }`. Combines with other hooks, policy and grants by "most restrictive wins" (spec 11 §3) |
| `tool.grantScope` | `engine.grantScope(call)`: for a shell-kind tool the command prefix (`git commit` for `git commit -m x`; the prefix `suggestRule` offers), `null` for a wrapper/interpreter/shell program, a compound or complex command, a redirect or a protected path (never remembered), `undefined` for other tools (spec 11 §3.1) |
| `step.prepare` | `activeTools`: drops `inactiveTools`, `disallowedTools`, and everything outside `allowedTools` (names or aliases). A mode change takes effect at the next model call. When the plan-exit tool was just approved (`e.continuing`), the next step already offers the tools of the mode being entered |
| `tool.after` | `filterOutputs` (default true): lines of `grep`/`list_files`/`glob` output (per the tool's `listing`) whose path `readBlocked` reports are dropped and counted: `(N results hidden by permission rules)` |
| `approval.decided` | a person's approval (`by: 'user'`, approved) calls `engine.noteApproval()`: a paused auto mode resumes. Then `onDecision(decision)`: every automatic decision (`by: 'plugin:permissions'`) and every answer — an audit log. Errors are `W_HOOK_FAILED` and never change a decision |
| session tool | the plan-exit tool (`exit_plan_mode`, input `{ plan }`, risk `external`) unless `planExitTool: false` or `mode` is a fixed mode. It asks in plan mode; once the user approves, it switches the engine to `leavePlanMode()` and calls `onPlanExit(mode, ctx)` |

`mode` (plugin option) overrides the engine's mode for this plugin instance: a fixed
`PermissionMode` (e.g. a read-only subagent: `'plan'`; no plan-exit tool is registered then) or a
function `(ctx) => PermissionMode | undefined` evaluated at every decision, for a deployment where
the mode lives in storage (§9c). It must be deterministic.

## 8. Output filtering

A `read` rule hides what the approval alone cannot: `grep`, `list_files` and `glob` are approved on
a directory, so their *output* is filtered. `readBlocked(virtualPath)` is true when a `Read` deny or
ask rule matches the path (the built-in `.env` ask included, unless an allow rule names the path).
`read_file` itself is gated by the approval and shell reads are covered at approval time (§5);
this stage only covers the listing tools.

## 9. The three deployment profiles

The engine and plugin never wait for a person; the profiles differ in who answers an ask.

**(a) Autonomous server.** Nobody to ask. Either `mode: 'bypassPermissions'` with deny rules and
protected paths as the safety net, or — recommended — `mode: 'dontAsk'` with a fixed allow-list:

```ts
createPermissionEngine({
  roots: () => [{ virtual: '/', real: '/srv/work' }],
  mode: 'dontAsk',
  rules: { allow: ['Edit(reports/**)', 'Bash(git status *)', 'WebFetch(domain:api.example.com)'] },
})
```
Everything outside the list is a denial the model reads (`DONT_ASK_REASON`) and can adapt to; the
turn never goes `tool-pending`. Combine with budgets, the progress guard and a sandboxed shell.

**(b) Single-process CLI.** The user switches modes live: `engine.cycleMode()` on a key,
`engine.subscribe(render)` for the status line, the in-process approval UI answers `respond()`.
"Don't ask again" calls `engine.suggestRule(call)` then `engine.allow(rule)`; `persist` writes
the project settings file. `setPlanExitMode('acceptEdits')` records the user's choice when
approving a plan.

**(c) Split web/server.** `tool.approve` stays a deterministic function of (rules, mode, call), so
any instance decides the same way after a restart. Approvals surface as `tool-pending`; the
browser answers through `respond()` (spec 11 §4). The rules and the mode are application state:
load them into the engine at request time (`createPermissionEngine({ rules: await loadRules(tenant), mode })`,
engines are cheap) or pass `permissions({ mode: (ctx) => modes.get(ctx.session.id) })`. Store
a remembered answer with `persist` or from `suggestRule`; store the continuing mode from
`onPlanExit`. A user's session-level "always allow" is the core's `remember: 'session'` grant (spec
11 §3.1), which this module does not duplicate.

## 12. Auto mode (Draft)

> **Draft / experimental (0.7).** The `auto` mode, the `classifier` option, `modelClassifier()` and
> the auto-pause counters may change in a minor release
> ([API stability](../engineering/api-stability.md)).

Modelled on Claude Code's auto mode: a classifier model reviews the actions no rule settles, so
the person is not asked for every shell command and the model still cannot do the dangerous
things without a human. `auto` is a `PermissionMode` and needs `classifier` in the engine options:

```ts
type AutoClassifier = (action: AutoAction, ctx: AutoClassifierContext) => Promise<AutoVerdict> | AutoVerdict
interface AutoAction { toolName; input; kind: ToolKind; summary?: string /* command or URL */; agent?: string }
interface AutoClassifierContext { transcript: readonly GuardTranscriptEntry[]; abortSignal?: AbortSignal; coordinator?: JudgeCoordinator; toolCallId?: string; risk?: string }
interface AutoVerdict { decision: 'allow' | 'block'; reason?: string }
```

**Availability.** Without a classifier `auto` is unavailable: `createPermissionEngine({ mode: 'auto' })`
and `setMode('auto')` throw `EH_CONFIG_INVALID`, `auto` is filtered out of the cycle, and a per-call
or per-plugin `mode: 'auto'` asks a person (it never approves). `engine.autoAvailable` tells UIs.

**Decision order** in `auto` (the §4 order up to the mode default is unchanged, with the changes
marked):
1. deny rules → denied. 2. plan-exit / `ask` kinds as before. 3. `alwaysAsk` tools and protected
paths → ask a person (Claude Code sends protected-path writes to its classifier; we keep a human
there, the conservative choice). 4. ask rules and built-in ask rules → ask a person. 5. allow rules
→ approved **without** the classifier, except broad ones that approve arbitrary code (bare `Bash`,
`Bash(*)`, wildcarded interpreters/wrappers such as `Bash(python*)`, `Bash(bash *)`), which are
ignored in `auto` as in Claude Code; narrow rules (`Bash(bun test *)`) stay. 6. mode default:
reads, writes inside writable roots, read-only shell commands (paths inside the working
directories) and `mkdir`/`touch`/`mv`/`cp` of `acceptEdits` → approved; `agent`, `ask`, `safe` →
approved; everything else (other shell commands, `fetch`, `search`, `other`, a read-only command
reading outside the working directories) → **classify**.

`decide()` stays deterministic and sync: it returns `{ status: 'user-approval', auto: 'classify' }`
for a call that needs the classifier. `decideAsync(call, { mode?, toolCallId?, transcript?, abortSignal? })`
runs it:
- `allow` → `{ status: 'approved', auto: 'allowed' }`; resets the consecutive-block counter.
- `block` → `{ status: 'denied', auto: 'blocked', reason }`. The reason ("Auto mode blocked this
  action: …") reaches the model as the tool result, so it can choose another way; the block is counted.
- A classifier verdict `ask` (`AutoVerdict.decision`) is neither allow nor block: a person decides (no counter). `modelClassifier` returns it when the action summary exceeds 2000 characters or the input exceeds `maxCallChars` (default 8 000, the same option and default as `guard()`; `maxContext.maxChars` bounds the transcript only): the judge never sees a truncated action (fail closed).
- A classifier that throws, or returns something unreadable → blocked with a reason
  (**fail closed**) and counted.
- A classifier that **could not run** (it throws `ClassifierUnavailableError`: provider error, no
  credits, timeout, network; `modelClassifier` does this for every failed `generateText`) →
  `{ status: 'denied', auto: 'unavailable', reason }`, still fail closed, but **not a block**: it
  does not touch the counters (so an outage never pauses auto mode) and `subscribeAuto` gets an
  `unavailable` event (`toolName`, `reason`, `state`) instead of `blocked`.
- A call a person approved (`approval.decided`, `by: 'user'`, approved; or `noteApproval(toolCallId)`)
  is never classified again: AI SDK re-validates approved calls in the `respond()` continuation, and
  a classifier verdict (or outage) there would deny what the person just allowed (ADR-0055).
- The verdict is remembered per `toolCallId` (AI SDK re-validates approved calls): the classifier
  runs once and counts once. If the engine's mode left `auto` while the classifier ran, the verdict is
  dropped and the new mode decides (usually an ask).
- `dontAsk` (global) still turns what would be an ask into a denial; the classifier is not called.

**With an approval guard (one call).** The permissions plugin passes `judgeCoordinator(ctx.signal)`,
the `toolCallId` and the tool risk to `decideAsync` (`DecideOptions.coordinator`, `risk`) and on to
the classifier (`AutoClassifierContext`). `modelClassifier()` uses them to judge a call together
with the session's `guard()` in one model call when both use the same model and limits (spec 15
§7). The engine only sees the auto half: `allow`/`block`/`ask` and the counters behave exactly as
with a separate classifier; the guard's objection reaches the call through the guard's own
`tool.approve` answer (most restrictive wins), so auto allow + guard deny is denied with the guard
reason and auto allow + guard ask asks a person. The classifier cache is bypassed for combined
calls. Paused auto mode, `bypassPermissions`, rule-settled calls and other models: no combining.

**Fallback (repeated blocks).** 3 blocks in a row, or 20 in total, **pause** auto mode
(fixed limits, like in Claude Code). While paused,
calls that would be classified ask a person (`auto: 'paused'`, `AUTO_PAUSED_REASON`); rules and
read-only checks work as before. A person's approval (`approval.decided` with `by: 'user'`;
`noteApproval()` for apps that answer elsewhere) or `resumeAuto()` or entering `auto` again resumes;
the consecutive counter restarts at 0, the total persists (it resets only when its own limit pauses
auto mode). In a host with nobody to answer the ask behaves like any other ask there (the turn stops
`tool-pending`, or the application's `dontAsk`-style policy denies it); the action never runs. State
and notices: `autoState(): { paused, consecutive, total }` and
`subscribeAuto(listener)` with events `blocked` (tool, reason, state), `paused` (cause), `resumed`.
The counters live in the engine instance (one per session in a CLI); the library does not persist
them.

**`modelClassifier({ model, instructions?, environment?, maxContext?, timeoutMs?, maxRetries?, maxOutputTokens?, temperature?, cache?, onModelCall? })`**
is the ready classifier: a thin wrapper over the **shared judge engine** (`createJudge` in core,
role `decide`; [ADR-0060](../decisions/0060-shared-llm-judge-engine.md), guide
[LLM judge: two modes](../guides/llm-judge.md)): one AI SDK `generateText` call with `Output.object`
(`{ decision: 'allow' | 'block', reason }`). Role `decide` is the one that may approve; the same engine
under `guard()` (spec 15) runs with role `tighten` and never approves. The engine's
verdict cache is **off** here by default (`cache: { maxEntries?, ttlMs? }` turns it on, in the
classifier's own memory): a cached allow would ignore a boundary the user states later. Its
circuit breaker is off too: the engine's pause logic above is the breaker in this mode.
The default rules are internal text (replace them through `instructions`): block downloading and
running code, sending secrets out, production deploys, irreversible destruction, force pushes;
allow routine work in the working directory; a boundary the user stated in the conversation blocks
matching actions until lifted; an explicit approval naming the action and what makes it dangerous
clears one block. `environment` describes trusted infrastructure (framed as `<environment>`). The
prompt carries the restricted transcript (spec 11 §3.4: user messages and earlier tool calls,
**never tool outputs**, so a prompt injection in a file or page cannot reach it) as a JSON array in
`<transcript>`, the call under review is left out of it, and the action (tool, kind, summary, input)
is framed as data in `<action>`; frame tags inside untrusted text are neutralised (the renderer is
shared with the guard). The call sets `maxOutputTokens` (default 1024: a verdict
is one short sentence, and a provider default of the model maximum makes gateways reserve and bill
for tens of thousands of tokens per permission decision) and `temperature` (default 0); `timeoutMs` defaults to 20 000, `maxRetries` to 1, `maxContext` to `{ maxEntries: 20, maxChars: 12_000 }` (transcript only), `maxCallChars` to 8 000 (the longest action input judged; longer asks a person); `onModelCall(record)` receives one model-call record per classification (activity logs, spec 12 §7).
Use a cheap fast model; its usage is the application's to track
(it is not charged to the turn).

Limits: the classifier is a heuristic layer, not a boundary; use deny rules for hard guarantees.
Boundaries stated in the conversation are lost if compaction removes the message that stated them.
Claude Code's per-command sandbox domains, critical-path removal checks and subagent-spawn/result
review are not part of this module.

## 10. Dropped from the example, on purpose

- `request_directory_access` (always asks, even with an allow rule) and the directory-access broker:
  app policy; model it as an `other` tool plus `roots: () => …` growing at runtime.
- Settings files (`settings.local.json`), `--add-dir`, the audit JSONL file: file I/O is the app's;
  `persist` and `onDecision` are the hooks.
- `bun test *` as a suggested prefix rule: `bun` is treated like every interpreter (exact command).
- `describeApproval` (human-readable approval titles) and the approval broker: UI concerns.
- Hard-coded tool names, `.coder` protected paths, the `/.coder/tool-outputs/` mount special case
  (modelled with `workingDir: false`).
- shell-quote and `ignore`: replaced by an in-module tokenizer and gitignore matcher. Behaviour
  differences: a comment ends at the newline; `$'…'` and `$"…"` are complex; a digit is a file
  descriptor only when attached to the redirect (`echo 2 > f` keeps `2`).

## 11. Limits

- Paths are POSIX strings; `real` is a namespace for rules and shell commands, not necessarily a
  disk. Symlinks are resolved only with the `realpath` option (§5); there is no Windows path support.
- Glob arguments of auto-approved read-only commands must stay inside the working directories:
  a glob segment that can expand to `..` (`.[.]`, `.?`, `.*`, `[.][.]`, `.[!x]`, `..*`; a segment
  starting with `*` or `?` cannot, a shell never matches a leading dot with them) makes the path
  unresolvable, so the command asks (bash <= 5.1 and macOS `/bin/bash` expand `.[.]` to `..`; 5.2+
  does not, but the guard does not depend on the shell version).
- Deny rules are **best-effort filters on the parsed command**, not a boundary. They see through
  `!`, program paths, git global options, the common wrappers and `sh -c` / `eval` payloads (§5),
  but not `busybox rm`, renamed or aliased binaries, `find -exec`, scripts or computed command
  names. Use them to remove the obvious paths; rely on the mode, the approval and the OS sandbox
  for the rest.
- A session grant (`respond({ approvals: [{ remember: 'session' }] })`, spec 11 §3.1) for a shell
  tool is scoped to the **command prefix** (`tool.grantScope`, §7): approving `git commit -m a`
  with `remember: 'session'` approves later `git commit …` calls that would ask, not `curl …`. A
  wrapper or interpreter (`sudo`, `env`, `bash -c`, `python`, `node`, …), a compound or complex
  command, a redirect, a command mentioning a protected path or one with `*` is never remembered
  (approved once, asks again). Grants of other tools stay per tool name: one approved edit makes
  every later edit of the session that would ask run unasked. A grant never overrides `denied`.
  Per-tool grants of a shell tool are ignored: the call asks again.
  Offer `remember` only where that is acceptable (`allowRemember: false` in `eharness/http`), or
  grant by rule (`persist`) instead.
- The shell analysis is a gate, not a sandbox: run the shell tool in an OS sandbox (`eharness/shell`) when
  the model is not trusted.
- A command the analysis cannot read is never approved by a rule or a grammar; it asks (or is denied
  in `plan`/`dontAsk`).
