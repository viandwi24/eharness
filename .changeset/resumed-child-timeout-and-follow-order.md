---
"eharness": patch
---

Fix two regressions found in manual testing of the team example:

- `eharness/subagent`: the background time limit (`background.timeoutMs`, enforced with `stopOnTimeout`) is measured from the start of the turn the child is running now, not from the child's creation. A background child resumed by a message hours after it was launched was reported as timed out and stopped seconds after it started ("Resumed subagent … failed. [subagent stopped: aborted]").
- `eharness/client`: following a turn that continues an assistant message which is no longer the newest one (a `respond()` continuation after subagent events or other kind messages were stored behind the waiting reply, or a recovered turn) moved that message to the end before `resumeStream()`. AI SDK only replaces the last message, so the continuation was pushed as a second copy with the same id, which crashed keyed UI lists (Svelte `each_key_duplicate`, a blank "500 Internal Error" page after answering a question). The refetch after the turn restores the stored order.
