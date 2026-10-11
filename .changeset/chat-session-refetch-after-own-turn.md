---
"eharness": patch
---

`eharness/client`: `createChatSession` refetches the stored messages when a turn this chat streamed itself ends, if the server announced stored messages meanwhile (`storedElsewhere()` was called while busy). Kind messages stored during the turn (events, notices) now show without waiting for the next event, and the optimistic user message (an id AI SDK made up) is replaced by the stored one.
