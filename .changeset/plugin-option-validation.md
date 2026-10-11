---
'eharness': minor
---

Numeric options of `todos()`, `ask()`, `group()`, `webFetch()` and `shell()` are validated: BREAKING, invalid values (negative, zero where a positive number is required, fractions for counts, `ask` `maxQuestions` above 4) now throw `EH_CONFIG_INVALID` instead of being clamped silently. `listRemoteMcpTools` now times out like `mcpServerSource` (`timeoutMs`, default 15 s). Config errors of `approvalGuard()` now read `guard: …` instead of `approvalGuard: …`. JSDoc examples and version notes corrected.
