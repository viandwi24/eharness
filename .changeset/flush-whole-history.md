---
"eharness": patch
---

`session.flush()` now covers the whole model-visible history, as spec 06 §5.2a rule 11 states (the planning of `compact({ keepLast: 0 })`). In 0.14.0 it used `compaction.keepLast`, so a session with no more completed turns than `keepLast` flushed nothing and returned `skipped` with `nothing-to-flush`.
