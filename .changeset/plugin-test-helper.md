---
"eharness": minor
---

`eharness/testing` gains `resolvePlugin(plugin, options?)`, which resolves a plugin the way a session does (boot checks, setup and session phases, tool factories, instructions, hooks) so plugin code can be unit-tested without a session. The returned `runHook(name, event, overrides?)` calls a hook with a fake context. Also exports `fakeHarnessContext(plugin, overrides?)`, `HarnessContextOverrides`, `ResolvedPlugin`, `ResolvePluginOptions`, `RunHookArgs` and `HookResult`.
