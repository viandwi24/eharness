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
import { createPermissionEngine, permissionsPlugin } from 'eharness/permissions'

const engine = createPermissionEngine({
  // the directories the file tools address: the virtual prefix and the path rules/shell use
  roots: () => [{ virtual: '/', real: '/work/proj' }],
  home: '/home/me',
  rules: {
    allow: ['Bash(bun test *)', 'Edit(src/**)'],
    ask: ['Bash(git push *)'],
    deny: ['Read(~/.ssh/**)', 'Edit(.env*)'],
  },
})

const agent = defineHarnessAgent({
  model,
  plugins: [filesystem({ fs }), permissionsPlugin({ engine })],
})
```

In `default` mode reads are free, `src/**` edits and `bun test` run without asking, a `git push`
asks, writes elsewhere ask, and `.env*` reads ask (built in; an allow rule can lift it). A deny
rule applies in every mode.

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
createPermissionEngine({
  roots,
  toolKinds: {
    run_script: { kind: 'shell', commandField: 'cmd' },
    read_doc: { kind: 'read', pathField: 'file' },
    deploy: { kind: 'other' },            // asks by default, denied in plan mode
  },
  aliases: { Docs: ['read_doc'] },
})
```

`Read(...)` rules now cover `read_doc` too. Kinds: `read`, `write`, `shell`, `fetch`, `search`,
`agent`, `ask`, `plan-exit`, `safe`, `other` (spec 18 §3 has the behaviour table).

## Modes

| Mode | Use it for |
|---|---|
| `default` | a person is there: writes and shell ask |
| `acceptEdits` | a person who trusts file edits (and `mkdir`/`touch`/`mv`/`cp` inside the roots) |
| `plan` | read-only exploration; the model ends it with `exit_plan_mode` and the user approves the plan |
| `dontAsk` | nobody is there: only allow rules and read-only commands run, the rest is denied |
| `bypassPermissions` | everything runs except deny rules, protected paths and "a deny rule could match" |

Protected paths (`protectedPaths`, default `['.git']`) ask in **every** mode, bypass included;
add your own state (`'.myapp/settings*.json'`). `engine.cycleMode()` and `engine.subscribe()` are
what a terminal UI binds to a key and a status line.

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
engine.subscribe((mode) => statusLine.set(mode))
onShiftTab(() => engine.cycleMode())
// the user picked "always allow" on an approval:
const rule = engine.suggestRule({ toolName, input })
if (rule) await engine.allow(rule)       // persist() writes it to your settings file
```

**Split web/server.** Decisions are a deterministic function of (rules, mode, call), so any
instance decides the same way after a restart; approvals travel as `tool-pending` and the browser
answers with `respond()`. The rules and the mode are your application state:

```ts
const engine = createPermissionEngine({
  roots: () => [{ virtual: '/', real: tenantRoot }],
  rules: await loadRules(tenantId),
  persist: (rules) => saveRules(tenantId, rules),     // after allow()/addRule()/removeRule()
})
permissionsPlugin({
  engine,
  mode: (ctx) => modes.get(ctx.session.id),            // per session, from storage
  onPlanExit: (mode, ctx) => modes.set(ctx.session.id, mode),
  onDecision: (d) => audit.write(d),                   // every decision and answer
})
```

A per-session "always allow" without writing a rule is the core's `remember: 'session'` grant
(spec 11 §3.1).

## Plugin options

| Option | What |
|---|---|
| `mode` | a fixed mode for this plugin instance (a read-only subagent: `'plan'`) or a function of the context |
| `allowedTools` / `disallowedTools` | tool names or aliases (`'Read'`, `'Edit'`) offered / never offered to the model |
| `planExitTool` | `false` to not register `exit_plan_mode`, or `{ name, description }` |
| `filterOutputs` | hide `Read`-protected paths from `grep`, `list_files` and `glob` output (default on) |
| `onDecision` | audit callback for every automatic decision and every answer |
| `onPlanExit` | the user approved a plan; store the mode to continue in |

Combine it with [`approvalGuard()`](guard.md): the guard can only tighten, so the two compose by the
core's "most restrictive wins".
