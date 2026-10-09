---
"eharness": minor
---

New module `eharness/permissions` (P31): rule-based tool permissions, promoted from the coder example.

- `createPermissionEngine({ roots, home?, mode?, rules?, protectedPaths?, readOnlyCommands?, toolKinds?, aliases?, persist? })` decides every call: `Tool(spec)` rules (`Bash(bun test *)`, `Read(.env*)`, `Edit(src/**)`, `WebFetch(domain:…)`, `Agent(name)`) with deny > ask > allow precedence, modes `default` / `acceptEdits` / `plan` / `dontAsk` / `bypassPermissions`, protected paths that ask in every mode, and a built-in `.env` ask.
- Shell commands are analysed without running them: a strict tokenizer (wrappers, redirects, `$(…)`, heredocs are "complex"), argument grammars for read-only commands (allow-lists, not deny-lists), lexical path containment and `Read`/`Edit` rule matching on the paths a command touches. No new dependencies: the tokenizer and the gitignore matcher are in the module.
- `permissionsPlugin({ engine, … })` wires it onto `tool.approve`, `step.prepare` (hides tools by mode and rule), `tool.after` (hides `Read`-protected paths from `grep`/`list_files`/`glob` output) and `approval.decided` (`onDecision`), and registers the `exit_plan_mode` tool. Tools are described by a configurable tool map (`toolKinds`), with defaults for eharness's own tools.
- Works in all three deployment profiles: `dontAsk` + allow-list for autonomous servers, live `cycleMode()` for a CLI, a per-session `mode` function and `persist` / `onPlanExit` callbacks for split web/server apps.

See spec 18 and the permissions guide.
