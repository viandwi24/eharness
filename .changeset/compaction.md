---
"eharness": patch
---

Context loading and compaction: the fixed compaction algorithm (pre-turn, mid-turn with
`partial`, and manual `session.compact()`), rolling chunked summarization with a continuation-brief
prompt and the `compaction.prompt` / `compaction.after` hooks, `eh.compaction` markers with a
compaction pointer so cold loads need one `load({ fromId })` query (self-healing after lost state
writes), calibrated token accounting (`metadata.eharness.tokens`, `session.stats()`,
`data-eh.context` with `lastCompaction`), the complete guard (drop oldest turns, truncate the
largest tool outputs in the request, `W_CONTEXT_TRUNCATED`, `EH_CONTEXT_OVERFLOW`), the `select`
escape hatch, `compaction: false`, and provider overflow recovery (held-back error chunk,
recalibration, compact-and-retry, tighter guard, `W_OVERFLOW_RETRY`, `config.isContextOverflow`).
