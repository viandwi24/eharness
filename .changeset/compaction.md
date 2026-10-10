---
"eharness": minor
---

`session.compact(options?)` takes `CompactOptions = { keepLast?, instructions? }` for that call only: `keepLast` overrides `compaction.keepLast` (`0` summarizes everything, including the newest completed turn; invalid values reject with `EH_INVALID_INPUT`), and `instructions` adds a focus line (`The user asked the summary to focus on: …`) to the summarizer context after plugin lines. The `compaction.prompt` hook event gains a read-only `instructions` field.
