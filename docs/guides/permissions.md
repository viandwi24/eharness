# Permissions

`eharness/permissions` decides every tool call from rules and a mode: approve, ask a person, or
deny with a reason the model can read and adapt to. It is policy only — asking is the core's
`tool-pending` + `respond()` flow (see [Approvals and interaction](approvals-and-interaction.md)),
so the same module serves an unattended server, a terminal app and a web chat. Contract:
[spec 18](../specs/18-permissions-plugin.md).

## A first setup

```ts
import { defineHarnessAgent } from 'eharness'
import { filesystem } from 'eharness/filesystem'
import { nodeContainsProtected, nodeRealpath } from 'eharness/filesystem/node'
import { createPermissionEngine, permissions } from 'eharness/permissions'

// yours: `model` and `fs` (a FileSystem over /work/proj)
const engine = createPermissionEngine({
  // the directories the file tools address: the virtual prefix and the path rules/shell use
  roots: () => [{ virtual: '/', real: '/work/proj' }],
  home: '/home/me',
  realpath: nodeRealpath, // optional: match symlink targets too (g -> .git, x -> .env)
  containsProtected: nodeContainsProtected, // optional: look into `grep -r .` for .env files
  rules: {
    allow: ['Bash(bun test *)', 'Edit(src/**)'],
    ask: ['Bash(git push *)'],
    deny: ['Read(~/.ssh/**)', 'Edit(.env*)'],
  },
})

const agent = defineHarnessAgent({
  model,
  plugins: [filesystem({ fs }), permissions({ engine })],
})
```

In `default` mode reads are free, `src/**` edits and `bun test` run without asking, a `git push`
asks, writes elsewhere ask, and `.env*` reads ask (built in; an allow rule can lift it). A deny
rule applies in every mode.

> **Recursive reads.** The built-in `.env*` ask matches named paths (`cat .env`, `grep -r x .env`)
> but, lexically, not a recursive read of a directory: without help, `grep -r KEY .`, `rg KEY` or
> `cp -r . /tmp/x` through `bash` can read `.env` files without asking, because the engine cannot
> list directories (core is runtime-neutral). Close it with the `containsProtected` option
> (`nodeContainsProtected` from `eharness/filesystem/node`, next to `nodeRealpath`): `decideAsync`
> then looks into the directories such a command reads, **asks** when a built-in ask path or
> protected path (`.git` by default) is below, and **denies** when a `Read` deny rule matches there.
> The walk is bounded (32 levels, 50 000 entries, 2 s) and fails closed. Without the option
> behaviour is unchanged: a user `Read(**/.env*)` deny/ask rule still asks for any directory it
> could match, and an OS sandbox `denyRead` remains the hard stop. Deny rules also see through
> `busybox` and `find -exec`.

## Rules in practice

- `Bash(npm run *)`: `*` is any text and a trailing ` *` also matches the bare command. An allow
  rule must match **every** subcommand of `a && b | c` and never a complex command (`$(...)`,
  heredocs, subshells); deny and ask rules match when **any** part matches, even inside `$(...)`.
- `Read(...)` and `Edit(...)` take gitignore patterns: `src/**` is anchored at the project root,
  `*.pem` matches at any depth (also inside other roots), `//etc/**` is absolute, `~/.ssh/**` is under
  `home`. They also apply to what a shell command reads (`cat secrets/a`) and redirects to
  (`echo x > secrets/a`).
- `WebFetch(domain:example.com)`, `WebFetch(domain:*.example.com)`, `Agent(name)`, or a bare
  `mcp__server__tool`.
- A rule that does not parse throws `EH_CONFIG_INVALID` instead of silently doing nothing.

Test a rule without an engine with `matchRule('Edit(src/**)', call, { roots })`.

## Telling the engine about your tools

The engine knows kinds, not names. The defaults cover eharness's tools (`read_file`, `edit_file`,
`bash`, `web_fetch`, …); describe the rest:

```ts
// yours: `roots` as in the first example
createPermissionEngine({
  roots,
  toolKinds: {
    run_script: { kind: 'shell', commandField: 'cmd' },
    read_doc: { kind: 'read', pathField: 'file' },
    deploy: { kind: 'other' },            // asks by default, denied in plan mode
    pay: { kind: 'other', alwaysAsk: true }, // asks in every mode, even bypassPermissions
  },
  aliases: { Docs: ['read_doc'] },
})
```

`Read(...)` rules now cover `read_doc` too. Kinds: `read`, `write`, `shell`, `fetch`, `search`,
`agent`, `ask`, `plan-exit`, `safe`, `other` (spec 18 §3 has the behaviour table).

`alwaysAsk` is the way to protect tools that must always involve a human (directory access,
payments, deploys): no allow rule or mode approves them, deny rules still deny. An autonomous
server (nobody to ask, `dontAsk`) therefore gets them denied.

## Modes

| Mode | Use it for |
|---|---|
| `default` | a person is there: writes and shell ask |
| `acceptEdits` | a person who trusts file edits (and `mkdir`/`touch`/`mv`/`cp` inside the roots) |
| `plan` | read-only exploration; the model ends it with `exit_plan_mode` and the user approves the plan |
| `dontAsk` | nobody is there: only allow rules and read-only commands run, the rest is denied |
| `bypassPermissions` | everything runs except deny rules, protected paths and "a deny rule could match" |
| `auto` | edits and read-only commands run; everything else is judged by a classifier model (see Auto mode) |

Protected paths (`protectedPaths`, default `['.git']`) ask in **every** mode, bypass included;
add your own state (`'.myapp/settings*.json'`). `engine.cycleMode()` and `engine.subscribe()` are
what a terminal UI binds to a key and a status line. `modeCycleFor({ bypass, auto })` builds the
cycle like Claude Code: `default`, `acceptEdits`, `plan`, then `bypassPermissions`, then `auto`
(each only when you enable it); from `dontAsk` or any mode outside the cycle the next press goes to
`default`. Pass it as `modeCycle`; making `bypassPermissions` reachable is your application's
decision (a flag, a setting).

## Auto mode

`modelClassifier` runs on the same judge engine as the approval guard (role `decide`, so an allow
replaces asking a person); see [LLM judge: two modes](llm-judge.md).

A classifier model reviews what no rule settles, so a person is not asked for every command:

```ts
import { createPermissionEngine, modelClassifier, modeCycleFor } from 'eharness/permissions'

// yours: `roots` as in the first example, `cheapModel` (an AI SDK LanguageModel)
const engine = createPermissionEngine({
  roots,
  classifier: modelClassifier({
    model: cheapModel,
    environment: 'Trusted: github.com/acme/app, the staging bucket s3://acme-staging',
    cache: { maxEntries: 200, ttlMs: 3_600_000 }, // optional; the verdict cache is off by default
  }),
  modeCycle: modeCycleFor({ auto: true }),
})
engine.setMode('auto')   // throws EH_CONFIG_INVALID without a classifier; engine.autoAvailable says
```

Deny and ask rules still win, narrow allow rules run without the classifier (broad ones like
`Bash(*)` are ignored in this mode), reads, edits in the roots and read-only commands run, protected
paths ask a person, and the rest goes to the classifier. A block is a denied tool result with a
reason the model reads, so it picks another way; a classifier that fails blocks too. A classifier may also return `decision: 'ask'` (`AutoVerdict.decision`
is `'allow' | 'block' | 'ask'`) to hand the action to a person; `modelClassifier` does so itself
when the action is over 2000 characters (summary) or `maxCallChars` (input, default 8 000, the same option and default as `guard()`), instead of judging it. `maxContext.maxChars` bounds the transcript only. After 3 blocks in
a row or 20 in total auto mode **pauses** and asks a person again until one approval resumes it:
show `engine.autoState()` and listen with `engine.subscribeAuto()` for a notice. Write your own
classifier (`(action, { transcript, abortSignal }) => ({ decision, reason })`), add trusted context
to the shipped one with `environment`, or replace its rules prompt with `instructions`. The classifier is a heuristic layer: use deny
rules for hard guarantees. Spec 18 §12 has the exact order and limits.

## Shell commands

`ls`, `cat`, `grep`, `git status`, `find` without `-exec`/`-delete`, and a few dozen more are
*read-only* and need no rule — if their arguments pass a strict grammar (no `sort -o`, no `rg --pre`,
no `git -c`) **and** every path they read is inside a root and not hidden by a `Read` rule. A
`grep -r KEY .` asks when a deny rule could match anything below `.`. `cat $HOME/x`, `cat ~root/x`
and brace expansions ask because the path cannot be resolved without a shell. Anything else asks,
or is denied in `plan` and `dontAsk`. The full threat model and the grammar table are in spec 18 §5.

`readOnlyCommands: ['ls', 'git']` narrows the list; `[]` turns it off. This analysis is a gate,
not a sandbox: run the shell tool in an OS sandbox when the model is not trusted.

## Plan mode

```ts
engine.setMode('plan')   // writes are denied and hidden; exit_plan_mode is offered
```

The model explores and calls `exit_plan_mode({ plan })`. That call asks; when the user approves, the
engine switches back to the mode that was active before (or to the one set with
`engine.setPlanExitMode('acceptEdits')` while the user approved), and the next model step already
offers the edit tools. If the user rejects the plan, their feedback reaches the model and plan mode
stays.

## Three deployment profiles

**Autonomous server.** Use `dontAsk` with an allow-list. Nothing ever waits for a person; what is
not allowed is a denial the model reads and works around.

```ts
createPermissionEngine({
  roots: () => [{ virtual: '/', real: '/srv/work' }],
  mode: 'dontAsk',
  rules: { allow: ['Edit(reports/**)', 'Bash(git status *)', 'WebFetch(domain:api.example.com)'] },
})
```

**Single-process CLI.** Switch modes live, and make "don't ask again" a one-liner:

```ts
// yours: `engine` as above
engine.subscribe((mode) => statusLine.set(mode))
onShiftTab(() => engine.cycleMode())
// yours: `statusLine`, `onShiftTab`, `toolName` and `input` of the approval the user answered
// the user picked "always allow" on an approval:
const rule = engine.suggestRule({ toolName, input })
if (rule) await engine.allow(rule)       // persist() writes it to your settings file
if (rule) await engine.allow(rule, 'session') // this session only: persist() is not called
```

**Split web/server.** Decisions are a deterministic function of (rules, mode, call), so any
instance decides the same way after a restart; approvals travel as `tool-pending` and the browser
answers with `respond()`. The rules and the mode are your application state:

```ts
// yours: `tenantRoot`, `tenantId`, `loadRules`, `saveRules`, `modes` (per-session mode store), `audit`
const engine = createPermissionEngine({
  roots: () => [{ virtual: '/', real: tenantRoot }],
  rules: await loadRules(tenantId),
  persist: (rules, change) => saveRules(tenantId, rules),  // after allow()/addRule()/removeRule(); change = { op, kind, rule, scope }
})
permissions({
  engine,
  mode: (ctx) => modes.get(ctx.session.id),            // per session, from storage
  onPlanExit: (mode, ctx) => modes.set(ctx.session.id, mode),
  onDecision: (d) => audit.write(d),                   // every decision and answer
})
```

A per-session "always allow" without writing a rule is the core's `remember: 'session'` grant
(spec 11 §3.1).

## Prompt injection

Tool output from outside your control (web pages, search results, MCP servers, files someone else
wrote) can contain instructions aimed at the model. No single layer stops that; stack them:

1. **Framing.** `webFetch`, `webSearch` and `mcpServerSource` wrap their text results in
   `<untrusted-content source="…">…</untrusted-content>` (`untrustedContent()` from `eharness`;
   text inside cannot close the frame). Put `UNTRUSTED_CONTENT_INSTRUCTIONS` in your instructions
   so the model knows to treat the frame as data. Each source has a `wrapUntrusted` option; `false`
   opts out.
   Filesystem reads are **not** framed (the project is the user's own workspace and framing every
   read is noisy); wrap a tool result yourself with `untrustedContent()` where you read files you
   do not trust (downloads, other users' uploads).
2. **Permissions.** Reads of untrusted data are harmless only if the dangerous tools (shell,
   writes, network, `external` and `destructive` risks) still ask. Keep approval on for them.
3. **Auto mode.** The classifier never sees tool outputs, so an injected page cannot talk the
   classifier into approving an action.
4. **Sandbox.** Run the shell in a sandbox and restrict `webFetch` with `onlyAllowed` / `allow`
   for autonomous servers.
5. **Containment.** Least-privilege credentials per session, no secrets in the model's reach,
   per-user MCP transports, budgets and abort.

Framing lowers the odds; permissions and containment limit the damage when it fails.

## Security notes

- **Case and Unicode.** Protected paths, the built-in `.env*` ask and your `deny` / `ask` rules match
  case-insensitively (NFC, trailing dots and spaces ignored), on every platform: `.GIT/config` and
  `.ENV` ask like `.git/config` and `.env`. `allow` rules stay exact.
- **Globs cannot leave the project.** A read-only command whose glob can expand to `..`
  (`cat .[.]/.[.]/etc/passwd`, `ls .?/`, `ls -d .*`) asks instead of auto-approving; `*.ts`, `.git*`
  and other ordinary globs are unaffected.
- **Deny rules are best-effort, not a boundary.** `Bash(rm *)` and `Bash(git push *)` also deny
  `! rm`, `/bin/rm`, `sudo rm`, `env A=1 rm`, `sh -c "rm x"`, `eval 'rm x'`, `git -C . push`,
  `git --no-pager push` and `git -c x=y push` (`ask` rules too; `allow` rules never get this, so
  they cannot be widened). They also see through `xargs [flags]`, `find -exec`/`-execdir`,
  `busybox`, `setsid` and `flock <file>`. A `sh -c` payload that cannot be read asks. Not seen:
  renamed binaries, scripts, computed names. Use `dontAsk`/`plan` modes, the OS
  sandbox and least-privilege credentials for a real boundary.
- **"Allow for this session" is scoped for shells.** On a shell tool, `remember: 'session'`
  stores the command prefix (`git commit`), so approving `git commit -m a` never approves
  `curl …`; wrappers, interpreters, compound commands, redirects and protected paths are not
  remembered. A command that carries a high-risk flag (`--force`, `git push -f`, `rm -r`/`-f`,
  `--hard`, `--privileged`, `-v /…`, `--mount`, …) is never covered by a session grant or a
  suggested rule: it asks again. Likewise an allow rule with a wildcard does not approve inline
  code (`python -c`, `node -e`, `perl -e`); only an exact rule does. Other tools keep one grant
  per tool name (after one approved edit every later edit that would ask runs unasked, never one
  that is `denied`). The HTTP attention route drops `remember` unless you set
  `allowRemember: true`.
- **Symlinks.** Pass `realpath: nodeRealpath` (from `eharness/filesystem/node`) so protected paths
  and `Read`/`Edit` rules also match the symlink-resolved path (`g -> .git`, `x -> .env`); without
  it matching is lexical.
- **Recursive reads.** Pass `containsProtected: nodeContainsProtected` as well so a recursive read
  (`grep -r KEY .`, `rg`, `find -exec cat`, `cp -r`, `tar`) of a directory that holds `.env*` files
  or protected paths asks (or is denied by a `Read` deny rule); without it only user `Read` rules
  cover subtrees. Every `grep -r` from a repository root then asks while `.git` is protected.
- **The analysis is a gate, not a sandbox** (spec 18 §11): pair shells with
  [the OS sandbox](shell.md#environment-and-sandbox-limits).

## Plugin options

| Option | What |
|---|---|
| `mode` | a fixed mode for this plugin instance (a read-only subagent: `'plan'`) or a function of the context |
| `allowedTools` / `disallowedTools` | tool names or aliases (`'Read'`, `'Edit'`) offered / never offered to the model |
| `planExitTool` | `false` to not register `exit_plan_mode`, or `{ name, description }` |
| `filterOutputs` | hide `Read`-protected paths from `grep`, `list_files` and `glob` output (default on) |
| `onDecision` | audit callback for every automatic decision and every answer |
| `onPlanExit` | the user approved a plan; store the mode to continue in |

Combine it with [`guard()`](guard.md): the guard can only tighten, so the two compose by the
core's "most restrictive wins".
