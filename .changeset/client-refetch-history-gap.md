---
"eharness": patch
---

`eharness/client`: a `ChatSession` refetch no longer leaves a hole in the history when more than one page of messages was stored while the tab was away (the stale older messages are dropped and "load older" fills the gap), and an optimistic user message never survives a refetch that holds the message the server stored.
