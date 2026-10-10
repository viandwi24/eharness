---
"eharness": minor
---

New subpath `eharness/permissions`: rule-based tool permissions (Draft).

- `createPermissionEngine({ roots, home?, mode?, rules?, protectedPaths?, readOnlyCommands?, toolKinds?, aliases?, modeCycle?, classifier?, persist? })` decides every call: `Tool(spec)` rules (`Bash(bun test *)`, `Read(.env*)`, `Edit(src/**)`, `WebFetch(domain:…)`, `Agent(name)`) with deny > ask > allow precedence, protected paths that ask in every mode, and a built-in `.env` ask.
- Modes: `default`, `acceptEdits`, `plan`, `dontAsk`, `bypassPermissions` and `auto`. `modeCycleFor({ bypass, auto })` builds the `cycleMode()` order.
- **Auto mode (Draft):** the `classifier` option (`AutoClassifier`, e.g. `modelClassifier({ model, … })` with `AUTO_CLASSIFIER_INSTRUCTIONS`) decides the calls no rule or read-only check settles. A failing classifier blocks; repeated blocks (3 in a row, 20 in total) pause auto mode until a person approves (`autoState()`, `subscribeAuto()`, `noteApproval()`, `resumeAuto()`). `engine.decideAsync()` runs the classifier; `decide()` stays synchronous.
- Shell commands are analysed without running them: a strict tokenizer (wrappers, redirects, `$(…)` and heredocs count as complex), argument grammars for read-only commands (allow-lists), lexical path containment, and `Read` / `Edit` rule matching on the paths a command touches. No new dependencies.
- `permissionsPlugin({ engine, … })` wires the engine onto `tool.approve`, `step.prepare` (hides tools by mode and rule), `tool.after` (hides `Read`-protected paths from `grep`, `list_files`, `glob` output) and `approval.decided`, and registers `exit_plan_mode`. `toolKinds` maps tools (defaults cover eharness's own tools, including `send_message`, `agent_output` and `agent_stop` as `safe`); `ToolKindSpec.alwaysAsk` makes a tool ask in every mode, even `bypassPermissions`.
- Works in the three deployment profiles: `dontAsk` plus an allow-list for autonomous servers, live `cycleMode()` for a CLI, a per-session `mode` function with `persist` (`{ op, kind, rule, scope }`; `'session'` scope rules are not stored) and `onPlanExit` for split web/server apps.

Claude-Code-derived names (`bypassPermissions`, `acceptEdits`, `dontAsk`) are kept on purpose. See spec 18 and the permissions guide.
