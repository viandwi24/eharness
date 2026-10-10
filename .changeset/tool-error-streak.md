---
"eharness": patch
---

Progress guard sees returned failures. A tool result that is a text (or JSON string) starting with `ERROR:` now counts as a failed result for the error streak and for progress, and the new `loop.progress.toolErrorStreak` (default 8) stops a turn that keeps failing with one tool whatever its inputs, even when other tools succeed in between (`W_LOOP_STUCK` `details.kind: 'tool-errors'`). See spec 05 §3.2.
