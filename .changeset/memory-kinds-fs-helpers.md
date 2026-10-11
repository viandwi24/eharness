---
"eharness": minor
---

**BREAKING (security default):** `eharness/permissions`: the `memory_*` tools are `safe` in `DEFAULT_TOOL_KINDS` (no more asking for every memory call). `eharness/filesystem` exports `splitLines`, `statelessPattern` and `GREP_SCAN_CHARS` for adapter authors; docs cover the conformance factory contract and the cost of an inbox without `notify`/`subscribe`.

Migration: the `memory_*` tools no longer ask for approval under the permission engine. To keep asking, give the tools you want gated a non-`safe` kind through the engine's `toolKinds` option, or add `ask` rules naming them.
