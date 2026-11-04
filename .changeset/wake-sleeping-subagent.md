---
"eharness": patch
---

subagent: `send_message` to a park-mode child that is asleep (`sleep` tool) now wakes it and hands it the message at once. Before, the message was queued behind the sleep and read only when the sleep ended, while the sender was told it was delivered.
