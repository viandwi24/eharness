---
"eharness": patch
---

A call to a deferred tool that was not loaded yet now loads it for the next step (the failed call counts as a discovery), so the model does not need a separate `tool_search` round.
