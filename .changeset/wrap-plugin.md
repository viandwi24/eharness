---
"eharness": minor
---

Add `wrapPlugin(plugin, overrides?)`: compose a plugin through the public API.

- Returns a normal plugin with the inner plugin's name, `version`, `provides`, `requires`, data
  parts and message kinds; intercept `setup`, `session` and any hook with a `next` that calls the
  inner implementation. Hook order and boot validation are unchanged.
- `next.using(other)` runs another plugin's session phase, for per-request configuration of plugins
  configured at construction (e.g. a judge model for `approvalGuard()` resolved from `ctx.runtime`).
- New types: `WrapPluginOverrides`, `WrapSessionNext`, `WrapHookOverride`, `WrapHookOverrides`,
  `WrapHookNext`. No changes when unused (spec 01 §2.1, ADR-0033).
