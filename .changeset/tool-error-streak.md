---
"eharness": minor
---

**BREAKING (default):** Progress guard sees returned failures. A tool result that is a text (or JSON string) starting with `ERROR:` now counts as a failed result for the error streak and for progress, and the new `loop.progress.toolErrorStreak` (default 8) stops a turn that keeps failing with one tool whatever its inputs, even when other tools succeed in between (`W_LOOP_STUCK` `details.kind: 'tool-errors'`). See spec 05 §3.2.

Migration: turns that previously ran on (several failing calls of one tool, or `ERROR:` results) can now stop with `W_LOOP_STUCK`. Raise `loop.progress.toolErrorStreak` (a positive integer; a very large value effectively restores the old behaviour).
