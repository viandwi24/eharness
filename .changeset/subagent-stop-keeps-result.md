---
'eharness': patch
---

eharness/subagent: a background subagent that ends after a stop request still reports its final answer to the parent (finished vs stopped is decided by whether its turn completed, and a stopped report carries the text so far), and `agent_stop` on an agent that already ended returns its final answer instead of only "not running".
