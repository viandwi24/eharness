---
"eharness": patch
---

`eharness/subagent`: the model-visible completion text of a background (or resumed) subagent names the task id and agent name (`Background subagent agent-1 "writer" (general-purpose: …) finished.`) instead of the child session id. The session id stays in the event `data`.
