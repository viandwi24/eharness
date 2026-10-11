---
"eharness": patch
---

Fix "This part type is not accepted from clients." when retrying an interrupted reply: a `regenerate-message` request is decided by `messageId` alone. `eharness/client` no longer sends the message before the reply (it can be a stored kind message such as a subagent event, with a `data-eh.event` part) nor an idempotency key taken from it, and `eharness/http` no longer validates the messages of a regenerate body.
