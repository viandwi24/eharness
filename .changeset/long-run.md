---
'eharness': minor
---

Long-run jobs. `longRun()` (`eharness/limits`) runs a job as a chain of bounded turns on the durable inbox: at the end of a chunk the model writes a checkpoint note, a continuation turn is enqueued with an idempotent id, and the job stops only when the model finishes, when it is stuck, when its cost or duration budget is spent or when `stop()` is called. Job state lives in the session state (`longRunState()`), `resume()` continues a running job after a restart. `stepBudget({ onCap })` gives a turn a few extra steps and a hand-over reminder when it reaches the hard cap while progressing. Core exports `LONG_RUN_CHECKPOINT_STOP` / `isLongRunCheckpoint`; background subagents do not report a checkpoint turn as the end of the child. State changes made by `turn.end` hooks are now written right after the hooks.
