---
"eharness": patch
---

Internal refactor, no behaviour or API change. `eharness/subagent`: the 3 100-line `subagent()` closure is split into modules over an explicit `Env` (resolved options) and `Scope` (one session's state); every execution mode (foreground, user-moved-to-background, background, park) now runs through one `withChildLifecycle` that owns the abort wiring, the concurrency slot and the child session handle, so no mode can leak a listener, a slot or an open child. Subpath modules reuse the core `isRecord` / `errorText` helpers instead of private copies, `eharness/connectors` shares the base64url of `eharness/providers`, and a few misleading comments are fixed.
