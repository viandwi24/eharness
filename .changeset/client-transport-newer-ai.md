---
'eharness': patch
---

`eharness/client`: the chat transport also type-checks with newer `ai` releases, which declare `resumeStreamIsReplay` on `DefaultChatTransport` themselves. The value is set after construction instead of as a class field. No behaviour change.
