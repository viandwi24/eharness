---
"eharness": minor
---

**BREAKING:** `session.stats()` measures the whole next request; new tool ordering, deferral and listing.

- **BREAKING:** an idle `session.stats()` now measures the whole next request (skills index, turn-refresh instructions, skill and source tools), so `instructions` and `tools` can be larger than before, and it lists tool sources like a turn does. Deferred tools count 0 toward the totals. `ContextStats` gains `instructionBlocks` (`{ owner, refresh, tokens }`) and `toolSources` (`{ source, tools, tokens }`), also in `data-eh.context`. Re-check thresholds that depend on `stats()`.
- `session.tools()` lists the tools of the next request in request order: `{ name, description?, inputSchema, source, deferred, tokens }` with `source` `'app' | 'core' | 'plugin:<name>' | 'source:<id>'` (deferred tools included, with their size). Type `SessionToolInfo`.
- `config.toolOrder` lists final tool names first, in that order; the rest keep the default order. Names that match no tool warn once per session with the new `W_TOOL_ORDER`. Keep it stable: a changed order busts the prompt cache.
- `config.deferTools` hides the named app, plugin or source tools until the model finds them with `tool_search`. When any tool is deferred the core adds a turn reminder listing the deferred tools by name with a one-line description (the reminder format is Draft).
- A stored `media-ref` tool output (a filesystem image or PDF) is estimated like the wire it stands for instead of its JSON, and the prune stage measures media by a fixed size, so `stats.pruned.chars` is not inflated by base64.
