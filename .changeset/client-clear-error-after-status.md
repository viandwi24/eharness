---
"eharness": patch
---

`eharness/client`: the chat session now clears the AI SDK `Chat` error after `Chat` has set its status. `Chat` calls `onError` before it sets `status: 'error'`, so a clear inside the handler was a no-op and the composer stayed in the error state after a refused or already-answered send.
