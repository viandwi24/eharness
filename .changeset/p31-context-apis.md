---
"eharness": minor
---

Context APIs for harness UIs (P31 R8, R12, R14, R15, R20).

- **`session.tools(): Promise<SessionToolInfo[]>`** lists the tools of the next request in request order: `{ name, description?, inputSchema, source, deferred, tokens }` with `source` `'app' | 'core' | 'plugin:<name>' | 'source:<id>'`. It resolves the registry like a turn would (without running one) and opens the session if needed; `refresh: 'turn'` sources are listed on every call.
- **`ContextStats.instructionBlocks`** (`{ owner, refresh, tokens }`) and **`ContextStats.toolSources`** (`{ source, tools, tokens }`) split `instructions` and `tools`; present in `session.stats()` and in `data-eh.context`. **Behaviour change:** idle `session.stats()` now measures the whole next request (skills index, turn-refresh instructions, skill and source tools), so `instructions` and `tools` can be larger than before; it also lists tool sources like a turn does.
- **`config.toolOrder`**: final tool names that go first, in that order; the rest keep the default order. Unknown names warn once per session with the new `W_TOOL_ORDER`.
- **`TurnInfo.addUsage()`** accepts plain token counts (`PlainUsage`, the shape of `TurnResult['usage']`, plus `reasoningTokens` and `costUsd`) besides AI SDK's `LanguageModelUsage`. New exported types `AddUsageInput`, `PlainUsage`.
- **Reasoning duration**: every `reasoning-end` chunk carries `providerMetadata.eharness.durationMs`, so UI and stored reasoning parts show how long the model thought. The key is removed from the provider wire.
