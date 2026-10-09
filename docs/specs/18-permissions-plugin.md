# Spec 18 — Permissions (`eharness/permissions`)

Status: **Draft**. Module: `src/permissions/*`. Built only with the public core API
(ADR-0008). Design: [ADR-0034](../decisions/0034-deployment-profiles.md). Promoted from the coder
example's proven permission system (`examples/coder`).

A rule engine that decides every tool call — approve, ask a person, or deny with a reason the
model reads — plus a plugin that wires it onto the core's approval chain (spec 11 §3). It is
policy only: it never asks anyone itself. Asking is the core's `tool-pending` + `respond()` flow,
so the same engine serves all three deployment profiles (§9).

## 1. Usage

```ts
import { createPermissionEngine, permissionsPlugin } from 'eharness/permissions'

const engine = createPermissionEngine({
  roots: () => [{ virtual: '/', real: '/work/proj' }],   // what the file tools address
  home: '/home/me',
  mode: 'default',
  rules: { allow: ['Bash(bun test *)', 'Edit(src/**)'], deny: ['Read(~/.ssh/**)'] },
  protectedPaths: ['.git', '.app/settings*.json'],
})
defineHarnessAgent({ model, plugins: [filesystem({ fs }), permissionsPlugin({ engine })] })
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
  persist?: (rules: PermissionRules, change: RuleChange) => void | Promise<void>
}

export interface PermissionEngine {
  readonly mode: PermissionMode
  setMode(mode): void;  cycleMode(): PermissionMode;  subscribe(listener): () => void
  decide(call: PermissionCall, mode?: PermissionMode): PermissionDecision
  decideAsync(call, options?: DecideOptions): Promise<PermissionDecision>   // decide + the auto classifier (§12)
  autoAvailable: boolean;  autoState(): AutoState;  noteApproval();  resumeAuto();  subscribeAuto(listener): () => void
  suggestRule(call): string | undefined
  allow(rule): Promise<void>;  addRule(kind, rule): Promise<void>;  removeRule(kind, rule): Promise<boolean>
  rules(): PermissionRules
  inactiveTools(mode?, toolNames?): string[]
  readBlocked(virtualPath): boolean
  kindOf(tool): ToolKind;  toolsOfKind(kind): string[];  toolSpec(tool);  expandRuleTool(ruleTool)
  modeBeforePlan();  setPlanExitMode(mode);  planExitMode();  leavePlanMode()
}

export function permissionsPlugin(opts: PermissionsPluginOptions): HarnessPlugin<'permissions'>
export function parseCommand(command: string): ParsedCommand
export function isReadOnlyCommand(command: string, filter?: ReadonlySet<string>): boolean
export function matchRule(rule: string, call: PermissionCall, options: MatchRuleOptions): boolean
```

Also exported: `parseRule`, `matchBashSpec`, `domainSpecifierMatches`, `isReadOnlySubcommand`,
`readPathArguments`, `isGlobArg`, `READ_ONLY_COMMAND_NAMES`, `DEFAULT_TOOL_KINDS`,
`DEFAULT_ALIASES`, `DEFAULT_BUILTIN_ASK`, `DEFAULT_PROTECTED_PATHS`, `DEFAULT_MODE_CYCLE`,
`PERMISSION_MODES`, `DONT_ASK_REASON`, `PLAN_MODE_REASON`, `modeCycleFor`, `modelClassifier`,
`AUTO_CLASSIFIER_INSTRUCTIONS`, `AUTO_PAUSED_REASON`, `AUTO_MAX_CONSECUTIVE_BLOCKS`,
`AUTO_MAX_TOTAL_BLOCKS` and the types.

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
leading dot (they are gitignore patterns, not shell globs).

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
scope promotes it). `removeRule` of a session rule does not call `persist` either. The extra
`change` argument is backwards compatible with `persist(rules)` callbacks; the changed `allow` and
`addRule` signatures only add an optional parameter.

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
(write), `bash` (shell, `eharness/shell`), `bash_output`, `kill_shell`, `todo_write` (safe),
`web_fetch`, `web_search`, `agent`, `send_message` (safe: it only reaches agents that already run under the same rules, ADR-0038), `ask_user_question`, `exit_plan_mode`. A tool the map does not
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

**Parsing** (`parseCommand`, own tokenizer: no dependency). Words, single/double quotes, backslash
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

`readOnlyCommands: ['ls', 'git']` restricts the list to those names; `[]` disables auto-approval
(`READ_ONLY_COMMAND_NAMES` lists them). `tree` is not on the list (`-o FILE` writes). Residual limit:
a repository's own git config (`diff.external`, textconv drivers, pager) can run programs for
`git diff|log|show`.

**Path containment.** A read-only command's path arguments (and `<` targets) are resolved
**lexically** against the project root (`..` collapsed, `~/` from `home`, absolute paths as is). It
auto-approves only if every path is inside a *working directory* (a root with `workingDir !== false`)
and none is unresolvable: `$` expansion in any argument, `~user`, brace expansion, `xargs` stdin.
Outside paths ask. `Read` deny/ask rules (and the built-in `.env` ask) are matched against the
paths: a deny match denies, an ask match asks. A **directory read recursively** (`grep -r KEY .`,
`rg KEY`) or a **glob** (`cat .e*`) covers its subtree: if any `Read` deny/ask rule *could* match
something there, the command asks. Lexical resolution does not follow symlinks; a file system
adapter that exposes symlinks must enforce its own path guard (spec 08).

**acceptEdits** additionally approves `mkdir`, `touch`, `mv`, `cp` whose paths are inside writable
roots, outside protected paths, with no `-t`/`--target*`/`--`, no `$`, no redirect.

## 6. Protected paths

`protectedPaths` are gitignore patterns relative to each root (default `['.git']`). A tool write, or
a shell redirect, to a match asks in every mode. Applications add their own state
(`'.myapp/settings*.json'`). A shell command mentions a protected pattern when its first literal
segment appears as a word (`.git`, not `.gitignore`, not `foo.git`).

## 7. The plugin

`permissionsPlugin({ engine, mode?, allowedTools?, disallowedTools?, planExitTool?, filterOutputs?, onDecision?, onPlanExit? })`
(name `permissions`). Hooks and contributions:

| Where | What |
|---|---|
| `tool.approve` | `await engine.decideAsync(...)` (the classifier of `auto` mode runs here, with the event's `toolCallId`, restricted `transcript()` and the turn's abort signal) → `{ type: 'approved' }`, `{ type: 'user-approval', reason? }`, `{ type: 'denied', reason }`. Combines with other hooks, policy and grants by "most restrictive wins" (spec 11 §3) |
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
engines are cheap) or pass `permissionsPlugin({ mode: (ctx) => modes.get(ctx.session.id) })`. Store
a remembered answer with `persist` or from `suggestRule`; store the continuing mode from
`onPlanExit`. A user's session-level "always allow" is the core's `remember: 'session'` grant (spec
11 §3.1), which this module does not duplicate.

## 12. Auto mode

Modelled on Claude Code's auto mode: a classifier model reviews the actions no rule settles, so
the person is not asked for every shell command and the model still cannot do the dangerous
things without a human. `auto` is a `PermissionMode` and needs `classifier` in the engine options:

```ts
type AutoClassifier = (action: AutoAction, ctx: AutoClassifierContext) => Promise<AutoVerdict> | AutoVerdict
interface AutoAction { toolName; input; kind: ToolKind; summary?: string /* command or URL */; agent?: string }
interface AutoClassifierContext { transcript: readonly GuardTranscriptEntry[]; abortSignal?: AbortSignal }
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
- A classifier that throws, times out or returns something unreadable → blocked with a reason
  (**fail closed**) and counted.
- The verdict is remembered per `toolCallId` (AI SDK re-validates approved calls): the classifier
  runs once and counts once. If the engine's mode left `auto` while the classifier ran, the verdict is
  dropped and the new mode decides (usually an ask).
- `dontAsk` (global) still turns what would be an ask into a denial; the classifier is not called.

**Fallback (repeated blocks).** 3 blocks in a row, or 20 in total, **pause** auto mode
(`AUTO_MAX_CONSECUTIVE_BLOCKS`, `AUTO_MAX_TOTAL_BLOCKS`; fixed like in Claude Code). While paused,
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

**`modelClassifier({ model, instructions?, environment?, maxContext?, timeoutMs?, maxRetries? })`**
is the ready classifier: one AI SDK `generateText` call with `Output.object` (`{ decision, reason }`).
The default rules are the exported `AUTO_CLASSIFIER_INSTRUCTIONS` (extend it:
`${AUTO_CLASSIFIER_INSTRUCTIONS}\n…`, or replace through `instructions`): block downloading and
running code, sending secrets out, production deploys, irreversible destruction, force pushes;
allow routine work in the working directory; a boundary the user stated in the conversation blocks
matching actions until lifted; an explicit approval naming the action and what makes it dangerous
clears one block. `environment` describes trusted infrastructure. The prompt carries the restricted
transcript (spec 11 §3.4: user messages and earlier tool calls, **never tool outputs**, so a prompt
injection in a file or page cannot reach it), the call under review is left out of it, and the
action's input is framed as data. Use a cheap fast model; its usage is the application's to track
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
  (now `workingDir: false`).
- Invalid initial rules were silently ignored; they now throw `EH_CONFIG_INVALID`.
- shell-quote and `ignore`: replaced by an in-module tokenizer and gitignore matcher. Behaviour
  differences: a comment now ends at the newline; `$'…'` and `$"…"` are complex; a digit is a file
  descriptor only when attached to the redirect (`echo 2 > f` keeps `2`).

## 11. Limits

- Paths are POSIX strings; `real` is a namespace for rules and shell commands, not necessarily a
  disk. There is no symlink resolution and no Windows path support.
- The shell analysis is a gate, not a sandbox: run the shell tool in an OS sandbox (`eharness/shell`) when
  the model is not trusted.
- A command the analysis cannot read is never approved by a rule or a grammar; it asks (or is denied
  in `plan`/`dontAsk`).
