---
"eharness": patch
---

OpenRouter `stickyProvider` forgets a conversation's provider when a call fails (rejected, a stream `error` part or a broken stream), so the next call is routed normally instead of going back to a failing upstream.
