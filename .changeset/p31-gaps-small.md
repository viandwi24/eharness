---
'eharness': minor
---

Permissions: `ToolKindSpec.alwaysAsk` makes a tool ask in every mode (even `bypassPermissions`, despite allow rules; denied in `dontAsk`); `persist(rules, change)` receives `{ op, kind, rule, scope }` and `allow`/`addRule` take a `scope` (`'session'` rules are not stored; the extra `persist` argument and optional parameters are backwards compatible). Web: the private/local host refusal names the `allow` option. Shell: the `bash` description states the sandbox state; `SandboxState` gains `writableRoots`.
